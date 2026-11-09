/**
 * Sign-in by email and one-time code.
 *
 * 1. POST /api/auth/request {email}: if the address is listed in ADMIN_EMAILS, a 6-digit code is
 *    emailed (Brevo) and a signed challenge is set as an HttpOnly cookie. The reply is the same
 *    whether or not the address is listed, so it reveals nothing.
 * 2. POST /api/auth/verify {code}: the code is checked against the challenge; on success a signed
 *    session cookie is set for 12 hours.
 *
 * Nothing is stored: the challenge and the session are HMAC-signed with SESSION_SECRET. Codes
 * expire after 10 minutes; requests and attempts are rate-limited per address and per IP, which
 * makes guessing a code impractical (at most 5 tries a minute against a million possibilities).
 * Changing SESSION_SECRET signs everyone out. Removing an address from ADMIN_EMAILS locks it out
 * at its next request, even with a live session.
 */

export const SESSION_COOKIE = "em_session";
export const CHALLENGE_COOKIE = "em_otp";
export const SESSION_TTL = 12 * 3600;
export const CODE_TTL = 10 * 60;

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const now = () => Math.floor(Date.now() / 1000);

export function allowedEmails(list: string | undefined): string[] {
  return (list ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const validEmail = (e: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(e) && e.length <= 254;

/** A uniformly random 6-digit code. */
export function newCode(): string {
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= 4_294_000_000); // drop the uneven tail so every code is equally likely
  return String(n % 1_000_000).padStart(6, "0");
}

// ---------- challenge: proves which code was sent to which address ----------

export async function makeChallenge(secret: string, email: string, code: string, ttl = CODE_TTL): Promise<string> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = b64url(enc.encode(JSON.stringify({ e: email, x: now() + ttl, n: nonce })));
  return `${payload}.${await hmac(secret, `otp|${payload}|${code}`)}`;
}

export async function checkChallenge(secret: string, challenge: string, code: string): Promise<string | null> {
  const [payload, sig] = challenge.split(".");
  if (!payload || !sig || !/^\d{6}$/.test(code)) return null;
  if (!same(sig, await hmac(secret, `otp|${payload}|${code}`))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { e: string; x: number };
    return p.x > now() ? p.e : null;
  } catch {
    return null;
  }
}

/** The address a challenge was made for, without checking a code: used to rate-limit attempts per address. */
export function challengeEmail(challenge: string): string | null {
  try {
    return (JSON.parse(new TextDecoder().decode(fromB64url(challenge.split(".")[0]))) as { e: string }).e;
  } catch {
    return null;
  }
}

// ---------- session ----------

export async function makeSession(secret: string, email: string, ttl = SESSION_TTL): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ e: email, x: now() + ttl })));
  return `${payload}.${await hmac(secret, `session|${payload}`)}`;
}

export async function checkSession(secret: string, token: string): Promise<string | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!same(sig, await hmac(secret, `session|${payload}`))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { e: string; x: number };
    return p.x > now() ? p.e : null;
  } catch {
    return null;
  }
}

// ---------- cookies ----------

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export function cookie(name: string, value: string, maxAge: number, path = "/", secure = true): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

// ---------- email ----------

export async function sendCode(
  opts: { apiKey: string; from: string; fromName: string },
  to: string,
  code: string,
): Promise<boolean> {
  const text = `Your Enhanc Media admin sign-in code is ${code}.\n\nIt expires in 10 minutes. If you did not ask for it, ignore this email.`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#111">
<p>Your Enhanc Media admin sign-in code:</p>
<p style="font-size:30px;font-weight:600;letter-spacing:6px;margin:16px 0">${code}</p>
<p style="color:#6a6a6a">It expires in 10 minutes. If you did not ask for it, ignore this email.</p></div>`;
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": opts.apiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: { email: opts.from, name: opts.fromName },
      to: [{ email: to }],
      subject: `${code} is your Enhanc Media admin code`,
      textContent: text,
      htmlContent: html,
    }),
  });
  if (!res.ok) console.error("auth: email not sent", res.status, (await res.text()).slice(0, 200));
  return res.ok;
}

// ---------- password sign-in ----------

/**
 * ADMIN_USERS: "email:password,email:password". Passwords may not contain commas and must be at
 * least 12 characters; shorter ones are ignored so a weak password can never sign in.
 */
export function parseUsers(list: string | undefined): Map<string, string> {
  const users = new Map<string, string>();
  for (const entry of (list ?? "").split(",")) {
    const i = entry.indexOf(":");
    if (i < 1) continue;
    const email = entry.slice(0, i).trim().toLowerCase();
    const password = entry.slice(i + 1).trim();
    if (password.length >= 12) users.set(email, password);
    else console.error(`auth: password for ${email} is shorter than 12 characters; that user cannot sign in`);
  }
  return users;
}

/** Compares passwords in constant time (both sides are hashed first, so lengths do not leak). */
export async function samePassword(secret: string, given: string, expected: string): Promise<boolean> {
  return same(await hmac(secret, `pw|${given}`), await hmac(secret, `pw|${expected}`));
}
