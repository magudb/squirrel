import { useQuery } from '@tanstack/react-query';
import { useSquirrelCategories, useSquirrelConfig } from './useSquirrel';
import { BlogService } from '../utils/blogService';
import { Category } from '../types';

/**
 * The section list, duplicated from `server/api/_lib/categories.ts`.
 *
 * The outbox accepts a link while the service is unreachable, and the form
 * promises exactly that — but a link still has to name a category to be saved
 * at all. An empty select would turn "we'll send it later" into "you cannot
 * save this". Ids must stay in step with the server, which validates them.
 */
const FALLBACK_CATEGORIES: Category[] = [
  { id: 'favorites', name: 'My favorites', anchor: 'favorites' },
  { id: 'agile', name: 'Agile, Leadership and Product', anchor: 'agile' },
  {
    id: 'development',
    name: 'Architecture, Development & Software development practices',
    anchor: 'development',
  },
  { id: 'devops', name: 'DevOps, Observability & Security', anchor: 'devops' },
  { id: 'tools', name: 'Tools and things from Github', anchor: 'tools' },
  { id: 'ai', name: 'AI, LLM & Machine Learning', anchor: 'ai' },
];

/**
 * What the popup's forms need to render.
 *
 * "No URL and token yet" and "the service is down" are separate flags because
 * they need separate advice: one is a trip to the Settings tab, the other is a
 * wait — and the second one no longer blocks a save, since the service worker's
 * outbox holds the link either way.
 */
export const useBlogData = () => {
  const { isConfigured, isLoading: configLoading } = useSquirrelConfig();
  const categoriesQuery = useSquirrelCategories();

  const savedLinksQuery = useQuery({
    queryKey: ['savedLinks'],
    queryFn: () => BlogService.getSavedLinks(),
    staleTime: 30 * 1000,
    retry: 2,
  });

  // The sidecar runs on one machine and is optional everywhere else, so its
  // absence is a missing feature rather than a failure: it never feeds `error`.
  const localAiQuery = useQuery({
    queryKey: ['localAi'],
    queryFn: () => BlogService.checkLocalAi(),
    staleTime: 60 * 1000,
    retry: false,
  });

  const notConfigured = !configLoading && !isConfigured;
  const serviceUnreachable = isConfigured && categoriesQuery.isError;

  const errorMessage = serviceUnreachable
    ? categoriesQuery.error?.message ?? 'The Squirrel service is not responding.'
    : savedLinksQuery.error?.message ?? null;

  return {
    categories: categoriesQuery.data ?? FALLBACK_CATEGORIES,
    savedLinks: savedLinksQuery.data ?? [],
    // Only the config gates the form. Waiting on categories would hold the UI
    // behind a spinner for the full retry budget of an unreachable service —
    // the one case where the form most needs to be usable.
    isLoading: configLoading,
    error: categoriesQuery.error ?? savedLinksQuery.error,
    errorMessage,
    /** No service URL and token stored yet. Fixed in the Settings tab. */
    notConfigured,
    /** Configured, but the service did not answer. Saves still queue. */
    serviceUnreachable,
    /** Undefined until the probe answers, so the UI need not flash a verdict. */
    aiSidecarAvailable: localAiQuery.data,
    refetch: () => {
      categoriesQuery.refetch();
      savedLinksQuery.refetch();
    },
  };
};
