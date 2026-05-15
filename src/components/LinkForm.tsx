import React, { useState, useEffect } from 'react';
import { useBlogData } from '../hooks/useBlogData';
import { useBlogMutation } from '../hooks/useBlogMutation';
import { useAnalyzeLink } from '../hooks/useAnalyzeLink';
import { TabInfo, Category, BlogPost } from '../types';

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
  const [selectedBlogFile, setSelectedBlogFile] = useState<BlogPost | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const { analyze, data: analyzeResult, isAnalyzing } = useAnalyzeLink();

  const { categories, blogFiles, isLoading, errorMessage: dataError, backendDown, refetch } = useBlogData();
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
    if (blogFiles.length > 0 && !selectedBlogFile) {
      setSelectedBlogFile(blogFiles[0]);
    }
  }, [blogFiles, selectedBlogFile]);

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

    if (!url || !title || !selectedCategory || !selectedBlogFile) {
      const missing = [!url && 'url', !title && 'title', !selectedCategory && 'category', !selectedBlogFile && 'blogFile'].filter(Boolean);
      setValidationError(`Missing: ${missing.join(', ')}`);
      return;
    }

    if (!isValidHttpUrl(url)) {
      setValidationError('Please enter a valid HTTP or HTTPS URL');
      return;
    }

    const link = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      url,
      title,
      selectedText: selectedText.trim() || undefined,
      description: description.trim() || undefined,
      category: selectedCategory.id,
      timestamp: Date.now()
    };

    addLink({ link, blogPost: selectedBlogFile });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (backendDown) {
    return (
      <div className="p-4">
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex items-start">
            <svg className="w-5 h-5 text-red-400 mr-2 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-red-800">Backend not reachable</p>
              <p className="text-xs text-red-600 mt-1">
                The squirrel-backend service doesn't seem to be running.
              </p>
              <p className="text-xs text-gray-500 mt-2 font-mono">
                sudo systemctl restart squirrel-backend
              </p>
              <button
                onClick={refetch}
                className="mt-3 text-sm text-red-700 underline hover:text-red-900"
              >
                Retry connection
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show a non-blocking warning if there's a data fetch error but we have some data
  const showDataWarning = dataError && !backendDown;

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

      {/* Data warning (partial failure) */}
      {showDataWarning && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
          <p className="text-xs text-yellow-700">{dataError}</p>
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
        <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
          Description {isAnalyzing && <span className="text-blue-500 text-xs ml-1">(AI analyzing...)</span>}
        </label>
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

      <div>
        <label htmlFor="blogFile" className="block text-sm font-medium text-gray-700 mb-1">
          Blog File *
        </label>
        <select
          id="blogFile"
          value={selectedBlogFile?.path || ''}
          onChange={(e) => {
            const blogFile = blogFiles.find(f => f.path === e.target.value);
            setSelectedBlogFile(blogFile || null);
          }}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        >
          <option value="">Select a blog file</option>
          {blogFiles.map((file) => (
            <option key={file.path} value={file.path}>
              {file.filename} - {file.title}
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
