import { useQuery } from '@tanstack/react-query';
import { BlogService } from '../utils/blogService';

export const useBlogData = () => {
  const categoriesQuery = useQuery({
    queryKey: ['categories'],
    queryFn: () => BlogService.getCategories(),
    staleTime: 5 * 60 * 1000,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });

  const blogFilesQuery = useQuery({
    queryKey: ['blogFiles'],
    queryFn: () => BlogService.findCuratedInsightsFiles(),
    staleTime: 2 * 60 * 1000,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
  });

  const savedLinksQuery = useQuery({
    queryKey: ['savedLinks'],
    queryFn: () => BlogService.getSavedLinks(),
    staleTime: 30 * 1000,
    retry: 2,
  });

  // Determine if backend is down (both backend-dependent queries failed)
  const backendDown = categoriesQuery.isError && blogFilesQuery.isError;

  // Build a user-friendly error message
  const errorMessage = backendDown
    ? 'Backend not reachable — is the squirrel-backend service running?'
    : categoriesQuery.error?.message || blogFilesQuery.error?.message || null;

  return {
    categories: categoriesQuery.data || [],
    blogFiles: blogFilesQuery.data || [],
    savedLinks: savedLinksQuery.data || [],
    isLoading: categoriesQuery.isLoading || blogFilesQuery.isLoading,
    error: categoriesQuery.error || blogFilesQuery.error || savedLinksQuery.error,
    errorMessage,
    backendDown,
    refetch: () => {
      categoriesQuery.refetch();
      blogFilesQuery.refetch();
    },
  };
};
