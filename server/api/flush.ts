import { runFlush } from './_lib/flush.js';
import { methods, withApiAuth } from './_lib/http.js';

/**
 * Drain the buffer into the target draft.
 *
 * A well-formed request always answers 200 and carries the outcome in `ok` and
 * `reason`. Returning 500 for a flush that could not run would tell the
 * extension its own request failed, and its outbox would re-POST links that are
 * already safely buffered — a failed flush must never cost a link.
 *
 * Called by the extension's service worker (which survives the popup) when a
 * save comes back with `flushSuggested`, and on its own 15-minute alarm.
 */
export default withApiAuth(
  methods({
    POST: async (_req, res) => {
      const result = await runFlush();
      res.status(200).json(result);
    },
  }),
);
