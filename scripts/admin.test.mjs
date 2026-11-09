// Unit tests for the parts that guard what reaches the repository.  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffImage, unsafeSvg, safeName } from "../worker/upload.ts";
import { validateDocument, validateSchema } from "../lib/schema.mjs";

test("images are recognised by their bytes, not their names", () => {
  assert.equal(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.ext, "png");
  assert.equal(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))?.ext, "jpg");
  assert.equal(sniffImage(new TextEncoder().encode("<html><script>")), null);
  assert.equal(sniffImage(new TextEncoder().encode('<?xml version="1.0"?><svg/>'))?.ext, "svg");
});

test("SVGs that can run code are refused", () => {
  assert.equal(unsafeSvg('<svg><path d="M0 0"/></svg>'), null);
  for (const bad of [
    "<svg><script>alert(1)</script></svg>",
    '<svg onload="x()"></svg>',
    '<svg><a href="javascript:x()"/></svg>',
    "<svg><foreignObject/></svg>",
    '<svg><image href="https://evil.example/x.png"/></svg>',
    '<!DOCTYPE x [<!ENTITY a "b">]><svg/>',
  ]) assert.ok(unsafeSvg(bad), bad);
});

test("upload names are made safe", () => {
  assert.equal(safeName("Prince Photo (final).JPG"), "prince-photo-final");
  assert.match(safeName("../../etc/passwd"), /^[a-z0-9-]+$/);
  assert.equal(safeName("???.png"), "image");
});

const schema = {
  $format: 1, id: "t", label: "T", group: "Pages", order: 1, kind: "object", file: "content/t.json",
  fields: [
    { name: "title", label: "Title", type: "text", required: true },
    { name: "cta", label: "Button", type: "link" },
    { name: "photo", label: "Photo", type: "image", nullable: true },
    { name: "tags", label: "Tags", type: "list", of: { name: "t", label: "Tag", type: "text" } },
  ],
};

test("the schema itself is checked", () => {
  assert.deepEqual(validateSchema(schema), []);
  assert.ok(validateSchema({ ...schema, fields: [{ name: "x", label: "X", type: "colour" }] }).length);
});

test("content is checked against the schema", () => {
  const ok = { title: "Hi", cta: { label: "Go", href: "/contact" }, photo: null, tags: ["a"] };
  assert.deepEqual(validateDocument(schema, ok), []);
  assert.ok(validateDocument(schema, { ...ok, title: "" }).some((e) => e.includes("required")));
  assert.ok(validateDocument(schema, { ...ok, cta: { label: "Go", href: "javascript:alert(1)" } }).length);
  assert.ok(validateDocument(schema, { ...ok, photo: "/x/../../secret.png" }).length);
  assert.ok(validateDocument(schema, { ...ok, extra: 1 }).some((e) => e.includes("not described")));
  const { tags, ...missing } = ok;
  assert.ok(validateDocument(schema, missing).some((e) => e.includes("missing")));
});
