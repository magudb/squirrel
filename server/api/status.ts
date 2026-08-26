import { flushPolicy } from './_lib/env.js';
import { methods, withApiAuth } from './_lib/http.js';
import { countPending, getLastFlush, getTarget, oldestPendingAgeMs } from './_lib/store.js';
import type { StatusResponse } from './_lib/types.js';
// The same predicate POST /api/links answers with, so polling status and saving
// a link cannot disagree about whether the buffer wants flushing.
import { suggestsFlush } from './links/index.js';

/**
 * The extension's only window into a buffer that has stopped draining.
 *
 * Everything here fails silently otherwise: a fine-grained GitHub PAT expires
 * after 30 days by default, and from that moment every flush is a 401 that
 * nobody sees while the buffer grows for weeks. So the whole `LastFlush` record
 * is passed through untouched — `error` is the field that turns "nothing is
 * happening" into "the token expired on the 14th".
 */
export default withApiAuth(
  methods({
    GET: async (_req, res) => {
      const policy = flushPolicy();
      const [pendingCount, oldestAgeMs, target, lastFlush] = await Promise.all([
        countPending(),
        oldestPendingAgeMs(),
        getTarget(),
        getLastFlush(),
      ]);

      const status: StatusResponse = {
        pendingCount,
        oldestAgeMinutes: oldestAgeMs === null ? null : Math.floor(oldestAgeMs / 60_000),
        flushSuggested: suggestsFlush(pendingCount, oldestAgeMs, policy),
        target,
        lastFlush,
        thresholds: { linkCount: policy.linkCount, maxAgeMinutes: policy.maxAgeMinutes },
      };

      res.status(200).json(status);
    },
  }),
);
