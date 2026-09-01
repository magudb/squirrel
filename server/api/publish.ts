import { HttpError, methods, readJsonBody, withApiAuth } from './_lib/http.js';
import type { FrontMatterPatch } from './_lib/markdown.js';
import { publish } from './_lib/publish.js';
import { normalizeDescription, normalizeDraftTitle, normalizeKeywords } from './_lib/template.js';

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
 * The front matter a publish may rewrite, validated here rather than deeper in.
 *
 * Every value goes through the same normaliser the draft template uses, because
 * it lands in the same place: a double-quoted YAML scalar in a file whose
 * malformed front matter fails the build of the entire blog. That matters more
 * than usual now that the text can come from a local AI that just read an
 * arbitrary web page — the model's answer is data, and this is where it stops
 * being trusted.
 *
 * An empty `meta` object is treated as no metadata at all, so a client that
 * always sends the key does not turn every publish into a front-matter rewrite.
 */
function optionalMeta(raw: unknown): FrontMatterPatch | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'meta must be an object', 'bad_request');
  }

  const source = raw as Record<string, unknown>;
  const patch: FrontMatterPatch = {};
  if (source.title !== undefined) patch.title = normalizeDraftTitle(source.title);
  if (source.description !== undefined) patch.description = normalizeDescription(source.description);
  if (source.keywords !== undefined) patch.keywords = normalizeKeywords(source.keywords);

  return Object.keys(patch).length === 0 ? undefined : patch;
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
      const meta = optionalMeta(body.meta);
      if (meta !== undefined) input.meta = meta;

      res.status(200).json(await publish(input));
    },
  }),
);
