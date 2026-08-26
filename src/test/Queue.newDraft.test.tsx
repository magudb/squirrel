import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CreateDraftResponse } from '../types';
import { SquirrelApiError } from '../utils/squirrelApi';

/**
 * The create path commits to master of the live blog, so the things worth
 * pinning are the ones that would cost a manual repo edit to undo: no commit
 * without a confirm, no second commit from a double click, and no filename
 * claimed that the server did not send.
 */
const state = vi.hoisted(() => ({
  createMutate: vi.fn(),
  createPending: false,
  createError: null as Error | null,
  createData: null as CreateDraftResponse | null,
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
    drafts: [],
    target: null,
    setTarget: { mutate: vi.fn(), isPending: false, error: null },
  }),
  useSquirrelCategories: () => ({ data: [] }),
  useCreateDraft: () => ({
    mutate: state.createMutate,
    isPending: state.createPending,
    error: state.createError,
    data: state.createData,
  }),
  usePublish: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
    data: null,
  }),
}));

import { Queue } from '../components/Queue';

const TITLE = 'Curated Insights: Q4 2026 — Don’t Panic';
const SLUG = 'curated-insights-q4-2026-dont-panic';

/**
 * The fields are filled with `fireEvent.change` rather than `user.type`: the
 * form reacts to the value, not to the keystrokes, and typing 38 characters is
 * 38 renders of noise per test.
 */
async function openForm(title = TITLE, date = '2026-10-01') {
  const user = userEvent.setup();
  render(<Queue />);
  await user.click(screen.getByRole('button', { name: 'New draft' }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: title } });
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: date } });
  return user;
}

describe('Queue new draft', () => {
  beforeEach(() => {
    state.createMutate = vi.fn();
    state.createPending = false;
    state.createError = null;
    state.createData = null;
  });

  it('stays collapsed until asked for', () => {
    render(<Queue />);

    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New draft' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('previews the filename with the service’s own slug rule, labelled as a preview', async () => {
    await openForm();

    expect(screen.getByText(`_drafts/2026-10-01-${SLUG}.md`)).toBeInTheDocument();
    expect(screen.getByText(/same rule the service uses/)).toBeInTheDocument();
  });

  it('will not commit without a confirmation', async () => {
    const user = await openForm();

    await user.click(screen.getByRole('button', { name: 'Create draft...' }));

    expect(state.createMutate).not.toHaveBeenCalled();
    expect(screen.getByText('This commits to master')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create in master' }));

    expect(state.createMutate).toHaveBeenCalledTimes(1);
    expect(state.createMutate).toHaveBeenCalledWith({
      title: TITLE,
      date: '2026-10-01',
      setAsTarget: true,
    });
  });

  it('drops the confirmation when the title changes under it', async () => {
    const user = await openForm();
    await user.click(screen.getByRole('button', { name: 'Create draft...' }));

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: `${TITLE} again` } });

    expect(screen.queryByText('This commits to master')).not.toBeInTheDocument();
    expect(state.createMutate).not.toHaveBeenCalled();
  });

  it('cannot be submitted again while the commit is in flight', async () => {
    state.createPending = true;
    const user = await openForm();
    await user.click(screen.getByRole('button', { name: 'Create draft...' }));

    const confirm = screen.getByRole('button', { name: 'Creating...' });
    expect(confirm).toBeDisabled();
    // Cancel does not pretend to abort a commit that is already on its way.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await user.click(confirm);
    fireEvent.click(confirm);
    expect(state.createMutate).not.toHaveBeenCalled();
  });

  it('says a 409 means the file is already there', async () => {
    state.createError = new SquirrelApiError('Request failed (HTTP 409)', 409, 'draft_exists');
    await openForm();

    expect(screen.getByText('That draft already exists')).toBeInTheDocument();
    expect(screen.getByText(/already exists for that date/)).toBeInTheDocument();
    expect(screen.getByText('Nothing was committed.')).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 409/)).not.toBeInTheDocument();
  });

  it('passes a 400 through with the service’s reason', async () => {
    state.createError = new SquirrelApiError('Title produces an empty slug', 400, 'bad_title');
    await openForm();

    expect(screen.getByText('The service would not accept that title')).toBeInTheDocument();
    expect(screen.getByText('Title produces an empty slug')).toBeInTheDocument();
  });

  it('does not claim the commit was skipped when the service never answered', async () => {
    state.createError = new SquirrelApiError('The service did not answer within 20s.', undefined, 'timeout');
    await openForm();

    expect(screen.getByText(/the commit may still have landed/)).toBeInTheDocument();
  });

  it('reports the path the service sent back, not the preview', async () => {
    state.createData = {
      draft: {
        id: 'aWQ',
        filename: `2026-10-01-${SLUG}.md`,
        path: `_drafts/2026-10-01-${SLUG}.md`,
        title: TITLE,
        curated: true,
      },
      commitSha: '0f6651bcafe1234',
      target: { draftId: 'aWQ', path: `_drafts/2026-10-01-${SLUG}.md`, setAt: 1_700_000_000_000 },
    };
    const user = userEvent.setup();
    render(<Queue />);
    await user.click(screen.getByRole('button', { name: 'New draft' }));

    expect(screen.getByText('Draft created')).toBeInTheDocument();
    expect(screen.getByText(`_drafts/2026-10-01-${SLUG}.md`)).toBeInTheDocument();
    expect(screen.getByText(/commit 0f6651b/)).toBeInTheDocument();
    expect(screen.getByText(/flushes now write into it/)).toBeInTheDocument();
    // The form is gone, so there is nothing left to submit a second time.
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
  });
});
