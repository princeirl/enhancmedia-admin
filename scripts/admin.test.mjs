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

// ---------- sign-in ----------
import * as auth from "../worker/auth.ts";
const KEY = "k".repeat(40);

test("a code works once, for its own challenge, before it expires", async () => {
  const code = auth.newCode();
  assert.match(code, /^\d{6}$/);
  const ch = await auth.makeChallenge(KEY, "a@b.co", code);
  assert.equal(await auth.checkChallenge(KEY, ch, code), "a@b.co");
  const wrong = code === "000000" ? "000001" : "000000";
  assert.equal(await auth.checkChallenge(KEY, ch, wrong), null);
  assert.equal(await auth.checkChallenge("x".repeat(40), ch, code), null, "another secret");
  const [p, s] = ch.split(".");
  const forged = Buffer.from(JSON.stringify({ e: "evil@x.co", x: 9e9, n: "a" })).toString("base64url");
  assert.equal(await auth.checkChallenge(KEY, `${forged}.${s}`, code), null, "changed address");
  const old = await auth.makeChallenge(KEY, "a@b.co", code, -1);
  assert.equal(await auth.checkChallenge(KEY, old, code), null, "expired");
  assert.equal(auth.challengeEmail(ch), "a@b.co");
  void p;
});

test("sessions are signed and expire", async () => {
  const s = await auth.makeSession(KEY, "a@b.co");
  assert.equal(await auth.checkSession(KEY, s), "a@b.co");
  assert.equal(await auth.checkSession("y".repeat(40), s), null);
  assert.equal(await auth.checkSession(KEY, s.replace(/.$/, (c) => (c === "A" ? "B" : "A"))), null);
  assert.equal(await auth.checkSession(KEY, await auth.makeSession(KEY, "a@b.co", -1)), null);
  // a challenge is not a session
  assert.equal(await auth.checkSession(KEY, await auth.makeChallenge(KEY, "a@b.co", "123456")), null);
});

test("the editor list and cookies", () => {
  assert.deepEqual(auth.allowedEmails(" A@b.co, c@d.co ,"), ["a@b.co", "c@d.co"]);
  const r = new Request("https://x", { headers: { Cookie: "a=1; em_session=abc.def=; b=2" } });
  assert.equal(auth.readCookie(r, "em_session"), "abc.def=");
  assert.match(auth.cookie("em_session", "v", 60), /HttpOnly; SameSite=Strict; Secure$/);
});

test("the code email goes to the Brevo transactional API", async () => {
  const real = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response("{}", { status: 201 }); };
  try {
    assert.equal(await auth.sendCode({ apiKey: "KEY", from: "admin@enhancmedia.com", fromName: "Enhanc Media" }, "a@b.co", "123456"), true);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(seen.url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(seen.init.headers["api-key"], "KEY");
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.sender, { email: "admin@enhancmedia.com", name: "Enhanc Media" });
  assert.deepEqual(body.to, [{ email: "a@b.co" }]);
  assert.match(body.subject, /123456/);
  assert.match(body.textContent, /123456/);
});
