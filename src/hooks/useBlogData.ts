import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BlogService } from '../utils/blogService';
import { Category, BlogPost, Link } from '../types';

// Hoisted so the `data || EMPTY` fallbacks keep a stable identity while a query
// is loading or errored. Consumers use these arrays as effect dependencies, and
// a fresh [] per render would re-run those effects on every render.
const EMPTY_CATEGORIES: Category[] = [];
const EMPTY_BLOG_FILES: BlogPost[] = [];
const EMPTY_LINKS: Link[] = [];

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

  const refetchCategories = categoriesQuery.refetch;
  const refetchBlogFiles = blogFilesQuery.refetch;
  const refetch = useCallback(() => {
    refetchCategories();
    refetchBlogFiles();
  }, [refetchCategories, refetchBlogFiles]);

  return {
    categories: categoriesQuery.data || EMPTY_CATEGORIES,
    blogFiles: blogFilesQuery.data || EMPTY_BLOG_FILES,
    savedLinks: savedLinksQuery.data || EMPTY_LINKS,
    isLoading: categoriesQuery.isLoading || blogFilesQuery.isLoading,
    error: categoriesQuery.error || blogFilesQuery.error || savedLinksQuery.error,
    errorMessage,
    backendDown,
    refetch,
  };
};
