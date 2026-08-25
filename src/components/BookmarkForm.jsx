import React, { useState, useEffect } from 'react';

const CATEGORIES = [
  { value: 'favorites', label: '⭐ My favorites' },
  { value: 'agile', label: '🎯 Agile, Leadership and Product' },
  { value: 'development', label: '💻 Architecture, Development & Software development practices' },
  { value: 'devops', label: '🔧 DevOps, Observability & Security' },
  { value: 'tools', label: '🛠️ Tools and things from Github' }
];

const BookmarkForm = () => {
  const [bookmark, setBookmark] = useState({
    url: '',
    title: '',
    category: 'development',
    description: ''
  });
  const [markdownLink, setMarkdownLink] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // Get page details when component mounts
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: 'getPageDetails' }, (details) => {
        if (details) {
          setBookmark(prev => ({
            ...prev,
            url: details.url || '',  // URL is already cleaned by content script
            title: details.title || '',
            description: details.description || details.summary || ''
          }));
        }
      });
    }
  }, []);

  useEffect(() => {
    // Update markdown link whenever bookmark changes
    if (bookmark.title && bookmark.url) {
      const link = `- [${bookmark.title}](${bookmark.url}){:target="_blank"}`;
      setMarkdownLink(link);
    } else {
      setMarkdownLink('');
    }
  }, [bookmark]);


  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setBookmark(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    try {
      // Here you would send the bookmark to your server
      // For now, we'll just copy to clipboard
      await navigator.clipboard.writeText(markdownLink);
      setSaved(true);
      
      // Show success message
      setTimeout(() => {
        setSaved(false);
        // Close the popup
        window.close();
      }, 1500);
    } catch (err) {
      console.error('Failed to save bookmark:', err);
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(markdownLink);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="field">
        <label className="label">Title</label>
        <div className="control">
          <input
            className="input"
            type="text"
            name="title"
            value={bookmark.title}
            onChange={handleInputChange}
            placeholder="Article title"
            required
          />
        </div>
      </div>

      <div className="field">
        <label className="label">URL</label>
        <div className="control">
          <input
            className="input"
            type="url"
            name="url"
            value={bookmark.url}
            onChange={handleInputChange}
            placeholder="https://example.com"
            required
          />
        </div>
        <p className="help">Tracking parameters automatically removed</p>
      </div>

      <div className="field">
        <label className="label">Category</label>
        <div className="control">
          <div className="select category-select">
            <select
              name="category"
              value={bookmark.category}
              onChange={handleInputChange}
            >
              {CATEGORIES.map(cat => (
                <option key={cat.value} value={cat.value}>
                  {cat.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="field">
        <label className="label">Description (optional)</label>
        <div className="control">
          <textarea
            className="textarea"
            name="description"
            value={bookmark.description}
            onChange={handleInputChange}
            placeholder="Brief description"
            rows="3"
          />
        </div>
        <p className="help">Auto-populated from page meta description or Open Graph data</p>
      </div>

      {markdownLink && (
        <div className="field">
          <label className="label">Markdown Link</label>
          <div className="markdown-preview" onClick={copyToClipboard} style={{ cursor: 'pointer' }}>
            {markdownLink}
          </div>
          <p className="help">Click to copy</p>
        </div>
      )}

      <div className="field">
        <div className="control">
          <button type="submit" className="button is-primary is-fullwidth">
            {saved ? '✓ Saved!' : 'Save Bookmark'}
          </button>
        </div>
      </div>

      {saved && (
        <div className="notification is-success">
          Link copied to clipboard!
        </div>
      )}
    </form>
  );
};

export default BookmarkForm;