/**
 * Enhanc Media — admin Worker.
 *
 * Serves the admin interface (static files in out/) and its API under /api/. The API edits the
 * website's content files in the website repository, on the draft branch only; Publish merges
 * the draft into main. Nothing is stored here.
 *
 * Every request must carry a valid Cloudflare Access token (worker/access.ts). Requests that
 * change something must also come from this origin with the X-Admin header, so another site
 * cannot make a signed-in editor's browser send them.
 */
import { verifyAccess } from "./access";
import * as git from "./git";
import { MAX_UPLOAD, safeName, sniffImage, unsafeSvg } from "./upload";

/**
 * Configuration. Everything is set in the Cloudflare dashboard (Worker → Settings → Variables and
 * Secrets); wrangler.jsonc holds none of it and has keep_vars, so deploys never remove it.
 * Only GITHUB_TOKEN, ACCESS_TEAM_DOMAIN and ACCESS_AUD are required; the rest have defaults.
 */
interface Env {
  ASSETS: Fetcher;
  GITHUB_TOKEN?: string; // secret
  REPO_OWNER?: string; // default princeirl
  REPO_NAME?: string; // default enhancmedia
  MAIN_BRANCH?: string; // default main
  DRAFT_BRANCH?: string; // default content-draft
  SITE_URL?: string; // default https://www.enhancmedia.com
  PREVIEW_URL?: string; // the content-draft preview URL of the website Worker
  ACCESS_TEAM_DOMAIN?: string; // https://<team>.cloudflareaccess.com
  ACCESS_AUD?: string; // the Access application's AUD tag
  ALLOWED_EMAILS?: string; // optional, comma-separated: a second list on top of the Access policy
  DEV_EMAIL?: string; // local development only (.dev.vars); honoured only on localhost
  DEV_GITHUB_API?: string; // local development only: a stand-in for the GitHub API (scripts/mock-github.mjs); honoured only on localhost
}

const MAX_TEXT = 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      // The interface itself is also behind Access; without a valid token it is not served.
      const who = await identify(request, env, url);
      if (!who) return new Response("Not signed in.", { status: 401 });
      return env.ASSETS.fetch(request);
    }
    try {
      return await api(request, env, url);
    } catch (e) {
      if (e instanceof git.GitError) {
        const status = e.status === 409 || e.status === 422 ? 409 : e.status === 404 ? 404 : 502;
        return json({ message: status === 409 ? "This file was changed elsewhere. Reload it and make your edit again." : e.message }, status);
      }
      console.error("admin: unexpected error", e instanceof Error ? e.message : String(e));
      return json({ message: "Something went wrong." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function identify(request: Request, env: Env, url: URL): Promise<string | null> {
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (local && env.DEV_EMAIL) return env.DEV_EMAIL.toLowerCase();
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null; // closed by default
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const email = await verifyAccess(token, env.ACCESS_TEAM_DOMAIN.replace(/\/$/, ""), env.ACCESS_AUD);
  if (!email) return null;
  const allow = (env.ALLOWED_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(email)) return null;
  return email;
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const email = await identify(request, env, url);
  if (!email) return json({ message: "Not signed in." }, 401);

  const write = request.method !== "GET" && request.method !== "HEAD";
  if (write) {
    if (request.headers.get("Origin") !== url.origin || request.headers.get("X-Admin") !== "1") return json({ message: "Forbidden." }, 403);
  }
  if (!env.GITHUB_TOKEN) return json({ message: "The admin is not connected to the website repository yet (GITHUB_TOKEN)." }, 503);

  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const apiBase = local && env.DEV_GITHUB_API ? env.DEV_GITHUB_API : "https://api.github.com";
  const repo: git.Repo = {
    owner: env.REPO_OWNER || "princeirl",
    name: env.REPO_NAME || "enhancmedia",
    token: env.GITHUB_TOKEN,
    main: env.MAIN_BRANCH || "main",
    draft: env.DRAFT_BRANCH || "content-draft",
    api: apiBase,
  };
  const siteUrl = (env.SITE_URL || "https://www.enhancmedia.com").replace(/\/$/, "");
  const previewUrl = (env.PREVIEW_URL || "").replace(/\/$/, "");
  const author: git.Author = { name: `${email.split("@")[0]} (admin)`, email };
  const route = `${request.method} ${url.pathname}`;
  const q = url.searchParams;

  switch (route) {
    case "GET /api/me":
      return json({ email, siteUrl, previewUrl });

    // Brings website changes on main into the draft. Called when the admin opens.
    case "POST /api/sync":
      await git.syncDraft(repo);
      return json({ ok: true });

    case "GET /api/state": {
      const draftSha = await git.branchSha(repo, repo.draft);
      if (!draftSha) return json({ changes: [], draftSha: null, build: null });
      const c = await git.compare(repo, repo.main, repo.draft);
      const build = c.ahead ? await git.previewBuild(repo, draftSha).catch(() => null) : null;
      return json({ draftSha, changes: c.files, behind: c.behind, build });
    }

    // Every schema, read from the draft branch: the website's own description of its content.
    case "GET /api/schemas": {
      const entries = (await git.listDir(repo, "content/_schema", repo.draft)).filter((e) => e.type === "file" && e.name.endsWith(".json"));
      const schemas = await Promise.all(entries.map(async (e) => JSON.parse((await git.readText(repo, e.path, repo.draft))!.text)));
      return json({ schemas });
    }

    case "GET /api/file": {
      const path = readable(q.get("path"));
      if (!path) return json({ message: "Not allowed." }, 400);
      const f = await git.readText(repo, path, repo.draft);
      return f ? json(f) : json({ message: "Not found." }, 404);
    }

    case "GET /api/list": {
      const dir = readable(q.get("dir"));
      if (!dir) return json({ message: "Not allowed." }, 400);
      const items = await git.listDir(repo, dir, repo.draft);
      return json({ items: items.filter((i) => i.type === "file").map((i) => ({ name: i.name, path: i.path, sha: i.sha })) });
    }

    // An image from the draft branch, for thumbnails in the editor.
    case "GET /api/raw": {
      const p = q.get("path") ?? "";
      const path = readable(`public${p.startsWith("/") ? "" : "/"}${p}`);
      if (!path) return json({ message: "Not allowed." }, 400);
      const bytes = await git.readRaw(repo, path, repo.draft);
      if (!bytes) return new Response("Not found.", { status: 404 });
      const kind = sniffImage(new Uint8Array(bytes));
      if (!kind) return new Response("Not an image.", { status: 415 });
      return new Response(bytes, {
        headers: {
          "Content-Type": kind.type,
          "Cache-Control": "private, max-age=300",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    case "PUT /api/file": {
      const body = (await request.json()) as { path?: string; text?: string; sha?: string; message?: string };
      const path = writable(body.path);
      if (!path) return json({ message: "That file cannot be edited from the admin." }, 400);
      if (typeof body.text !== "string" || body.text.length > MAX_TEXT) return json({ message: "The content is too large." }, 413);
      if (path.endsWith(".json")) {
        try {
          JSON.parse(body.text);
        } catch {
          return json({ message: "The content is not valid." }, 422);
        }
      }
      const sha = await git.writeFile(repo, path, new TextEncoder().encode(body.text), body.sha, clean(body.message) || `admin: update ${path}`, author);
      return json({ sha });
    }

    case "DELETE /api/file": {
      const body = (await request.json()) as { path?: string; sha?: string };
      const path = writable(body.path);
      if (!path || !path.endsWith(".md") || !body.sha) return json({ message: "That file cannot be removed from the admin." }, 400);
      await git.deleteFile(repo, path, body.sha, `admin: remove ${path}`, author);
      return json({ ok: true });
    }

    case "POST /api/upload": {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return json({ message: "No file." }, 400);
      if (file.size > MAX_UPLOAD) return json({ message: "Images must be under 8 MB." }, 413);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const kind = sniffImage(bytes);
      if (!kind) return json({ message: "Only PNG, JPEG, WebP, AVIF, GIF or SVG images can be uploaded." }, 415);
      if (kind.ext === "svg") {
        const bad = unsafeSvg(new TextDecoder().decode(bytes));
        if (bad) return json({ message: `This SVG contains ${bad}, so it was not uploaded. Export it again as a plain SVG, or use PNG.` }, 422);
      }
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
      const d = new Date();
      const rel = `uploads/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${safeName(file.name)}-${hash}.${kind.ext}`;
      const existing = await git.readText(repo, `public/${rel}`, repo.draft).catch(() => null);
      if (!existing) await git.writeFile(repo, `public/${rel}`, bytes, undefined, `admin: upload ${rel}`, author);
      return json({ path: `/${rel}` });
    }

    case "GET /api/history": {
      const path = readable(q.get("path"));
      if (!path) return json({ message: "Not allowed." }, 400);
      return json({ commits: await git.history(repo, path, repo.draft) });
    }

    case "POST /api/publish": {
      const draftSha = await git.branchSha(repo, repo.draft);
      if (!draftSha) return json({ message: "Nothing to publish." }, 409);
      const c = await git.compare(repo, repo.main, repo.draft);
      if (!c.ahead) return json({ message: "Nothing to publish." }, 409);
      // Never publish what is still building or failed to build on the preview.
      const build = await git.previewBuild(repo, draftSha);
      if (build.state === "pending") return json({ message: "The preview is still being built. Publish once it is ready." }, 409);
      if (build.state === "failure") return json({ message: "The preview failed to build, so these changes cannot be published. Open the build log for details." }, 409);
      const sha = await git.publish(repo, author);
      return json({ sha });
    }

    case "POST /api/discard":
      await git.discard(repo);
      return json({ ok: true });
  }
  return json({ message: "Not found." }, 404);
}

/** Paths the admin may read: the website's content and public files. */
function readable(p: string | null): string | null {
  if (!p) return null;
  const path = p.replace(/^\/+/, "");
  if (path.includes("..") || path.includes("\\") || path.includes("//")) return null;
  return /^(content|public)(\/|$)/.test(path) ? path : null;
}

/** Paths the admin may write: content files, never the schema (the website's side of the contract). */
function writable(p: string | undefined): string | null {
  const path = readable(p ?? null);
  if (!path) return null;
  if (!path.startsWith("content/") || path.startsWith("content/_schema/")) return null;
  return /^[a-z0-9/_-]+\.(json|md)$/.test(path) ? path : null;
}

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
