/** Product detail → pack variants (twin packs, bonus packs…) and market availability. */
import { useEffect, useState, type FormEvent } from 'react';
import { Boxes, Ellipsis, Globe, Pencil, Plus, Trash2 } from 'lucide-react';
import { apiDelete, apiPatch, apiPost, apiPut } from '@/lib/api.ts';
import { useCan } from '@/lib/auth.tsx';
import { fmtNumber } from '@/lib/format.ts';
import { useReference } from '@/lib/hooks.ts';
import { ConfirmDialog, Dialog, Menu } from '@/components/ui/overlays.tsx';
import { Badge, Button, Card, CardHeader, Field, IconButton, Input, Notice, Select, Switch, Textarea } from '@/components/ui/primitives.tsx';
import { PACK_UNITS } from '@shared/constants.ts';
import type { ProductDetail, VariantRow } from '@shared/api/catalogue.ts';
import { CheckList, errorMessage, PACK_UNIT_LABELS, parseNumber, useCatalogueActions } from './shared.tsx';

function VariantDialog({ open, onClose, productId, variant }: { open: boolean; onClose: () => void; productId: number; variant: VariantRow | null }) {
  const { run, busy } = useCatalogueActions();
  const [name, setName] = useState('');
  const [packSize, setPackSize] = useState('');
  const [packUnit, setPackUnit] = useState('ml');
  const [units, setUnits] = useState('1');
  const [gtin, setGtin] = useState('');
  const [notes, setNotes] = useState('');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(variant?.name ?? '');
    setPackSize(variant ? String(variant.pack_size) : '');
    setPackUnit(variant?.pack_unit ?? 'ml');
    setUnits(String(variant?.units_per_pack ?? 1));
    setGtin(variant?.gtin ?? '');
    setNotes(variant?.notes ?? '');
    setActive(variant ? variant.is_active === 1 : true);
    setError(null);
  }, [open, variant]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const size = parseNumber(packSize);
    const count = parseNumber(units);
    if (!name.trim()) return setError('Give the variant a name, for example “Twin pack 2 × 200ml”.');
    if (size === null || !Number.isFinite(size) || size <= 0) return setError('Pack size must be a number greater than zero.');
    if (count !== null && (!Number.isInteger(count) || count < 1)) return setError('Units per pack must be a whole number of at least 1.');
    setError(null);
    const body = { name: name.trim(), pack_size: size, pack_unit: packUnit, units_per_pack: count ?? 1, gtin, notes, is_active: active };
    const outcome = await run(
      'save-variant',
      () => (variant ? apiPatch<VariantRow>(`/variants/${variant.id}`, body) : apiPost<VariantRow>(`/products/${productId}/variants`, body)),
      { success: (v) => (variant ? `${v.name} updated` : `Pack variant ${v.name} added`), quietError: true },
    );
    if (outcome.ok) onClose();
    else setError(errorMessage(outcome.error, 'The pack variant could not be saved.'));
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={variant ? 'Edit pack variant' : 'Add pack variant'}
      description="Another pack of the same product that a retailer sells as its own listing."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="variant-form" loading={busy === 'save-variant'}>
            {variant ? 'Save changes' : 'Add variant'}
          </Button>
        </>
      }
    >
      <form id="variant-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {error ? <Notice tone="crit">{error}</Notice> : null}
        <Field label="Variant name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Twin pack 2 × 200ml" required autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Pack size" required>
            <Input value={packSize} onChange={(e) => setPackSize(e.target.value)} inputMode="decimal" placeholder="200" required />
          </Field>
          <Field label="Unit" required>
            <Select value={packUnit} onChange={(e) => setPackUnit(e.target.value)}>
              {PACK_UNITS.map((u) => (
                <option key={u} value={u}>
                  {PACK_UNIT_LABELS[u]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Units per pack">
            <Input value={units} onChange={(e) => setUnits(e.target.value)} inputMode="numeric" />
          </Field>
        </div>
        <Field label="Barcode / GTIN" hint="If the variant has its own barcode (8 to 14 digits).">
          <Input value={gtin} onChange={(e) => setGtin(e.target.value)} maxLength={40} inputMode="numeric" className="mono" />
        </Field>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} />
        </Field>
        {variant ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-ink-2">
              <span className="block font-medium text-ink">Active</span>
              Inactive variants can no longer be chosen for new listings.
            </span>
            <Switch checked={active} onChange={setActive} label="Variant is active" />
          </div>
        ) : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function ProductVariants({ detail }: { detail: ProductDetail }) {
  const canWrite = useCan('catalogue.write');
  const { run, busy } = useCatalogueActions();
  const [dialog, setDialog] = useState<{ open: boolean; variant: VariantRow | null }>({ open: false, variant: null });
  const [remove, setRemove] = useState<VariantRow | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const { product, variants } = detail;
  return (
    <Card>
      <CardHeader
        title="Pack variants"
        subtitle="A variant changes the content used for unit prices (price per 100 ml, 100 g or unit) of the listings that sell it."
        actions={
          canWrite ? (
            <Button size="sm" icon={Plus} onClick={() => setDialog({ open: true, variant: null })}>
              Add variant
            </Button>
          ) : undefined
        }
      />
      <ul>
        <li className="flex items-center justify-between gap-3 px-4 py-2.5">
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-ink">Standard pack</span>
            <span className="block text-[11.5px] leading-4 text-ink-3">The product's own pack. Used by listings without a variant.</span>
          </span>
          <span className="num shrink-0 text-[13px] font-semibold text-ink">{product.pack_label}</span>
        </li>
        {variants.map((v) => (
          <li key={v.id} className="flex items-start justify-between gap-3 border-t border-line px-4 py-2.5">
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] font-medium text-ink">{v.name}</span>
                {!v.is_active ? <Badge tone="neutral">Inactive</Badge> : null}
              </span>
              <span className="block text-[11.5px] leading-4 text-ink-3">
                {[`${fmtNumber(v.listing_count)} listing${v.listing_count === 1 ? '' : 's'}`, v.gtin ? `barcode ${v.gtin}` : null, v.notes].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="num text-[13px] font-semibold text-ink">{v.pack_label}</span>
              {canWrite ? (
                <Menu
                  trigger={<IconButton icon={Ellipsis} label={`Actions for ${v.name}`} size="sm" />}
                  items={[
                    { label: 'Edit', icon: Pencil, onSelect: () => setDialog({ open: true, variant: v }) },
                    {
                      label: 'Delete…',
                      icon: Trash2,
                      danger: true,
                      separatorBefore: true,
                      onSelect: () => {
                        setRemoveError(null);
                        setRemove(v);
                      },
                    },
                  ]}
                />
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {variants.length === 0 ? (
        <p className="flex items-start gap-2 border-t border-line px-4 py-2.5 text-[12px] leading-5 text-ink-3">
          <Boxes className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          No other packs. Add a variant when a retailer sells a twin pack, bonus pack or promotional size of this product.
        </p>
      ) : null}

      <VariantDialog open={dialog.open} variant={dialog.variant} productId={product.id} onClose={() => setDialog((d) => ({ ...d, open: false }))} />
      <ConfirmDialog
        open={remove !== null}
        onClose={() => setRemove(null)}
        title="Delete this pack variant?"
        confirmLabel="Delete variant"
        danger
        loading={busy === 'delete-variant'}
        onConfirm={async () => {
          if (!remove) return;
          const outcome = await run('delete-variant', () => apiDelete(`/variants/${remove.id}`), { success: `${remove.name} deleted`, quietError: true });
          if (outcome.ok) setRemove(null);
          else setRemoveError(errorMessage(outcome.error, 'The variant could not be deleted.'));
        }}
      >
        <p>
          <strong className="font-semibold text-ink">{remove?.name}</strong> will be removed. A variant that is used by a retailer listing cannot be deleted.
        </p>
        {removeError ? (
          <Notice tone="crit" className="mt-3" title="Not deleted">
            {removeError}
          </Notice>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}

export function ProductMarkets({ detail }: { detail: ProductDetail }) {
  const canWrite = useCan('catalogue.write');
  const { ref } = useReference();
  const { run, busy } = useCatalogueActions();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  useEffect(() => {
    if (open) setSelected(detail.market_ids);
  }, [open, detail.market_ids]);
  const markets = ref?.markets ?? [];
  // markets where the product has a listing, to show where "available" and "listed" disagree
  const listedIn = new Set(detail.listings.map((l) => l.market_id));
  return (
    <Card>
      <CardHeader
        title="Market availability"
        subtitle="Markets this product is sold in."
        actions={
          canWrite ? (
            <Button size="sm" icon={Pencil} onClick={() => setOpen(true)}>
              Edit
            </Button>
          ) : undefined
        }
      />
      <div className="px-4 py-3">
        {detail.markets.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {detail.markets.map((m) => (
              <li key={m.id}>
                <Badge tone={listedIn.has(m.id) ? 'accent' : 'outline'} title={listedIn.has(m.id) ? 'Has at least one retailer listing in this market' : 'Available, but no retailer listing is configured in this market yet'}>
                  {m.name}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-[12.5px] text-ink-3">
            <Globe className="size-3.5" aria-hidden /> No market assigned yet.
          </p>
        )}
        {detail.markets.some((m) => !listedIn.has(m.id)) ? <p className="mt-2 text-[11.5px] leading-4 text-ink-3">Outlined markets have no retailer listing for this product yet.</p> : null}
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Market availability"
        description={detail.product.name}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy === 'save-markets'}
              onClick={async () => {
                const outcome = await run('save-markets', () => apiPut<ProductDetail>(`/products/${detail.product.id}/markets`, { market_ids: selected }), {
                  success: `Available in ${fmtNumber(selected.length)} market${selected.length === 1 ? '' : 's'}`,
                });
                if (outcome.ok) setOpen(false);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="mb-3 flex gap-3 text-[12.5px]">
          <button type="button" className="link" onClick={() => setSelected(markets.map((m) => m.id))}>
            Select all
          </button>
          <button type="button" className="link" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
        <CheckList value={selected} onChange={setSelected} options={markets.map((m) => ({ value: m.id, label: m.name, hint: `${m.currency_code}${m.is_active ? '' : ' · inactive'}` }))} />
      </Dialog>
    </Card>
  );
}
