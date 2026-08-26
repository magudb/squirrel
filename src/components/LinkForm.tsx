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
  const { analyze, data: analyzeResult, isAnalyzing } = useAnalyzeLink();

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
    if (analyzeResult) {
      const suggestedCategory = categories.find(c => c.id === analyzeResult.category);
      if (suggestedCategory) {
        setSelectedCategory(suggestedCategory);
      }
      if (analyzeResult.description) {
        setDescription(analyzeResult.description);
      }
    }
  }, [analyzeResult, categories]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
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

  const handleRegenerate = () => {
    if (!url || !title || isAnalyzing) return;
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
            Description {isAnalyzing && <span className="text-blue-500 text-xs ml-1">(AI analyzing...)</span>}
            {!isAnalyzing && analyzeResult?.cached && (
              <span className="text-gray-400 text-xs ml-1">(cached)</span>
            )}
            {!isAnalyzing && aiSidecarAvailable === false && (
              <span
                className="text-gray-400 text-xs ml-1"
                title="The local AI sidecar isn't running. Everything else works; write the description yourself."
              >
                (AI suggestions unavailable)
              </span>
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
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            isAnalyzing ? 'border-blue-300 bg-blue-50 animate-pulse' : 'border-gray-300'
          }`}
          placeholder={isAnalyzing ? 'AI is generating a description...' : 'Short description for the blog (used as link text)'}
          disabled={isAnalyzing}
        />
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
          }}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            isAnalyzing ? 'border-blue-300 bg-blue-50' : 'border-gray-300'
          }`}
          required
        >
          <option value="">{isAnalyzing ? 'AI selecting category...' : 'Select a category'}</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        disabled={isAddingLink}
        className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isAddingLink ? 'Adding Link...' : 'Add Link'}
      </button>
    </form>
  );
};
