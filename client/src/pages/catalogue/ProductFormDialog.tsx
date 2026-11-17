/** Create / edit a canonical product. */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ImageOff } from 'lucide-react';
import { apiPatch, apiPost } from '@/lib/api.ts';
import { useApiQuery, useReference } from '@/lib/hooks.ts';
import { Dialog } from '@/components/ui/overlays.tsx';
import { Button, Field, Input, LoadingBlock, Notice, Select, Textarea } from '@/components/ui/primitives.tsx';
import { PACK_UNITS } from '@shared/constants.ts';
import type { ProductDetail, ProductRow } from '@shared/api/catalogue.ts';
import { CATALOGUE, categoryTree, CheckList, errorMessage, isHttpUrl, PACK_UNIT_LABELS, parseNumber, useCatalogueActions } from './shared.tsx';

interface FormState {
  brand_id: string;
  name: string;
  product_line: string;
  category_id: string;
  subcategory_id: string;
  sku: string;
  gtin: string;
  pack_size: string;
  pack_unit: string;
  units_per_pack: string;
  image_url: string;
  description: string;
  status: 'active' | 'inactive';
  market_ids: number[];
}

const EMPTY: FormState = {
  brand_id: '', name: '', product_line: '', category_id: '', subcategory_id: '', sku: '', gtin: '', pack_size: '', pack_unit: '',
  units_per_pack: '1', image_url: '', description: '', status: 'active', market_ids: [],
};

function fromProduct(product: ProductRow, marketIds: number[]): FormState {
  return {
    brand_id: String(product.brand_id),
    name: product.name,
    product_line: product.product_line ?? '',
    category_id: String(product.category_id),
    subcategory_id: product.subcategory_id ? String(product.subcategory_id) : '',
    sku: product.sku ?? '',
    gtin: product.gtin ?? '',
    pack_size: product.pack_size === null ? '' : String(product.pack_size),
    pack_unit: product.pack_unit ?? '',
    units_per_pack: String(product.units_per_pack ?? 1),
    image_url: product.image_url ?? '',
    description: product.description ?? '',
    status: product.status === 'inactive' ? 'inactive' : 'active',
    market_ids: marketIds,
  };
}

function ImagePreview({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const valid = isHttpUrl(url);
  return (
    <span className="flex size-[34px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-sunken text-ink-4" title={valid && !failed ? 'Image preview' : 'No preview'}>
      {valid && !failed ? <img src={url} alt="" className="size-full object-cover" onError={() => setFailed(true)} /> : <ImageOff className="size-3.5" aria-hidden />}
    </span>
  );
}

export function ProductFormDialog({
  open,
  onClose,
  productId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Edit this product; omit to create a new one. */
  productId?: number | null;
  onSaved?: (detail: ProductDetail) => void;
}) {
  const editing = !!productId;
  const { ref } = useReference();
  const { run, busy } = useCatalogueActions();
  const detail = useApiQuery<ProductDetail>([CATALOGUE, 'product', productId ?? 0], `/products/${productId}`, undefined, { enabled: open && editing });
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<number | 'new' | null>(null);

  // (Re)initialise the form each time the dialog opens for a product.
  useEffect(() => {
    if (!open) {
      setLoadedFor(null);
      setError(null);
      return;
    }
    if (!editing) {
      if (loadedFor !== 'new') {
        setForm(EMPTY);
        setLoadedFor('new');
      }
      return;
    }
    if (detail.data && detail.data.product.id === productId && loadedFor !== productId) {
      setForm(fromProduct(detail.data.product, detail.data.market_ids));
      setLoadedFor(productId!);
    }
  }, [open, editing, productId, detail.data, loadedFor]);

  const tree = useMemo(() => categoryTree(ref?.categories), [ref?.categories]);
  const subcategories = tree.find((c) => String(c.id) === form.category_id)?.children ?? [];
  const ownBrands = (ref?.brands ?? []).filter((b) => b.ownership === 'own');
  const competitorBrands = (ref?.brands ?? []).filter((b) => b.ownership === 'competitor');
  const markets = ref?.markets ?? [];
  const archived = editing && detail.data?.product.status === 'archived';
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const packSize = parseNumber(form.pack_size);
    const units = parseNumber(form.units_per_pack);
    if (!form.brand_id) return setError('Choose the brand this product belongs to.');
    if (!form.name.trim()) return setError('Enter the product name.');
    if (!form.category_id) return setError('Choose a category.');
    if (packSize !== null && (!Number.isFinite(packSize) || packSize <= 0)) return setError('Pack size must be a number greater than zero.');
    if (packSize !== null && !form.pack_unit) return setError('Choose the unit of the pack size.');
    if (units !== null && (!Number.isInteger(units) || units < 1)) return setError('Units per pack must be a whole number of at least 1.');
    if (form.image_url.trim() && !isHttpUrl(form.image_url.trim())) return setError('The image URL must start with http:// or https://.');
    const body: Record<string, unknown> = {
      brand_id: Number(form.brand_id),
      name: form.name.trim(),
      product_line: form.product_line,
      category_id: Number(form.category_id),
      subcategory_id: form.subcategory_id ? Number(form.subcategory_id) : null,
      sku: form.sku,
      gtin: form.gtin,
      pack_size: packSize,
      pack_unit: form.pack_unit || null,
      units_per_pack: units ?? 1,
      image_url: form.image_url.trim(),
      description: form.description,
      market_ids: form.market_ids,
    };
    // The status of an archived product only changes through "Restore".
    if (!archived) body.status = form.status;
    const outcome = await run(
      'save-product',
      () => (editing ? apiPatch<ProductDetail>(`/products/${productId}`, body) : apiPost<ProductDetail>('/products', body)),
      { success: (d) => (editing ? `${d.product.name} updated` : `${d.product.name} added to the catalogue as ${d.product.code}`), quietError: true },
    );
    if (outcome.ok) {
      onSaved?.(outcome.result);
      onClose();
    } else {
      setError(errorMessage(outcome.error, 'The product could not be saved.'));
    }
  }

  const loading = editing && (detail.isPending || loadedFor !== productId);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit product' : 'Add product'}
      description={editing ? detail.data?.product.code : 'A canonical product. Retailer listings are mapped to it afterwards.'}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="product-form" loading={busy === 'save-product'} disabled={loading}>
            {editing ? 'Save changes' : 'Add product'}
          </Button>
        </>
      }
    >
      {loading ? (
        detail.isError ? <Notice tone="crit">{errorMessage(detail.error, 'The product could not be loaded.')}</Notice> : <LoadingBlock />
      ) : (
        <form id="product-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {error ? (
            <Notice tone="crit" title="Check the form">
              {error}
            </Notice>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Brand" required hint="Own or competitor ownership comes from the brand.">
              <Select value={form.brand_id} onChange={(e) => set('brand_id', e.target.value)} required>
                <option value="">Choose a brand…</option>
                {ownBrands.length ? (
                  <optgroup label="Own brands">
                    {ownBrands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {competitorBrands.length ? (
                  <optgroup label="Competitor brands">
                    {competitorBrands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </Select>
            </Field>
            <Field label="Product name" required>
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={200} placeholder="e.g. Herbal Toothpaste Clove 150g" required />
            </Field>
            <Field label="Category" required>
              <Select
                value={form.category_id}
                onChange={(e) => setForm((f) => ({ ...f, category_id: e.target.value, subcategory_id: '' }))}
                required
              >
                <option value="">Choose a category…</option>
                {tree.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Subcategory" hint={form.category_id && subcategories.length === 0 ? 'This category has no subcategories.' : undefined}>
              <Select value={form.subcategory_id} onChange={(e) => set('subcategory_id', e.target.value)} disabled={!form.category_id || subcategories.length === 0}>
                <option value="">None</option>
                {subcategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Product line" hint="Groups pack sizes of the same product.">
              <Input value={form.product_line} onChange={(e) => set('product_line', e.target.value)} maxLength={200} />
            </Field>
            {!archived ? (
              <Field label="Status">
                <Select value={form.status} onChange={(e) => set('status', e.target.value as FormState['status'])}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </Select>
              </Field>
            ) : (
              <Field label="Status" hint="Restore the product to change its status.">
                <Input value="Archived" disabled readOnly />
              </Field>
            )}
            <Field label="SKU" hint="Your internal article code.">
              <Input value={form.sku} onChange={(e) => set('sku', e.target.value)} maxLength={100} className="mono" />
            </Field>
            <Field label="Barcode / GTIN" hint="8 to 14 digits.">
              <Input value={form.gtin} onChange={(e) => set('gtin', e.target.value)} maxLength={40} inputMode="numeric" className="mono" />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Pack size" hint="Used for price per 100 ml / 100 g / unit.">
              <Input value={form.pack_size} onChange={(e) => set('pack_size', e.target.value)} inputMode="decimal" placeholder="200" />
            </Field>
            <Field label="Pack size unit">
              <Select value={form.pack_unit} onChange={(e) => set('pack_unit', e.target.value)}>
                <option value="">Not set</option>
                {PACK_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {PACK_UNIT_LABELS[u]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Units per pack" hint="2 for a twin pack.">
              <Input value={form.units_per_pack} onChange={(e) => set('units_per_pack', e.target.value)} inputMode="numeric" />
            </Field>
          </div>

          <Field label="Product image URL" hint="A link to an image (http or https).">
            <span className="flex items-center gap-2">
              <Input type="url" value={form.image_url} onChange={(e) => set('image_url', e.target.value)} placeholder="https://…" maxLength={1000} />
              <ImagePreview url={form.image_url.trim()} />
            </span>
          </Field>
          <Field label="Description">
            <Textarea value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={2000} rows={2} />
          </Field>

          <fieldset className="min-w-0">
            <legend className="mb-1.5 flex w-full items-center justify-between gap-3 text-[12px] font-medium text-ink-2">
              <span>Market availability</span>
              <span className="flex gap-3 font-normal">
                <button type="button" className="link" onClick={() => set('market_ids', markets.map((m) => m.id))}>
                  Select all
                </button>
                <button type="button" className="link" onClick={() => set('market_ids', [])}>
                  Clear
                </button>
              </span>
            </legend>
            {markets.length ? (
              <div className="rounded-lg border border-line bg-sunken px-3 py-2.5">
                <CheckList columns={3} value={form.market_ids} onChange={(next) => set('market_ids', next)} options={markets.map((m) => ({ value: m.id, label: m.name, hint: m.currency_code }))} />
              </div>
            ) : (
              <p className="text-[12.5px] text-ink-3">No markets are configured yet.</p>
            )}
          </fieldset>
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}
