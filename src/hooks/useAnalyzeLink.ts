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
    error: mutation.error,
    reset: mutation.reset,
  };
};
