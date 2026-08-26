import React, { useState } from 'react';
import { useDrafts, usePublish, useQueue, useSquirrelCategories, useSquirrelConfig, useStatus } from '../hooks/useSquirrel';
import type { Category, FlushResult, LinkPatch, PendingLink } from '../types';

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

export const Queue: React.FC = () => {
  const { isConfigured, isLoading: configLoading } = useSquirrelConfig();
  const status = useStatus();
  const { links, isLoading, error, updateLink, deleteLink, flush } = useQueue();
  const { drafts, target, setTarget } = useDrafts();
  const categoriesQuery = useSquirrelCategories();
  const publish = usePublish();

  const [publishDraftId, setPublishDraftId] = useState('');
  const [prune, setPrune] = useState(false);
  const [confirmingPublish, setConfirmingPublish] = useState(false);

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
        <label htmlFor="target" className="block text-sm font-medium text-gray-700 mb-1">
          Target draft
        </label>
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
              The service names the post from the draft's title. The file it created is shown once the
              commit lands.
            </p>

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
              <button
                type="button"
                onClick={() => setConfirmingPublish(true)}
                className="w-full border border-blue-600 text-blue-600 py-2 px-4 rounded-md hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Publish...
              </button>
            ) : (
              <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
                <p className="text-sm font-medium text-yellow-800">This goes live</p>
                <p className="text-xs text-yellow-700 mt-1">
                  Buffered links are folded in,{' '}
                  <span className="font-mono">{selectedPublishDraft.path}</span> moves into{' '}
                  <span className="font-mono">_posts/</span> under a name taken from its title, and the
                  commit to master deploys the site. There is no undo from here.
                </p>
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
                      publish.mutate({ draftId: selectedPublishDraft.id, prune });
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
          </div>
        )}
      </div>
    </div>
  );
};
