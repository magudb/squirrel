import { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { LinkForm } from './components/LinkForm';
import { SavedLinks } from './components/SavedLinks';
import { TabInfo } from './types';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 10 * 60 * 1000, // 10 minutes
    },
  },
});

// Helper: Try to get selected text via content script messaging
async function getSelectedTextViaContentScript(tabId: number): Promise<string> {
  // Content script is already injected by manifest.json content_scripts,
  // so just send the message directly
  const response = await chrome.tabs.sendMessage(tabId, { action: 'getSelectedText' });
  return response?.selectedText || '';
}

// Helper: Fallback to get selected text via direct script execution
async function getSelectedTextViaExecuteScript(tabId: number): Promise<string> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const selection = window.getSelection();
      return selection ? selection.toString().trim() : '';
    }
  });
  return results[0]?.result as string || '';
}

// Helper: Get selected text with fallback strategies
async function getSelectedText(tabId: number): Promise<string> {
  try {
    return await getSelectedTextViaContentScript(tabId);
  } catch {
    try {
      return await getSelectedTextViaExecuteScript(tabId);
    } catch {
      return '';
    }
  }
}

// Helper: Check if URL is a special Chrome page
function isSpecialPage(url: string | undefined): boolean {
  if (!url) return true;
  return url.startsWith('chrome://') || url.startsWith('chrome-extension://');
}

function AppContent() {
  const [activeTab, setActiveTab] = useState<'add' | 'saved'>('add');
  const [tabInfo, setTabInfo] = useState<TabInfo | null>(null);

  useEffect(() => {
    const getCurrentTabInfo = async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab?.id || isSpecialPage(tab.url)) {
          setTabInfo({
            title: tab?.title || '',
            url: tab?.url || '',
            selectedText: ''
          });
          return;
        }

        const selectedText = await getSelectedText(tab.id);
        setTabInfo({
          title: tab.title || '',
          url: tab.url || '',
          selectedText
        });
      } catch (error) {
        console.error('Error getting tab info:', error);
        setTabInfo({ title: '', url: '', selectedText: '' });
      }
    };

    getCurrentTabInfo();
  }, []);

  return (
    <div className="w-[480px] bg-white shadow-lg">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-600 to-purple-600 text-white p-4">
        <div className="flex items-center space-x-2">
          <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center">
            🐿️
          </div>
          <div>
            <h1 className="text-lg font-bold">Squirrel</h1>
            <p className="text-sm opacity-90">Save links for winter</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex border-b" role="tablist" aria-label="Squirrel sections">
        <button
          type="button"
          role="tab"
          id="tab-add"
          aria-selected={activeTab === 'add'}
          aria-controls="panel-add"
          onClick={() => setActiveTab('add')}
          className={`flex-1 py-3 px-4 text-center font-medium transition-colors ${
            activeTab === 'add'
              ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600'
              : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
          }`}
        >
          Add Link
        </button>
        <button
          type="button"
          role="tab"
          id="tab-saved"
          aria-selected={activeTab === 'saved'}
          aria-controls="panel-saved"
          onClick={() => setActiveTab('saved')}
          className={`flex-1 py-3 px-4 text-center font-medium transition-colors ${
            activeTab === 'saved'
              ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600'
              : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
          }`}
        >
          Saved Links
        </button>
      </div>

      {/* Content */}
      <div>
        {activeTab === 'add' ? (
          <div role="tabpanel" id="panel-add" aria-labelledby="tab-add">
            <LinkForm tabInfo={tabInfo ?? undefined} />
          </div>
        ) : (
          <div role="tabpanel" id="panel-saved" aria-labelledby="tab-saved">
            <SavedLinks />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="bg-gray-50 px-4 py-2 text-center">
        <p className="text-xs text-gray-500">
          Press <kbd className="px-1 py-0.5 bg-gray-200 rounded text-xs">Ctrl+Shift+F</kbd> to open
        </p>
      </div>

      {import.meta.env.DEV ? <ReactQueryDevtools initialIsOpen={false} /> : null}
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}