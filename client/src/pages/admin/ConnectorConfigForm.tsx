/**
 * Connector configuration, rendered from the schema each connector publishes (GET /collection/connectors).
 * A new connector type therefore needs no change here. Anything the generic form cannot express can be
 * edited as JSON — both views work on the same object, so unknown keys are preserved.
 *
 * Credentials never live in this object: they are entered in the separate write-only credential field.
 */
import { useEffect, useMemo, useState } from 'react';
import { Braces, ChevronDown, ChevronRight, ListChecks, Plus, Wand2, X } from 'lucide-react';
import { Menu } from '@/components/ui/overlays.tsx';
import { Button, cn, Field, IconButton, Input, Notice, Select, Switch, Textarea } from '@/components/ui/primitives.tsx';
import type { ConnectorConfigField, ConnectorDescription, ConnectorExample } from '@shared/api/collection.ts';

export type ConfigObject = Record<string, unknown>;

export function getPath(obj: ConfigObject, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as ConfigObject)[part];
  }
  return current;
}

/** Immutable set; `undefined` removes the key and prunes parents that become empty. */
export function setPath(obj: ConfigObject, path: string, value: unknown): ConfigObject {
  const [head, ...rest] = path.split('.') as [string, ...string[]];
  const next: ConfigObject = { ...obj };
  if (rest.length === 0) {
    if (value === undefined) delete next[head];
    else next[head] = value;
    return next;
  }
  const child = next[head];
  const childObject = child !== null && typeof child === 'object' && !Array.isArray(child) ? (child as ConfigObject) : {};
  const updated = setPath(childObject, rest.join('.'), value);
  if (Object.keys(updated).length === 0) delete next[head];
  else next[head] = updated;
  return next;
}

/** Removes empty strings / lists / objects and trims list entries before a configuration is saved. */
export function cleanConfig(value: ConfigObject): ConfigObject {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      const items = input.map((item) => (typeof item === 'string' ? item.trim() : walk(item))).filter((item) => item !== '' && item !== undefined && item !== null);
      return items.length ? items : undefined;
    }
    if (input !== null && typeof input === 'object') {
      const out: ConfigObject = {};
      for (const [key, child] of Object.entries(input as ConfigObject)) {
        const cleaned = walk(child);
        if (cleaned !== undefined) out[key] = cleaned;
      }
      return Object.keys(out).length ? out : undefined;
    }
    if (typeof input === 'string') return input.trim() === '' ? undefined : input;
    return input === null ? undefined : input;
  };
  return (walk(value) as ConfigObject | undefined) ?? {};
}

function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

function KeyValueEditor({ value, onChange, disabled }: { value: unknown; onChange: (next: Record<string, string> | undefined) => void; disabled?: boolean }) {
  const external = useMemo(() => (value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')] as [string, string]) : []), [value]);
  const [rows, setRows] = useState<Array<[string, string]>>(external);
  // Re-sync when the object changes from outside (an example was applied, JSON was edited).
  useEffect(() => {
    setRows((prev) => {
      const prevObject = JSON.stringify(Object.fromEntries(prev.filter(([k]) => k.trim())));
      return prevObject === JSON.stringify(Object.fromEntries(external)) ? prev : external;
    });
  }, [external]);
  const commit = (next: Array<[string, string]>) => {
    setRows(next);
    const entries = next.filter(([k]) => k.trim());
    onChange(entries.length ? Object.fromEntries(entries.map(([k, v]) => [k.trim(), v])) : undefined);
  };
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([k, v], index) => (
        <div key={index} className="flex gap-1.5">
          <Input value={k} placeholder="Name" disabled={disabled} onChange={(e) => commit(rows.map((r, i) => (i === index ? [e.target.value, r[1]] : r)))} aria-label="Header name" />
          <Input value={v} placeholder="Value" disabled={disabled} onChange={(e) => commit(rows.map((r, i) => (i === index ? [r[0], e.target.value] : r)))} aria-label="Header value" />
          <IconButton icon={X} label="Remove" size="md" disabled={disabled} onClick={() => commit(rows.filter((_, i) => i !== index))} />
        </div>
      ))}
      <Button size="sm" icon={Plus} className="self-start" disabled={disabled} onClick={() => setRows([...rows, ['', '']])}>
        Add
      </Button>
    </div>
  );
}

function FieldControl({ field, config, onChange, disabled }: { field: ConnectorConfigField; config: ConfigObject; onChange: (next: ConfigObject) => void; disabled?: boolean }) {
  const raw = getPath(config, field.key);
  const set = (value: unknown) => onChange(setPath(config, field.key, value));
  const defaultText = field.default === undefined || field.default === null || typeof field.default === 'object' ? '' : String(field.default);
  const placeholder = field.placeholder ?? (defaultText ? `Default: ${defaultText}` : undefined);

  switch (field.type) {
    case 'boolean': {
      const on = raw === undefined ? field.default === true : raw === true;
      return (
        <div className="flex items-center gap-2.5 py-1">
          <Switch checked={on} onChange={(next) => set(next)} label={field.label} disabled={disabled} />
          <span className="text-[12.5px] text-ink-2">{on ? 'On' : 'Off'}</span>
        </div>
      );
    }
    case 'number':
      return (
        <Input
          type="number"
          inputMode="decimal"
          step="any"
          disabled={disabled}
          value={raw === undefined || raw === null ? '' : String(raw)}
          placeholder={placeholder}
          onChange={(e) => set(e.target.value === '' || !Number.isFinite(Number(e.target.value)) ? undefined : Number(e.target.value))}
        />
      );
    case 'select': {
      const value = raw === undefined || raw === null ? defaultText : String(raw);
      return (
        <Select value={value} disabled={disabled} onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)}>
          {!field.required && !defaultText ? <option value="">Not set</option> : null}
          {field.required && !defaultText && !value ? <option value="">Choose…</option> : null}
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    }
    case 'textarea':
      return <Textarea value={typeof raw === 'string' ? raw : ''} disabled={disabled} placeholder={placeholder} onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)} />;
    case 'key_value':
      return <KeyValueEditor value={raw} onChange={set} disabled={disabled} />;
    case 'string_list': {
      const list = Array.isArray(raw) ? raw.map(String) : Array.isArray(field.default) ? (field.default as unknown[]).map(String) : [];
      if (field.options?.length) {
        const ordered = [...list.filter((v) => field.options!.some((o) => o.value === v)), ...field.options.map((o) => o.value).filter((v) => !list.includes(v))];
        return (
          <ul className="flex flex-col gap-1.5 rounded-lg border border-line px-3 py-2.5">
            {ordered.map((value) => {
              const option = field.options!.find((o) => o.value === value)!;
              const on = list.includes(value);
              const position = list.indexOf(value);
              return (
                <li key={value} className="flex items-start gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    className="mt-[3px] size-3.5 accent-[var(--color-navy)]"
                    checked={on}
                    disabled={disabled}
                    aria-label={option.label}
                    onChange={(e) => set(e.target.checked ? [...list, value] : list.filter((v) => v !== value))}
                  />
                  <span className={cn('min-w-0 flex-1', on ? 'text-ink' : 'text-ink-3')}>
                    {on ? <span className="num mr-1.5 text-ink-3">{position + 1}.</span> : null}
                    {option.label}
                  </span>
                </li>
              );
            })}
          </ul>
        );
      }
      return (
        <Input
          value={Array.isArray(raw) ? raw.join(', ') : ''}
          disabled={disabled}
          placeholder={field.placeholder ?? 'Separate values with commas'}
          onChange={(e) => {
            const parts = e.target.value.split(',').map((p) => p.trimStart());
            const cleaned = parts.filter((p, i) => p.trim() !== '' || i === parts.length - 1);
            set(cleaned.some((p) => p.trim() !== '') ? cleaned : undefined);
          }}
          onBlur={() => {
            if (Array.isArray(raw)) {
              const trimmed = raw.map((p) => String(p).trim()).filter(Boolean);
              set(trimmed.length ? trimmed : undefined);
            }
          }}
        />
      );
    }
    default:
      return (
        <Input
          type={field.type === 'url' ? 'url' : 'text'}
          value={typeof raw === 'string' || typeof raw === 'number' ? String(raw) : ''}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => set(e.target.value === '' ? undefined : e.target.value)}
        />
      );
  }
}

export function ConnectorConfigForm({
  connector,
  value,
  onChange,
  disabled,
  onJsonValidity,
}: {
  connector: ConnectorDescription;
  value: ConfigObject;
  onChange: (next: ConfigObject) => void;
  disabled?: boolean;
  /** Reports whether the JSON editor currently holds valid JSON (saving is blocked while it does not). */
  onJsonValidity?: (valid: boolean) => void;
}) {
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [applied, setApplied] = useState<ConnectorExample | null>(null);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setApplied(null);
    setOpenGroups({});
    setJsonMode(false);
    setJsonError(null);
    onJsonValidity?.(true);
  }, [connector.method]); // eslint-disable-line react-hooks/exhaustive-deps

  const fieldDefault = (key: string) => connector.config_fields.find((f) => f.key === key)?.default;
  const visible = (field: ConnectorConfigField) => {
    if (!field.show_if) return true;
    const current = getPath(value, field.show_if.key) ?? fieldDefault(field.show_if.key);
    return field.show_if.in.includes(current);
  };
  const groups = useMemo(() => {
    const map = new Map<string, ConnectorConfigField[]>();
    for (const field of connector.config_fields) {
      const list = map.get(field.group);
      if (list) list.push(field);
      else map.set(field.group, [field]);
    }
    return [...map.entries()];
  }, [connector]);

  function toggleJson() {
    if (!jsonMode) {
      setJsonText(JSON.stringify(value, null, 2));
      setJsonError(null);
      setJsonMode(true);
    } else if (!jsonError) {
      setJsonMode(false);
    }
  }

  function editJson(text: string) {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text || '{}') as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The configuration must be a JSON object, e.g. { "mode": "bulk" }');
      setJsonError(null);
      onJsonValidity?.(true);
      onChange(parsed as ConfigObject);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'Invalid JSON');
      onJsonValidity?.(false);
    }
  }

  if (connector.config_fields.length === 0) {
    return (
      <Notice tone="info" title={connector.label}>
        <p>{connector.description}</p>
        <p className="mt-1">There is nothing to configure for this method.</p>
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-line bg-sunken px-3.5 py-3 text-[12.5px] leading-5 text-ink-2">
        <p className="font-medium text-ink">{connector.summary}</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="eyebrow mb-1">What it needs</div>
            <ul className="list-disc space-y-0.5 pl-4">
              {connector.requirements.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
          {connector.limitations.length ? (
            <div>
              <div className="eyebrow mb-1">Limitations</div>
              <ul className="list-disc space-y-0.5 pl-4">
                {connector.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {connector.examples.length ? (
          <Menu
            align="start"
            trigger={
              <Button size="sm" icon={Wand2} disabled={disabled}>
                Apply an example
              </Button>
            }
            items={connector.examples.map((example) => ({
              label: example.title,
              onSelect: () => {
                const config = JSON.parse(JSON.stringify(example.config)) as ConfigObject;
                onChange(config);
                setApplied(example);
                setJsonText(JSON.stringify(config, null, 2));
                setJsonError(null);
                onJsonValidity?.(true);
              },
            }))}
          />
        ) : null}
        <Button size="sm" icon={jsonMode ? ListChecks : Braces} onClick={toggleJson} disabled={disabled || (jsonMode && !!jsonError)}>
          {jsonMode ? 'Back to the form' : 'Edit as JSON'}
        </Button>
        <span className="text-[12px] text-ink-3">Credentials are entered separately below — never in this configuration.</span>
      </div>

      {applied ? (
        <Notice tone="info" title={`Example applied: ${applied.title}`}>
          <p>{applied.description} Replace the example URL and field names with those of your source.</p>
          {applied.notes?.length ? (
            <ul className="mt-1 list-disc pl-4">
              {applied.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}

      {jsonMode ? (
        <div>
          <Textarea
            value={jsonText}
            onChange={(e) => editJson(e.target.value)}
            rows={16}
            spellCheck={false}
            disabled={disabled}
            invalid={!!jsonError}
            className="mono !text-[12px] leading-[1.5]"
            aria-label="Connector configuration as JSON"
          />
          {jsonError ? <p className="mt-1 text-[12px] text-crit-ink">Not valid yet: {jsonError}</p> : <p className="mt-1 text-[12px] text-ink-3">Valid JSON object.</p>}
        </div>
      ) : (
        groups.map(([group, fields], index) => {
          const shown = fields.filter(visible);
          if (shown.length === 0) return null;
          const hasValue = fields.some((f) => isSet(getPath(value, f.key)));
          const hasRequired = fields.some((f) => f.required);
          const open = openGroups[group] ?? (index < 2 || hasValue || hasRequired);
          return (
            <section key={group} className="rounded-lg border border-line">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left"
                aria-expanded={open}
                onClick={() => setOpenGroups((prev) => ({ ...prev, [group]: !open }))}
              >
                <span className="eyebrow">{group}</span>
                <span className="flex items-center gap-2 text-[12px] text-ink-3">
                  {hasValue ? 'Configured' : hasRequired ? 'Required' : 'Optional'}
                  {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                </span>
              </button>
              {open ? (
                <div className="grid gap-3.5 border-t border-line px-3.5 py-3.5 sm:grid-cols-2">
                  {shown.map((field) => (
                    <Field
                      key={field.key}
                      label={field.label}
                      required={field.required}
                      hint={field.help}
                      className={cn((field.type === 'textarea' || field.type === 'key_value' || field.type === 'url' || (field.type === 'string_list' && field.options)) && 'sm:col-span-2')}
                    >
                      <FieldControl field={field} config={value} onChange={onChange} disabled={disabled} />
                    </Field>
                  ))}
                </div>
              ) : null}
            </section>
          );
        })
      )}
    </div>
  );
}
