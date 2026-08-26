import { runFlush } from '../_lib/flush.js';
import { methods, withCronAuth } from '../_lib/http.js';

/**
 * The daily safety net for when the browser — and therefore the extension's own
 * flush alarm — has been closed for a while.
 *
 * Vercel Cron issues a plain GET, never retries a failure, does not surface one,
 * is best-effort and can occasionally fire twice. That last part is only
 * survivable because `runFlush` claims the buffer atomically and dedupes against
 * the draft's own content, so a second concurrent run writes nothing.
 *
 * `ok: true` reports that the invocation ran; whether the flush achieved
 * anything is `result.ok`.
 */
export default withCronAuth(
  methods({
    GET: async (_req, res) => {
      const result = await runFlush();
      res.status(200).json({ ok: true, result });
    },
  }),
);
