import { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { LinkForm } from './components/LinkForm';
import { SavedLinks } from './components/SavedLinks';
import { Queue } from './components/Queue';
import { Settings } from './components/Settings';
import { useSquirrelConfig } from './hooks/useSquirrel';
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

const TABS = [
  { id: 'add', label: 'Add' },
  { id: 'queue', label: 'Queue' },
  { id: 'saved', label: 'Saved' },
  { id: 'settings', label: 'Settings' },
] as const;

type Tab = (typeof TABS)[number]['id'];

function AppContent() {
  const [activeTab, setActiveTab] = useState<Tab>('add');
  const [landed, setLanded] = useState(false);
  const [tabInfo, setTabInfo] = useState<TabInfo | null>(null);
  const { isConfigured, isLoading: configLoading } = useSquirrelConfig();

  // Every other tab is empty without a service, so open on the one that fixes
  // that. Only on the first load — never yank the user off a tab they chose.
  useEffect(() => {
    if (configLoading || landed) return;
    setLanded(true);
    if (!isConfigured) setActiveTab('settings');
  }, [configLoading, isConfigured, landed]);

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
      <div className="flex border-b">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 py-3 px-2 text-center text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div>
        {/*
          Add stays mounted and is hidden instead, because its state is
          volatile and expensive: a first-time AI analysis takes ~13s, and
          unmounting mid-flight throws away both the pending result and
          anything the user has typed. Nipping over to Queue to check the
          outbox should not cost you the description. The other tabs own no
          state worth preserving, so they still mount on demand.
        */}
        <div hidden={activeTab !== 'add'}>
          <LinkForm tabInfo={tabInfo ?? undefined} />
        </div>
        {activeTab === 'queue' && <Queue />}
        {activeTab === 'saved' && <SavedLinks />}
        {activeTab === 'settings' && <Settings />}
      </div>

      {/* Footer */}
      <div className="bg-gray-50 px-4 py-2 text-center">
        <p className="text-xs text-gray-500">
          Press <kbd className="px-1 py-0.5 bg-gray-200 rounded text-xs">Ctrl+Shift+F</kbd> to open
        </p>
      </div>

      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
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