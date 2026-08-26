import { useMutation } from '@tanstack/react-query';
import { BlogService } from '../utils/blogService';
import { AnalyzeLinkResponse } from '../types';

export const useAnalyzeLink = () => {
  const mutation = useMutation({
    mutationFn: async ({ url, title, selectedText, forceRefresh }: { url: string; title: string; selectedText?: string; forceRefresh?: boolean }): Promise<AnalyzeLinkResponse | null> => {
      return BlogService.analyzeLink(url, title, selectedText, forceRefresh);
    },
  });

  return {
    analyze: mutation.mutate,
    data: mutation.data ?? null,
    isAnalyzing: mutation.isPending,
    /**
     * The call is over. `analyzeLink` swallows its own failures and answers
     * `null`, so "settled with no data" is the only way the form can tell an
     * absent suggestion from one that has not arrived yet.
     */
    isSettled: mutation.isSuccess || mutation.isError,
    error: mutation.error,
    reset: mutation.reset,
  };
};
