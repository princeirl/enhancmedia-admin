/**
 * The website repository, through the GitHub REST API.
 *
 * Everything the admin knows about where content is stored lives in this one module. Moving the
 * website to another git host means re-implementing these functions and nothing else.
 *
 * The token is fine-grained and limited to the website repository: Contents read/write and
 * Actions read. It is a Worker secret (GITHUB_TOKEN), sourced from the vault, never committed.
 */

export type Repo = { owner: string; name: string; token: string; main: string; draft: string; api: string };
export type Author = { name: string; email: string };

export class GitError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function gh<T>(repo: Repo, path: string, init: RequestInit = {}, accept = "application/vnd.github+json"): Promise<T> {
  const res = await fetch(`${repo.api}/repos/${repo.owner}/${repo.name}${path}`, {
    ...init,
    headers: {
      Accept: accept,
      Authorization: `Bearer ${repo.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "enhancmedia-admin",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GitError(res.status, body.message ?? `GitHub ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  if (accept.includes("raw")) return (await res.arrayBuffer()) as T;
  return (await res.json()) as T;
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0));
}

export async function branchSha(repo: Repo, branch: string): Promise<string | null> {
  try {
    const r = await gh<{ object: { sha: string } }>(repo, `/git/ref/heads/${enc(branch)}`);
    return r.object.sha;
  } catch (e) {
    if (e instanceof GitError && e.status === 404) return null;
    throw e;
  }
}

export type Comparison = { ahead: number; behind: number; files: { path: string; status: string }[] };
export async function compare(repo: Repo, base: string, head: string): Promise<Comparison> {
  const r = await gh<{ ahead_by: number; behind_by: number; files?: { filename: string; status: string }[] }>(
    repo,
    `/compare/${enc(base)}...${enc(head)}`,
  );
  return { ahead: r.ahead_by, behind: r.behind_by, files: (r.files ?? []).map((f) => ({ path: f.filename, status: f.status })) };
}

/**
 * Makes sure the draft branch exists and carries everything on main.
 * Website changes — a new page and its schema — land on main; bringing them into the draft
 * is what makes them appear in the admin straight away.
 */
export async function syncDraft(repo: Repo): Promise<void> {
  const mainSha = await branchSha(repo, repo.main);
  if (!mainSha) throw new GitError(500, `branch ${repo.main} not found`);
  const draftSha = await branchSha(repo, repo.draft);
  if (!draftSha) {
    await gh(repo, `/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${repo.draft}`, sha: mainSha }) });
    return;
  }
  const c = await compare(repo, repo.draft, repo.main); // main relative to draft
  if (c.ahead === 0) return; // draft already has everything on main
  const back = await compare(repo, repo.main, repo.draft);
  if (back.ahead === 0) {
    // No unpublished edits: move the draft forward to main.
    await gh(repo, `/git/refs/heads/${enc(repo.draft)}`, { method: "PATCH", body: JSON.stringify({ sha: mainSha, force: false }) });
    return;
  }
  // Unpublished edits and new website changes: merge main into the draft.
  await gh(repo, `/merges`, {
    method: "POST",
    body: JSON.stringify({ base: repo.draft, head: repo.main, commit_message: `admin: bring ${repo.main} into ${repo.draft}` }),
  });
}

export async function readText(repo: Repo, path: string, ref: string): Promise<{ text: string; sha: string } | null> {
  try {
    const r = await gh<{ content: string; sha: string; encoding: string; type: string }>(repo, `/contents/${enc(path)}?ref=${enc(ref)}`);
    if (r.type !== "file") return null;
    return { text: new TextDecoder().decode(fromBase64(r.content)), sha: r.sha };
  } catch (e) {
    if (e instanceof GitError && e.status === 404) return null;
    throw e;
  }
}

export async function readRaw(repo: Repo, path: string, ref: string): Promise<ArrayBuffer | null> {
  try {
    return await gh<ArrayBuffer>(repo, `/contents/${enc(path)}?ref=${enc(ref)}`, {}, "application/vnd.github.raw+json");
  } catch (e) {
    if (e instanceof GitError && e.status === 404) return null;
    throw e;
  }
}

export async function listDir(repo: Repo, path: string, ref: string): Promise<{ name: string; path: string; sha: string; type: string }[]> {
  try {
    return await gh(repo, `/contents/${enc(path)}?ref=${enc(ref)}`);
  } catch (e) {
    if (e instanceof GitError && e.status === 404) return [];
    throw e;
  }
}

/** Writes one file to the draft branch. `sha` is the version the editor started from; a mismatch is a conflict (409). */
export async function writeFile(
  repo: Repo,
  path: string,
  bytes: Uint8Array,
  sha: string | undefined,
  message: string,
  author: Author,
): Promise<string> {
  const r = await gh<{ content: { sha: string } }>(repo, `/contents/${enc(path)}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: toBase64(bytes), branch: repo.draft, ...(sha ? { sha } : {}), author }),
  });
  return r.content.sha;
}

export async function deleteFile(repo: Repo, path: string, sha: string, message: string, author: Author): Promise<void> {
  await gh(repo, `/contents/${enc(path)}`, { method: "DELETE", body: JSON.stringify({ message, sha, branch: repo.draft, author }) });
}

export type BuildState = { state: "pending" | "success" | "failure" | "unknown"; url: string | null };

/**
 * Whether the preview of a draft commit built, as reported on the commit by the build service
 * (Cloudflare Workers Builds posts a check run; commit statuses are read too). "unknown" when
 * nothing is reported, or the token may not read checks.
 */
export async function previewBuild(repo: Repo, sha: string): Promise<BuildState> {
  const results: { state: BuildState["state"]; url: string | null }[] = [];
  try {
    const r = await gh<{ check_runs: { status: string; conclusion: string | null; html_url: string | null; details_url: string | null }[] }>(
      repo,
      `/commits/${sha}/check-runs?per_page=50`,
    );
    for (const c of r.check_runs) {
      const state = c.status !== "completed" ? "pending" : ["success", "neutral", "skipped"].includes(c.conclusion ?? "") ? "success" : "failure";
      results.push({ state, url: c.details_url ?? c.html_url });
    }
  } catch {
    /* not readable with this token: fall through */
  }
  try {
    const s = await gh<{ statuses: { state: string; target_url: string | null }[] }>(repo, `/commits/${sha}/status`);
    for (const x of s.statuses) {
      results.push({ state: x.state === "success" ? "success" : x.state === "pending" ? "pending" : "failure", url: x.target_url });
    }
  } catch {
    /* as above */
  }
  if (!results.length) return { state: "unknown", url: null };
  const worst = results.find((r) => r.state === "failure") ?? results.find((r) => r.state === "pending") ?? results[0];
  return worst;
}

/** Publishes: merges the draft into main. Main's deploy then builds the live site. */
export async function publish(repo: Repo, author: Author): Promise<string | null> {
  const r = await gh<{ sha: string } | undefined>(repo, `/merges`, {
    method: "POST",
    body: JSON.stringify({ base: repo.main, head: repo.draft, commit_message: `admin: publish (${author.email})` }),
  });
  return r?.sha ?? null; // 204: nothing to merge
}

/** Discards every unpublished edit: the draft goes back to main. */
export async function discard(repo: Repo): Promise<void> {
  const mainSha = await branchSha(repo, repo.main);
  await gh(repo, `/git/refs/heads/${enc(repo.draft)}`, { method: "PATCH", body: JSON.stringify({ sha: mainSha, force: true }) });
}

export type Commit = { sha: string; message: string; author: string; date: string };
export async function history(repo: Repo, path: string, ref: string): Promise<Commit[]> {
  const r = await gh<{ sha: string; commit: { message: string; author: { name: string; email: string; date: string } } }[]>(
    repo,
    `/commits?sha=${enc(ref)}&path=${enc(path)}&per_page=15`,
  );
  return r.map((c) => ({ sha: c.sha, message: c.commit.message.split("\n")[0], author: c.commit.author.email, date: c.commit.author.date }));
}
