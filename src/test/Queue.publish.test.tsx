import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublishResult } from '../types';

/**
 * `_drafts/2025-06-20-on AI.md` has no front matter, so the listing reports its
 * filename as the title and the server publishes it as `_posts/<today>-on-ai.md`
 * — nothing the popup can derive from the title alone.
 */
const state = vi.hoisted(() => ({
  publishData: null as PublishResult | null,
}));

vi.mock('../hooks/useSquirrel', () => ({
  useSquirrelConfig: () => ({ isConfigured: true, isLoading: false }),
  useStatus: () => ({ data: null, error: null }),
  useQueue: () => ({
    links: [],
    isLoading: false,
    error: null,
    updateLink: { mutate: vi.fn(), error: null },
    deleteLink: { mutate: vi.fn(), error: null },
    flush: { mutate: vi.fn(), isPending: false, error: null, data: null },
  }),
  useDrafts: () => ({
    drafts: [
      {
        id: 'MjAyNS0wNi0yMC1vbiBBSS5tZA',
        filename: '2025-06-20-on AI.md',
        path: '_drafts/2025-06-20-on AI.md',
        title: '2025-06-20-on AI.md',
        curated: false,
      },
    ],
    target: null,
    setTarget: { mutate: vi.fn(), isPending: false, error: null },
  }),
  useSquirrelCategories: () => ({ data: [] }),
  useCreateDraft: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
    data: null,
  }),
  usePublish: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
    data: state.publishData,
  }),
}));

import { Queue } from '../components/Queue';

const POST_FILE = /_posts\/\d{4}-\d{2}-\d{2}-[^\s]*\.md/;

async function openConfirmation() {
  const user = userEvent.setup();
  render(<Queue />);
  const [, publishSelect] = screen.getAllByRole('combobox');
  await user.selectOptions(publishSelect, 'MjAyNS0wNi0yMC1vbiBBSS5tZA');
  await user.click(screen.getByRole('button', { name: 'Publish...' }));
}

describe('Queue publish confirmation', () => {
  beforeEach(() => {
    state.publishData = null;
  });

  it('does not name a destination file the server may not create', async () => {
    await openConfirmation();

    expect(screen.getByText(/There is no undo from here/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(POST_FILE);
  });

  it('names the destination only once the server reports it', async () => {
    state.publishData = {
      ok: true,
      commitSha: '0f6651bcafe',
      postPath: '_posts/2026-08-26-on-ai.md',
      draftPath: '_drafts/2025-06-20-on AI.md',
      linksIncluded: 2,
      skipped: 0,
      unroutable: 0,
      prunedSections: [],
    };
    render(<Queue />);

    expect(screen.getByText('_posts/2026-08-26-on-ai.md')).toBeInTheDocument();
  });
});
