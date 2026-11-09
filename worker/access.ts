/**
 * Verifies the Cloudflare Access token on every request.
 *
 * Access stands in front of admin.enhancmedia.com and lets in only the listed email addresses.
 * This check is the second lock: the Worker trusts nothing it has not verified itself — the
 * token's signature (RS256, keys published by the Access team domain), its audience (this
 * application's AUD tag), issuer and expiry. If the gate is ever misconfigured or bypassed,
 * requests still fail here.
 */

type Jwk = JsonWebKey & { kid: string };
let keyCache: { at: number; team: string; keys: Map<string, CryptoKey> } | null = null;

async function keys(team: string): Promise<Map<string, CryptoKey>> {
  if (keyCache && keyCache.team === team && Date.now() - keyCache.at < 3600_000) return keyCache.keys;
  const res = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  const map = new Map<string, CryptoKey>();
  for (const k of body.keys) {
    map.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  keyCache = { at: Date.now(), team, keys: map };
  return map;
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

export async function verifyAccess(token: string, team: string, aud: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
  try {
    header = json(h);
    payload = json(p);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  let key = (await keys(team)).get(header.kid);
  if (!key) {
    keyCache = null; // keys rotate; fetch once more
    key = (await keys(team)).get(header.kid);
    if (!key) return null;
  }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.iss !== team) return null;
  if (!payload.exp || payload.exp < now) return null;
  if (payload.nbf && payload.nbf > now + 60) return null;
  return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
}
