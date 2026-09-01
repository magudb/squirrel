import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PublishResult } from '../types';
import type { ReviewedDraft } from '../hooks/useMetadataReview';
import { BackendError } from '../utils/blogService';
import { SquirrelApiError } from '../utils/squirrelApi';

/**
 * Publishing is the one irreversible button in this popup: it commits to master
 * and deploys the site. Two things are pinned here.
 *
 * The destination filename is never guessed — the server derives it from the
 * draft as it reads at that moment, on its own UTC clock, so anything computed
 * in the popup can name a different file than the one created.
 *
 * And a post is created with the front matter it will be read with, so the
 * metadata check is a gate rather than a suggestion: an unreviewed publish is
 * the case that cannot be taken back.
 */
const CURATED_ID = 'MjAyNi0wOC0wMS1UZWNoIERpZ2VzdC5tZA';
const PROSE_ID = 'MjAyNS0wNi0yMC1vbiBBSS5tZA';

const REVIEW: ReviewedDraft = {
  draftId: CURATED_ID,
  current: {
    title: 'Summer 2026 Tech Links',
    description: '',
    keywords: '',
  },
  review: {
    verdict: 'mismatch',
    title: 'Fall 2026 Tech Links',
    description: 'Nine links on engineering leadership and the cost of a rewrite.',
    keywords: 'leadership, architecture, go',
    notes: 'The title says Summer; every link landed after August.',
  },
};

const state = vi.hoisted(() => ({
  publishData: null as PublishResult | null,
  publishVariables: undefined as unknown,
  publishMutate: vi.fn(),
  reviewData: null as unknown,
  reviewError: null as Error | null,
  isReviewing: false,
  reviewMutate: vi.fn(),
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
        id: CURATED_ID,
        filename: '2026-08-01-Tech Digest.md',
        path: '_drafts/2026-08-01-Tech Digest.md',
        title: 'Summer 2026 Tech Links',
        curated: true,
      },
      // No front matter at all — a real file in this repo, and the one case the
      // metadata review cannot answer for.
      {
        id: PROSE_ID,
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
  useCreateDraft: () => ({ mutate: vi.fn(), isPending: false, error: null, data: null }),
  usePublish: () => ({
    mutate: state.publishMutate,
    reset: vi.fn(),
    isPending: false,
    error: null,
    data: state.publishData,
    variables: state.publishVariables,
  }),
}));

vi.mock('../hooks/useMetadataReview', () => ({
  useMetadataReview: () => ({
    review: state.reviewMutate,
    data: state.reviewData,
    isReviewing: state.isReviewing,
    error: state.reviewError,
    reset: vi.fn(),
  }),
}));

import { Queue } from '../components/Queue';

const POST_FILE = /_posts\/\d{4}-\d{2}-\d{2}-[^\s]*\.md/;

async function selectDraft(id: string) {
  const user = userEvent.setup();
  render(<Queue />);
  const [, publishSelect] = screen.getAllByRole('combobox');
  await user.selectOptions(publishSelect, id);
  return user;
}

describe('Queue publish gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.publishData = null;
    state.publishVariables = undefined;
    state.reviewData = null;
    state.reviewError = null;
    state.isReviewing = false;
  });

  it('will not open the confirmation until the metadata has been reviewed', async () => {
    const user = await selectDraft(CURATED_ID);

    expect(screen.getByRole('button', { name: 'Publish...' })).toBeDisabled();
    expect(screen.getByText(/Run the metadata check first/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Publish...' }));
    expect(screen.queryByText(/There is no undo from here/)).not.toBeInTheDocument();
  });

  it('stays blocked when the sidecar could not answer', async () => {
    state.reviewError = new BackendError('Local AI sidecar not responding (timeout)');
    await selectDraft(CURATED_ID);

    expect(screen.getByText('Metadata check failed')).toBeInTheDocument();
    expect(screen.getByText(/Local AI sidecar not responding/)).toBeInTheDocument();
    expect(screen.getByText(/npm run backend/)).toBeInTheDocument();
    // The failure explains itself rather than reading as approval.
    expect(screen.getByRole('button', { name: 'Publish...' })).toBeDisabled();
  });

  it('does not blame the sidecar for a failure that came from the service', async () => {
    // The check makes two hops. An older deployment answering without the draft
    // body used to surface as "start the sidecar", sending the user to restart
    // a process that was running fine.
    state.reviewError = new SquirrelApiError(
      'The service returned no draft body.',
      undefined,
      'draft_content_missing',
    );
    await selectDraft(CURATED_ID);

    expect(screen.getByText(/The service returned no draft body/)).toBeInTheDocument();
    expect(screen.queryByText(/npm run backend/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish...' })).toBeDisabled();
  });

  it('offers a review belonging to another draft to nobody', async () => {
    // A review is keyed to the draft it read; selecting a different one must not
    // let its metadata be published onto this post.
    state.reviewData = REVIEW;
    await selectDraft(PROSE_ID);

    expect(screen.getByRole('button', { name: 'Publish...' })).toBeDisabled();
  });

  it('shows what the AI proposes against what the file says', async () => {
    state.reviewData = REVIEW;
    await selectDraft(CURATED_ID);

    expect(screen.getByText(/The front matter does not match the links/)).toBeInTheDocument();
    expect(screen.getByText(/every link landed after August/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Fall 2026 Tech Links');
    expect(screen.getByLabelText('Description')).toHaveValue(REVIEW.review.description);
    // The old value stays visible, because the title names the file.
    expect(screen.getByText('Summer 2026 Tech Links')).toBeInTheDocument();
  });

  it('warns that the URL moves with the title, then sends the reviewed metadata', async () => {
    state.reviewData = REVIEW;
    const user = await selectDraft(CURATED_ID);

    await user.click(screen.getByRole('button', { name: 'Publish...' }));
    expect(screen.getByText(/the post's URL is built from the new one/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Publish to master' }));

    expect(state.publishMutate).toHaveBeenCalledWith({
      draftId: CURATED_ID,
      prune: false,
      meta: {
        title: 'Fall 2026 Tech Links',
        description: REVIEW.review.description,
        keywords: 'leadership, architecture, go',
      },
    });
  });

  it('refuses a post with no title, since the filename is built from it', async () => {
    state.reviewData = REVIEW;
    const user = await selectDraft(CURATED_ID);

    await user.clear(screen.getByLabelText('Title'));

    expect(screen.getByText(/A title is required/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish...' })).toBeDisabled();
  });

  it('does not name a destination file the server may not create', async () => {
    state.reviewData = REVIEW;
    const user = await selectDraft(CURATED_ID);

    await user.click(screen.getByRole('button', { name: 'Publish...' }));

    expect(screen.getByText(/There is no undo from here/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(POST_FILE);
  });

  it('names the destination and the fields written only once the server reports them', async () => {
    state.publishData = {
      ok: true,
      commitSha: '0f6651bcafe',
      postPath: '_posts/2026-08-26-fall-2026-tech-links.md',
      draftPath: '_drafts/2026-08-01-Tech Digest.md',
      linksIncluded: 2,
      skipped: 0,
      unroutable: 0,
      prunedSections: [],
      metaUpdated: ['title', 'description', 'keywords'],
    };
    render(<Queue />);

    expect(screen.getByText('_posts/2026-08-26-fall-2026-tech-links.md')).toBeInTheDocument();
    expect(screen.getByText(/Front matter written: title, description, keywords/)).toBeInTheDocument();
  });

  it('says nothing about front matter when none was sent and none was reported', async () => {
    state.publishData = {
      ok: true,
      commitSha: '0f6651bcafe',
      postPath: '_posts/2026-08-26-on-ai.md',
      draftPath: '_drafts/2025-06-20-on AI.md',
      linksIncluded: 0,
      skipped: 0,
      unroutable: 0,
      prunedSections: [],
    };
    render(<Queue />);

    expect(screen.queryByText(/Front matter written/)).not.toBeInTheDocument();
    expect(screen.queryByText(/did not report writing the front matter/)).not.toBeInTheDocument();
  });

  it('flags a service that took the metadata and said nothing about it', async () => {
    // What a deployment older than metadata support looks like from here: the
    // post was created, and it still carries the draft's front matter.
    state.publishVariables = { draftId: CURATED_ID, meta: { title: 'Fall 2026 Tech Links' } };
    state.publishData = {
      ok: true,
      commitSha: '0f6651bcafe',
      postPath: '_posts/2026-08-26-fall-2026-tech-links.md',
      draftPath: '_drafts/2026-08-01-Tech Digest.md',
      linksIncluded: 2,
      skipped: 0,
      unroutable: 0,
      prunedSections: [],
    };
    render(<Queue />);

    expect(screen.getByText(/did not report writing the front matter/)).toBeInTheDocument();
  });
});
