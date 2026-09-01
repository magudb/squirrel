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
| GET | `/api/drafts` | Candidate drafts, by opaque id. `?id=` returns one with its body. |
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

### Metadata at publish time

The draft template ships `description` and `keywords` empty for the author to
fill in at publish time, and a digest's title is written in week one and read
three months later — by which point the links under it have wandered. So
`POST /api/publish` takes an optional `meta`:

```json
{ "draftId": "…", "meta": { "title": "…", "description": "…", "keywords": "…" } }
```

Those three scalars are rewritten in the front matter **inside the same commit
that creates the post**. A second commit would break the property the whole
module is built on: the blog's announce job keys on files ADDED under `_posts/`,
so a post created first and corrected after is announced with the draft's
metadata.

- Every value goes through the same normaliser as a new draft's title — control
  characters, `<`, `>` and over-long values are 400s, and `"` and `\` are
  escaped. A malformed scalar fails the build of the entire blog, and this text
  now arrives from an AI that just read an arbitrary web page.
- `meta.title` also names the destination file, and therefore the post's URL. An
  explicit `slug` still wins.
- A draft with no front matter is a 409 `no_front_matter`, raised before the
  buffer is claimed. `_drafts/2025-06-20-on AI.md` is that case.
- The response carries `metaUpdated`, the fields actually written.

The judgement itself is not made here. `GET /api/drafts?id=` hands the draft to
the extension, the local AI sidecar reads the links and proposes the metadata,
and the author edits it before it is sent back. This service only validates and
writes.

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

### If a deployment comes back BLOCKED

The CLI reports this with an empty error and the dashboard shows nothing
useful. The reason is in the API response, not the CLI output:

```bash
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v13/deployments/<deployment-url>?teamId=<team>" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['readyStateReason'])"
```

The one that bit us:

> Git author `mlu@testaviva.dk` must have access to the team Magnus on Vercel
> to create deployments.

Vercel checks the **commit author of HEAD** against the accounts holding a seat
on the team. The repo committed under a work address while the Vercel account
is `magnus@udbjorg.net`, so every deploy was refused — including, crucially,
deploys from GitHub Actions, which check out the repo and read the same author.

Two fixes, both real:

- Add the second address to the Vercel account (Account → Emails, then verify).
  Works no matter who authors a given commit — prefer this if more than one
  machine or identity ever commits here.
- `git config --local user.email magnus@udbjorg.net`, which is what this repo
  now does. Only holds while HEAD carries that address.

Do **not** work around it with `vercel deploy --meta githubCommitAuthorEmail=…`.
That does not grant access, it just records an author who did not write the
commit.

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

`src/blogBackend.js` in the parent repo is an AI sidecar on `localhost:3001`,
exposing `/health`, `/api/analyze-link` and `/api/review-metadata`. It shells out
to the local `claude` CLI (or `codex`); no AI key ever reaches Vercel.

`/api/analyze-link` is genuinely optional — with it absent the extension works
exactly the same, minus the auto-suggestion.

`/api/review-metadata` is not. It reads a draft's links and judges whether the
front matter still describes them, and the popup blocks publishing until it has
answered, so an issue cannot ship with the description of a different one. That
makes publishing a thing you do from a machine running the sidecar. A review of
a real fifteen-link digest takes about 40s, which is why the extension gives it
its own 120s budget rather than the 30s an `analyze-link` gets.

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
