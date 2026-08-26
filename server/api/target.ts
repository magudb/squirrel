import { listDir } from './_lib/github.js';
import { HttpError, methods, readJsonBody, withApiAuth } from './_lib/http.js';
import { DRAFTS_DIR, assertWritablePath, decodeDraftId, encodeDraftId } from './_lib/paths.js';
import { getTarget, setTarget } from './_lib/store.js';
import type { TargetDraft } from './_lib/types.js';

/**
 * The single draft every flush writes into.
 *
 * It is global rather than recorded per link because a per-link target is a
 * stale pointer: publish a draft and every link still buffered against it names
 * a file that has moved to `_posts/`, fails its write with a 404 and is stuck in
 * the buffer forever. One target that publish re-points atomically has nothing
 * to strand.
 */
export default withApiAuth(
  methods({
    GET: async (_req, res) => {
      res.status(200).json({ target: await getTarget() });
    },

    PUT: async (req, res) => {
      const body = readJsonBody(req);
      // Opaque id in, filename out. The directory is never client-supplied —
      // a caller that could name the path could name `_config.yml`.
      const filename = decodeDraftId(typeof body.draftId === 'string' ? body.draftId : '');

      // Resolved against a listing fetched right now, not a cached one: an id is
      // only an allowlist entry while the file is actually in `_drafts/`, and a
      // draft published last week must 404 rather than become a write target.
      const entry = (await listDir(DRAFTS_DIR)).find((candidate) => candidate.name === filename);
      if (entry === undefined) {
        throw new HttpError(404, 'No such draft', 'draft_not_found');
      }

      // Belt and braces: the path stored here is handed to a commit later, and
      // this is the same gate the flush and the publish go through.
      assertWritablePath(entry.path);

      const target: TargetDraft = {
        draftId: encodeDraftId(filename),
        path: entry.path,
        setAt: Date.now(),
      };
      await setTarget(target);
      res.status(200).json({ target });
    },
  }),
);
