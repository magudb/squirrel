export interface Link {
  id: string;
  url: string;
  title: string;
  selectedText?: string;
  description?: string;
  category: string;
  timestamp: number;
}

export interface Category {
  id: string;
  name: string;
  anchor: string;
}

export interface BlogPost {
  path: string;
  filename: string;
  title: string;
}

export interface TabInfo {
  title: string;
  url: string;
  selectedText?: string;
}

export interface AnalyzeLinkResponse {
  category: string;
  description: string;
  /** True when the result was served from the backend cache rather than freshly generated. */
  cached?: boolean;
}

/*
 * Everything below mirrors `server/api/_lib/types.ts` field for field. The two
 * files are a wire contract, not two independent models: a link round-trips
 * through the service without translation, so a drift here is a runtime bug
 * that no compiler on either side can see.
 */

/**
 * A link buffered by the service, waiting to be written into the draft.
 *
 * `id` is minted by the server (`lnk_…`); the extension's own local id travels
 * as the `Idempotency-Key` instead. `url` is whatever was captured, verbatim —
 * newsletter attribution is part of the published link.
 */
export interface PendingLink {
  id: string;
  url: string;
  title: string;
  selectedText?: string;
  description?: string;
  /** A `Category.id`. */
  category: string;
  /** Epoch ms when the server accepted the link. */
  addedAt: number;
  source?: string;
  targetSnapshot?: string;
}

/** A candidate draft in `_drafts/`, addressed by opaque id — never by path. */
export interface DraftRef {
  /** base64url(filename). The only draft identifier a client may send. */
  id: string;
  filename: string;
  /** Repo-relative path. Informational here; the server never accepts it back. */
  path: string;
  title: string;
  /** True when the front matter carries `category: "Curated Insights"`. */
  curated: boolean;
}

/** The draft that flushes currently write into. */
export interface TargetDraft {
  draftId: string;
  path: string;
  setAt: number;
}

export type FlushReason = 'ok' | 'empty' | 'locked' | 'no-target' | 'nothing-new' | 'error';

export interface FlushResult {
  ok: boolean;
  reason: FlushReason;
  flushId: string;
  committed: number;
  skipped: number;
  /** Returned to the buffer: their category has no section in the target draft. */
  unroutable: number;
  commitSha?: string;
  targetPath?: string;
  error?: string;
}

export interface LastFlush {
  at: number;
  flushId: string;
  reason: FlushReason;
  committed: number;
  skipped: number;
  unroutable: number;
  commitSha?: string;
  error?: string;
}

export interface StatusResponse {
  pendingCount: number;
  oldestAgeMinutes: number | null;
  flushSuggested: boolean;
  target: TargetDraft | null;
  lastFlush: LastFlush | null;
  thresholds: {
    linkCount: number;
    maxAgeMinutes: number;
  };
}

export interface PublishResult {
  ok: boolean;
  commitSha: string;
  postPath: string;
  draftPath: string;
  /** Buffered links folded into the post as part of the same commit. */
  linksIncluded: number;
  skipped: number;
  unroutable: number;
  prunedSections: string[];
}

/** The body of `POST /api/links`. No `id` and no `addedAt` — the server mints both. */
export interface NewLink {
  url: string;
  title: string;
  selectedText?: string;
  description?: string;
  category: string;
  source?: string;
}

/** The body of `PATCH /api/links/:id`. Every field is an opt-in overwrite. */
export interface LinkPatch {
  url?: string;
  title?: string;
  description?: string;
  category?: string;
}

export interface CreateLinkResponse {
  link: PendingLink;
  pendingCount: number;
  /** The service worker acts on this by issuing a separate `POST /api/flush`. */
  flushSuggested: boolean;
  /** A UX hint from the seen-URL cache, never a correctness claim. */
  duplicate?: boolean;
}

/** `baseUrl` is always an origin — no trailing slash, no path. */
export interface SquirrelConfig {
  baseUrl: string;
  token: string;
}

/**
 * A queued link the service worker gave up on after its retries ran out. It
 * stays in the outbox — losing a link the user was told was saved is worse
 * than a stuck badge — until `RETRY_FAILED` puts it back in rotation.
 */
export interface FailedLink {
  id: string;
  url: string;
  title: string;
  queuedAt: number;
  attempts: number;
  error?: string;
}

/** The answer to `GET_QUEUE_STATE`: everything the popup can say about the outbox. */
export interface QueueState {
  /** Entries still being retried. */
  queued: number;
  failed: FailedLink[];
  /** The last send failure, cleared by a drain that empties the outbox. */
  lastError: string | null;
  /** The last `POST /api/flush` that answered `ok: false` — links accepted by
   *  the service but not reaching the draft. */
  flushError: string | null;
}
