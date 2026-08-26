import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AnalyzeLinkResponse, TabInfo } from '../types';

/**
 * The sidecar takes ~12.7s on a URL it has not seen, which is how three real
 * links reached the blog with no description and the default category. The
 * deferred below is that gap: the form has to stay usable inside it, and
 * whatever the user does inside it has to survive the result landing.
 */
const state = vi.hoisted(() => {
  type Deferred = {
    promise: Promise<AnalyzeLinkResponse | null>;
    resolve: (value: AnalyzeLinkResponse | null) => void;
  };
  const defer = (): Deferred => {
    let resolve!: (value: AnalyzeLinkResponse | null) => void;
    const promise = new Promise<AnalyzeLinkResponse | null>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  return {
    defer,
    analysis: defer(),
    aiSidecarAvailable: undefined as boolean | undefined,
    addLink: vi.fn(),
    categories: [
      { id: 'favorites', name: 'My favorites', anchor: 'favorites' },
      { id: 'agile', name: 'Agile, Leadership and Product', anchor: 'agile' },
    ],
  };
});

vi.mock('../utils/blogService', () => ({
  BlogService: {
    analyzeLink: vi.fn(() => state.analysis.promise),
  },
}));

vi.mock('../hooks/useBlogData', () => ({
  useBlogData: () => ({
    categories: state.categories,
    savedLinks: [],
    isLoading: false,
    error: null,
    errorMessage: null,
    notConfigured: false,
    serviceUnreachable: false,
    aiSidecarAvailable: state.aiSidecarAvailable,
    refetch: vi.fn(),
  }),
}));

vi.mock('../hooks/useBlogMutation', () => ({
  useBlogMutation: () => ({
    addLink: state.addLink,
    isLoading: false,
    error: null,
    errorMessage: null,
    reset: vi.fn(),
  }),
}));

import { LinkForm } from '../components/LinkForm';

const TAB: TabInfo = {
  url: 'https://example.com/post',
  title: 'Raw page title',
  selectedText: '',
};

const AI_RESULT: AnalyzeLinkResponse = {
  category: 'agile',
  description: 'A field guide to running retrospectives that change something',
};

/**
 * userEvent's async wrapper does not inherit React's act environment here, so
 * every interaction that changes state goes through act by hand — otherwise the
 * keystroke lands as an unwrapped update and the assertion races the re-render.
 */
const interact = (run: () => Promise<unknown>) => act(async () => {
  await run();
});

function renderForm() {
  const user = userEvent.setup();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <LinkForm tabInfo={TAB} />
    </QueryClientProvider>,
  );
  return user;
}

/** Land the AI result and wait for the form to come out of its waiting state. */
async function landAnalysis(result: AnalyzeLinkResponse | null = AI_RESULT) {
  await act(async () => {
    state.analysis.resolve(result);
    await state.analysis.promise;
  });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /Waiting for AI/ })).not.toBeInTheDocument(),
  );
}

const description = () => screen.getByLabelText(/Description/) as HTMLTextAreaElement;

describe('LinkForm AI suggestions', () => {
  beforeEach(() => {
    state.analysis = state.defer();
    state.aiSidecarAvailable = true;
    state.addLink.mockReset();
  });

  it('holds the primary submit while analysing and releases it on the result', async () => {
    renderForm();

    const waiting = await screen.findByRole('button', { name: /Waiting for AI/ });
    expect(waiting).toBeDisabled();
    expect(description()).toHaveAttribute('aria-busy', 'true');

    await landAnalysis();

    expect(screen.getByRole('button', { name: 'Add Link' })).toBeEnabled();
    expect(description()).toHaveAttribute('aria-busy', 'false');
  });

  it('saves without AI while the analysis is still in flight', async () => {
    const user = renderForm();
    await screen.findByRole('button', { name: /Waiting for AI/ });

    const escapeHatch = screen.getByRole('button', { name: 'Save without AI' });
    expect(escapeHatch).toBeEnabled();
    await interact(() => user.click(escapeHatch));

    expect(state.addLink).toHaveBeenCalledTimes(1);
    expect(state.addLink).toHaveBeenCalledWith(
      expect.objectContaining({ url: TAB.url, title: TAB.title, category: 'favorites' }),
    );
  });

  it('keeps a typed description when the AI result lands, and offers the suggestion', async () => {
    const user = renderForm();
    await screen.findByRole('button', { name: /Waiting for AI/ });

    // Typing at all is the point of rule 4: the field is no longer disabled
    // while the sidecar thinks, and userEvent refuses a disabled field.
    expect(description()).toBeEnabled();
    await interact(() => user.type(description(), 'My own words'));
    await landAnalysis();

    expect(description()).toHaveValue('My own words');

    await interact(() => user.click(screen.getByRole('button', { name: 'Use AI suggestion' })));
    expect(description()).toHaveValue(AI_RESULT.description);
  });

  it('fills an untouched description and category from the AI result', async () => {
    renderForm();
    await screen.findByRole('button', { name: /Waiting for AI/ });

    await landAnalysis();

    expect(description()).toHaveValue(AI_RESULT.description);
    expect(screen.getByLabelText(/Category/)).toHaveValue('agile');
    expect(screen.queryByRole('button', { name: 'Use AI suggestion' })).not.toBeInTheDocument();
  });

  it('does not wait on a sidecar that is not there', async () => {
    state.aiSidecarAvailable = false;
    renderForm();

    // The analysis is never resolved: an absent sidecar must not be a delay.
    expect(await screen.findByRole('button', { name: 'Add Link' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /Waiting for AI/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/AI suggestions are unavailable/);
  });
});
