"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "@/lib/api";
import { defaultsFor, parseMarkdown, serializeJson, serializeMarkdown, slugify, type Store } from "@/lib/docs";
import { validateDocument } from "@/lib/schema.mjs";
import type { Json, MarkdownDoc, Obj, Schema } from "@/lib/types";
import { FieldEditor, FieldsEditor } from "./fields";

type Nav = (schemaId: string, item?: string | null) => void;
type Common = { schema: Schema; store: Store; nav: Nav; onSaved: () => void; previewUrl: string; setDirty: (d: boolean) => void };

export function Editor(props: Common & { item: string | null }) {
  const { schema, item } = props;
  if (schema.kind === "list") return item ? <ListItemEditor key={`${schema.id}/${item}`} {...props} item={item} /> : <CollectionList {...props} />;
  if (schema.kind === "markdown-folder") return item ? <FolderItemEditor key={`${schema.id}/${item}`} {...props} item={item} /> : <FolderList {...props} />;
  return <DocumentEditor key={schema.id} {...props} />;
}

// ---------- A single file: a page, settings, or a legal document ----------

function DocumentEditor({ schema, store, onSaved, previewUrl, setDirty }: Common) {
  const md = schema.kind === "markdown";
  const [loaded, setLoaded] = useState<{ sha?: string; value: Obj | MarkdownDoc } | null>(null);
  const [value, setValue] = useState<Obj | MarkdownDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      await store.prepare(schema.fields ?? []);
      const f = await store.load(schema.file!, true);
      const v = md ? parseMarkdown(f.text) : (JSON.parse(f.text) as Obj);
      setLoaded({ sha: f.sha, value: v });
      setValue(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load.");
    }
  }, [schema, store, md]);
  useEffect(() => void load(), [load]);

  const dirty = !!loaded && JSON.stringify(loaded.value) !== JSON.stringify(value);
  useEffect(() => setDirty(dirty), [dirty, setDirty]);

  if (error) return <Failure message={error} retry={load} />;
  if (!value || !loaded) return <Loading />;

  const save = async () => {
    const errs = validateDocument(schema, value, store.ctx());
    if (errs.length) return { errors: errs };
    const text = md ? serializeMarkdown(value as MarkdownDoc) : serializeJson(value as Json);
    const { sha } = await api.save(schema.file!, text, loaded.sha, `admin: edit ${schema.label}`);
    store.files.set(schema.file!, { path: schema.file!, sha, text });
    setLoaded({ sha, value });
    onSaved();
    return { errors: [] };
  };

  return (
    <Frame schema={schema} previewUrl={previewUrl} previewPath={schema.preview} dirty={dirty} onSave={save} onReset={() => setValue(loaded.value)} file={schema.file!}>
      {md ? (
        <div className="space-y-6">
          <FieldsEditor fields={schema.fields ?? []} value={(value as MarkdownDoc).data} store={store} id={schema.id} onChange={(data) => setValue({ ...(value as MarkdownDoc), data })} />
          <FieldEditor
            field={{ name: "body", label: schema.body?.label ?? "Text", type: "markdown", help: (schema.body?.help ?? "") + " Markdown: ## heading, **bold**, *italic*, - list, [link](/page)." }}
            value={(value as MarkdownDoc).body}
            store={store}
            id={`${schema.id}-body`}
            onChange={(body) => setValue({ ...(value as MarkdownDoc), body: String(body ?? "") })}
          />
        </div>
      ) : (
        <FieldsEditor fields={schema.fields ?? []} value={value as Obj} store={store} id={schema.id} onChange={setValue} showAdvanced />
      )}
    </Frame>
  );
}

// ---------- A collection kept in one JSON file: services, industries, team, work ----------

function CollectionList({ schema, store, nav, onSaved, previewUrl }: Common) {
  const it = schema.item!;
  const [data, setData] = useState<{ sha?: string; items: Obj[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      const f = await store.load(schema.file!, true);
      setData({ sha: f.sha, items: JSON.parse(f.text) as Obj[] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load.");
    }
  }, [schema, store]);
  useEffect(() => void load(), [load]);
  if (error) return <Failure message={error} retry={load} />;
  if (!data) return <Loading />;

  const write = async (items: Obj[], message: string) => {
    setBusy(true);
    try {
      const text = serializeJson(items as Json);
      const { sha } = await api.save(schema.file!, text, data.sha, message);
      store.files.set(schema.file!, { path: schema.file!, sha, text });
      setData({ sha, items });
      onSaved();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not save.");
      await load();
    } finally {
      setBusy(false);
    }
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= data.items.length) return;
    const items = [...data.items];
    [items[i], items[j]] = [items[j], items[i]];
    void write(items, `admin: reorder ${schema.label}`);
  };

  return (
    <div>
      <Header schema={schema} previewUrl={previewUrl} previewPath={schema.preview?.includes("{") ? undefined : schema.preview}>
        <button className="btn-primary" onClick={() => nav(schema.id, "new")} disabled={busy}>+ New {it.label.toLowerCase()}</button>
      </Header>
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-white">
        {data.items.map((item, i) => (
          <li key={String(item[it.key])} className="flex items-center gap-3 px-4 py-3">
            <span className="w-6 text-right text-xs tabular-nums text-muted">{i + 1}</span>
            <button className="min-w-0 flex-1 truncate text-left font-medium hover:text-gold-ink" onClick={() => nav(schema.id, String(item[it.key]))}>
              {String(item[it.title] || item[it.key])}
            </button>
            {"status" in item && <StatusPill status={String(item.status)} />}
            <button className="btn h-7 w-7 px-0" aria-label="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)}>↑</button>
            <button className="btn h-7 w-7 px-0" aria-label="Move down" disabled={busy || i === data.items.length - 1} onClick={() => move(i, 1)}>↓</button>
          </li>
        ))}
        {data.items.length === 0 && <li className="px-4 py-6 text-sm italic text-muted">None yet.</li>}
      </ul>
      <p className="help mt-3">The order here is the order on the website.</p>
    </div>
  );
}

function ListItemEditor({ schema, store, nav, onSaved, previewUrl, setDirty, item }: Common & { item: string }) {
  const it = schema.item!;
  const isNew = item === "new";
  const [state, setState] = useState<{ sha?: string; items: Obj[]; index: number; original: Obj } | null>(null);
  const [value, setValue] = useState<Obj | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      await store.prepare(it.fields);
      const f = await store.load(schema.file!, true);
      const items = JSON.parse(f.text) as Obj[];
      const index = isNew ? items.length : items.findIndex((x) => String(x[it.key]) === item);
      if (index < 0) throw new Error(`${it.label} “${item}” no longer exists.`);
      const original = isNew ? defaultsFor(it.fields, store.ctx()) : items[index];
      setState({ sha: f.sha, items, index, original });
      setValue(original);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load.");
    }
  }, [schema, store, it, item, isNew]);
  useEffect(() => void load(), [load]);

  const dirty = !!state && JSON.stringify(state.original) !== JSON.stringify(value);
  useEffect(() => setDirty(dirty || isNew), [dirty, isNew, setDirty]);

  if (error) return <Failure message={error} retry={load} back={() => nav(schema.id)} />;
  if (!state || !value) return <Loading />;

  const key = String(value[it.key] ?? "");
  const save = async () => {
    const items = [...state.items];
    items[state.index] = value;
    const errs = validateDocument(schema, items, store.ctx());
    if (errs.length) return { errors: errs };
    const text = serializeJson(items as Json);
    const { sha } = await api.save(schema.file!, text, state.sha, `admin: ${isNew ? "add" : "edit"} ${it.label.toLowerCase()} “${String(value[it.title])}”`);
    store.files.set(schema.file!, { path: schema.file!, sha, text });
    setState({ ...state, sha, items, original: value });
    onSaved();
    if (isNew || key !== item) nav(schema.id, key);
    return { errors: [] };
  };
  const remove = async () => {
    if (!confirm(`Delete “${String(value[it.title])}”? Its page will disappear from the website when you publish.`)) return;
    const items = state.items.filter((_, i) => i !== state.index);
    const errs = validateDocument(schema, items, store.ctx());
    if (errs.length) return alert(errs.join("\n"));
    await api.save(schema.file!, serializeJson(items as Json), state.sha, `admin: delete ${it.label.toLowerCase()} “${String(value[it.title])}”`);
    setDirty(false);
    onSaved();
    nav(schema.id);
  };

  return (
    <Frame
      schema={schema}
      title={isNew ? `New ${it.label.toLowerCase()}` : String(value[it.title] || key)}
      back={() => nav(schema.id)}
      previewUrl={previewUrl}
      previewPath={!isNew && schema.preview ? schema.preview.replace("{slug}", item) : undefined}
      dirty={dirty || isNew}
      onSave={save}
      onReset={() => setValue(state.original)}
      onDelete={isNew ? undefined : remove}
      file={schema.file!}
    >
      <SlugHelper value={value} setValue={setValue} keyField={it.key} titleField={it.title} isNew={isNew} />
      <FieldsEditor fields={it.fields} value={value} store={store} id={`${schema.id}-${key || "new"}`} onChange={setValue} />
    </Frame>
  );
}

// ---------- A folder of Markdown files: insights articles ----------

function FolderList({ schema, store, nav, previewUrl }: Common) {
  const [items, setItems] = useState<{ name: string; path: string; sha: string; title?: string; status?: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await store.folder(schema.folder!, true);
      const full = await Promise.all(
        list.map(async (i) => {
          const f = await store.load(i.path, true);
          const { data } = parseMarkdown(f.text);
          return { ...i, title: String(data[schema.item!.title] ?? i.name), status: data.status ? String(data.status) : undefined, date: String(data.date ?? "") };
        }),
      );
      setItems(full.sort((a, b) => (a.date < b.date ? 1 : -1)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load.");
    }
  }, [schema, store]);
  useEffect(() => void load(), [load]);
  if (error) return <Failure message={error} retry={load} />;
  if (!items) return <Loading />;
  return (
    <div>
      <Header schema={schema} previewUrl={previewUrl} previewPath={schema.preview?.includes("{") ? undefined : schema.preview}>
        <button className="btn-primary" onClick={() => nav(schema.id, "new")}>+ New {schema.item!.label.toLowerCase()}</button>
      </Header>
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-white">
        {items.map((i) => (
          <li key={i.path} className="flex items-center gap-3 px-4 py-3">
            <button className="min-w-0 flex-1 truncate text-left font-medium hover:text-gold-ink" onClick={() => nav(schema.id, i.name.replace(/\.md$/, ""))}>
              {i.title}
            </button>
            {i.status && <StatusPill status={i.status} />}
          </li>
        ))}
        {items.length === 0 && <li className="px-4 py-6 text-sm italic text-muted">None yet.</li>}
      </ul>
    </div>
  );
}

function FolderItemEditor({ schema, store, nav, onSaved, previewUrl, setDirty, item }: Common & { item: string }) {
  const it = schema.item!;
  const isNew = item === "new";
  const [state, setState] = useState<{ sha?: string; original: MarkdownDoc & { slug: string } } | null>(null);
  const [value, setValue] = useState<(MarkdownDoc & { slug: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      await store.prepare(it.fields);
      if (isNew) {
        const original = { slug: "", data: defaultsFor(it.fields, store.ctx()), body: "\nWrite the article here.\n" };
        setState({ original });
        setValue(original);
      } else {
        const f = await store.load(`${schema.folder}/${item}.md`, true);
        const original = { slug: item, ...parseMarkdown(f.text) };
        setState({ sha: f.sha, original });
        setValue(original);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load.");
    }
  }, [schema, store, it, item, isNew]);
  useEffect(() => void load(), [load]);

  const dirty = !!state && JSON.stringify(state.original) !== JSON.stringify(value);
  useEffect(() => setDirty(dirty || isNew), [dirty, isNew, setDirty]);
  if (error) return <Failure message={error} retry={load} back={() => nav(schema.id)} />;
  if (!state || !value) return <Loading />;

  const path = `${schema.folder}/${value.slug}.md`;
  const save = async () => {
    const errs = validateDocument(schema, value, store.ctx());
    if (errs.length) return { errors: errs };
    if (isNew && (await store.folder(schema.folder!, true)).some((f) => f.name === `${value.slug}.md`)) {
      return { errors: [`An ${it.label.toLowerCase()} with the address “${value.slug}” already exists.`] };
    }
    const text = serializeMarkdown(value);
    const { sha } = await api.save(path, text, isNew ? undefined : state.sha, `admin: ${isNew ? "add" : "edit"} ${it.label.toLowerCase()} “${String(value.data[it.title])}”`);
    store.files.set(path, { path, sha, text });
    setState({ sha, original: value });
    onSaved();
    if (isNew) nav(schema.id, value.slug);
    return { errors: [] };
  };
  const remove = async () => {
    if (!confirm(`Delete “${String(value.data[it.title])}”? It will disappear from the website when you publish.`)) return;
    await api.remove(`${schema.folder}/${item}.md`, state.sha!);
    setDirty(false);
    onSaved();
    nav(schema.id);
  };

  return (
    <Frame
      schema={schema}
      title={isNew ? `New ${it.label.toLowerCase()}` : String(value.data[it.title] || item)}
      back={() => nav(schema.id)}
      previewUrl={previewUrl}
      previewPath={!isNew && schema.preview ? schema.preview.replace("{slug}", item) : undefined}
      dirty={dirty || isNew}
      onSave={save}
      onReset={() => setValue(state.original)}
      onDelete={isNew ? undefined : remove}
      file={isNew ? undefined : path}
    >
      <div className="space-y-6">
        {isNew ? (
          <div>
            <label className="label" htmlFor="slug">Address (slug) <span className="text-gold-ink">*</span></label>
            <p className="help -mt-0.5 mb-2">The page will be at {schema.preview?.replace("{slug}", value.slug || "…")}. Lower-case words joined by hyphens; it cannot be changed later.</p>
            <div className="flex gap-2">
              <input id="slug" className="input font-mono text-sm" value={value.slug} onChange={(e) => setValue({ ...value, slug: e.target.value })} />
              <button type="button" className="btn shrink-0" onClick={() => setValue({ ...value, slug: slugify(String(value.data[it.title] ?? "")) })}>From title</button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">Address: <code className="font-mono">{schema.preview?.replace("{slug}", item)}</code></p>
        )}
        <FieldsEditor fields={it.fields} value={value.data} store={store} id={`${schema.id}-${value.slug || "new"}`} onChange={(data) => setValue({ ...value, data })} />
        <FieldEditor
          field={{ name: "body", label: schema.body?.label ?? "Text", type: "markdown", help: "Markdown: ## heading, **bold**, *italic*, - list, [link](/page)." }}
          value={value.body}
          store={store}
          id={`${schema.id}-body`}
          onChange={(body) => setValue({ ...value, body: String(body ?? "") })}
        />
      </div>
    </Frame>
  );
}

// ---------- Shared pieces ----------

function SlugHelper({ value, setValue, keyField, titleField, isNew }: { value: Obj; setValue: (v: Obj) => void; keyField: string; titleField: string; isNew: boolean }) {
  if (!isNew) return null;
  return (
    <div className="mb-6 flex items-center justify-between gap-3 rounded-md border border-dashed border-gold bg-[#fbf6ee] px-4 py-3 text-sm">
      <span>Fill in the name first, then make the address from it.</span>
      <button type="button" className="btn shrink-0" onClick={() => setValue({ ...value, [keyField]: slugify(String(value[titleField] ?? "")) })}>Address from name</button>
    </div>
  );
}

function Header({ schema, title, back, previewUrl, previewPath, children }: { schema: Schema; title?: string; back?: () => void; previewUrl: string; previewPath?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6">
      {back && (
        <button onClick={back} className="mb-2 text-sm text-muted hover:text-ink">← {schema.label}</button>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-ink">{schema.group}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title ?? schema.label}</h1>
        </div>
        <div className="flex items-center gap-2">
          {previewPath && previewUrl && (
            <a className="btn" href={`${previewUrl}${previewPath}`} target="_blank" rel="noopener noreferrer">View on preview ↗</a>
          )}
          {children}
        </div>
      </div>
      {schema.help && !back && <p className="mt-3 max-w-2xl text-sm text-muted">{schema.help}</p>}
    </div>
  );
}

function Frame({
  schema, title, back, previewUrl, previewPath, dirty, onSave, onReset, onDelete, file, children,
}: {
  schema: Schema; title?: string; back?: () => void; previewUrl: string; previewPath?: string; dirty: boolean;
  onSave: () => Promise<{ errors: string[] }>; onReset: () => void; onDelete?: () => Promise<void>; file?: string; children: React.ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const save = async () => {
    setSaving(true);
    setMessage(null);
    setConflict(false);
    try {
      const r = await onSave();
      setErrors(r.errors);
      if (!r.errors.length) setMessage("Saved to the draft. It will be on the preview in a minute or two.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      setErrors([e instanceof Error ? e.message : "Could not save."]);
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty && !saving) void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div>
      <Header schema={schema} title={title} back={back} previewUrl={previewUrl} previewPath={previewPath} />
      <div className="max-w-3xl">{children}</div>
      <div className="sticky bottom-0 -mx-4 mt-10 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur md:-mx-8 md:px-8">
        {errors.length > 0 && (
          <div role="alert" className="mb-3 max-h-48 overflow-auto rounded-md border-l-2 border-danger bg-[#fbf1f1] px-4 py-3 text-sm text-[#7a1f1f]">
            <p className="font-semibold">{conflict ? "Someone else saved this in the meantime." : "Please fix these before saving:"}</p>
            <ul className="mt-1 list-disc pl-5">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            {conflict && <button className="btn mt-2" onClick={() => location.reload()}>Reload (your unsaved changes will be lost)</button>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn-primary" disabled={!dirty || saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
          <button className="btn" disabled={!dirty || saving} onClick={() => { onReset(); setErrors([]); }}>Undo changes</button>
          {message && !dirty && <span className="text-sm text-ok">{message}</span>}
          {dirty && <span className="text-sm text-muted">Unsaved changes · Ctrl+S</span>}
          <span className="flex-1" />
          {file && <HistoryButton file={file} />}
          {onDelete && <button className="btn-danger" disabled={saving} onClick={() => void onDelete()}>Delete</button>}
        </div>
      </div>
    </div>
  );
}

function HistoryButton({ file }: { file: string }) {
  const [open, setOpen] = useState(false);
  const [commits, setCommits] = useState<{ sha: string; message: string; author: string; date: string }[] | null>(null);
  useEffect(() => {
    if (open && !commits) api.history(file).then((r) => setCommits(r.commits)).catch(() => setCommits([]));
  }, [open, commits, file]);
  return (
    <div className="relative">
      <button className="btn" onClick={() => setOpen(!open)} aria-expanded={open}>History</button>
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-[26rem] max-w-[90vw] rounded-lg border border-line bg-white p-3 shadow-lg">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted">Recent changes to this file</p>
          {!commits ? <p className="text-sm text-muted">Loading…</p> : (
            <ul className="max-h-72 space-y-2 overflow-auto text-sm">
              {commits.map((c) => (
                <li key={c.sha} className="border-b border-line pb-2 last:border-0">
                  <p className="font-medium">{c.message}</p>
                  <p className="text-xs text-muted">{c.author} · {new Date(c.date).toLocaleString()}</p>
                </li>
              ))}
              {commits.length === 0 && <li className="text-muted">No history.</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const pub = status === "published";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide ${pub ? "bg-[#e7f1e9] text-ok" : "bg-[#f4efe6] text-gold-ink"}`}>
      {pub ? "Published" : "Draft"}
    </span>
  );
}

export function Loading() {
  return <p className="py-10 text-sm text-muted">Loading…</p>;
}

function Failure({ message, retry, back }: { message: string; retry: () => void; back?: () => void }) {
  return (
    <div className="rounded-md border-l-2 border-danger bg-[#fbf1f1] px-4 py-3 text-sm text-[#7a1f1f]">
      <p>{message}</p>
      <div className="mt-2 flex gap-2">
        <button className="btn" onClick={retry}>Try again</button>
        {back && <button className="btn" onClick={back}>Back</button>}
      </div>
    </div>
  );
}

export const useSorted = (schemas: Schema[]) =>
  useMemo(() => {
    const order = ["Pages", "Collections", "Settings", "Legal"];
    const groups = new Map<string, Schema[]>();
    for (const s of [...schemas].sort((a, b) => a.order - b.order)) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
    return [...groups.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]), ib = order.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a[0].localeCompare(b[0]);
    });
  }, [schemas]);
