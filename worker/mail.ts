/**
 * Sends one email through an HTTP email API. Shared, byte-identical, by the website Worker (inquiry
 * form) and the admin Worker (sign-in codes).
 *
 * The provider follows the key that is set, in this order: ZEPTOMAIL_API_KEY → Zoho ZeptoMail,
 * RESEND_API_KEY → Resend, BREVO_API_KEY → Brevo. ZEPTOMAIL_HOST picks the ZeptoMail data centre
 * (default api.zeptomail.in, India; api.zeptomail.com for the US, .eu for Europe).
 * Changing provider is a change of variables, not of code; adding one is one more branch below.
 * No imports, so both Workers can use it unchanged.
 */

export type MailKeys = { ZEPTOMAIL_API_KEY?: string; ZEPTOMAIL_HOST?: string; RESEND_API_KEY?: string; BREVO_API_KEY?: string };
export type Mail = { from: string; fromName: string; to: string; replyTo?: string; subject: string; text: string; html?: string };

export const mailProvider = (keys: MailKeys): "zeptomail" | "resend" | "brevo" | null =>
  keys.ZEPTOMAIL_API_KEY ? "zeptomail" : keys.RESEND_API_KEY ? "resend" : keys.BREVO_API_KEY ? "brevo" : null;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export async function sendMail(keys: MailKeys, m: Mail): Promise<{ ok: boolean; error?: string }> {
  const subject = oneLine(m.subject).slice(0, 250);
  const fromName = oneLine(m.fromName).replace(/["<>]/g, "");
  const provider = mailProvider(keys);
  let res: Response;
  if (provider === "zeptomail") {
    // The "Send Mail token" from ZeptoMail → Mail Agents → SMTP/API → API, with or without its prefix.
    const token = keys.ZEPTOMAIL_API_KEY!.trim().replace(/^Zoho-enczapikey\s+/i, "");
    const given = (keys.ZEPTOMAIL_HOST || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    // Only a ZeptoMail API host: a mistyped variable must never send the token elsewhere.
    const host = /^api\.zeptomail\.[a-z]{2,3}(\.[a-z]{2})?$/.test(given) ? given : "api.zeptomail.in";
    res = await fetch(`https://${host}/v1.1/email`, {
      method: "POST",
      headers: { Authorization: `Zoho-enczapikey ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        from: { address: m.from, name: fromName },
        to: [{ email_address: { address: m.to } }],
        ...(m.replyTo ? { reply_to: [{ address: oneLine(m.replyTo) }] } : {}),
        subject,
        textbody: m.text,
        // ZeptoMail needs an HTML body; plain-text mails get an escaped copy.
        htmlbody: m.html ?? `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(m.text)}</pre>`,
      }),
    });
  } else if (provider === "resend") {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${m.from}>`,
        to: [m.to],
        subject,
        text: m.text,
        ...(m.html ? { html: m.html } : {}),
        ...(m.replyTo ? { reply_to: oneLine(m.replyTo) } : {}),
      }),
    });
  } else if (provider === "brevo") {
    res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": keys.BREVO_API_KEY!, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { email: m.from, name: fromName },
        to: [{ email: m.to }],
        subject,
        textContent: m.text,
        ...(m.html ? { htmlContent: m.html } : {}),
        ...(m.replyTo ? { replyTo: { email: oneLine(m.replyTo) } } : {}),
      }),
    });
  } else {
    return { ok: false, error: "no email provider key (ZEPTOMAIL_API_KEY, RESEND_API_KEY or BREVO_API_KEY)" };
  }
  if (res.ok) return { ok: true };
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  return { ok: false, error: `${provider} ${res.status}: ${detail}` };
}
