# Enhanc Media — admin panel

Edits every text, image, menu and setting of www.enhancmedia.com. Same stack as the website
(Next.js static export, TypeScript, Tailwind CSS, one Cloudflare Worker), its own repository,
deployed separately at **admin.enhancmedia.com**.

Plan and decisions: `.project/plans/2026-11/2026-11-09-admin-panel.md` and
`.project/memory/2026-11-09-admin-panel-decision.md` in the project records.

## How it works

```
browser ── Cloudflare Access (listed emails, one-time code) ── admin Worker
                                                                 │  verifies the Access token itself
                                                                 │  GitHub API, fine-grained token
                                                                 ▼
                                  github.com/princeirl/enhancmedia  (the website repository)
                                    content-draft ← every Save      → preview version (preview URL)
                                    main          ← Publish (merge) → www.enhancmedia.com
```

- **The forms are not written here.** The admin reads the website's `content/_schema/*.json`
  and builds a form for each content file: pages, collections, settings, legal pages. When the
  website gains a page or a field (with its schema, which its build enforces), it appears here
  with no change to this repository.
- **Save** validates with `lib/schema.mjs` — byte-identical to the website's copy, the same
  rules its build applies — and commits the file to `content-draft`, named after the editor.
  A stale copy is refused (409) rather than overwriting someone else's save.
- **Images** are checked by their bytes (PNG, JPEG, WebP, AVIF, GIF, SVG; under 8 MB; SVGs with
  scripts, handlers or external references are refused) and committed to
  `public/uploads/YYYY/MM/` on the draft.
- **Publish** merges `content-draft` into `main`. It is refused while the draft's preview build
  (as reported on the commit by Workers Builds) is running or has failed; if no status is
  reported it asks the editor to check the preview first. **Discard** resets the draft to `main`.
- **When it opens**, the admin brings `main` into `content-draft`, so website changes show up
  straight away.
- What it may touch: it reads `content/` and `public/`; it writes `content/**/*.json|md` except
  `content/_schema/`, and `public/uploads/`. Code and the schema are never changed from here.

```
app/          the interface (one client-side page)
components/   the editor and one control per field type
lib/          API client, file parsing, schema types, schema.mjs (copy of the website's)
worker/       the Worker: Access check, API, GitHub calls (git.ts), upload checks
scripts/      schema-sync check, unit tests, a local stand-in for the GitHub API
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Builds and runs locally at http://127.0.0.1:8788 (see "Local development") |
| `npm run typecheck` | Type-checks the interface and the Worker |
| `npm test` | Unit tests: upload checks, schema validation |
| `npm run check:schema` | Confirms `lib/schema.mjs` matches `../website/lib/schema.mjs` |
| `npm run deploy` | Type check, build, deploy (from a machine with a Cloudflare login) |

## Variables

Set in the Cloudflare dashboard: Worker `enhancmedia-admin` → Settings → Variables and Secrets.
None live in `wrangler.jsonc` or in GitHub; `keep_vars: true` stops deploys from removing them.
Without the three required values the Worker refuses every request (closed by default).

| Name | Type | Value |
|---|---|---|
| `GITHUB_TOKEN` | Secret, required | Fine-grained token for `princeirl/enhancmedia` only: *Contents: Read and write*, *Commit statuses: Read* (and *Checks: Read* if offered). From the vault. |
| `ACCESS_TEAM_DOMAIN` | Text, required | `https://<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | Text, required | The Access application's *AUD tag* |
| `PREVIEW_URL` | Text | The website's `content-draft` preview URL, e.g. `https://content-draft-enhancmedia-website.<subdomain>.workers.dev` |
| `SITE_URL` | Text | Default `https://www.enhancmedia.com` |
| `REPO_OWNER`, `REPO_NAME` | Text | Default `princeirl`, `enhancmedia` |
| `MAIN_BRANCH`, `DRAFT_BRANCH` | Text | Default `main`, `content-draft` |
| `ALLOWED_EMAILS` | Text | Optional second list of editors, comma-separated |

`.dev.vars.example` lists the same names for local work.

## Setting up (once)

1. **Website builds** — connect `princeirl/enhancmedia` to the Worker `enhancmedia-website` in
   Workers Builds, with the settings in the website README → Deployment, and turn on builds for
   non-production branches. The admin creates the branch `content-draft` on first use.
2. **Access** — Zero Trust → Access → Applications → *Self-hosted* for `admin.enhancmedia.com`,
   policy *Allow* with the editors' emails, login by one-time PIN. Protect the website Worker's
   preview URLs with Access too (Worker → Settings → Domains & Routes → Preview URLs).
3. **Admin Worker** — connect this repository to a Worker named `enhancmedia-admin` in Workers
   Builds: build command `npm run build`, deploy command `npx wrangler deploy`. Or deploy from a
   machine with `npm run deploy`. Wrangler attaches `admin.enhancmedia.com` as a custom domain.
4. **Variables** — set the table above in the dashboard, then redeploy (or *Retry build*).

Adding or removing an editor is a change to the Access policy; nothing here changes.

## Local development

```bash
printf 'DEV_EMAIL=you@enhancmedia.com\nGITHUB_TOKEN=local\nDEV_GITHUB_API=http://127.0.0.1:8790\n' > .dev.vars   # see .dev.vars.example
node scripts/mock-github.mjs ../website 8790 &        # in-memory stand-in for GitHub, from the website copy
npm run build && npx wrangler dev --port 8788 --ip 127.0.0.1 --local-upstream 127.0.0.1:8788
```

`DEV_EMAIL` and `DEV_GITHUB_API` are honoured only when the request is for localhost; in
production they do nothing. Point `DEV_GITHUB_API` away (and set a real `GITHUB_TOKEN`) to work
against the real repository. `.dev.vars` is git-ignored.

## When the website needs a new kind of field

The field types are listed in `lib/schema.mjs` (`FIELD_TYPES`). A new type means: add it and its
validation to the website's `lib/schema.mjs`, copy the file here, add its control to
`components/fields.tsx`, release the admin, then use it in the website. If the website's schemas
ever declare a newer `$format`, the admin stops and says it needs an update rather than guessing.

## Leaving GitHub or Cloudflare

- Another git host: re-implement `worker/git.ts` (one module) against its API.
- Another login gate: replace `worker/access.ts`; any proxy that signs a verified email works.
- Another host: the interface is static files in `out/`; the API is one Worker file with no
  platform storage.
