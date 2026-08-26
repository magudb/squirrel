# Squirrel link service

A small, API-only Vercel service that decouples link collecting from the machine
you collect on. The extension pushes links here; they buffer in Redis; the
service batches them into a Jekyll draft in the blog repo over the GitHub API;
and one call promotes that draft to a published post.

The old setup wrote straight into a working copy at
`/home/mlu/Documents/project/magudb.github.io/_drafts` from a local Express
process, so it only worked on one laptop with a service running. GitHub is now
the storage; this service is the only writer.

## How a link travels

```
 popup ──QUEUE_LINK──▶ service worker outbox (chrome.storage.local)
                              │
                              │ POST /api/links   (Idempotency-Key)
                              ▼
                       Redis buffer  ── squirrel:pending (ZSET) + payloads
                              │
      POST /api/flush ────────┤  triggered by: 5 buffered links,
      (extension alarm,       │               a 15-min extension alarm,
       daily Vercel cron)     │               or the daily cron safety net
                              ▼
                     one commit ──▶ _drafts/<target>.md on master
                              │
      POST /api/publish ──────┤  one commit: create _posts/YYYY-MM-DD-slug.md
                              ▼               + delete the draft
                     GitHub Pages build ──▶ live
```

The buffer is never the source of truth for what is already published. Every
flush re-reads the draft from GitHub and drops any link whose normalised URL is
already in the file. That single property is what makes the whole thing safe to
retry: a double cron fire, a lost Redis delete, a rebuilt commit after a
conflict, or an ambiguous ref update all converge on the same file.

## Setup

### 1. Redis

In the Vercel dashboard: **Storage → Create → Upstash Redis**, and connect it to
the project. That injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

Do not set a Custom Prefix when connecting — it renames those variables and
nothing finds them. `REDIS_URL` / `KV_URL` are ignored on purpose: they are TCP
endpoints and this uses the HTTP client.

### 2. GitHub token

Create a **fine-grained** personal access token, scoped to `magudb.github.io`
only, with one permission: **Contents: Read and write**.

Do not grant Workflows. Contents-only means a leaked token can edit posts;
Workflows would let it rewrite `.github/workflows/` and run arbitrary CI with
the repo's secrets.

Fine-grained tokens default to a 30-day expiry. Pick a long one — an expired
token turns every flush into a silent upstream failure while links pile up in
Redis. `GET /api/status` surfaces that, and the extension badges the toolbar.

### 3. Create the Vercel project

Either import the repo in the dashboard, or link it from the CLI:

```bash
npx vercel login
npx vercel link          # run from the REPO ROOT, not from server/
```

Then set **Root Directory** to `server` and framework preset to **Other**. No
build command — Vercel compiles `api/**/*.ts` with esbuild automatically.

Root Directory matters more than it looks: `vercel.json` is read from inside it,
so a copy at the repo root would be silently ignored and the cron would never
register.

Deployment itself runs from GitHub Actions — see
[Deploying](#deploying) below.

### 4. Environment variables

Set everything in [`.env.example`](.env.example) under
**Settings → Environment Variables**. Mint each token with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

`CRON_SECRET` is one you create, not one Vercel generates. Vercel attaches
`Authorization: Bearer $CRON_SECRET` to cron invocations only if the variable
already exists — leave it blank and every run gets a 401. Since Vercel never
retries a cron and does not surface cron failures, that fails completely
silently. Verify it after the first deploy:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
     -H "user-agent: vercel-cron/1.0" \
     https://<your-deployment>/api/cron/flush
```

then check that `GET /api/status` reports a fresh `lastFlush`.

### 5. Point the extension at it

```bash
cd .. && npm run build     # then reload the unpacked extension from dist/
```

Open the popup → **Settings** → paste the deployment URL and the token → Save.
Saving requests the host permission for that origin, so it has to happen from
the button click. Hit **Test connection**.

Then **Queue → target draft** and pick which `_drafts/` file links land in.
Until a target is set, flushes fail loudly and leave the buffer untouched
rather than guessing.

## API

Everything except `/api/health` needs `Authorization: Bearer $SQUIRREL_TOKEN`.
`/api/cron/flush` takes `CRON_SECRET` instead — the two tokens are not
interchangeable in either direction.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness. No auth. |
| GET | `/api/categories` | The six section definitions. |
| GET | `/api/status` | Buffer depth, oldest link age, target, last flush + its error. |
| GET | `/api/links` | Buffered links, paginated (`limit`, `offset`). |
| POST | `/api/links` | Enqueue. Honours `Idempotency-Key`. Never touches GitHub. |
| PATCH | `/api/links/:id` | Edit title, description, category or url. |
| DELETE | `/api/links/:id` | Drop a buffered link. |
| POST | `/api/flush` | Write the buffer into the target draft. |
| GET | `/api/drafts` | Candidate drafts, by opaque id. |
| GET/PUT | `/api/target` | Read or set the draft flushes write into. |
| POST | `/api/publish` | Draft → `_posts/`, one commit. |
| GET | `/api/cron/flush` | Vercel Cron entry point. |

`POST /api/flush` always answers 200 for a well-formed request. The outcome
lives in `ok` and `reason` (`ok`, `empty`, `locked`, `no-target`, `nothing-new`,
`error`) so that a failed flush can never make the extension re-enqueue links it
already delivered.

Publishing takes a `draftId`, never a path, and builds the `_posts/` destination
itself from the draft's front-matter title. A caller cannot name the file that
gets written.

## Flush timing

Two independent triggers, because the plan constrains one of them:

- **The extension** fires `POST /api/flush` on a 15-minute `chrome.alarms`
  timer, and immediately when the server reports `flushSuggested` (5+ buffered
  links, or the oldest past 12h). This is the primary trigger.
- **Vercel Cron** runs `0 6 * * *` as a safety net for links left buffered
  while the browser is closed.

Hobby caps cron at once per day and *fails the deployment* on anything more
frequent — `*/15 * * * *` breaks the build rather than skipping runs. On Pro,
change that one field in `vercel.json`.

## Deploying

`.github/workflows/deploy-server.yml` deploys to production on any push to
`master` that touches `server/**`, after the tests pass. It needs three
repository secrets:

| Secret | Where to get it |
| --- | --- |
| `VERCEL_TOKEN` | vercel.com/account/tokens |
| `VERCEL_ORG_ID` | `.vercel/project.json` after `vercel link`, or dashboard → Settings |
| `VERCEL_PROJECT_ID` | same |

**Only those three.** `GITHUB_TOKEN`, the Upstash credentials, `SQUIRREL_TOKEN`
and `CRON_SECRET` stay in Vercel project settings — they are runtime
environment, read by the function when it executes, and never pass through CI.
Copying them into GitHub would only widen where they can leak from.

### The one thing that will bite you

Every Vercel CLI step runs from the **repository root**, never from `server/`.
The CLI resolves the project's Root Directory relative to the working
directory:

```js
const workPath = join(cwd, project.settings.rootDirectory || '.')
```

So running the CLI inside `server/` resolves to `server/server`, which builds
zero functions, registers zero crons — and still exits 0. You get a green tick
on an empty deployment. The workflow asserts a non-zero function count after
`vercel build` precisely so that cannot pass silently.

### If you imported the repo in the dashboard

Vercel's Git integration will then deploy on push as well, racing the Actions
workflow. Turn it off by adding to `server/vercel.json`:

```json
"git": { "deploymentEnabled": false }
```

A bare `false` covers every branch; `{"master": false}` would stop production
but still double-deploy every PR. Don't use "Ignored Build Step" for this —
a cancelled build still counts as a deployment against your quota. If you
created the project with `vercel link` instead, there is no Git integration and
nothing to disable.

### Notes

- Crons only attach to **production** deployments. A preview deploy carries the
  config but nothing fires.
- Preview deployments have Deployment Protection on by default, which answers
  with an HTML login page — point the extension at production, not a preview.
- The workflow smoke-tests `/api/health` for 200 and `/api/status` for 401
  after deploying, so a broken auth wrapper fails the run rather than sitting
  live.
- `vercel pull` writes your production env vars to `.vercel/.env.production.local`
  on the runner. They are build-time only and `.vercel/` is gitignored, but the
  file does briefly exist on disk there.
- Add required reviewers to the `production` GitHub Environment if you want a
  manual gate before anything reaches master's deployment.

## Local development

```bash
npm install
npm run typecheck
npm test
```

`vercel dev` does not run cron jobs. Exercise that path by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
     -H "user-agent: vercel-cron/1.0" \
     http://localhost:3000/api/cron/flush
```

## What still runs locally

`src/blogBackend.js` in the parent repo is now only an optional AI sidecar on
`localhost:3001`, exposing `/health` and `/api/analyze-link`. It shells out to
the local `claude` CLI to suggest a category and description. It is genuinely
optional: with it absent the extension works exactly the same, minus the
auto-suggestion. No AI key ever reaches Vercel.

## Notes for whoever touches this next

- `api/_lib/markdown.ts` edits a live, hand-maintained blog. Its rules were
  derived from the real 233-file corpus and checked against kramdown 2.4.0, and
  the golden test asserts an insertion changes exactly one line. Sections are
  matched by anchor id, never by heading text — the headings contain typos,
  varying whitespace and trailing prose that have been there for years.
- URLs are normalised for dedupe only. The emitted URL is byte-for-byte what was
  captured, tracking parameters included: 291 links in the corpus carry
  newsletter attribution the author deliberately kept.
- `api/_lib/paths.ts` is a security boundary. Real filenames contain spaces and
  colons, so it rejects separators and dot-dot rather than allowlisting
  characters.
- Anything under `api/` whose path contains `/_` is not deployed as a function,
  which is why shared code lives in `api/_lib/`.
- Relative imports need a `.js` suffix (`./types.js` for `types.ts`) — the
  tsconfig is NodeNext.
