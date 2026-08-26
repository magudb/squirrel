import type { FailedLink, FlushResult, QueueState } from './types';
import { getConfig, hasHostPermission, SquirrelApi, SquirrelApiError } from './utils/squirrelApi';

/**
 * Durable outbox for the link service.
 *
 * The popup's document — and every fetch it started — is destroyed the moment
 * focus leaves it, so the popup may not own the save. It appends to the outbox
 * and returns; this worker does the network.
 *
 * Nothing that must survive lives in a module variable: the worker is killed
 * after 30s idle and every global goes with it. The queue, the attempt counts
 * and the last send and flush errors all live in chrome.storage.local.
 */

/** Derived from the API surface so an outbox entry and a request body cannot drift. */
type NewLink = Parameters<typeof SquirrelApi.createLink>[0];

type SwRequest =
  | { type: 'QUEUE_LINK'; link: NewLink }
  | { type: 'DRAIN_QUEUE' }
  | { type: 'GET_QUEUE_STATE' }
  | { type: 'RETRY_FAILED' };

interface OutboxEntry {
  /** Also the Idempotency-Key, so a retried POST can never double-enqueue. */
  id: string;
  link: NewLink;
  queuedAt: number;
  attempts: number;
  /** Retries exhausted. Kept in the outbox so `GET_QUEUE_STATE` can surface it
   *  and `RETRY_FAILED` can revive it — never dropped. */
  failed?: boolean;
  error?: string;
}

interface DrainSummary {
  sent: number;
  failed: number;
}

const OUTBOX_KEY = 'outbox';
const LAST_ERROR_KEY = 'lastError';
const FLUSH_ERROR_KEY = 'flushError';
const DRAIN_ALARM = 'squirrel-drain';
const FLUSH_ALARM = 'squirrel-flush';
const DRAIN_PERIOD_MINUTES = 1;
const FLUSH_PERIOD_MINUTES = 15;
const MAX_ATTEMPTS = 8;
const REQUEST_DEADLINE_MS = 20_000;

/**
 * The protocol the popup speaks:
 *
 *   QUEUE_LINK       append a link, start a drain   -> { ok, queued }
 *   DRAIN_QUEUE      send what is queued now        -> { ok, sent, failed }
 *   GET_QUEUE_STATE  queued / failed / errors       -> { ok, ...QueueState }
 *   RETRY_FAILED     revive exhausted entries       -> { ok, retried }
 *
 * RETRY_FAILED exists because `failed` was otherwise terminal: an entry that
 * ran out of attempts stayed in the outbox with no path back out of it, so a
 * link the user was told was saved never reached the blog and nothing could
 * ask for it again.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'Unauthorized' });
    return false;
  }

  const request = asRequest(message);
  if (!request) {
    // Answer rather than falling through. Returning without calling
    // sendResponse closes the channel and the caller just sees `undefined`,
    // which it can only report as a generic refusal — the exact shape of a
    // stale worker still running the previous protocol after a rebuild, and
    // indistinguishable from a malformed link until you go read this file.
    sendResponse({
      ok: false,
      error:
        `Unrecognised message: ${describeMessage(message)}. ` +
        'If the extension was rebuilt, reload it at chrome://extensions so the ' +
        'service worker picks up the new code.',
    });
    return false;
  }

  switch (request.type) {
    case 'QUEUE_LINK':
      queueLink(request.link)
        .then((queued) => sendResponse({ ok: true, queued }))
        .catch((error) => sendResponse({ ok: false, error: describe(error) }));
      return true;

    case 'DRAIN_QUEUE':
      drain()
        .then((summary) => sendResponse({ ok: summary.failed === 0, ...summary }))
        .catch((error) => sendResponse({ ok: false, sent: 0, failed: 0, error: describe(error) }));
      return true;

    case 'GET_QUEUE_STATE':
      queueState()
        .then((state) => sendResponse({ ok: true, ...state }))
        .catch((error) => sendResponse({ ok: false, error: describe(error) }));
      return true;

    case 'RETRY_FAILED':
      retryFailed()
        .then((retried) => sendResponse({ ok: true, retried }))
        .catch((error) => sendResponse({ ok: false, error: describe(error) }));
      return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DRAIN_ALARM) {
    void drain();
    return;
  }
  if (alarm.name === FLUSH_ALARM) {
    void scheduledFlush();
  }
});

chrome.runtime.onInstalled.addListener(() => void bootstrap());
chrome.runtime.onStartup.addListener(() => void bootstrap());

chrome.commands.onCommand.addListener((command) => {
  // Chrome opens the popup for _execute_action itself. The listener stays so a
  // future command lands here instead of nowhere.
  if (command !== '_execute_action') {
    console.warn('Unhandled command:', command);
  }
});

async function bootstrap(): Promise<void> {
  await ensureAlarms();
  await refreshBadge();
  await drain();
}

async function ensureAlarms(): Promise<void> {
  // create() replaces a same-named alarm and restarts its period from zero, so
  // a browser that restarts every few minutes would never reach the 15-minute
  // flush. Only create what is missing.
  if (!(await chrome.alarms.get(DRAIN_ALARM))) {
    await chrome.alarms.create(DRAIN_ALARM, { periodInMinutes: DRAIN_PERIOD_MINUTES });
  }
  if (!(await chrome.alarms.get(FLUSH_ALARM))) {
    await chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: FLUSH_PERIOD_MINUTES });
  }
}

async function queueLink(link: NewLink): Promise<number> {
  const queued = await mutateOutbox((entries) => {
    const next = [...entries, { id: crypto.randomUUID(), link, queuedAt: Date.now(), attempts: 0 }];
    return { entries: next, result: next.length };
  });

  // Never awaited: the popup that sent this is free to close immediately, and
  // the alarm covers the case where this worker dies mid-drain.
  void drain();
  return queued;
}

async function queueState(): Promise<QueueState> {
  const [entries, lastError, flushError] = await Promise.all([
    readOutbox(),
    readLastError(),
    readFlushError(),
  ]);
  return {
    queued: entries.filter((entry) => !entry.failed).length,
    failed: entries.filter((entry) => entry.failed).map(describeFailed),
    lastError,
    flushError,
  };
}

/** The popup renders these; it has no business knowing the outbox shape. */
function describeFailed(entry: OutboxEntry): FailedLink {
  return {
    id: entry.id,
    url: entry.link.url,
    title: entry.link.title,
    queuedAt: entry.queuedAt,
    attempts: entry.attempts,
    error: entry.error,
  };
}

/**
 * Clear the attempt counters so the drain picks these up again. The usual cause
 * of exhaustion is a wrong service URL or a rejected token, and by the time the
 * user asks for a retry they have just corrected one of them.
 */
async function retryFailed(): Promise<number> {
  const revived = await mutateOutbox((entries) => {
    let count = 0;
    const next = entries.map((entry) => {
      if (!entry.failed) return entry;
      count += 1;
      // Rebuilt rather than spread, so `failed` and the stale error leave the
      // record entirely instead of lingering as falsy leftovers.
      return { id: entry.id, link: entry.link, queuedAt: entry.queuedAt, attempts: 0 };
    });
    return { entries: next, result: count };
  });

  await setLastError(null);
  void drain();
  return revived;
}

let draining: Promise<DrainSummary> | null = null;

/**
 * Coalesce overlapping triggers — a QUEUE_LINK and the 1-minute alarm land
 * together often. This is a liveness guard, not state; a terminated worker
 * simply starts a fresh drain from what storage still holds.
 */
function drain(): Promise<DrainSummary> {
  if (!draining) {
    draining = runDrain().finally(() => {
      draining = null;
    });
  }
  return draining;
}

async function runDrain(): Promise<DrainSummary> {
  const summary: DrainSummary = { sent: 0, failed: 0 };
  if (!(await isConfigured())) return summary;

  const pending = (await readOutbox()).filter((entry) => !entry.failed);
  if (pending.length === 0) {
    await setLastError(null);
    return summary;
  }

  let flushSuggested = false;
  let lastError: string | null = null;

  for (const entry of pending) {
    try {
      const response = await withDeadline(SquirrelApi.createLink(entry.link, entry.id));
      flushSuggested = flushSuggested || response.flushSuggested;
      await forget(entry.id);
      summary.sent += 1;
    } catch (error) {
      lastError = describe(error);
      await recordAttempt(entry.id, lastError);
      summary.failed += 1;
      // A 400 is about this one link, so the rest of the batch still has a
      // chance. A dead host or a rejected token will fail every remaining entry
      // identically — stop rather than spend an attempt on each of them.
      if (isSystemic(error)) break;
    }
  }

  if (flushSuggested) {
    // The links are already accepted server-side, so a failed flush is worth
    // reporting but does not make the drain itself a failure — hence its own
    // key rather than `lastError`.
    try {
      await setFlushError(flushFailure(await withDeadline(SquirrelApi.flush())));
    } catch (error) {
      await setFlushError(describe(error));
    }
  }

  await setLastError(lastError);
  return summary;
}

/**
 * The 15-minute alarm is the primary time-based flush trigger: the user is on
 * Vercel Hobby, where cron runs once a day, so the server-side schedule is only
 * a safety net for a closed browser.
 */
async function scheduledFlush(): Promise<void> {
  if (!(await isConfigured())) return;

  // Anything still in the outbox would otherwise miss this window and wait
  // another fifteen minutes to reach the draft.
  await drain();

  try {
    await setFlushError(flushFailure(await withDeadline(SquirrelApi.flush())));
  } catch (error) {
    await setFlushError(describe(error));
  }
}

/**
 * `POST /api/flush` answers 200 whether or not the flush worked — the outcome
 * rides in `ok` and `reason` — so a promise that resolves proves nothing. An
 * expired GitHub token fails every flush this way, and without reading the
 * result the buffer would grow for weeks with the toolbar showing nothing.
 */
function flushFailure(result: FlushResult): string | null {
  // Another flush already holds the lock, or there was nothing to send. Both
  // are the system working.
  if (result.ok || result.reason === 'locked' || result.reason === 'empty') return null;
  if (result.reason === 'no-target') {
    return 'No target draft is set — choose the draft to collect links in before the buffer can be flushed.';
  }
  return result.error ?? `The flush failed (${result.reason}).`;
}

async function isConfigured(): Promise<boolean> {
  const config = await getConfig();
  if (!config) return false;
  // Without the origin granted the fetch degrades to a CORS request against a
  // service that does not answer preflights for it. Bail quietly instead — the
  // settings UI is where the user grants it, under a real click.
  return hasHostPermission(config.baseUrl);
}

/**
 * The platform kills this worker outright when a single fetch outlives 30s, so
 * no wait here may come near that. SquirrelApi owns the socket; this bounds how
 * long the drain waits on it. A straggler that lands after the deadline is
 * harmless: the Idempotency-Key makes the retry a no-op server-side.
 */
function withDeadline<T>(work: Promise<T>, ms = REQUEST_DEADLINE_MS): Promise<T> {
  const expiry = AbortSignal.timeout(ms);
  const timeout = new Promise<never>((_, reject) => {
    expiry.addEventListener('abort', () => reject(new Error(`Request exceeded ${ms}ms`)), { once: true });
  });
  return Promise.race([work, timeout]);
}

/** A per-link rejection leaves the batch viable; anything else does not. */
function isSystemic(error: unknown): boolean {
  if (!(error instanceof SquirrelApiError)) return true;
  if (error.status === undefined) return true;
  return error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500;
}

async function forget(id: string): Promise<void> {
  await mutateOutbox((entries) => ({
    entries: entries.filter((entry) => entry.id !== id),
    result: undefined,
  }));
}

async function recordAttempt(id: string, error: string): Promise<void> {
  await mutateOutbox((entries) => ({
    entries: entries.map((entry) => {
      if (entry.id !== id) return entry;
      const attempts = entry.attempts + 1;
      // Exhausted entries stop being retried but stay in the outbox, badged and
      // listed, until RETRY_FAILED clears the counter. Losing a link the user
      // thought was saved is worse than a stuck badge.
      return { ...entry, attempts, error, failed: attempts >= MAX_ATTEMPTS };
    }),
    result: undefined,
  }));
}

let mutations: Promise<unknown> = Promise.resolve();

/**
 * Every outbox write is a read-modify-write and a QUEUE_LINK can land while a
 * drain is mid-flight. Serialising them through one chain stops a drain that
 * read the outbox before the append from writing the new entry back out.
 */
function mutateOutbox<T>(apply: (entries: OutboxEntry[]) => { entries: OutboxEntry[]; result: T }): Promise<T> {
  const next = mutations.then(async () => {
    const { entries, result } = apply(await readOutbox());
    await chrome.storage.local.set({ [OUTBOX_KEY]: entries });
    await refreshBadge(entries);
    return result;
  });
  mutations = next.catch(() => undefined);
  return next;
}

async function readOutbox(): Promise<OutboxEntry[]> {
  const stored = await chrome.storage.local.get(OUTBOX_KEY);
  const entries = stored[OUTBOX_KEY];
  return Array.isArray(entries) ? (entries as OutboxEntry[]) : [];
}

async function readLastError(): Promise<string | null> {
  const stored = await chrome.storage.local.get(LAST_ERROR_KEY);
  const lastError = stored[LAST_ERROR_KEY];
  return typeof lastError === 'string' ? lastError : null;
}

async function setLastError(message: string | null): Promise<void> {
  await chrome.storage.local.set({ [LAST_ERROR_KEY]: message });
  await refreshBadge();
}

async function readFlushError(): Promise<string | null> {
  const stored = await chrome.storage.local.get(FLUSH_ERROR_KEY);
  const flushError = stored[FLUSH_ERROR_KEY];
  return typeof flushError === 'string' ? flushError : null;
}

/**
 * Kept apart from `lastError`: the links behind a flush failure are safely
 * buffered server-side, so this is the blog pipeline stalling rather than the
 * outbox failing to send, and a clean drain must not erase it.
 */
async function setFlushError(message: string | null): Promise<void> {
  await chrome.storage.local.set({ [FLUSH_ERROR_KEY]: message });
  await refreshBadge();
}

/**
 * The only monitoring a silently stuck buffer gets. An expired token turns
 * every drain into a 401 and the outbox grows invisibly otherwise.
 */
async function refreshBadge(entries?: OutboxEntry[]): Promise<void> {
  const outbox = entries ?? (await readOutbox());
  const [lastError, flushError] = await Promise.all([readLastError(), readFlushError()]);
  const dead = outbox.filter((entry) => entry.failed).length;
  const stuck = dead > 0 || lastError !== null || flushError !== null;
  const text = stuck ? '!' : outbox.length > 0 ? String(outbox.length) : '';

  await chrome.action.setBadgeText({ text });
  if (text !== '') {
    await chrome.action.setBadgeBackgroundColor({ color: stuck ? '#c0392b' : '#4a5568' });
  }
  await chrome.action.setTitle({ title: badgeTitle(outbox.length - dead, dead, lastError, flushError) });
}

/** A one-character badge cannot say what is wrong; hovering it has to. */
function badgeTitle(
  queued: number,
  dead: number,
  lastError: string | null,
  flushError: string | null,
): string {
  const lines: string[] = [];
  if (dead > 0) {
    lines.push(`${dead} ${dead === 1 ? 'link' : 'links'} gave up sending — open Squirrel to retry`);
  }
  if (queued > 0) lines.push(`${queued} waiting to send`);
  if (lastError !== null) lines.push(`Last error: ${lastError}`);
  if (flushError !== null) lines.push(`Last flush: ${flushError}`);
  return lines.length === 0 ? 'Squirrel' : `Squirrel — ${lines.join('\n')}`;
}

function asRequest(message: unknown): SwRequest | null {
  if (typeof message !== 'object' || message === null) return null;
  const { type, link } = message as { type?: unknown; link?: unknown };

  if (type === 'DRAIN_QUEUE' || type === 'GET_QUEUE_STATE' || type === 'RETRY_FAILED') {
    return { type };
  }
  if (type !== 'QUEUE_LINK') return null;

  // A malformed link would sit in a durable queue failing eight times before
  // anyone noticed, so it is rejected at the door instead.
  if (typeof link !== 'object' || link === null) return null;
  const { url, title } = link as { url?: unknown; title?: unknown };
  if (typeof url !== 'string' || url === '' || typeof title !== 'string') return null;

  return { type, link: link as NewLink };
}

/** Enough of a rejected message to identify it, without logging link contents. */
function describeMessage(message: unknown): string {
  if (typeof message !== 'object' || message === null) return typeof message;
  const { type } = message as { type?: unknown };
  return typeof type === 'string' ? `type=${type}` : 'no type field';
}

function describe(error: unknown): string {
  if (error instanceof SquirrelApiError && error.status !== undefined) {
    return `${error.status} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
