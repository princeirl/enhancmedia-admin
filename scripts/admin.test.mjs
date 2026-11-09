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

async function capture(fn) {
  const real = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response("{}", { status: 200 }); };
  try { return { result: await fn(), seen }; } finally { globalThis.fetch = real; }
}

test("codes go out through ZeptoMail when its key is set (India data centre by default)", async () => {
  const { result, seen } = await capture(() => auth.sendCode({ ZEPTOMAIL_API_KEY: "Zoho-enczapikey abc==", RESEND_API_KEY: "re" }, { email: "admin@enhancmedia.com", name: "Enhanc Media Admin" }, "a@b.co", "123456"));
  assert.equal(result, true);
  assert.equal(seen.url, "https://api.zeptomail.in/v1.1/email");
  assert.equal(seen.init.headers.Authorization, "Zoho-enczapikey abc==");
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.from, { address: "admin@enhancmedia.com", name: "Enhanc Media Admin" });
  assert.deepEqual(body.to, [{ email_address: { address: "a@b.co" } }]);
  assert.match(body.subject, /123456/);
  assert.match(body.htmlbody, /123456/);
});

test("ZeptoMail: token without prefix, other data centre, plain text gets an escaped HTML body", async () => {
  const { sendMail } = await import("../worker/mail.ts");
  const { seen } = await capture(() => sendMail({ ZEPTOMAIL_API_KEY: "abc==", ZEPTOMAIL_HOST: "https://api.zeptomail.com/" }, { from: "w@enhancmedia.com", fromName: "Site", to: "in@enhancmedia.com", replyTo: "v@x.co", subject: "s", text: "<b>hi</b>" }));
  assert.equal(seen.url, "https://api.zeptomail.com/v1.1/email");
  assert.equal(seen.init.headers.Authorization, "Zoho-enczapikey abc==");
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.reply_to, [{ address: "v@x.co" }]);
  assert.ok(!body.htmlbody.includes("<b>") && body.htmlbody.includes("&#60;b&#62;"));
});

test("codes go out through Resend when its key is set", async () => {
  const { result, seen } = await capture(() => auth.sendCode({ RESEND_API_KEY: "re_x", BREVO_API_KEY: "b" }, { email: "admin@enhancmedia.com", name: "Enhanc Media Admin" }, "a@b.co", "123456"));
  assert.equal(result, true);
  assert.equal(seen.url, "https://api.resend.com/emails");
  assert.equal(seen.init.headers.Authorization, "Bearer re_x");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.from, "Enhanc Media Admin <admin@enhancmedia.com>");
  assert.deepEqual(body.to, ["a@b.co"]);
  assert.match(body.subject, /123456/);
});

test("and through Brevo when only its key is set", async () => {
  const { seen } = await capture(() => auth.sendCode({ BREVO_API_KEY: "KEY" }, { email: "admin@enhancmedia.com", name: "Enhanc Media" }, "a@b.co", "123456"));
  assert.equal(seen.url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(seen.init.headers["api-key"], "KEY");
  const body = JSON.parse(seen.init.body);
  assert.deepEqual(body.sender, { email: "admin@enhancmedia.com", name: "Enhanc Media" });
  assert.deepEqual(body.to, [{ email: "a@b.co" }]);
});

test("mail: reply-to and header injection", async () => {
  const { sendMail } = await import("../worker/mail.ts");
  const { seen } = await capture(() => sendMail({ RESEND_API_KEY: "k" }, { from: "w@enhancmedia.com", fromName: 'Site "x" <y>', to: "in@enhancmedia.com", replyTo: "v@x.co\r\nBcc: evil@x.co", subject: "Hi\r\nBcc: evil@x.co", text: "t" }));
  const body = JSON.parse(seen.init.body);
  assert.equal(body.from, "Site x y <w@enhancmedia.com>");
  assert.ok(!/[\r\n]/.test(body.subject) && !/[\r\n]/.test(body.reply_to));
  const none = await sendMail({}, { from: "a", fromName: "b", to: "c", subject: "d", text: "e" });
  assert.equal(none.ok, false);
});

test("ZeptoMail host must be a ZeptoMail API host", async () => {
  const { sendMail } = await import("../worker/mail.ts");
  const { seen } = await capture(() => sendMail({ ZEPTOMAIL_API_KEY: "k", ZEPTOMAIL_HOST: "evil.example.com" }, { from: "a@b.co", fromName: "x", to: "c@d.co", subject: "s", text: "t" }));
  assert.equal(seen.url, "https://api.zeptomail.in/v1.1/email");
});
