/** Checks an uploaded image by its bytes, not its name or the type the browser claims. */

export const MAX_UPLOAD = 8 * 1024 * 1024;

const sig = (b: Uint8Array, bytes: number[], at = 0) => bytes.every((x, i) => b[at + i] === x);

export function sniffImage(b: Uint8Array): { ext: string; type: string } | null {
  if (sig(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", type: "image/png" };
  if (sig(b, [0xff, 0xd8, 0xff])) return { ext: "jpg", type: "image/jpeg" };
  if (sig(b, [0x52, 0x49, 0x46, 0x46]) && sig(b, [0x57, 0x45, 0x42, 0x50], 8)) return { ext: "webp", type: "image/webp" };
  if (sig(b, [0x47, 0x49, 0x46, 0x38])) return { ext: "gif", type: "image/gif" };
  if (sig(b, [0x66, 0x74, 0x79, 0x70], 4) && /avi[fs]/.test(new TextDecoder().decode(b.subarray(8, 12)))) return { ext: "avif", type: "image/avif" };
  const head = new TextDecoder().decode(b.subarray(0, 1024)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return { ext: "svg", type: "image/svg+xml" };
  return null;
}

/**
 * An SVG can carry script. Logos are the only reason to accept SVG, and a logo needs none of
 * these, so any of them rejects the file outright rather than trying to clean it.
 */
export function unsafeSvg(text: string): string | null {
  const t = text.toLowerCase();
  const banned: [RegExp, string][] = [
    [/<script/, "a script"],
    [/\son[a-z]+\s*=/, "an event handler"],
    [/javascript:/, "a javascript: link"],
    [/<foreignobject/, "embedded HTML"],
    [/<iframe|<embed|<object/, "embedded content"],
    [/<!entity/, "an XML entity"],
    [/(href|src)\s*=\s*["']\s*(https?:|data:text)/, "an external reference"],
  ];
  for (const [re, what] of banned) if (re.test(t)) return what;
  return null;
}

export function safeName(name: string): string {
  const base = name.replace(/\.[^.]*$/, "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return base || "image";
}
