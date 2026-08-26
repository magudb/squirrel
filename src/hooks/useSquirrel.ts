import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SquirrelApi, SquirrelApiError, getConfig, setConfig } from '../utils/squirrelApi';
import type { LinkPatch, NewDraft, PendingLink, SquirrelConfig } from '../types';

/**
 * Query keys for everything the Vercel link service answers.
 *
 * Grouped under a single root so that saving a new base URL or token can
 * invalidate the whole subtree in one call — a different service or a different
 * token makes every cached answer wrong at once.
 */
export const squirrelKeys = {
  all: ['squirrel'] as const,
  config: ['squirrel', 'config'] as const,
  categories: ['squirrel', 'categories'] as const,
  status: ['squirrel', 'status'] as const,
  links: ['squirrel', 'links'] as const,
  drafts: ['squirrel', 'drafts'] as const,
  target: ['squirrel', 'target'] as const,
};

const retryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 5000);

/**
 * A rejected token, a bad request or an unknown id fails identically on every
 * attempt, so retrying only delays the message the user needs to act on. Retry
 * the transport-level failures, which are the ones that do clear up.
 */
function retryTransient(failureCount: number, error: Error): boolean {
  const status = error instanceof SquirrelApiError ? error.status : undefined;
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < 2;
}

/**
 * The stored config, shared by every hook here.
 *
 * chrome.storage is local and authoritative, so this never goes stale on its
 * own; the save mutation invalidates it explicitly.
 */
function useConfigQuery() {
  return useQuery({
    queryKey: squirrelKeys.config,
    queryFn: () => getConfig(),
    staleTime: Infinity,
    retry: false,
  });
}

export function useSquirrelConfig() {
  const queryClient = useQueryClient();
  const query = useConfigQuery();

  const saveMutation = useMutation({
    mutationFn: (config: SquirrelConfig) => setConfig(config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: squirrelKeys.all });
    },
  });

  return {
    config: query.data ?? null,
    isConfigured: Boolean(query.data),
    isLoading: query.isLoading,
    /** Awaitable, and must be the first await of a click handler: setConfig
     *  asks Chrome for the host permission and needs the live user gesture. */
    save: saveMutation.mutateAsync,
    isSaving: saveMutation.isPending,
    saveError: saveMutation.error,
  };
}

export function useSquirrelCategories() {
  const { data: config } = useConfigQuery();

  return useQuery({
    queryKey: squirrelKeys.categories,
    queryFn: () => SquirrelApi.getCategories(),
    enabled: Boolean(config),
    staleTime: 30 * 60 * 1000,
    retry: retryTransient,
    retryDelay,
  });
}

/**
 * Buffer health, refreshed while the popup is open.
 *
 * The poll is what makes `lastFlush.error` visible: an expired GitHub PAT makes
 * every flush fail without any other symptom, and the buffer just grows.
 */
export function useStatus() {
  const { data: config } = useConfigQuery();

  return useQuery({
    queryKey: squirrelKeys.status,
    queryFn: () => SquirrelApi.getStatus(),
    enabled: Boolean(config),
    refetchInterval: 30 * 1000,
    staleTime: 15 * 1000,
    retry: retryTransient,
    retryDelay,
  });
}

export function useQueue() {
  const queryClient = useQueryClient();
  const { data: config } = useConfigQuery();
  const enabled = Boolean(config);

  const linksQuery = useQuery({
    queryKey: squirrelKeys.links,
    queryFn: () => SquirrelApi.listLinks(),
    enabled,
    staleTime: 15 * 1000,
    retry: retryTransient,
    retryDelay,
  });

  const updateLink = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: LinkPatch }) => SquirrelApi.updateLink(id, patch),
    retry: false,
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: squirrelKeys.links });
      const previous = queryClient.getQueryData<PendingLink[]>(squirrelKeys.links);
      queryClient.setQueryData<PendingLink[]>(squirrelKeys.links, (links) =>
        links?.map((link) => (link.id === id ? { ...link, ...patch } : link)),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(squirrelKeys.links, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: squirrelKeys.links });
    },
  });

  const deleteLink = useMutation({
    mutationFn: (id: string) => SquirrelApi.deleteLink(id),
    retry: false,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: squirrelKeys.links });
      const previous = queryClient.getQueryData<PendingLink[]>(squirrelKeys.links);
      queryClient.setQueryData<PendingLink[]>(squirrelKeys.links, (links) =>
        links?.filter((link) => link.id !== id),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(squirrelKeys.links, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: squirrelKeys.links });
      queryClient.invalidateQueries({ queryKey: squirrelKeys.status });
    },
  });

  const flush = useMutation({
    mutationFn: () => SquirrelApi.flush(),
    // A flush writes a commit. An automatic second attempt would race the
    // first one's lock at best and duplicate work at worst — the user retries.
    retry: false,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: squirrelKeys.links });
      queryClient.invalidateQueries({ queryKey: squirrelKeys.status });
    },
  });

  return {
    links: linksQuery.data ?? [],
    isLoading: linksQuery.isLoading,
    error: linksQuery.error,
    refetch: linksQuery.refetch,
    updateLink,
    deleteLink,
    flush,
  };
}

export function useDrafts() {
  const queryClient = useQueryClient();
  const { data: config } = useConfigQuery();
  const enabled = Boolean(config);

  const draftsQuery = useQuery({
    queryKey: squirrelKeys.drafts,
    queryFn: () => SquirrelApi.listDrafts(),
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: retryTransient,
    retryDelay,
  });

  const targetQuery = useQuery({
    queryKey: squirrelKeys.target,
    queryFn: () => SquirrelApi.getTarget(),
    enabled,
    staleTime: 60 * 1000,
    retry: retryTransient,
    retryDelay,
  });

  const setTarget = useMutation({
    mutationFn: (draftId: string) => SquirrelApi.setTarget(draftId),
    retry: false,
    onSuccess: (target) => {
      queryClient.setQueryData(squirrelKeys.target, target);
      // Flush routing reads the target, and /api/status reports it back.
      queryClient.invalidateQueries({ queryKey: squirrelKeys.status });
    },
  });

  return {
    drafts: draftsQuery.data ?? [],
    target: targetQuery.data ?? null,
    isLoading: draftsQuery.isLoading || targetQuery.isLoading,
    error: draftsQuery.error ?? targetQuery.error,
    setTarget,
  };
}

/**
 * Creates the next Curated Insights draft in the blog repo.
 *
 * This is the once-a-quarter action that used to require a checkout of the blog
 * on the right machine, which is exactly the dependency the service exists to
 * remove.
 */
export function useCreateDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: NewDraft) => SquirrelApi.createDraft(draft),
    // A create writes a commit to master. Retrying on a timeout would attempt a
    // second file whose fate depends on whether the first one landed, and the
    // 409 that saves us only fires once the first commit is visible.
    retry: false,
    onSuccess: (result) => {
      // A new file in _drafts/ makes the cached listing wrong immediately, and
      // the listing is what the target and publish selects are built from.
      queryClient.invalidateQueries({ queryKey: squirrelKeys.drafts });
      if (result.target) {
        // Seed the answer the server already gave so the target select re-points
        // without a round trip, then confirm it — same shape as `setTarget`.
        queryClient.setQueryData(squirrelKeys.target, result.target);
        queryClient.invalidateQueries({ queryKey: squirrelKeys.target });
        // /api/status reports the target back, so it is stale too.
        queryClient.invalidateQueries({ queryKey: squirrelKeys.status });
      }
    },
  });
}

export function usePublish() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { draftId: string; slug?: string; prune?: boolean }) => SquirrelApi.publish(input),
    // Publishing commits to master and triggers a live deploy. Nothing about
    // that is safe to repeat without the user asking again.
    retry: false,
    onSuccess: () => {
      // The draft moved to _posts, the target was re-pointed and the buffer was
      // folded into the same commit — nothing cached survives that.
      queryClient.invalidateQueries({ queryKey: squirrelKeys.drafts });
      queryClient.invalidateQueries({ queryKey: squirrelKeys.target });
      queryClient.invalidateQueries({ queryKey: squirrelKeys.links });
      queryClient.invalidateQueries({ queryKey: squirrelKeys.status });
    },
  });
}
