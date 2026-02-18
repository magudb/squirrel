# Ollama Auto-Categorization Design

## Problem

When creating a new link in Squirrel, the user must manually pick a category and the link text defaults to the page title. This is slow and the page title is often not descriptive enough for a curated blog.

## Solution

Use Ollama (qwen3:14b) to automatically suggest a category and generate a short description when a link is being added. The backend fetches the page content, sends it to Ollama, and returns a suggestion that pre-fills the form. The user can override both before saving.

## Decisions

- **Trigger**: Suggest before save (auto-trigger when popup opens with a URL)
- **Ollama caller**: Backend (Express server at localhost:3001)
- **Content source**: Fetch full page content from URL, extract readable text
- **Description use**: Replace link text in blog markdown (AI description instead of page title)
- **Architecture**: Simple new endpoint, loading spinner, no streaming

## Backend

### New endpoint: `POST /api/analyze-link`

**Request**: `{ url: string, title: string, selectedText?: string }`

**Response**: `{ category: string, description: string }`

**Steps**:
1. Fetch URL HTML content with `fetch()` (Node 18+ built-in)
2. Extract readable text using `cheerio` (strip nav, footer, scripts, truncate to ~2000 chars)
3. Build prompt with categories list + page content
4. Call Ollama at `http://localhost:11434/api/generate` with model `qwen3:14b`
5. Parse JSON response, return category ID + description

### Ollama prompt

```
Given these categories:
- favorites: My favorites
- agile: Agile, Leadership and Product
- development: Architecture, Development & Software development practices
- devops: DevOps, Observability & Security
- tools: Tools and things from Github
- ai: AI, LLM & Machine Learning

Analyze this article and respond with JSON only:
Title: {title}
URL: {url}
Content: {truncated page text}

Respond with exactly this JSON format, no other text:
{"category": "<category_id>", "description": "<1-2 sentence description for a tech blog link list>"}
```

## Frontend

### LinkForm.tsx changes

- Auto-trigger analyze request when popup opens with a URL
- Loading state: category dropdown shows "Analyzing..." (disabled), description field shows spinner
- On success: pre-select suggested category, populate description field
- On error: fall back to manual mode, show "AI suggestion unavailable" warning
- User can override both category and description before saving

### New description field

- Editable text input below the category dropdown
- Pre-filled by AI, editable by user
- Used as the link text in blog markdown: `- [description](url){:target="_blank"}`
- Falls back to page title if empty

## Error Handling

- **Ollama not running**: 503 to extension, fall back to manual mode
- **Page fetch fails**: Send just URL + title to Ollama (degraded). If that fails too, 503
- **Bad JSON from Ollama**: Try regex fallback to extract fields. If unparseable, 500
- **Slow response (>10s)**: Backend timeout. Extension shows "Taking longer..." after 5s with "Skip" button
- **Unknown category ID**: Leave category unselected for user to pick

## New Dependency

- `cheerio` for HTML text extraction

## Files Changed

| File | Change |
|------|--------|
| `src/blogBackend.js` | Add `/api/analyze-link`, `fetchPageContent()`, `analyzeWithOllama()` |
| `src/utils/blogService.ts` | Add `analyzeLink()`, update `formatLink()` to use description |
| `src/components/LinkForm.tsx` | Auto-trigger analysis, description field, loading states |
| `src/types/index.ts` | Add `description` to Link, add `AnalyzeLinkResponse` type |
| `src/hooks/useAnalyzeLink.ts` | New React Query hook for analyze call |
| `package.json` | Add `cheerio` |
