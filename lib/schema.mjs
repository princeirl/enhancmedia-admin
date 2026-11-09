// Content schema — format 1.
//
// `content/_schema/*.json` describes every content file of this website. It is the contract
// between the website and the admin panel: the website's build validates every content file
// against it (scripts/check-content.mjs), and the admin builds its forms from it and validates
// with an identical copy of this file before saving.
//
// This module has no imports, so both sides can run it unchanged. The admin's copy must stay
// byte-identical; its `npm run check:schema` compares the two.

export const FORMAT = 1;

export const FIELD_TYPES = [
  "text", "textarea", "markdown", "url", "image", "number", "boolean", "date",
  "select", "reference", "link", "object", "list",
];

const IMAGE_EXT = /\.(png|jpe?g|webp|avif|gif|svg)$/i;
const SAFE_URL = /^(\/|#|https:\/\/|http:\/\/|mailto:|tel:)/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Reads a dotted path such as "categories" or "a.b" from parsed data. */
export function getPath(data, path) {
  return path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), data);
}

/** The values a select field accepts. `ctx.lookup(file, path)` resolves `optionsFrom`. */
export function selectOptions(field, ctx) {
  if (field.optionsFrom) {
    const list = ctx?.lookup?.(field.optionsFrom.file, field.optionsFrom.path);
    return Array.isArray(list) ? list.map((v) => ({ value: v, label: String(v) })) : [];
  }
  return (field.options ?? []).map((o) => (isObj(o) ? o : { value: o, label: String(o) }));
}

/**
 * Validates one value against one field.
 * @param {object} field  a schema field
 * @param {unknown} value
 * @param {string} at     a readable location for error messages
 * @param {object} ctx    { lookup(file, path), keys(collectionId) => string[], imageExists(path) => boolean }
 * @returns {string[]}    errors; empty when valid
 */
export function validateField(field, value, at, ctx = {}) {
  const errs = [];
  const err = (m) => errs.push(`${at}: ${m}`);

  if (value === null) {
    if (!field.nullable) err("is empty but must have a value");
    return errs;
  }
  if (value === undefined) {
    if (!field.optional) err("is missing");
    return errs;
  }

  switch (field.type) {
    case "text":
    case "textarea":
    case "markdown": {
      if (typeof value !== "string") { err("must be text"); break; }
      if (field.required && value.trim() === "") err("is required");
      if (field.max && value.length > field.max) err(`must be at most ${field.max} characters`);
      if (field.pattern && value !== "" && !new RegExp(field.pattern).test(value)) err("has the wrong format");
      break;
    }
    case "url": {
      if (typeof value !== "string") { err("must be a link"); break; }
      if (value === "") { if (field.required) err("is required"); break; }
      if (!SAFE_URL.test(value)) err("must start with /, https://, mailto: or tel:");
      break;
    }
    case "image": {
      if (typeof value !== "string") { err("must be an image path"); break; }
      if (value === "") { if (field.required) err("is required"); break; }
      if (!value.startsWith("/") || value.includes("..") || !IMAGE_EXT.test(value)) err("must be an image path such as /uploads/photo.jpg");
      else if (ctx.imageExists && !ctx.imageExists(value)) err(`image ${value} does not exist`);
      break;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) { err("must be a number"); break; }
      if (field.min !== undefined && value < field.min) err(`must be at least ${field.min}`);
      if (field.max !== undefined && value > field.max) err(`must be at most ${field.max}`);
      break;
    }
    case "boolean":
      if (typeof value !== "boolean") err("must be on or off");
      break;
    case "date":
      if (typeof value !== "string" || !DATE.test(value) || isNaN(Date.parse(value))) err("must be a date (YYYY-MM-DD)");
      break;
    case "select": {
      const opts = selectOptions(field, ctx);
      if (!opts.some((o) => o.value === value)) err(`must be one of: ${opts.map((o) => o.label).join(", ")}`);
      break;
    }
    case "reference": {
      if (typeof value !== "string") { err("must be a reference"); break; }
      const keys = ctx.keys ? ctx.keys(field.collection) : null;
      if (keys && !keys.includes(value)) err(`“${value}” is not in ${field.collection}`);
      break;
    }
    case "link": {
      if (!isObj(value)) { err("must be a link with a label"); break; }
      errs.push(...validateFields([
        { name: "label", type: "text", required: true },
        { name: "href", type: "url", required: true },
      ], value, at, ctx));
      break;
    }
    case "object": {
      if (!isObj(value)) { err("must be a group of fields"); break; }
      errs.push(...validateFields(field.fields, value, at, ctx));
      break;
    }
    case "list": {
      if (!Array.isArray(value)) { err("must be a list"); break; }
      if (field.min !== undefined && value.length < field.min) err(`needs at least ${field.min}`);
      if (field.max !== undefined && value.length > field.max) err(`allows at most ${field.max}`);
      value.forEach((v, i) => errs.push(...validateField(field.of, v, `${at}[${i + 1}]`, ctx)));
      break;
    }
    default:
      err(`unknown field type “${field.type}”`);
  }
  return errs;
}

/** Validates an object against a list of fields. Unknown keys are errors: content and schema never drift. */
export function validateFields(fields, data, at, ctx = {}) {
  const errs = [];
  const known = new Set(fields.map((f) => f.name));
  for (const f of fields) errs.push(...validateField(f, data[f.name], at ? `${at} › ${f.label ?? f.name}` : (f.label ?? f.name), ctx));
  for (const k of Object.keys(data)) if (!known.has(k)) errs.push(`${at || "file"}: “${k}” is not described in the schema`);
  return errs;
}

/**
 * Validates a whole document of a schema.
 *  - kind "object":          data is the parsed JSON object
 *  - kind "list":            data is the parsed JSON array
 *  - kind "markdown":        data is { data: front matter, body }
 *  - kind "markdown-folder": data is { slug, data: front matter, body } for one file
 */
export function validateDocument(schema, doc, ctx = {}) {
  const errs = [];
  switch (schema.kind) {
    case "object":
      if (!isObj(doc)) return ["the file must hold an object"];
      return validateFields(schema.fields, doc, "", ctx);
    case "list": {
      if (!Array.isArray(doc)) return ["the file must hold a list"];
      const seen = new Set();
      doc.forEach((item, i) => {
        const name = (isObj(item) && item[schema.item.title]) || `#${i + 1}`;
        if (!isObj(item)) { errs.push(`${schema.item.label} ${name}: must be a group of fields`); return; }
        errs.push(...validateFields(schema.item.fields, item, `${schema.item.label} “${name}”`, ctx));
        const key = item[schema.item.key];
        if (seen.has(key)) errs.push(`${schema.item.label} “${name}”: ${schema.item.key} “${key}” is used twice`);
        seen.add(key);
      });
      return errs;
    }
    case "markdown":
      errs.push(...validateFields(schema.fields, doc.data ?? {}, "", ctx));
      if (typeof doc.body !== "string") errs.push("the text is missing");
      return errs;
    case "markdown-folder":
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(doc.slug ?? "")) errs.push(`file name “${doc.slug}” must be lower-case words joined by hyphens`);
      errs.push(...validateFields(schema.item.fields, doc.data ?? {}, `${schema.item.label} “${doc.slug}”`, ctx));
      if (typeof doc.body !== "string") errs.push(`${schema.item.label} “${doc.slug}”: the text is missing`);
      return errs;
    default:
      return [`unknown schema kind “${schema.kind}”`];
  }
}

/** Checks a schema file itself. */
export function validateSchema(schema) {
  const errs = [];
  const at = `schema ${schema.id ?? "?"}`;
  if (schema.$format !== FORMAT) errs.push(`${at}: $format must be ${FORMAT}`);
  if (!/^[a-z0-9-]+$/.test(schema.id ?? "")) errs.push(`${at}: id must be lower-case words joined by hyphens`);
  if (!schema.label || !schema.group) errs.push(`${at}: label and group are required`);
  const checkFields = (fields, where) => {
    if (!Array.isArray(fields)) { errs.push(`${where}: fields must be a list`); return; }
    for (const f of fields) checkField(f, `${where} › ${f.name}`);
  };
  const checkField = (f, where) => {
    if (!FIELD_TYPES.includes(f.type)) errs.push(`${where}: unknown type “${f.type}”`);
    if (f.type === "object") checkFields(f.fields, where);
    if (f.type === "list") f.of ? checkField(f.of, `${where}[]`) : errs.push(`${where}: list needs “of”`);
    if (f.type === "select" && !f.options && !f.optionsFrom) errs.push(`${where}: select needs options`);
    if (f.type === "reference" && !f.collection) errs.push(`${where}: reference needs a collection`);
  };
  if (schema.kind === "object" || schema.kind === "markdown") {
    if (!schema.file) errs.push(`${at}: file is required`);
    checkFields(schema.fields, at);
  } else if (schema.kind === "list" || schema.kind === "markdown-folder") {
    if (schema.kind === "list" && !schema.file) errs.push(`${at}: file is required`);
    if (schema.kind === "markdown-folder" && !schema.folder) errs.push(`${at}: folder is required`);
    if (!schema.item?.fields || !schema.item.title || !schema.item.key) errs.push(`${at}: item needs fields, title and key`);
    else checkFields(schema.item.fields, at);
  } else errs.push(`${at}: kind must be object, list, markdown or markdown-folder`);
  return errs;
}
