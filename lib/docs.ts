import YAML from "yaml";
import { api } from "./api";
import type { Ctx, Field, Json, MarkdownDoc, Obj, Schema } from "./types";

// ---------- Reading and writing files ----------

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseMarkdown(text: string): MarkdownDoc {
  const m = FRONT.exec(text);
  if (!m) return { data: {}, body: text };
  const data = (YAML.parse(m[1]) ?? {}) as Obj;
  return { data, body: m[2] };
}

export function serializeMarkdown(doc: MarkdownDoc): string {
  const front = YAML.stringify(doc.data, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN", lineWidth: 0 });
  const body = doc.body.startsWith("\n") ? doc.body : `\n${doc.body}`;
  return `---\n${front}---\n${body.endsWith("\n") ? body : body + "\n"}`;
}

export const serializeJson = (data: Json) => JSON.stringify(data, null, 2) + "\n";

// ---------- New values ----------

/** The value a new field starts with. */
export function defaultFor(f: Field, ctx?: Ctx): Json | undefined {
  if (f.optional) return undefined;
  if (f.nullable) return null;
  switch (f.type) {
    case "number":
      return f.min ?? 0;
    case "boolean":
      return false;
    case "date":
      return new Date().toISOString().slice(0, 10);
    case "link":
      return { label: "", href: "/" };
    case "list":
      return [];
    case "object":
      return defaultsFor(f.fields ?? [], ctx);
    case "select": {
      const o = f.options?.[0];
      if (o !== undefined) return (typeof o === "object" ? o.value : o) as Json;
      const from = f.optionsFrom && ctx?.lookup?.(f.optionsFrom.file, f.optionsFrom.path);
      return Array.isArray(from) && from.length ? (from[0] as Json) : "";
    }
    case "reference":
      return ctx?.keys?.(f.collection!)?.[0] ?? "";
    default:
      return "";
  }
}

export function defaultsFor(fields: Field[], ctx?: Ctx): Obj {
  const o: Obj = {};
  for (const f of fields) {
    const v = defaultFor(f, ctx);
    if (v !== undefined) o[f.name] = v;
  }
  return o;
}

// ---------- Loaded documents, shared across editors ----------

export type Loaded = { path: string; sha: string | undefined; text: string };

/** Caches the parsed files an editor needs for choices and references. */
export class Store {
  files = new Map<string, Loaded>();
  folders = new Map<string, { name: string; path: string; sha: string }[]>();
  constructor(public schemas: Schema[]) {}

  async load(path: string, fresh = false): Promise<Loaded> {
    if (!fresh && this.files.has(path)) return this.files.get(path)!;
    const f = await api.file(path);
    const l = { path, sha: f.sha, text: f.text };
    this.files.set(path, l);
    return l;
  }
  async folder(dir: string, fresh = false) {
    if (!fresh && this.folders.has(dir)) return this.folders.get(dir)!;
    const { items } = await api.list(dir);
    const md = items.filter((i) => i.name.endsWith(".md"));
    this.folders.set(dir, md);
    return md;
  }
  forget(path: string) {
    this.files.delete(path);
  }

  /** Loads what the fields refer to: files holding choices, and referenced collections. */
  async prepare(fields: Field[]) {
    const files = new Set<string>();
    const folders = new Set<string>();
    const walk = (fs: Field[]) =>
      fs.forEach((f) => {
        if (f.optionsFrom) files.add(f.optionsFrom.file);
        if (f.type === "reference") {
          const s = this.schemas.find((x) => x.id === f.collection);
          if (s?.file) files.add(s.file);
          if (s?.folder) folders.add(s.folder);
        }
        if (f.fields) walk(f.fields);
        if (f.of) walk([f.of]);
      });
    walk(fields);
    await Promise.all([...[...files].map((p) => this.load(p)), ...[...folders].map((d) => this.folder(d))]);
  }

  ctx(): Ctx {
    return {
      lookup: (file, path) => {
        const l = this.files.get(file);
        if (!l) return undefined;
        return path.split(".").reduce<unknown>((v, k) => (v == null ? undefined : (v as Obj)[k]), JSON.parse(l.text));
      },
      keys: (id) => {
        const s = this.schemas.find((x) => x.id === id);
        if (!s) return [];
        if (s.kind === "list" && s.file && this.files.has(s.file)) {
          return (JSON.parse(this.files.get(s.file)!.text) as Obj[]).map((i) => String(i[s.item!.key]));
        }
        if (s.folder) return (this.folders.get(s.folder) ?? []).map((i) => i.name.replace(/\.md$/, ""));
        return [];
      },
    };
  }

  /** Readable labels for a referenced collection, e.g. service titles. */
  labels(id: string): Map<string, string> {
    const s = this.schemas.find((x) => x.id === id);
    const m = new Map<string, string>();
    if (s?.kind === "list" && s.file && this.files.has(s.file)) {
      for (const i of JSON.parse(this.files.get(s.file)!.text) as Obj[]) m.set(String(i[s.item!.key]), String(i[s.item!.title] ?? i[s.item!.key]));
    }
    return m;
  }
}

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
