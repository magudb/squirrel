import '@testing-library/jest-dom';
import { vi, beforeEach } from 'vitest';

// Mock Chrome Extension APIs
const mockChrome = {
  tabs: {
    query: vi.fn(),
    sendMessage: vi.fn(),
  },
  scripting: {
    executeScript: vi.fn(),
  },
  storage: {
    local: {
      get: vi.fn<[string[]], Promise<{ [key: string]: unknown }>>().mockResolvedValue({}),
      set: vi.fn<[{ [key: string]: unknown }], Promise<void>>().mockResolvedValue(undefined),
    },
  },
  runtime: {
    id: 'test-extension-id',
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onInstalled: {
      addListener: vi.fn(),
    },
  },
  notifications: {
    create: vi.fn(),
  },
  commands: {
    onCommand: {
      addListener: vi.fn(),
    },
  },
};

// @ts-expect-error - Mocking global chrome object
global.chrome = mockChrome;

// Reset mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});
