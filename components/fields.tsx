"use client";

/**
 * One form control per schema field type. The forms are never written by hand: they are built
 * from the website's content/_schema/, so a new page or field on the website appears here by itself.
 */
import { useRef, useState } from "react";
import { api, rawUrl } from "@/lib/api";
import { defaultFor, type Store } from "@/lib/docs";
import { selectOptions } from "@/lib/schema.mjs";
import type { Field, Json, Obj } from "@/lib/types";

type Props = { field: Field; value: Json | undefined; onChange: (v: Json | undefined) => void; store: Store; id: string; showAdvanced?: boolean };

export function FieldsEditor({ fields, value, onChange, store, id, showAdvanced }: {
  fields: Field[];
  value: Obj;
  onChange: (v: Obj) => void;
  store: Store;
  id: string;
  showAdvanced?: boolean;
}) {
  return (
    <div className="space-y-5">
      {fields
        .filter((f) => showAdvanced || !f.advanced)
        .map((f) => (
          <FieldEditor
            key={f.name}
            id={`${id}-${f.name}`}
            field={f}
            value={value[f.name]}
            store={store}
            showAdvanced={showAdvanced}
            onChange={(v) => {
              const next = { ...value };
              if (v === undefined) delete next[f.name];
              else next[f.name] = v;
              onChange(next);
            }}
          />
        ))}
    </div>
  );
}

export function FieldEditor(props: Props) {
  const { field: f, value, onChange, store } = props;

  // Optional fields that are absent, and nullable fields that are empty, show an "Add" button.
  if (value === undefined && f.optional) {
    return (
      <Shell {...props}>
        <button type="button" className="btn" onClick={() => onChange(defaultFor({ ...f, optional: false, nullable: false }, store.ctx()) as Json)}>
          + Add {f.label.toLowerCase()}
        </button>
      </Shell>
    );
  }
  if (value === null && f.nullable) {
    return (
      <Shell {...props}>
        <div className="flex items-center gap-3">
          <span className="text-sm italic text-muted">Not set — hidden on the site</span>
          <button type="button" className="btn" onClick={() => onChange(defaultFor({ ...f, nullable: false }, store.ctx()) as Json)}>
            Set
          </button>
        </div>
      </Shell>
    );
  }
  const clear = f.nullable ? () => onChange(null) : f.optional ? () => onChange(undefined) : undefined;
  return (
    <Shell {...props} clear={clear}>
      <Control {...props} />
    </Shell>
  );
}

function Shell({ field: f, id, children, clear }: Props & { children: React.ReactNode; clear?: () => void }) {
  const group = f.type === "object" || f.type === "list";
  return (
    <div className={group ? "rounded-lg border border-line bg-white/60 p-4" : ""}>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label htmlFor={id} className={group ? "text-sm font-semibold text-ink" : "label"}>
          {f.label}
          {f.required && <span className="text-gold-ink"> *</span>}
        </label>
        {clear && (
          <button type="button" onClick={clear} className="text-xs text-muted underline-offset-2 hover:text-danger hover:underline">
            {f.nullable ? "Clear" : "Remove"}
          </button>
        )}
      </div>
      {f.help && <p className="help -mt-1 mb-2">{f.help}</p>}
      {children}
    </div>
  );
}

function Control({ field: f, value, onChange, store, id, showAdvanced }: Props) {
  switch (f.type) {
    case "text":
    case "url":
      return (
        <input
          id={id}
          className="input"
          value={String(value ?? "")}
          maxLength={f.max}
          inputMode={f.type === "url" ? "url" : undefined}
          placeholder={f.type === "url" ? "/page, https://…, mailto:…" : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "textarea":
      return <AutoArea id={id} value={String(value ?? "")} onChange={onChange} max={f.max} />;
    case "markdown":
      return <AutoArea id={id} value={String(value ?? "")} onChange={onChange} mono rows={14} />;
    case "number":
      return (
        <input
          id={id}
          type="number"
          className="input w-32"
          min={f.min}
          max={f.max}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? (f.min ?? 0) : Number(e.target.value))}
        />
      );
    case "boolean":
      return (
        <label className="inline-flex items-center gap-2 text-sm">
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-ink" />
          {value ? "On" : "Off"}
        </label>
      );
    case "date":
      return <input id={id} type="date" className="input w-48" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    case "select": {
      const opts = selectOptions(f, store.ctx());
      const idx = opts.findIndex((o) => o.value === value);
      return (
        <select id={id} className="input" value={idx} onChange={(e) => onChange(opts[Number(e.target.value)].value as Json)}>
          {idx === -1 && <option value={-1}>— choose —</option>}
          {opts.map((o, i) => (
            <option key={i} value={i}>{o.label}</option>
          ))}
        </select>
      );
    }
    case "reference": {
      const keys = store.ctx().keys?.(f.collection!) ?? [];
      const labels = store.labels(f.collection!);
      return (
        <select id={id} className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {!keys.includes(String(value)) && <option value={String(value ?? "")}>{value ? `${value} (missing)` : "— choose —"}</option>}
          {keys.map((k) => (
            <option key={k} value={k}>{labels.get(k) ?? k}</option>
          ))}
        </select>
      );
    }
    case "link": {
      const v = (value ?? { label: "", href: "/" }) as Obj;
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <input id={id} className="input" placeholder="Label" value={String(v.label ?? "")} onChange={(e) => onChange({ ...v, label: e.target.value })} />
          <input className="input" placeholder="/page or https://…" value={String(v.href ?? "")} onChange={(e) => onChange({ ...v, href: e.target.value })} aria-label={`${f.label} link`} />
        </div>
      );
    }
    case "image":
      return <ImageControl id={id} value={String(value ?? "")} onChange={onChange} />;
    case "object":
      return <FieldsEditor fields={f.fields ?? []} value={(value ?? {}) as Obj} onChange={onChange} store={store} id={id} showAdvanced={showAdvanced} />;
    case "list":
      return <ListControl field={f} value={(value ?? []) as Json[]} onChange={onChange} store={store} id={id} showAdvanced={showAdvanced} />;
    default:
      return <p className="text-sm text-danger">Unknown field type “{f.type}”. The admin needs an update for it.</p>;
  }
}

function AutoArea({ id, value, onChange, mono, rows = 3, max }: { id: string; value: string; onChange: (v: string) => void; mono?: boolean; rows?: number; max?: number }) {
  const lines = Math.min(30, Math.max(rows, value.split("\n").length + Math.floor(value.length / 90)));
  return (
    <textarea
      id={id}
      className={`input resize-y leading-relaxed ${mono ? "font-mono text-[0.85rem]" : ""}`}
      rows={lines}
      maxLength={max}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ImageControl({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const { path } = await api.upload(file);
      setBroken(false);
      onChange(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex h-28 w-40 items-center justify-center overflow-hidden rounded-md border border-line bg-[repeating-conic-gradient(#f1f0ec_0_25%,#fff_0_50%)] bg-[length:16px_16px]">
        {value && !broken ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={rawUrl(value)} alt="" className="max-h-full max-w-full object-contain" onError={() => setBroken(true)} />
        ) : (
          <span className="px-2 text-center text-xs text-muted">{value ? "Not found" : "No image"}</span>
        )}
      </div>
      <div className="min-w-[14rem] flex-1 space-y-2">
        <input id={id} className="input font-mono text-xs" value={value} placeholder="/uploads/…" onChange={(e) => { setBroken(false); onChange(e.target.value); }} />
        <div className="flex items-center gap-2">
          <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? "Uploading…" : value ? "Replace image" : "Upload image"}
          </button>
          <span className="text-xs text-muted">PNG, JPEG, WebP, AVIF, GIF or SVG, under 8 MB</span>
        </div>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/avif,image/gif,image/svg+xml" hidden onChange={(e) => pick(e.target.files?.[0])} />
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </div>
  );
}

function ListControl({ field: f, value, onChange, store, id, showAdvanced }: { field: Field; value: Json[]; onChange: (v: Json[]) => void; store: Store; id: string; showAdvanced?: boolean }) {
  const of = f.of!;
  const complex = of.type === "object";
  const [open, setOpen] = useState<number | null>(null);
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    if (open === i) setOpen(j);
  };
  const title = (v: Json, i: number) => {
    if (complex && f.itemTitle) return String((v as Obj)?.[f.itemTitle] || `${of.label} ${i + 1}`);
    if (of.type === "link") return String((v as Obj)?.label || `${of.label} ${i + 1}`);
    return `${of.label} ${i + 1}`;
  };
  return (
    <div className="space-y-2">
      {value.length === 0 && <p className="text-sm italic text-muted">None yet.</p>}
      {value.map((v, i) => (
        <div key={i} className="rounded-md border border-line bg-white">
          <div className="flex items-start gap-2 p-2">
            <span className="mt-2 w-6 shrink-0 text-right text-xs tabular-nums text-muted">{i + 1}</span>
            <div className="min-w-0 flex-1">
              {complex ? (
                <button type="button" className="w-full truncate py-1.5 text-left text-sm font-medium" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                  <span className="mr-2 text-gold-ink">{open === i ? "▾" : "▸"}</span>
                  {title(v, i)}
                </button>
              ) : (
                <Control field={{ ...of, label: `${f.label} ${i + 1}` }} value={v} store={store} id={`${id}-${i}`} showAdvanced={showAdvanced} onChange={(nv) => onChange(value.map((x, k) => (k === i ? (nv as Json) : x)))} />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1 pt-1">
              <IconBtn label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</IconBtn>
              <IconBtn label="Move down" onClick={() => move(i, 1)} disabled={i === value.length - 1}>↓</IconBtn>
              <IconBtn label="Remove" danger onClick={() => { if (confirm(`Remove “${title(v, i)}”?`)) { onChange(value.filter((_, k) => k !== i)); setOpen(null); } }}>✕</IconBtn>
            </div>
          </div>
          {complex && open === i && (
            <div className="border-t border-line p-4">
              <FieldsEditor fields={of.fields ?? []} value={(v ?? {}) as Obj} store={store} id={`${id}-${i}`} showAdvanced={showAdvanced} onChange={(nv) => onChange(value.map((x, k) => (k === i ? nv : x)))} />
            </div>
          )}
        </div>
      ))}
      {(f.max === undefined || value.length < f.max) && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            onChange([...value, defaultFor({ ...of, optional: false, nullable: false }, store.ctx()) as Json]);
            if (complex) setOpen(value.length);
          }}
        >
          + Add {of.label.toLowerCase()}
        </button>
      )}
    </div>
  );
}

function IconBtn({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`h-7 w-7 rounded text-sm text-muted transition-colors hover:bg-paper disabled:opacity-30 ${danger ? "hover:text-danger" : "hover:text-ink"}`}
    >
      {children}
    </button>
  );
}
