import { listDir, readFile } from './_lib/github.js';
import { methods, withApiAuth } from './_lib/http.js';
import { DRAFTS_DIR, draftRefFromFile } from './_lib/paths.js';
import type { DraftRef } from './_lib/types.js';

/** A directory listing carries no content, so the front matter costs one read per file. */
const READ_CONCURRENCY = 6;

/** Both extensions are in use: the legacy drafts in this repo are `.markdown`. */
const MARKDOWN = /\.(md|markdown)$/i;

/**
 * Bounded rather than a bare `Promise.all` over the listing: the reads all go to
 * the same host under one PAT, and a directory that grows to fifty drafts would
 * otherwise open fifty sockets at once and earn a secondary rate limit.
 */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Curated drafts first, then newest by filename — every draft is date-prefixed,
 * so a plain descending string compare is the date order. Compared by code unit
 * rather than by locale so two deployments cannot disagree about the order.
 */
function byCuratedThenNewest(a: DraftRef, b: DraftRef): number {
  if (a.curated !== b.curated) return a.curated ? -1 : 1;
  if (a.filename === b.filename) return 0;
  return a.filename < b.filename ? 1 : -1;
}

/**
 * The draft picker for the extension. Clients only ever see the opaque `id` —
 * `PUT /api/target` and `POST /api/publish` both resolve it back against a fresh
 * listing, so no caller-supplied string ever reaches a commit as a path.
 */
export default withApiAuth(
  methods({
    GET: async (_req, res) => {
      const entries = (await listDir(DRAFTS_DIR)).filter((entry) => MARKDOWN.test(entry.name));
      const drafts = await mapBounded(entries, READ_CONCURRENCY, async (entry) => {
        // A draft with no front matter at all is a real case in this repo
        // (`_drafts/2025-06-20-on AI.md`); it lists with the filename as its
        // title and `curated: false` rather than failing the whole picker.
        const file = await readFile(entry.path);
        return draftRefFromFile(entry.name, file.text);
      });

      res.status(200).json(drafts.sort(byCuratedThenNewest));
    },
  }),
);
