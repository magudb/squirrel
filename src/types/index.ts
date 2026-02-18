export interface Link {
  id: string;
  url: string;
  title: string;
  selectedText?: string;
  description?: string;
  category: string;
  timestamp: number;
}

export interface Category {
  id: string;
  name: string;
  anchor: string;
}

export interface BlogPost {
  path: string;
  filename: string;
  title: string;
}

export interface TabInfo {
  title: string;
  url: string;
  selectedText?: string;
}

export interface AnalyzeLinkResponse {
  category: string;
  description: string;
}