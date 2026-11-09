/** Calls to the admin Worker. Changes carry X-Admin, which the Worker requires (see worker/index.ts). */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { "X-Admin": "1" }, credentials: "same-origin" };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(path, init);
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new ApiError(res.status, data.message ?? `Request failed (${res.status}).`);
  return data as T;
}

export type Me = { email: string; siteUrl: string; previewUrl: string };
export type Build = { state: "pending" | "success" | "failure" | "unknown"; url: string | null } | null;
export type State = { draftSha: string | null; changes: { path: string; status: string }[]; behind?: number; build: Build };
export type FileText = { text: string; sha: string };

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  requestCode: (email: string) => call<{ ok: true }>("POST", "/api/auth/request", { email }),
  verifyCode: (code: string) => call<{ email: string }>("POST", "/api/auth/verify", { code }),
  logout: () => call<{ ok: true }>("POST", "/api/auth/logout"),
  sync: () => call<{ ok: true }>("POST", "/api/sync"),
  state: () => call<State>("GET", "/api/state"),
  schemas: () => call<{ schemas: import("./types").Schema[] }>("GET", "/api/schemas"),
  file: (path: string) => call<FileText>("GET", `/api/file?path=${encodeURIComponent(path)}`),
  list: (dir: string) => call<{ items: { name: string; path: string; sha: string }[] }>("GET", `/api/list?dir=${encodeURIComponent(dir)}`),
  save: (path: string, text: string, sha: string | undefined, message?: string) => call<{ sha: string }>("PUT", "/api/file", { path, text, sha, message }),
  remove: (path: string, sha: string) => call<{ ok: true }>("DELETE", "/api/file", { path, sha }),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return call<{ path: string }>("POST", "/api/upload", fd);
  },
  history: (path: string) => call<{ commits: { sha: string; message: string; author: string; date: string }[] }>("GET", `/api/history?path=${encodeURIComponent(path)}`),
  publish: () => call<{ sha: string | null }>("POST", "/api/publish"),
  discard: () => call<{ ok: true }>("POST", "/api/discard"),
};

export const rawUrl = (publicPath: string) => `/api/raw?path=${encodeURIComponent(publicPath)}`;
