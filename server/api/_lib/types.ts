/**
 * Shared contracts for the Squirrel link service.
 *
 * These types are the interface between the Redis buffer, the GitHub writer and
 * the HTTP routes. They intentionally mirror `src/types/index.ts` in the
 * extension so a link can round-trip without translation.
 */

/** A section of the curated-links post. `anchor` is the `<a name="...">` id. */
export interface Category {
  id: string;
  name: string;
  anchor: string;
}

/**
 * A link waiting to be written into the draft.
 *
 * `url` is stored exactly as captured — newsletter attribution (`utm_*`) is
 * part of the published link and must survive verbatim. Normalisation happens
 * only when deriving a dedupe key; see `urlnorm.ts`.
 */
export interface PendingLink {
  /** Server-minted, always prefixed so it can never parse as a number. */
  id: string;
  url: string;
  title: string;
  selectedText?: string;
  description?: string;
  /** A `Category.id`. Validated on write. */
  category: string;
  /** Epoch ms when the server accepted the link. */
  addedAt: number;
  /** Free-form provenance, e.g. "extension". */
  source?: string;
  /** Snapshot of the target draft at enqueue time, for audit only. */
  targetSnapshot?: string;
}

/** A candidate draft in `_drafts/`, addressed by opaque id — never by path. */
export interface DraftRef {
  /** base64url(filename). The only draft identifier a client may send. */
  id: string;
  filename: string;
  /** Repo-relative path, e.g. `_drafts/2026-08-01-....md`. Server-side only. */
  path: string;
  /** Front-matter title, falling back to the filename. */
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

export type FlushReason =
  | 'ok'
  | 'empty'
  | 'locked'
  | 'no-target'
  | 'nothing-new'
  | 'error';

export interface FlushResult {
  ok: boolean;
  reason: FlushReason;
  flushId: string;
  /** Links written into the draft by this flush. */
  committed: number;
  /** Links dropped because the draft already contained the URL. */
  skipped: number;
  /**
   * Links returned to the buffer because their category has no matching
   * section in the target draft. Surfaced so the user can re-categorise them.
   */
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
