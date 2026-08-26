import type { VercelRequest, VercelResponse } from '@vercel/node';
import { applyCors, methods } from './_lib/http.js';

const respond = methods({
  GET: (_req, res) => {
    res.status(200).json({ ok: true, service: 'squirrel', time: new Date().toISOString() });
  },
});

/**
 * The one unauthenticated route. It exists so the extension's settings screen
 * can tell "wrong base URL" apart from "wrong token" — a probe that needed the
 * token could not distinguish them. It touches neither Redis nor GitHub, so it
 * also answers "is the deployment up" without waking a dependency.
 */
export default function handler(req: VercelRequest, res: VercelResponse): Promise<void> | void {
  applyCors(req, res);
  return respond(req, res);
}
