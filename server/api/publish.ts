import { HttpError, methods, readJsonBody, withApiAuth } from './_lib/http.js';
import { publish } from './_lib/publish.js';

/** Kept in step with `publish` itself rather than restated, so the two cannot drift. */
type PublishInput = Parameters<typeof publish>[0];

function optionalString(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new HttpError(400, `${field} must be a string`, 'bad_request');
  }
  return raw;
}

/**
 * Move the target draft into `_posts/`.
 *
 * The request names a draft and nothing else: the destination filename is built
 * server-side from the title (or an explicit slug) and the date, because a
 * caller who could name the written path could name `_config.yml` or a workflow
 * file, and a Git Data tree entry takes its path raw.
 *
 * Errors are deliberately not caught here — `publish` raises `HttpError` for the
 * cases the client has to tell apart: 404 for a draft that is no longer in
 * `_drafts/`, 409 for a post that already exists at the destination.
 */
export default withApiAuth(
  methods({
    POST: async (req, res) => {
      const body = readJsonBody(req);

      if (typeof body.draftId !== 'string') {
        throw new HttpError(400, 'A draftId is required', 'bad_draft_id');
      }
      if (body.prune !== undefined && typeof body.prune !== 'boolean') {
        throw new HttpError(400, 'prune must be a boolean', 'bad_request');
      }

      const input: PublishInput = { draftId: body.draftId };
      const slug = optionalString(body.slug, 'slug');
      if (slug !== undefined) input.slug = slug;
      const date = optionalString(body.date, 'date');
      if (date !== undefined) input.date = date;
      if (body.prune !== undefined) input.prune = body.prune;

      res.status(200).json(await publish(input));
    },
  }),
);
