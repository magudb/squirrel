import React, { useMemo } from 'react';
import { useBlogData } from '../hooks/useBlogData';
import { BlogService } from '../utils/blogService';
import { Link } from '../types';

export const SavedLinks: React.FC = () => {
  const { savedLinks, categories, isLoading, serviceUnreachable } = useBlogData();

  // One index build instead of a linear scan per rendered row.
  const categoryNames = useMemo(
    () => new Map(categories.map(c => [c.id, c.name])),
    [categories]
  );

  const copyLinkMarkdown = async (link: Link) => {
    try {
      const formatted = BlogService.formatLink(link);
      await navigator.clipboard.writeText(formatted);

      chrome.notifications?.create({
        type: 'basic',
        iconUrl: 'images/icon.png',
        title: 'Copied',
        message: 'Link markdown copied to clipboard'
      });
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
      chrome.notifications?.create({
        type: 'basic',
        iconUrl: 'images/icon.png',
        title: 'Copy Failed',
        message: 'Could not copy to clipboard'
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8" role="status">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="sr-only">Loading saved links…</span>
      </div>
    );
  }

  if (savedLinks.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500">
        No saved links yet. Add some links to see them here.
      </div>
    );
  }

  return (
    <div className="p-4">
      {serviceUnreachable && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-2 mb-3" role="alert">
          <p className="text-xs text-yellow-700">
            Squirrel service unreachable — these are your local copies, and category names may fall back to ids.
          </p>
        </div>
      )}
      <h3 className="text-lg font-semibold mb-4">Saved Links ({savedLinks.length})</h3>
      <div className="space-y-3 max-h-[400px] overflow-y-auto">
        {savedLinks.map((link) => (
          <div key={link.id} className="border border-gray-200 rounded-lg p-3 hover:bg-gray-50">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-medium text-gray-900 truncate">
                  {link.title}
                </h4>
                <p className="text-xs text-gray-500 truncate mt-1">
                  {link.url}
                </p>
                <div className="flex items-center mt-2 space-x-2">
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                    {categoryNames.get(link.category) ?? link.category}
                  </span>
                  <span className="text-xs text-gray-400">
                    {new Date(link.timestamp).toLocaleDateString()}
                  </span>
                </div>
                {link.selectedText && (
                  <p className="text-xs text-gray-600 mt-2 italic">
                    "{link.selectedText}"
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => copyLinkMarkdown(link)}
                className="ml-2 p-1 text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
                title="Copy markdown"
                aria-label={`Copy markdown for ${link.title}`}
              >
                <svg aria-hidden="true" className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
