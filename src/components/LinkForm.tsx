import React, { useState, useEffect } from 'react';
import { useBlogData } from '../hooks/useBlogData';
import { useBlogMutation } from '../hooks/useBlogMutation';
import { useAnalyzeLink } from '../hooks/useAnalyzeLink';
import { TabInfo, Category } from '../types';

interface LinkFormProps {
  tabInfo?: TabInfo;
}

// Validate URL is http or https only
const isValidHttpUrl = (urlString: string): boolean => {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const LinkForm: React.FC<LinkFormProps> = ({ tabInfo }) => {
  const [url, setUrl] = useState(tabInfo?.url || '');
  const [title, setTitle] = useState(tabInfo?.title || '');
  const [selectedText, setSelectedText] = useState(tabInfo?.selectedText || '');
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  /**
   * A first analysis takes ~13s (a repeat is ~5ms, off the sidecar's cache), and
   * the description is what gets published as the link text. So the popup is
   * fully usable during those 13s — which means anything the user changed in
   * that window is an answer, not a placeholder waiting to be overwritten.
   */
  const [descriptionTouched, setDescriptionTouched] = useState(false);
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const { analyze, data: analyzeResult, isAnalyzing, isSettled: analysisSettled } = useAnalyzeLink();

  const {
    categories,
    isLoading,
    errorMessage: dataError,
    notConfigured,
    serviceUnreachable,
    aiSidecarAvailable,
    refetch,
  } = useBlogData();
  const { addLink, isLoading: isAddingLink, errorMessage: mutationError, reset: resetMutation } = useBlogMutation();

  // The sidecar runs on exactly one machine. A verdict of "not there" has to
  // release the submit button immediately, even mid-request, or the extension
  // is worse everywhere else than it was before the AI existed. `undefined`
  // means the probe has not answered and is deliberately not a verdict.
  const sidecarMissing = aiSidecarAvailable === false;
  const isWaitingForAi = isAnalyzing && !sidecarMissing;

  // A re-run keeps the previous result in `data` while pending; showing it as a
  // live suggestion would offer the answer that is currently being replaced.
  const suggestedCategory =
    !isAnalyzing && analyzeResult
      ? categories.find(c => c.id === analyzeResult.category) ?? null
      : null;
  const suggestedDescription = !isAnalyzing ? (analyzeResult?.description ?? '').trim() : '';

  // A touched field is never overwritten, so a suggestion that disagrees with
  // it has to be offered rather than applied. Dropping it silently loses the
  // same work the auto-apply used to destroy, just in the other direction.
  const descriptionSuggestion =
    descriptionTouched && suggestedDescription && suggestedDescription !== description.trim()
      ? suggestedDescription
      : null;
  const categorySuggestion =
    categoryTouched && suggestedCategory && suggestedCategory.id !== selectedCategory?.id
      ? suggestedCategory
      : null;

  const analysisEmpty = analysisSettled && !isAnalyzing && !sidecarMissing && !analyzeResult;

  const aiStatusMessage = isWaitingForAi
    ? 'AI is reading the page for a description and category. You can save without waiting.'
    : sidecarMissing
      ? 'AI suggestions are unavailable on this machine. Everything else works as usual.'
      : analysisEmpty
        ? 'No AI suggestion came back. Write a description yourself.'
        : '';

  useEffect(() => {
    if (tabInfo) {
      setUrl(tabInfo.url);
      setTitle(tabInfo.title);
      setSelectedText(tabInfo.selectedText || '');
    }
  }, [tabInfo]);

  useEffect(() => {
    if (categories.length > 0 && !selectedCategory) {
      setSelectedCategory(categories[0]);
    }
  }, [categories, selectedCategory]);

  useEffect(() => {
    if (tabInfo?.url && tabInfo.url.startsWith('http')) {
      analyze({
        url: tabInfo.url,
        title: tabInfo.title,
        selectedText: tabInfo.selectedText,
      });
    }
  }, [tabInfo, analyze]);

  useEffect(() => {
    if (!analyzeResult) return;
    if (!categoryTouched) {
      const suggested = categories.find(c => c.id === analyzeResult.category);
      if (suggested) {
        setSelectedCategory(suggested);
      }
    }
    if (!descriptionTouched && analyzeResult.description) {
      setDescription(analyzeResult.description);
    }
  }, [analyzeResult, categories, categoryTouched, descriptionTouched]);

  // A button that sits dead for thirteen seconds reads as a hang, so it counts.
  useEffect(() => {
    if (!isWaitingForAi) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const tick = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [isWaitingForAi]);

  const submitLink = () => {
    setValidationError(null);
    resetMutation();

    if (!url || !title || !selectedCategory) {
      const missing = [!url && 'url', !title && 'title', !selectedCategory && 'category'].filter(Boolean);
      setValidationError(`Missing: ${missing.join(', ')}`);
      return;
    }

    if (!isValidHttpUrl(url)) {
      setValidationError('Please enter a valid HTTP or HTTPS URL');
      return;
    }

    addLink({
      id: crypto.randomUUID(),
      url,
      title,
      selectedText: selectedText.trim() || undefined,
      description: description.trim() || undefined,
      category: selectedCategory.id,
      timestamp: Date.now()
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Enter in a text field can submit past a disabled submit button, which is
    // the exact race that published links with no description at all.
    if (isWaitingForAi) return;
    submitLink();
  };

  const handleRegenerate = () => {
    if (!url || !title || isAnalyzing) return;
    // Asking for a regeneration IS a request to be overwritten, so clear the
    // touched flags the auto-apply is gated on. Without this the new result
    // arrives and is offered as a suggestion the user has to accept again,
    // which is not what clicking Regenerate means.
    setDescriptionTouched(false);
    setCategoryTouched(false);
    analyze({ url, title, selectedText, forceRefresh: true });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  // Nothing here can reach anywhere until the service is named, and the fix is
  // one tab away rather than anything to retry.
  if (notConfigured) {
    return (
      <div className="p-4">
        <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
          <div className="flex items-start">
            <svg className="w-5 h-5 text-blue-400 mr-2 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-blue-800">Squirrel isn't set up yet</p>
              <p className="text-xs text-blue-700 mt-1">
                Open the <span className="font-medium">Settings</span> tab and add your Squirrel
                service URL and token. Saved links go to the service, which writes them to the blog.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4">
      {/* Validation error */}
      {validationError && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3">
          <p className="text-sm text-red-700">{validationError}</p>
        </div>
      )}

      {/* Mutation error (failed to add link) */}
      {mutationError && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3">
          <p className="text-sm font-medium text-red-800">Failed to add link</p>
          <p className="text-xs text-red-600 mt-1">{mutationError}</p>
          <p className="text-xs text-gray-500 mt-1">The link was saved locally. You can retry.</p>
        </div>
      )}

      {/* Service down: a warning, not a blocker — the outbox holds the link */}
      {serviceUnreachable && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
          <p className="text-sm font-medium text-yellow-800">Squirrel service is not responding</p>
          <p className="text-xs text-yellow-700 mt-1">
            Saving still works — the link is queued and sent as soon as the service answers.
          </p>
          {dataError && <p className="text-xs text-yellow-600 mt-1">{dataError}</p>}
          <button
            type="button"
            onClick={refetch}
            className="mt-2 text-xs text-yellow-800 underline hover:text-yellow-900"
          >
            Try again
          </button>
        </div>
      )}

      <div>
        <label htmlFor="url" className="block text-sm font-medium text-gray-700 mb-1">
          URL *
        </label>
        <input
          type="url"
          id="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="https://example.com"
          required
        />
      </div>

      <div>
        <label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-1">
          Title *
        </label>
        <input
          type="text"
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Link title"
          required
        />
      </div>

      <div>
        <label htmlFor="selectedText" className="block text-sm font-medium text-gray-700 mb-1">
          Selected Text (optional)
        </label>
        <textarea
          id="selectedText"
          value={selectedText}
          onChange={(e) => setSelectedText(e.target.value)}
          rows={3}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Text you selected on the page"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor="description" className="block text-sm font-medium text-gray-700">
            Description {isWaitingForAi && <span className="text-blue-500 text-xs ml-1">(AI analyzing...)</span>}
            {!isAnalyzing && analyzeResult?.cached && (
              <span className="text-gray-400 text-xs ml-1">(cached)</span>
            )}
          </label>
          <button
            type="button"
            onClick={handleRegenerate}
            disabled={isAnalyzing || !url || !title}
            title="Regenerate the AI summary and category"
            className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
          >
            <svg className={`w-3 h-3 ${isAnalyzing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Regenerate
          </button>
        </div>
        {/* Never disabled: the whole point is that the user can write their own
            description instead of waiting for the sidecar. */}
        <textarea
          id="description"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setDescriptionTouched(true);
          }}
          rows={2}
          aria-busy={isWaitingForAi}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            isWaitingForAi ? 'border-blue-300' : 'border-gray-300'
          }`}
          placeholder={
            isWaitingForAi
              ? 'AI is writing one — or type your own'
              : 'Short description for the blog (used as link text)'
          }
        />
        {descriptionSuggestion && (
          <div className="mt-2 bg-blue-50 border border-blue-200 rounded-md p-3">
            <p className="text-xs font-medium text-blue-800">AI suggested a different description</p>
            <p className="text-xs text-blue-700 mt-1 italic">"{descriptionSuggestion}"</p>
            <button
              type="button"
              onClick={() => setDescription(descriptionSuggestion)}
              className="mt-2 text-xs text-blue-800 underline hover:text-blue-900"
            >
              Use AI suggestion
            </button>
          </div>
        )}
      </div>

      <div>
        <label htmlFor="category" className="block text-sm font-medium text-gray-700 mb-1">
          Category *
        </label>
        <select
          id="category"
          value={selectedCategory?.id || ''}
          onChange={(e) => {
            const category = categories.find(c => c.id === e.target.value);
            setSelectedCategory(category || null);
            // Picking the blank placeholder is not a choice — the default
            // effect immediately snaps back to categories[0], and counting it
            // as touched would permanently block the AI's own category on a
            // value the user never selected.
            setCategoryTouched(Boolean(category));
          }}
          aria-busy={isWaitingForAi}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            isWaitingForAi ? 'border-blue-300' : 'border-gray-300'
          }`}
          required
        >
          <option value="">{isWaitingForAi ? 'AI selecting category...' : 'Select a category'}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        {categorySuggestion && (
          <button
            type="button"
            onClick={() => setSelectedCategory(categorySuggestion)}
            className="mt-2 text-xs text-blue-800 underline hover:text-blue-900"
          >
            Use AI suggestion: {categorySuggestion.name}
          </button>
        )}
      </div>

      {/* Mounted even when empty: a live region only announces text that arrives
          into a region the screen reader already knows about. */}
      <div role="status" aria-live="polite" className="min-h-[1rem]">
        {aiStatusMessage && <p className="text-xs text-gray-500">{aiStatusMessage}</p>}
      </div>

      <div className="space-y-2">
        <button
          type="submit"
          disabled={isAddingLink || isWaitingForAi}
          className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isAddingLink
            ? 'Adding Link...'
            : isWaitingForAi
              ? `Waiting for AI... ${elapsedSeconds}s`
              : 'Add Link'}
        </button>
        {/* The escape hatch. A sidecar that is slow, wedged, or lying about being
            up must never be able to hold a link hostage. Only an in-flight save
            disables it, and that is the save happening, not the AI blocking. */}
        {isWaitingForAi && (
          <button
            type="button"
            onClick={submitLink}
            disabled={isAddingLink}
            className="w-full bg-white border border-gray-300 text-gray-700 py-2 px-4 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Save without AI
          </button>
        )}
      </div>
    </form>
  );
};
