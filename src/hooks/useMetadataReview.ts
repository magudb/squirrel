import { useMutation } from '@tanstack/react-query';
import { BlogService } from '../utils/blogService';
import { SquirrelApi } from '../utils/squirrelApi';
import { hasFrontMatter, readFrontMatter, type FrontMatterFields } from '../utils/frontMatter';
import { MetadataReview } from '../types';

export interface ReviewedDraft {
  draftId: string;
  /** What the file says today. */
  current: FrontMatterFields;
  /** What the local agent proposes it should say. */
  review: MetadataReview;
}

/**
 * The pre-publish metadata check.
 *
 * Two hops, and they belong to different machines: the draft comes from the
 * hosted service (only it can read the blog repo) and the judgement comes from
 * the local sidecar (only it has the agent CLI). Doing the fetch here rather
 * than in the component keeps that split in one place, and means the review is
 * always about the draft as master has it right now — not the cached listing
 * the picker was drawn from.
 *
 * No retry. The sidecar call costs a real agent invocation and takes the better
 * part of a minute; a silent second one on a timeout would double that while
 * the user watches a spinner.
 */
export const useMetadataReview = () => {
  const mutation = useMutation({
    mutationFn: async ({
      draftId,
      forceRefresh,
    }: {
      draftId: string;
      forceRefresh?: boolean;
    }): Promise<ReviewedDraft> => {
      const { content } = await SquirrelApi.getDraft(draftId);
      if (!hasFrontMatter(content)) {
        // The service would refuse the write anyway; saying so here costs a
        // round trip instead of an agent invocation the answer cannot be used.
        throw new Error(
          'This draft has no front matter, so there is no metadata to review or write.',
        );
      }
      const current = readFrontMatter(content);
      const review = await BlogService.reviewMetadata({ ...current, content, forceRefresh });
      return { draftId, current, review };
    },
    retry: false,
  });

  return {
    review: (draftId: string, forceRefresh = false) => mutation.mutate({ draftId, forceRefresh }),
    data: mutation.data ?? null,
    isReviewing: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
};
