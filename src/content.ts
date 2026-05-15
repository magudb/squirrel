// Content script for getting page information
console.log('Squirrel content script loaded');

// Store the last selected text
let lastSelectedText = '';

// Monitor text selection changes
document.addEventListener('selectionchange', () => {
  const selection = window.getSelection();
  if (selection && selection.toString().trim()) {
    lastSelectedText = selection.toString().trim();
    console.log('Selection captured:', lastSelectedText);
  }
});

// Also capture selection on mouseup (fallback for better compatibility)
document.addEventListener('mouseup', () => {
  const selection = window.getSelection();
  if (selection && selection.toString().trim()) {
    lastSelectedText = selection.toString().trim();
  }
});

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  console.log('Content script received message:', request);

  if (request.action === 'getSelectedText') {
    // Try to get current selection first, fallback to stored selection
    const currentSelection = window.getSelection()?.toString().trim() || '';
    const selectedText = currentSelection || lastSelectedText;
    
    sendResponse({ 
      selectedText,
      title: document.title,
      url: window.location.href
    });
    return true;
  }

  if (request.action === 'getPageInfo') {
    // Try to get current selection first, fallback to stored selection
    const currentSelection = window.getSelection()?.toString().trim() || '';
    const selectedText = currentSelection || lastSelectedText;
    
    const pageInfo = {
      title: document.title,
      url: window.location.href,
      selectedText
    };
    sendResponse(pageInfo);
    return true;
  }
});

// Automatically send page info when content script loads (for the old background.js pattern)
const pageInfo = {
  title: document.title,
  url: window.location.href,
  summary: lastSelectedText || window.getSelection()?.toString().trim() || ''
};

// Send to background script
chrome.runtime.sendMessage(pageInfo).catch(() => {
  // Ignore errors if background script isn't listening
});