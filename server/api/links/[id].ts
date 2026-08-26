import type { VercelRequest, VercelResponse } from '@vercel/node';
import { HttpError, firstQuery, methods, readJsonBody, withApiAuth } from '../_lib/http.js';
import { getLink, putLink, removeLinks } from '../_lib/store.js';
import type { PendingLink } from '../_lib/types.js';
// The same validators the create path uses. An edit that accepted what a create
// rejects would be a second, quieter way into the buffer.
import { optionalDescription, requireTitle, requireUrl, resolveCategory } from './index.js';

/**
 * Mirrors `newLinkId`. The id is concatenated into a `squirrel:link:` key and
 * used as a ZSET member, so a shape this route has never minted is refused
 * before it reaches Redis rather than looked up and reported missing.
 */
const LINK_ID = /^lnk_[0-9a-z]+_[0-9a-f]{8}$/;

function requireId(req: VercelRequest): string {
  const id = firstQuery(req.query.id);
  if (id === undefined || !LINK_ID.test(id)) {
    throw new HttpError(400, 'Malformed link id', 'bad_link_id');
  }
  return id;
}

/**
 * Read, merge, write back. `putLink` rewrites the payload only, so an edit
 * never moves the link's ZSET score — its queue position and the age that
 * drives the flush trigger both survive.
 */
async function patch(req: VercelRequest, res: VercelResponse): Promise<void> {
  const id = requireId(req);
  const body = readJsonBody(req);

  const link = await getLink(id);
  if (link === null) {
    throw new HttpError(404, 'No such link', 'not_found');
  }

  const merged: PendingLink = { ...link };
  if ('url' in body) merged.url = requireUrl(body.url);
  if ('title' in body) merged.title = requireTitle(body.title);
  if ('category' in body) merged.category = resolveCategory(body.category);
  if ('description' in body) {
    const description = optionalDescription(body.description);
    // An explicit null or empty string is the client asking to fall back to the
    // title, so the field is dropped rather than stored blank.
    if (description === undefined) delete merged.description;
    else merged.description = description;
  }

  await putLink(merged);
  res.status(200).json({ link: merged });
}

/**
 * `removeLinks` clears the index member and the payload together. Clearing only
 * the payload would leave a member whose score keeps answering "the oldest link
 * is older than the max age" — a flush loop that can never make progress.
 *
 * No 404 on an id that is already gone: the extension retries a failed delete,
 * and the second attempt has achieved exactly what was asked.
 */
async function remove(req: VercelRequest, res: VercelResponse): Promise<void> {
  await removeLinks([requireId(req)]);
  res.status(204).end();
}

export default withApiAuth(methods({ PATCH: patch, DELETE: remove }));
