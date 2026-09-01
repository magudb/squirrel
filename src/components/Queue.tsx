import React, { useEffect, useState } from 'react';
import {
  useCreateDraft,
  useDrafts,
  usePublish,
  useQueue,
  useSquirrelCategories,
  useSquirrelConfig,
  useStatus,
} from '../hooks/useSquirrel';
import { useMetadataReview } from '../hooks/useMetadataReview';
import { SquirrelApiError } from '../utils/squirrelApi';
import { BackendError } from '../utils/blogService';
import type { Category, FlushResult, LinkPatch, PendingLink, PublishMeta } from '../types';

function formatAge(addedAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - addedAt) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One front-matter field, with what the file says today underneath it when the
 * two differ. Showing the old value matters more than it looks: the title drives
 * the post's filename, so "this is being changed" is the thing to notice before
 * the commit, not after.
 */
const MetaField: React.FC<{
  id: string;
  label: string;
  hint: string;
  value: string;
  current: string;
  maxLength: number;
  rows?: number;
  onChange: (value: string) => void;
}> = ({ id, label, hint, value, current, maxLength, rows, onChange }) => (
  <div>
    <label htmlFor={id} className="block text-xs font-medium text-gray-700">
      {label}
    </label>
    {rows === undefined ? (
      <input
        id={id}
        type="text"
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    ) : (
      <textarea
        id={id}
        value={value}
        rows={rows}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    )}
    {value.trim() !== current.trim() && (
      <p className="mt-1 text-xs text-gray-500">
        Was: {current.trim() === '' ? <em>empty</em> : <span className="italic">{current}</span>}
      </p>
    )}
    <p className="mt-0.5 text-xs text-gray-400">{hint}</p>
  </div>
);

/** Kept in step with MAX_TITLE_LENGTH in server/api/_lib/template.ts. */
const MAX_TITLE_LENGTH = 200;

/** The other two caps the service enforces on front-matter scalars. */
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_KEYWORDS_LENGTH = 200;

/**
 * Today on the user's calendar, not the service's.
 *
 * The date is sent with the request rather than left for the server to default,
 * so the file carries the day the user was looking at. Reading it in UTC here
 * would put the wrong day in the filename for the last two hours of every
 * evening in CEST, and a draft's date is not something you rename later.
 */
function todayIsoDate(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * `slugify` from `server/api/_lib/paths.ts`, ported for the filename preview —
 * minus the throw, because an empty slug is a state this form has to render
 * rather than an exception.
 *
 * Duplicating a rule is a real cost and the two copies can drift, so the reason
 * this one is worth it is worth stating. The publish confirmation shows the
 * failure mode: it used to name a destination the server would not create,
 * because the server takes the title from the draft's front matter as it reads
 * at commit time and the date from its own UTC clock — nothing computed in the
 * popup could have been right, so it now shows no filename at all. Creating a
 * draft is the opposite case: the title and the date are both typed here and
 * travel verbatim in the request body, which leaves slugify as the only
 * transformation between them and the path, and it is pure. The preview is
 * still labelled a preview, and the filename that gets reported afterwards is
 * the one the server sent back, never this one.
 */
function previewSlug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Apostrophes join words rather than separating them: "doesn't" -> "doesnt".
    .replace(/['\u2018\u2019]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

/**
 * A refused create is usually an answer rather than breakage, and the generic
 * "Request failed (HTTP 409)" tells the user nothing they can act on.
 */
function describeCreateError(error: unknown): { heading: string; detail: string; note: string } {
  const status = error instanceof SquirrelApiError ? error.status : undefined;

  if (status === 409) {
    return {
      heading: 'That draft already exists',
      detail:
        'A draft with that name already exists for that date. Change the title or the date, or select the existing draft as the target above.',
      note: 'Nothing was committed.',
    };
  }

  if (status === 400) {
    // Key on the code, not the status: `bad_date` comes back as a 400 too, and
    // a date rejection headed "would not accept that title" sends the user off
    // editing the wrong field.
    const code = error instanceof SquirrelApiError ? error.code : undefined;
    return {
      heading:
        code === 'bad_date'
          ? 'The service would not accept that date'
          : 'The service would not accept that title',
      detail: errorText(error),
      note: 'Nothing was committed.',
    };
  }

  return {
    heading: 'Could not create the draft',
    detail: errorText(error),
    // A timeout or a dropped connection says nothing about whether the commit
    // landed. Claiming it did not is a lie the user would act on by retrying.
    note: 'Check the draft list before retrying — the commit may still have landed.',
  };
}

const FlushCounts: React.FC<{ result: FlushResult }> = ({ result }) => (
  <p className="text-xs text-gray-600 mt-1">
    {result.committed} committed · {result.skipped} already in the draft · {result.unroutable} unroutable
    {result.commitSha && <> · commit {result.commitSha.slice(0, 7)}</>}
  </p>
);

const FlushReport: React.FC<{ result: FlushResult }> = ({ result }) => {
  if (result.reason === 'locked') {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
        <p className="text-sm font-medium text-yellow-800">Another flush is running</p>
        <p className="text-xs text-yellow-700 mt-1">
          Nothing was lost and nothing was written twice. Try again in a minute.
        </p>
      </div>
    );
  }

  if (result.reason === 'no-target') {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
        <p className="text-sm font-medium text-yellow-800">No target draft</p>
        <p className="text-xs text-yellow-700 mt-1">
          Pick the draft these links should be written into, then flush again. The buffer is untouched.
        </p>
      </div>
    );
  }

  if (result.reason === 'empty') {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
        <p className="text-sm text-gray-700">Nothing buffered — no commit was made.</p>
      </div>
    );
  }

  if (result.reason === 'error' || !result.ok) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-3">
        <p className="text-sm font-medium text-red-800">Flush failed</p>
        <p className="text-xs text-red-600 mt-1">{result.error || 'The service did not say why.'}</p>
        <p className="text-xs text-gray-500 mt-1">The links are still buffered.</p>
        <FlushCounts result={result} />
      </div>
    );
  }

  if (result.reason === 'nothing-new') {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-md p-3">
        <p className="text-sm text-gray-700">
          Every buffered link was already in the draft, so nothing was committed.
        </p>
        <FlushCounts result={result} />
      </div>
    );
  }

  return (
    <div className="bg-green-50 border border-green-200 rounded-md p-3">
      <p className="text-sm font-medium text-green-800">
        Wrote {result.committed} link{result.committed === 1 ? '' : 's'}
        {result.targetPath && <> into {result.targetPath}</>}
      </p>
      <FlushCounts result={result} />
      {result.unroutable > 0 && (
        <p className="text-xs text-yellow-700 mt-1">
          {result.unroutable} link{result.unroutable === 1 ? ' has a category' : 's have categories'} with no
          matching section in that draft. They stayed in the buffer — re-categorise them below.
        </p>
      )}
    </div>
  );
};

interface QueueRowProps {
  link: PendingLink;
  categories: Category[];
  onSave: (patch: LinkPatch) => void;
  onDelete: () => void;
}

const QueueRow: React.FC<QueueRowProps> = ({ link, categories, onSave, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [description, setDescription] = useState(link.description ?? '');
  const [category, setCategory] = useState(link.category);

  const categoryName = categories.find((c) => c.id === link.category)?.name ?? link.category;

  const startEditing = () => {
    setDescription(link.description ?? '');
    setCategory(link.category);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const patch: LinkPatch = {};
    if (description.trim() !== (link.description ?? '')) patch.description = description.trim();
    if (category !== link.category) patch.category = category;
    if (Object.keys(patch).length > 0) onSave(patch);
  };

  return (
    <div className="border border-gray-200 rounded-lg p-3">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-gray-900 truncate" title={link.title}>
            {link.title}
          </h4>
          <p className="text-xs text-gray-500 truncate mt-0.5" title={link.url}>
            {link.url}
          </p>
        </div>
        {!editing && !confirmingDelete && (
          <div className="ml-2 flex items-center space-x-2 flex-shrink-0">
            <button
              type="button"
              onClick={startEditing}
              className="text-xs text-blue-600 hover:text-blue-800"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="text-xs text-gray-400 hover:text-red-600"
            >
              Remove
            </button>
          </div>
        )}
      </div>

      {confirmingDelete && (
        <div className="mt-2 flex items-center justify-between bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
          <span className="text-xs text-red-700">Drop this link from the buffer?</span>
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="text-xs font-medium text-red-700 hover:text-red-900"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {editing ? (
        <div className="mt-2 space-y-2">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            placeholder="Link text for the bullet"
          />
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          >
            {categories.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          <div className="flex items-center justify-end space-x-3">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commit}
              className="bg-blue-600 text-white text-xs py-1.5 px-3 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-xs text-gray-700 mt-2">
            {link.description?.trim() ? (
              link.description
            ) : (
              <span className="text-gray-400 italic">No description — the title becomes the link text.</span>
            )}
          </p>
          <div className="flex items-center mt-2 space-x-2">
            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
              {categoryName}
            </span>
            <span className="text-xs text-gray-400">{formatAge(link.addedAt)}</span>
          </div>
        </>
      )}
    </div>
  );
};

/**
 * Creating the next Curated Insights draft from the extension.
 *
 * Mounted only while expanded, so closing it clears the form, the confirmation
 * and the last result — this runs about four times a year and a stale success
 * card sitting above the everyday controls would be noise.
 */
const NewDraftForm: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const create = useCreateDraft();
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayIsoDate);
  const [setAsTarget, setSetAsTarget] = useState(true);
  const [confirming, setConfirming] = useState(false);

  const trimmedTitle = title.trim();
  const slug = previewSlug(trimmedTitle);
  const dateValid = ISO_DATE.test(date);
  // Mirror the server's own title rules, not just the slug rule. Both are pure
  // and short, and without them the preview happily renders a filename for a
  // title the server rejects — the user reads the commit warning, confirms, and
  // only then learns it was never going to work.
  const titleRejected =
    trimmedTitle.length > MAX_TITLE_LENGTH || /[<>]/.test(trimmedTitle);
  const canCreate = slug !== '' && dateValid && !titleRejected;
  const failure = create.error ? describeCreateError(create.error) : null;

  // Any edit invalidates an open confirmation: the yellow card describes the
  // file that was about to be created, and confirming it after a change would
  // commit something the user never read.
  const edited = () => setConfirming(false);

  // The form is replaced by its outcome rather than kept alongside it. A second
  // create from the same filled-in form either 409s or, after a date change,
  // quietly adds a near-duplicate file to the live repo.
  if (create.data) {
    const { draft, commitSha, target } = create.data;
    return (
      <div className="mt-2 bg-green-50 border border-green-200 rounded-md p-3">
        <p className="text-sm font-medium text-green-800">Draft created</p>
        {/* The server's own report of what it wrote, not the preview. */}
        <p className="text-xs text-green-700 mt-1 font-mono break-all">{draft.path}</p>
        <p className="text-xs text-gray-600 mt-1">
          commit {commitSha.slice(0, 7)}
          {target ? ' · flushes now write into it' : ' · the flush target is unchanged'}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-2 text-xs text-green-800 underline hover:text-green-900"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 border border-gray-200 rounded-md p-3 space-y-3">
      <div>
        <label htmlFor="new-draft-title" className="block text-sm font-medium text-gray-700 mb-1">
          Title
        </label>
        <input
          id="new-draft-title"
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            edited();
          }}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          placeholder="Curated Insights Q4 2026"
        />
      </div>

      <div>
        <label htmlFor="new-draft-date" className="block text-sm font-medium text-gray-700 mb-1">
          Date
        </label>
        <input
          id="new-draft-date"
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            edited();
          }}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
        />
      </div>

      <div aria-live="polite">
        {trimmedTitle !== '' && slug === '' ? (
          <p className="text-xs text-yellow-700">
            That title has no letters or digits, so there is no filename to build from it.
          </p>
        ) : !dateValid ? (
          <p className="text-xs text-yellow-700">
            Pick a date — it becomes the first part of the filename.
          </p>
        ) : canCreate ? (
          <>
            <p className="text-xs text-gray-500">
              Preview: <span className="font-mono break-all">_drafts/{date}-{slug}.md</span>
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Built here with the same rule the service uses. The service names the real file and
              reports it back.
            </p>
          </>
        ) : (
          <p className="text-xs text-gray-400">The filename comes from the title and the date.</p>
        )}
      </div>

      <label className="flex items-center space-x-2 text-xs text-gray-600">
        <input
          type="checkbox"
          checked={setAsTarget}
          onChange={(e) => {
            setSetAsTarget(e.target.checked);
            edited();
          }}
          className="rounded border-gray-300 focus:ring-2 focus:ring-blue-500"
        />
        <span>Flush into this draft from now on</span>
      </label>

      {!confirming ? (
        <button
          type="button"
          disabled={!canCreate}
          onClick={() => setConfirming(true)}
          className="w-full border border-blue-600 text-blue-600 py-2 px-4 rounded-md hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Create draft...
        </button>
      ) : (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
          <p className="text-sm font-medium text-yellow-800">This commits to master</p>
          <p className="text-xs text-yellow-700 mt-1">
            A new empty Curated Insights draft is committed to the live blog repo
            {setAsTarget && <> and every flush starts writing into it</>}. Removing it again is a
            manual edit in the repo.
          </p>
          <div className="flex items-center justify-end space-x-3 mt-3">
            {/* Dead while the request is in flight: nothing here can call back
                a commit that is already on its way, and a live Cancel would
                claim otherwise. */}
            <button
              type="button"
              disabled={create.isPending}
              onClick={() => setConfirming(false)}
              className="text-xs text-gray-600 hover:text-gray-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={create.isPending || !canCreate}
              onClick={() => {
                // The disabled prop is the real guard; this covers the click
                // that is already dispatched when the re-render happens.
                if (create.isPending) return;
                create.mutate({ title: trimmedTitle, date, setAsTarget });
              }}
              className="bg-blue-600 text-white text-xs py-1.5 px-3 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {create.isPending ? 'Creating...' : 'Create in master'}
            </button>
          </div>
        </div>
      )}

      {failure && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3">
          <p className="text-sm font-medium text-red-800">{failure.heading}</p>
          <p className="text-xs text-red-600 mt-1">{failure.detail}</p>
          <p className="text-xs text-gray-500 mt-1">{failure.note}</p>
        </div>
      )}
    </div>
  );
};

export const Queue: React.FC = () => {
  const { isConfigured, isLoading: configLoading } = useSquirrelConfig();
  const status = useStatus();
  const { links, isLoading, error, updateLink, deleteLink, flush } = useQueue();
  const { drafts, target, setTarget } = useDrafts();
  const categoriesQuery = useSquirrelCategories();
  const publish = usePublish();
  const metadata = useMetadataReview();

  const [publishDraftId, setPublishDraftId] = useState('');
  const [prune, setPrune] = useState(false);
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [creatingDraft, setCreatingDraft] = useState(false);
  // Seeded from the review, then the user's to edit. The three fields together
  // are what the post ships with — not a diff against the draft — so what is in
  // these boxes at the moment of the click is exactly what gets committed.
  const [meta, setMeta] = useState<Required<PublishMeta>>({
    title: '',
    description: '',
    keywords: '',
  });

  const reviewed = metadata.data;
  const reviewIsForSelection = reviewed?.draftId === publishDraftId;
  // The gate. A post is created with its front matter, so an unreviewed publish
  // is the one thing this screen cannot take back.
  const canPublish = reviewIsForSelection && !metadata.isReviewing && meta.title.trim() !== '';
  const titleChanged =
    reviewIsForSelection && meta.title.trim() !== reviewed.current.title.trim();

  useEffect(() => {
    if (reviewed === null) return;
    setMeta({
      title: reviewed.review.title,
      description: reviewed.review.description,
      keywords: reviewed.review.keywords,
    });
  }, [reviewed]);

  const categories = categoriesQuery.data ?? [];
  const lastFlushError = status.data?.lastFlush?.error;

  const selectedPublishDraft = drafts.find((d) => d.id === publishDraftId) ?? null;

  if (configLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!isConfigured) {
    return (
      <div className="p-4">
        <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
          <p className="text-sm font-medium text-blue-800">No service configured</p>
          <p className="text-xs text-blue-700 mt-1">
            Add the service URL and token under Settings and the buffer shows up here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* An expired GitHub PAT fails every flush and shows no other symptom. */}
      {lastFlushError && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3">
          <p className="text-sm font-medium text-red-800">The last flush failed</p>
          <p className="text-xs text-red-600 mt-1">{lastFlushError}</p>
          <p className="text-xs text-gray-500 mt-1">
            Links keep piling up until this is fixed. An expired GitHub token is the usual cause.
          </p>
        </div>
      )}

      {status.error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3">
          <p className="text-sm font-medium text-red-800">Cannot read service status</p>
          <p className="text-xs text-red-600 mt-1">{errorText(status.error)}</p>
        </div>
      )}

      {status.data && (
        <div className="flex items-start justify-between text-xs text-gray-500">
          <span>
            {status.data.pendingCount} buffered
            {status.data.oldestAgeMinutes !== null && <> · oldest {status.data.oldestAgeMinutes}m</>}
            {status.data.flushSuggested && <span className="text-blue-600"> · ready to flush</span>}
          </span>
          <span className="text-right ml-2 truncate max-w-[200px]" title={status.data.target?.path}>
            {status.data.target ? status.data.target.path : 'no target draft'}
          </span>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor="target" className="block text-sm font-medium text-gray-700">
            Target draft
          </label>
          {/* Collapsed by default. Creating a draft happens once a quarter and
              must not sit next to the controls used on every save. */}
          <button
            type="button"
            aria-expanded={creatingDraft}
            aria-controls="new-draft"
            onClick={() => setCreatingDraft((open) => !open)}
            className="text-xs text-blue-600 hover:text-blue-800"
          >
            {/* Not "Cancel": the confirmation card inside the form owns that
                word, and two buttons named Cancel a centimetre apart on a
                480px popup is a way to commit something by accident. */}
            {creatingDraft ? 'Hide' : 'New draft'}
          </button>
        </div>
        <select
          id="target"
          value={target?.draftId ?? ''}
          onChange={(e) => e.target.value && setTarget.mutate(e.target.value)}
          disabled={setTarget.isPending || drafts.length === 0}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        >
          <option value="">{drafts.length === 0 ? 'No drafts found' : 'Select a draft'}</option>
          {drafts.map((draft) => (
            <option key={draft.id} value={draft.id}>
              {draft.title}
              {draft.curated ? ' — Curated Insights' : ''}
            </option>
          ))}
        </select>
        {setTarget.error && (
          <p className="text-xs text-red-600 mt-1">{errorText(setTarget.error)}</p>
        )}

        <div id="new-draft">
          {creatingDraft && <NewDraftForm onClose={() => setCreatingDraft(false)} />}
        </div>
      </div>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => flush.mutate()}
          disabled={flush.isPending}
          className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {flush.isPending ? 'Flushing...' : 'Flush now'}
        </button>
        {flush.error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3">
            <p className="text-sm font-medium text-red-800">Could not reach the service</p>
            <p className="text-xs text-red-600 mt-1">{errorText(flush.error)}</p>
          </div>
        )}
        {flush.data && <FlushReport result={flush.data} />}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-800">Buffered links ({links.length})</h3>
          {isLoading && <span className="text-xs text-gray-400">loading...</span>}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3">
            <p className="text-sm font-medium text-red-800">Could not load the buffer</p>
            <p className="text-xs text-red-600 mt-1">{errorText(error)}</p>
          </div>
        )}

        {!error && links.length === 0 && !isLoading && (
          <p className="text-sm text-gray-500">Nothing buffered. Saved links land here until a flush.</p>
        )}

        {links.length > 0 && (
          <div className="space-y-3 max-h-[300px] overflow-y-auto">
            {links.map((link) => (
              <QueueRow
                key={link.id}
                link={link}
                categories={categories}
                onSave={(patch) => updateLink.mutate({ id: link.id, patch })}
                onDelete={() => deleteLink.mutate(link.id)}
              />
            ))}
          </div>
        )}

        {updateLink.error && (
          <p className="text-xs text-red-600 mt-2">Edit failed: {errorText(updateLink.error)}</p>
        )}
        {deleteLink.error && (
          <p className="text-xs text-red-600 mt-2">Remove failed: {errorText(deleteLink.error)}</p>
        )}
      </div>

      <div className="border-t pt-4 space-y-2">
        <h3 className="text-sm font-semibold text-gray-800">Publish a draft</h3>
        <select
          value={publishDraftId}
          onChange={(e) => {
            setPublishDraftId(e.target.value);
            setConfirmingPublish(false);
            publish.reset();
            // A review belongs to the draft it read. Keeping it across a change
            // of selection would offer one issue's metadata for another's post.
            metadata.reset();
          }}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Select a draft to publish</option>
          {drafts.map((draft) => (
            <option key={draft.id} value={draft.id}>
              {draft.title}
              {draft.curated ? ' — Curated Insights' : ''}
            </option>
          ))}
        </select>

        {/* No destination filename is shown before the commit. The service derives
            it when it publishes — front-matter title, else the filename stripped of
            its date prefix and extension — from the draft as it reads at that
            moment and on its own UTC clock, so anything computed here is a guess
            that can name a different file than the one created, and this is the
            last screen before an irreversible publish. The real path comes back in
            the result below. */}
        {selectedPublishDraft && (
          <>
            <p className="text-xs text-gray-500">
              The service names the post from its title. The file it created is shown once the commit
              lands.
            </p>

            <div className="border border-gray-200 rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-gray-800">Metadata check</h4>
                {reviewIsForSelection && !metadata.isReviewing && (
                  <button
                    type="button"
                    onClick={() => metadata.review(publishDraftId, true)}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    Re-run
                  </button>
                )}
              </div>

              {!reviewIsForSelection && !metadata.isReviewing && metadata.error === null && (
                <>
                  <p className="text-xs text-gray-600">
                    The local AI reads the links this issue actually collected and checks that the
                    title, description and keywords still describe them.
                  </p>
                  <button
                    type="button"
                    onClick={() => metadata.review(publishDraftId)}
                    className="w-full border border-gray-300 text-gray-700 text-xs py-1.5 px-3 rounded-md hover:border-blue-500 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    Review metadata
                  </button>
                </>
              )}

              {metadata.isReviewing && (
                <p className="text-xs text-gray-600" role="status">
                  Reading the issue and checking its front matter — this takes about a minute.
                </p>
              )}

              {metadata.error !== null && !metadata.isReviewing && (
                <div className="bg-red-50 border border-red-200 rounded-md p-2">
                  <p className="text-xs font-medium text-red-800">Metadata check failed</p>
                  <p className="text-xs text-red-600 mt-1">{errorText(metadata.error)}</p>
                  {/*
                    Only when the sidecar is what failed. The check also fetches
                    the draft from the service, and telling someone to start a
                    process that is already running sends them after the wrong
                    machine.
                  */}
                  {metadata.error instanceof BackendError && (
                    <p className="text-xs text-gray-500 mt-1">
                      The review runs on this machine's sidecar. Start it with{' '}
                      <span className="font-mono">npm run backend</span> and try again.
                    </p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    Publishing stays blocked until the check has run.
                  </p>
                  <button
                    type="button"
                    onClick={() => metadata.review(publishDraftId)}
                    className="mt-2 text-xs text-blue-600 hover:text-blue-800"
                  >
                    Try again
                  </button>
                </div>
              )}

              {reviewIsForSelection && !metadata.isReviewing && (
                <>
                  <p
                    className={`text-xs rounded-md p-2 ${
                      reviewed.review.verdict === 'ok'
                        ? 'bg-green-50 border border-green-200 text-green-800'
                        : 'bg-amber-50 border border-amber-200 text-amber-800'
                    }`}
                  >
                    {reviewed.review.verdict === 'ok'
                      ? 'The front matter matches the links.'
                      : 'The front matter does not match the links.'}{' '}
                    {reviewed.review.notes}
                  </p>

                  <MetaField
                    id="meta-title"
                    label="Title"
                    hint="Names the post file, and therefore its URL."
                    value={meta.title}
                    current={reviewed.current.title}
                    maxLength={MAX_TITLE_LENGTH}
                    onChange={(title) => setMeta((previous) => ({ ...previous, title }))}
                  />
                  <MetaField
                    id="meta-description"
                    label="Description"
                    hint="The meta description a reader sees in search results."
                    value={meta.description}
                    current={reviewed.current.description}
                    maxLength={MAX_DESCRIPTION_LENGTH}
                    rows={3}
                    onChange={(description) =>
                      setMeta((previous) => ({ ...previous, description }))
                    }
                  />
                  <MetaField
                    id="meta-keywords"
                    label="Keywords"
                    hint="Comma-separated."
                    value={meta.keywords}
                    current={reviewed.current.keywords}
                    maxLength={MAX_KEYWORDS_LENGTH}
                    onChange={(keywords) => setMeta((previous) => ({ ...previous, keywords }))}
                  />

                  {meta.title.trim() === '' && (
                    <p className="text-xs text-red-600">
                      A title is required — the post's filename is built from it.
                    </p>
                  )}
                </>
              )}
            </div>

            <label className="flex items-center space-x-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={prune}
                onChange={(e) => setPrune(e.target.checked)}
                className="rounded border-gray-300 focus:ring-2 focus:ring-blue-500"
              />
              <span>Remove sections that ended up with no links</span>
            </label>

            {!confirmingPublish ? (
              <>
                <button
                  type="button"
                  disabled={!canPublish}
                  onClick={() => setConfirmingPublish(true)}
                  className="w-full border border-blue-600 text-blue-600 py-2 px-4 rounded-md hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  Publish...
                </button>
                {!canPublish && (
                  <p className="text-xs text-gray-500">
                    {reviewIsForSelection
                      ? 'Give the post a title to publish.'
                      : 'Run the metadata check first — a post ships with the front matter it is created with.'}
                  </p>
                )}
              </>
            ) : (
              <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
                <p className="text-sm font-medium text-yellow-800">This goes live</p>
                <p className="text-xs text-yellow-700 mt-1">
                  Buffered links are folded in, the front matter above is written into the post, and{' '}
                  <span className="font-mono">{selectedPublishDraft.path}</span> moves into{' '}
                  <span className="font-mono">_posts/</span> under a name taken from its title — one
                  commit to master, which deploys the site. There is no undo from here.
                </p>
                {titleChanged && (
                  <p className="text-xs text-yellow-800 mt-2 font-medium">
                    The title changes, so the post's URL is built from the new one.
                  </p>
                )}
                <div className="flex items-center justify-end space-x-3 mt-3">
                  <button
                    type="button"
                    onClick={() => setConfirmingPublish(false)}
                    className="text-xs text-gray-600 hover:text-gray-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={publish.isPending}
                    onClick={() => {
                      setConfirmingPublish(false);
                      publish.mutate({
                        draftId: selectedPublishDraft.id,
                        prune,
                        // All three, not a diff: what the boxes say is what the
                        // post ships with, and an unchanged value writes itself
                        // back unchanged.
                        meta: {
                          title: meta.title.trim(),
                          description: meta.description.trim(),
                          keywords: meta.keywords.trim(),
                        },
                      });
                    }}
                    className="bg-blue-600 text-white text-xs py-1.5 px-3 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                  >
                    {publish.isPending ? 'Publishing...' : 'Publish to master'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {publish.error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3">
            <p className="text-sm font-medium text-red-800">Publish failed</p>
            <p className="text-xs text-red-600 mt-1">{errorText(publish.error)}</p>
            <p className="text-xs text-gray-500 mt-1">The draft was left where it was.</p>
          </div>
        )}

        {publish.data && (
          <div className="bg-green-50 border border-green-200 rounded-md p-3">
            <p className="text-sm font-medium text-green-800">Published</p>
            <p className="text-xs text-green-700 mt-1 font-mono break-all">{publish.data.postPath}</p>
            <p className="text-xs text-gray-600 mt-1">
              {publish.data.linksIncluded} link{publish.data.linksIncluded === 1 ? '' : 's'} folded in ·{' '}
              {publish.data.skipped} already present · commit {publish.data.commitSha.slice(0, 7)}
            </p>
            {publish.data.prunedSections.length > 0 && (
              <p className="text-xs text-gray-600 mt-1">
                Pruned empty sections: {publish.data.prunedSections.join(', ')}
              </p>
            )}
            {publish.data.metaUpdated !== undefined && publish.data.metaUpdated.length > 0 && (
              <p className="text-xs text-gray-600 mt-1">
                Front matter written: {publish.data.metaUpdated.join(', ')}
              </p>
            )}
            {publish.data.metaUpdated === undefined && publish.variables?.meta !== undefined && (
              // The reviewed metadata was sent and the service said nothing about
              // it. That is what a deployment older than metadata support looks
              // like from here, and the post it just created still carries the
              // draft's front matter.
              <p className="text-xs text-amber-700 mt-1">
                The service did not report writing the front matter — it may predate metadata
                support. Check the post and redeploy the service.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
