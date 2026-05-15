import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BlogService, BackendError } from '../utils/blogService';
import { Link, BlogPost } from '../types';

export const useBlogMutation = () => {
  const queryClient = useQueryClient();

  const addLinkMutation = useMutation({
    mutationFn: async ({ link, blogPost }: { link: Link; blogPost: BlogPost }) => {
      // Save locally first (always succeeds)
      await BlogService.saveLinkLocally(link);

      // Then add to blog (may throw)
      await BlogService.addLinkToBlog(link, blogPost);
      return link;
    },
    retry: 1,
    retryDelay: 2000,
    onSuccess: (link) => {
      queryClient.invalidateQueries({ queryKey: ['savedLinks'] });
      chrome.notifications?.create({
        type: 'basic',
        iconUrl: 'images/icon.png',
        title: 'Link Added',
        message: `Added to blog: ${link.title}`
      });
      window.close();
    },
    onError: (error) => {
      // Still invalidate saved links since we saved locally
      queryClient.invalidateQueries({ queryKey: ['savedLinks'] });

      const message = error instanceof BackendError
        ? error.message
        : 'Failed to add link. Please try again.';

      chrome.notifications?.create({
        type: 'basic',
        iconUrl: 'images/icon.png',
        title: 'Error Adding Link',
        message
      });
    }
  });

  // Build a user-friendly error string
  const errorMessage = addLinkMutation.error
    ? addLinkMutation.error instanceof BackendError
      ? addLinkMutation.error.message
      : 'Something went wrong. Please try again.'
    : null;

  return {
    addLink: addLinkMutation.mutate,
    isLoading: addLinkMutation.isPending,
    error: addLinkMutation.error,
    errorMessage,
    reset: addLinkMutation.reset,
  };
};
