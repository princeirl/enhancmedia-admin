/** The content schema, format 1 — see lib/schema.mjs and the website's content/_schema/. */
export type FieldType =
  | "text" | "textarea" | "markdown" | "url" | "image" | "number" | "boolean" | "date"
  | "select" | "reference" | "link" | "object" | "list";

export type Field = {
  name: string;
  label: string;
  type: FieldType;
  help?: string;
  required?: boolean;
  nullable?: boolean;
  optional?: boolean;
  advanced?: boolean;
  max?: number;
  min?: number;
  pattern?: string;
  options?: ({ value: unknown; label: string } | string)[];
  optionsFrom?: { file: string; path: string };
  collection?: string;
  fields?: Field[];
  of?: Field;
  itemTitle?: string;
};

export type Item = { label: string; title: string; key: string; fields: Field[] };

export type Schema = {
  $format: number;
  id: string;
  label: string;
  group: string;
  order: number;
  kind: "object" | "list" | "markdown" | "markdown-folder";
  file?: string;
  folder?: string;
  preview?: string;
  help?: string;
  fields?: Field[];
  item?: Item;
  body?: { label: string; help?: string };
};

export type Ctx = {
  lookup?: (file: string, path: string) => unknown;
  keys?: (collection: string) => string[];
  imageExists?: (path: string) => boolean;
};

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Obj = { [k: string]: Json };
export type MarkdownDoc = { data: Obj; body: string };
