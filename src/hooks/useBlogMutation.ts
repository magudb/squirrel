import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BlogService } from '../utils/blogService';
import { Link, NewLink } from '../types';

interface QueueAck {
  ok: boolean;
  queued?: number;
  error?: string;
}

/**
 * Hand the link to the service worker and wait for it to say the outbox write
 * landed.
 *
 * The popup is destroyed the instant focus leaves it, taking any fetch it
 * started with it — and this popup closes itself on success. So the network is
 * the worker's job, and the acknowledgement here means "durably queued", not
 * "delivered".
 */
async function queueWithServiceWorker(link: Link): Promise<void> {
  const payload: NewLink = {
    url: link.url,
    title: link.title,
    selectedText: link.selectedText,
    description: link.description,
    category: link.category,
    source: 'extension',
  };

  let ack: QueueAck | undefined;
  try {
    ack = (await chrome.runtime.sendMessage({ type: 'QUEUE_LINK', link: payload })) as
      | QueueAck
      | undefined;
  } catch (error) {
    throw new Error(
      `Squirrel's background service did not respond: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!ack?.ok) {
    throw new Error(ack?.error ?? 'The background service refused the link.');
  }
}

export const useBlogMutation = () => {
  const queryClient = useQueryClient();

  const addLinkMutation = useMutation({
    mutationFn: async (link: Link) => {
      // Local first, so there is a record even if the handoff below fails.
      await BlogService.saveLinkLocally(link);
      await queueWithServiceWorker(link);
      return link;
    },
    // The outbox is the retry mechanism now. Retrying here would only write a
    // second local copy of a link the worker may already hold.
    retry: false,
    onSuccess: (link) => {
      queryClient.invalidateQueries({ queryKey: ['savedLinks'] });
      chrome.notifications?.create({
        type: 'basic',
        iconUrl: 'images/icon.png',
        title: 'Link Queued',
        message: `Saved for the blog: ${link.title}`
      });
      window.close();
    },
    onError: (error) => {
      // Still invalidate saved links since we saved locally
      queryClient.invalidateQueries({ queryKey: ['savedLinks'] });

      chrome.notifications?.create({
        type: 'basic',
        iconUrl: 'images/icon.png',
        title: 'Error Adding Link',
        message: error instanceof Error ? error.message : 'Failed to add link. Please try again.'
      });
    }
  });

  const errorMessage = addLinkMutation.error
    ? addLinkMutation.error.message
    : null;

  return {
    addLink: addLinkMutation.mutate,
    isLoading: addLinkMutation.isPending,
    error: addLinkMutation.error,
    errorMessage,
    reset: addLinkMutation.reset,
  };
};
