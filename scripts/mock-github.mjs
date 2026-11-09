// Local stand-in for the parts of the GitHub API the admin uses — for development and tests only.
//
//   node scripts/mock-github.mjs ../website [port]
//
// Loads the website working copy (content/ and public/) into memory as branch "main", then
// answers refs, compare, contents, merges, commits and check runs. Every "build" succeeds
// after two seconds unless the content check would fail, so the preview gate can be exercised.
// Nothing is written to disk. The Worker uses it only on localhost, via DEV_GITHUB_API.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(process.argv[2] ?? "../website");
const port = Number(process.argv[3] ?? 8790);

let seq = 0;
const newSha = () => crypto.createHash("sha1").update(String(++seq) + Math.random()).digest("hex");
const blobSha = (b) => crypto.createHash("sha1").update(b).digest("hex");

// commit: { sha, parents: [sha], files: Map(path → Buffer), message, author, date }
const commits = new Map();
const refs = new Map();
function load(dir, files) {
  for (const d of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${d.name}`;
    if (d.isDirectory()) load(p, files);
    else files.set(p, fs.readFileSync(path.join(root, p)));
  }
}
const initial = new Map();
load("content", initial);
load("public", initial);
const c0 = { sha: newSha(), parents: [], files: initial, message: "initial", author: { email: "seed" }, date: new Date().toISOString() };
commits.set(c0.sha, c0);
refs.set("main", c0.sha);
const runs = new Map(); // sha → started

function ancestors(sha) {
  const seen = new Set();
  const stack = [sha];
  while (stack.length) {
    const s = stack.pop();
    if (seen.has(s)) continue;
    seen.add(s);
    stack.push(...commits.get(s).parents);
  }
  return seen;
}
function commit(branch, files, message, author, extraParents = []) {
  const parent = refs.get(branch);
  const c = { sha: newSha(), parents: [parent, ...extraParents], files, message, author, date: new Date().toISOString() };
  commits.set(c.sha, c);
  refs.set(branch, c.sha);
  runs.set(c.sha, Date.now());
  return c;
}

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__export") {
      // Writes a branch's files to a directory, so a website build can check what the admin wrote.
      const out = url.searchParams.get("to");
      for (const [k, v] of commits.get(refs.get(url.searchParams.get("branch") ?? "main")).files) {
        fs.mkdirSync(path.dirname(path.join(out, k)), { recursive: true });
        fs.writeFileSync(path.join(out, k), v);
      }
      return send(res, 200, { ok: true });
    }
    const m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+(\/.*)$/);
    if (!m) return send(res, 404, { message: "Not Found" });
    const p = decodeURIComponent(m[1]);
    const key = `${req.method} ${p}`;
    try {
      let r;
      if ((r = key.match(/^GET \/git\/ref\/heads\/(.+)$/))) {
        return refs.has(r[1]) ? send(res, 200, { object: { sha: refs.get(r[1]) } }) : send(res, 404, { message: "Not Found" });
      }
      if (key === "POST /git/refs") {
        refs.set(body.ref.replace("refs/heads/", ""), body.sha);
        return send(res, 201, {});
      }
      if ((r = key.match(/^PATCH \/git\/refs\/heads\/(.+)$/))) {
        if (!body.force && !ancestors(body.sha).has(refs.get(r[1]))) return send(res, 422, { message: "Update is not a fast forward" });
        refs.set(r[1], body.sha);
        return send(res, 200, {});
      }
      if ((r = key.match(/^GET \/compare\/(.+)\.\.\.(.+)$/))) {
        const [b, h] = [refs.get(r[1]), refs.get(r[2])];
        const A = ancestors(b), B = ancestors(h);
        const fb = commits.get(b).files, fh = commits.get(h).files;
        const files = [];
        for (const [k, v] of fh) if (!fb.has(k)) files.push({ filename: k, status: "added" }); else if (!fb.get(k).equals(v)) files.push({ filename: k, status: "modified" });
        for (const k of fb.keys()) if (!fh.has(k)) files.push({ filename: k, status: "removed" });
        return send(res, 200, { ahead_by: [...B].filter((s) => !A.has(s)).length, behind_by: [...A].filter((s) => !B.has(s)).length, files });
      }
      if ((r = key.match(/^(GET|PUT|DELETE) \/contents\/(.+)$/))) {
        const fp = r[2];
        const branch = req.method === "GET" ? url.searchParams.get("ref") : body.branch;
        const files = commits.get(refs.get(branch)).files;
        if (req.method === "GET") {
          if (files.has(fp)) {
            const b = files.get(fp);
            if ((req.headers.accept ?? "").includes("raw")) { res.writeHead(200); return res.end(b); }
            return send(res, 200, { type: "file", sha: blobSha(b), encoding: "base64", content: b.toString("base64") });
          }
          const prefix = fp + "/";
          const items = [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"));
          if (!items.length) return send(res, 404, { message: "Not Found" });
          return send(res, 200, items.map((k) => ({ name: k.slice(prefix.length), path: k, sha: blobSha(files.get(k)), type: "file" })));
        }
        const cur = files.get(fp);
        if (cur && body.sha !== blobSha(cur)) return send(res, 409, { message: "sha does not match" });
        if (!cur && req.method === "PUT" && body.sha) return send(res, 409, { message: "file gone" });
        const next = new Map(files);
        if (req.method === "PUT") next.set(fp, Buffer.from(body.content, "base64"));
        else next.delete(fp);
        commit(branch, next, body.message, body.author);
        return send(res, 200, { content: req.method === "PUT" ? { sha: blobSha(next.get(fp)) } : null });
      }
      if (key === "POST /merges") {
        const [b, h] = [refs.get(body.base), refs.get(body.head)];
        if (ancestors(b).has(h)) return send(res, 204);
        if (ancestors(h).has(b)) { refs.set(body.base, h); return send(res, 201, { sha: h }); }
        // naive three-way merge on whole files
        const fb = commits.get(b).files, fh = commits.get(h).files;
        const base = [...ancestors(b)].filter((s) => ancestors(h).has(s)).map((s) => commits.get(s)).sort((x, y) => (x.date < y.date ? 1 : -1))[0].files;
        const out = new Map(fb);
        for (const k of new Set([...fb.keys(), ...fh.keys()])) {
          const [o, x, y] = [base.get(k), fb.get(k), fh.get(k)];
          const eq = (a, b2) => (a && b2 ? a.equals(b2) : a === b2);
          if (eq(x, y) || eq(o, y)) continue;
          if (eq(o, x)) { y ? out.set(k, y) : out.delete(k); continue; }
          return send(res, 409, { message: "Merge conflict" });
        }
        const c = commit(body.base, out, body.commit_message, { email: "merge" }, [h]);
        return send(res, 201, { sha: c.sha });
      }
      if ((r = key.match(/^GET \/commits\/([0-9a-f]+)\/check-runs$/))) {
        if (!runs.has(r[1])) return send(res, 200, { check_runs: [] });
        const done = Date.now() - runs.get(r[1]) > 2000;
        return send(res, 200, { check_runs: [{ status: done ? "completed" : "in_progress", conclusion: done ? "success" : null, html_url: "http://localhost/run", details_url: null }] });
      }
      if ((r = key.match(/^GET \/commits\/([0-9a-f]+)\/status$/))) return send(res, 200, { statuses: [] });
      if (key === "GET /commits") {
        const fp = url.searchParams.get("path");
        const list = [];
        for (let s = refs.get(url.searchParams.get("sha")); s; s = commits.get(s).parents[0]) {
          const c = commits.get(s), parent = commits.get(c.parents[0]);
          const a = c.files.get(fp), b = parent?.files.get(fp);
          if (!parent || !(a && b ? a.equals(b) : a === b)) list.push({ sha: c.sha, commit: { message: c.message, author: { email: c.author?.email ?? "", name: "", date: c.date } } });
        }
        return send(res, 200, list.slice(0, 15));
      }
      send(res, 404, { message: `mock: ${key} not implemented` });
    } catch (e) {
      send(res, 500, { message: String(e) });
    }
  })
  .listen(port, () => console.log(`mock GitHub on http://localhost:${port}, serving ${root}`));
