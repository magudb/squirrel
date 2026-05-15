# Ollama Auto-Categorization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When adding a link, auto-suggest a category and description using Ollama qwen3:14b by fetching the page content and analyzing it.

**Architecture:** New `POST /api/analyze-link` endpoint on the Express backend fetches the page HTML, extracts readable text with cheerio, sends it to Ollama, and returns `{ category, description }`. The React popup auto-triggers this on load, pre-filling the form. User can override before saving. The description replaces the page title as the link text in the blog markdown.

**Tech Stack:** Node.js/Express backend, Ollama HTTP API (localhost:11434), cheerio for HTML parsing, React Query mutation for the frontend call.

---

### Task 1: Install cheerio dependency

**Files:**
- Modify: `package.json`

**Step 1: Install cheerio**

Run: `npm install cheerio --save-dev`

cheerio goes in devDependencies since it's used by the backend (which is a dev tool, not shipped in the extension).

**Step 2: Verify installation**

Run: `node -e "import('cheerio').then(c => console.log('cheerio OK'))"`
Expected: `cheerio OK`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add cheerio for HTML text extraction"
```

---

### Task 2: Add `description` field to the Link type

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/test/blogService.test.ts`

**Step 1: Write the failing test**

Add to `src/test/blogService.test.ts` inside the `formatLink` describe block:

```typescript
it('should use description as link text when present', () => {
  const link = {
    id: '1',
    url: 'https://example.com',
    title: 'Example Title',
    description: 'A concise summary of the article about testing',
    category: 'test',
    timestamp: Date.now(),
  };

  const result = BlogService.formatLink(link);
  expect(result).toBe('- [A concise summary of the article about testing](https://example.com){:target="_blank"}');
});

it('should fall back to selectedText when description is absent', () => {
  const link = {
    id: '1',
    url: 'https://example.com',
    title: 'Example Title',
    selectedText: 'Selected text here',
    category: 'test',
    timestamp: Date.now(),
  };

  const result = BlogService.formatLink(link);
  expect(result).toBe('- [Selected text here](https://example.com){:target="_blank"}');
});

it('should fall back to title when both description and selectedText are absent', () => {
  const link = {
    id: '1',
    url: 'https://example.com',
    title: 'Example Title',
    category: 'test',
    timestamp: Date.now(),
  };

  const result = BlogService.formatLink(link);
  expect(result).toBe('- [Example Title](https://example.com){:target="_blank"}');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/blogService.test.ts`
Expected: FAIL — `description` property doesn't exist on Link type yet, and `formatLink` doesn't use it.

**Step 3: Update the Link type**

In `src/types/index.ts`, add `description` to the `Link` interface:

```typescript
export interface Link {
  id: string;
  url: string;
  title: string;
  selectedText?: string;
  description?: string;
  category: string;
  timestamp: number;
}
```

Also add the new response type at the end of the file:

```typescript
export interface AnalyzeLinkResponse {
  category: string;
  description: string;
}
```

**Step 4: Update `formatLink` in `src/utils/blogService.ts`**

Change the `formatLink` method. The display text priority becomes: `description` > `selectedText` > `title`.

Replace line 57:
```typescript
const displayText = sanitizeMarkdown(link.selectedText?.trim() || link.title);
```

With:
```typescript
const displayText = sanitizeMarkdown(link.description?.trim() || link.selectedText?.trim() || link.title);
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/test/blogService.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/types/index.ts src/utils/blogService.ts src/test/blogService.test.ts
git commit -m "feat: add description field to Link type and update formatLink priority"
```

---

### Task 3: Add `analyzeLink` method to BlogService

**Files:**
- Modify: `src/utils/blogService.ts`
- Modify: `src/test/blogService.test.ts`

**Step 1: Write the failing test**

Add a new `describe('analyzeLink', ...)` block to `src/test/blogService.test.ts`:

```typescript
describe('analyzeLink', () => {
  it('should call backend analyze-link endpoint and return result', async () => {
    const mockResponse = { category: 'development', description: 'A guide to testing practices' };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response);

    const result = await BlogService.analyzeLink('https://example.com', 'Test Article', 'some selected text');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/analyze-link',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', title: 'Test Article', selectedText: 'some selected text' }),
      })
    );
    expect(result).toEqual(mockResponse);
  });

  it('should return null when backend returns non-ok response', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);

    const result = await BlogService.analyzeLink('https://example.com', 'Test');
    expect(result).toBeNull();
  });

  it('should return null when fetch throws', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'));

    const result = await BlogService.analyzeLink('https://example.com', 'Test');
    expect(result).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/blogService.test.ts`
Expected: FAIL — `BlogService.analyzeLink` is not a function.

**Step 3: Implement `analyzeLink` in `src/utils/blogService.ts`**

Add this method to the `BlogService` class, after the `getCategories` method (around line 23):

```typescript
static async analyzeLink(url: string, title: string, selectedText?: string): Promise<AnalyzeLinkResponse | null> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/analyze-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title, selectedText }),
    });

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error('Error analyzing link:', error);
    return null;
  }
}
```

Also add the import for `AnalyzeLinkResponse` at the top of `src/utils/blogService.ts`:

```typescript
import { Category, Link, BlogPost, AnalyzeLinkResponse } from '../types';
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/test/blogService.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/utils/blogService.ts src/test/blogService.test.ts
git commit -m "feat: add analyzeLink method to BlogService"
```

---

### Task 4: Add `/api/analyze-link` endpoint to backend

**Files:**
- Modify: `src/blogBackend.js`

**Step 1: Add the helper functions**

Add these two functions after the existing `formatLink` function (after line 59) in `src/blogBackend.js`:

```javascript
async function fetchPageContent(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Squirrel/2.0; +https://github.com/magudb/squirrel)',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch page: ${response.status}`);
  }

  const html = await response.text();
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);

  // Remove non-content elements
  $('script, style, nav, footer, header, aside, iframe, noscript').remove();

  // Try to get main content, fall back to body
  const mainContent = $('main, article, [role="main"], .content, .post, .article').first();
  const text = (mainContent.length ? mainContent : $('body')).text();

  // Clean up whitespace and truncate
  return text.replace(/\s+/g, ' ').trim().slice(0, 3000);
}

async function analyzeWithOllama(url, title, pageContent, selectedText) {
  const categoryList = CATEGORIES.map(c => `- ${c.id}: ${c.name}`).join('\n');

  const prompt = `Given these categories:
${categoryList}

Analyze this article and respond with JSON only:
Title: ${title}
URL: ${url}
${selectedText ? `Selected text: ${selectedText}` : ''}
Content: ${pageContent}

Respond with exactly this JSON format, no other text:
{"category": "<category_id>", "description": "<1-2 sentence description for a tech blog link list>"}`;

  const response = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3:14b',
      prompt,
      stream: false,
      format: 'json',
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}`);
  }

  const data = await response.json();
  const parsed = JSON.parse(data.response);

  // Validate category exists
  const validCategory = CATEGORIES.find(c => c.id === parsed.category);
  if (!validCategory) {
    parsed.category = CATEGORIES[0].id; // Default to first category
  }

  return {
    category: parsed.category,
    description: parsed.description || title,
  };
}
```

**Step 2: Add the endpoint**

Add this route after the existing `/api/blog-files` endpoint (after line 177):

```javascript
app.post('/api/analyze-link', async (req, res) => {
  try {
    const { url, title, selectedText } = req.body;

    if (!url || !title) {
      return res.status(400).json({ error: 'url and title are required' });
    }

    // Fetch page content (gracefully degrade if it fails)
    let pageContent = '';
    try {
      pageContent = await fetchPageContent(url);
    } catch (err) {
      console.warn(`Could not fetch page content for ${url}:`, err.message);
    }

    // Analyze with Ollama
    const result = await analyzeWithOllama(url, title, pageContent, selectedText);
    res.json(result);
  } catch (error) {
    console.error('Error in analyze-link endpoint:', error);
    res.status(503).json({
      error: 'AI analysis unavailable',
      message: error.message,
    });
  }
});
```

**Step 3: Update the startup log**

Update the console.log block at the bottom (around line 219) to include the new endpoint:

```javascript
console.log('  POST /api/analyze-link');
```

Add this line after the existing `POST /api/add-link` log line.

**Step 4: Test manually**

Run the backend and test with curl:

```bash
# Terminal 1: Start backend
npm run backend

# Terminal 2: Test the endpoint (make sure Ollama is running with qwen3:14b)
curl -X POST http://localhost:3001/api/analyze-link \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://martinfowler.com/articles/continuousIntegration.html", "title": "Continuous Integration"}'
```

Expected: JSON response like `{"category": "development", "description": "..."}`

**Step 5: Commit**

```bash
git add src/blogBackend.js
git commit -m "feat: add /api/analyze-link endpoint with Ollama integration"
```

---

### Task 5: Update `formatLink` in the backend to use description

**Files:**
- Modify: `src/blogBackend.js`

**Step 1: Update the backend `formatLink` function**

In `src/blogBackend.js`, replace the `formatLink` function (lines 56-59):

```javascript
function formatLink(link) {
  const displayText = ((link.description && link.description.trim()) || (link.selectedText && link.selectedText.trim()) || link.title).replace(/\|/g, '-');
  return `- [${displayText}](${link.url}){:target="_blank"}`;
}
```

This mirrors the frontend priority: `description` > `selectedText` > `title`.

**Step 2: Commit**

```bash
git add src/blogBackend.js
git commit -m "feat: update backend formatLink to use description field"
```

---

### Task 6: Create `useAnalyzeLink` React Query hook

**Files:**
- Create: `src/hooks/useAnalyzeLink.ts`

**Step 1: Create the hook**

Create `src/hooks/useAnalyzeLink.ts`:

```typescript
import { useMutation } from '@tanstack/react-query';
import { BlogService } from '../utils/blogService';
import { AnalyzeLinkResponse } from '../types';

export const useAnalyzeLink = () => {
  const mutation = useMutation({
    mutationFn: async ({ url, title, selectedText }: { url: string; title: string; selectedText?: string }): Promise<AnalyzeLinkResponse | null> => {
      return BlogService.analyzeLink(url, title, selectedText);
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
```

**Step 2: Commit**

```bash
git add src/hooks/useAnalyzeLink.ts
git commit -m "feat: add useAnalyzeLink React Query hook"
```

---

### Task 7: Update LinkForm to auto-trigger analysis and show description

**Files:**
- Modify: `src/components/LinkForm.tsx`

**Step 1: Add the description state and analyze hook**

In `src/components/LinkForm.tsx`:

Add import at the top:
```typescript
import { useAnalyzeLink } from '../hooks/useAnalyzeLink';
```

Inside the `LinkForm` component, add after the existing state declarations (after line 26):

```typescript
const [description, setDescription] = useState('');
const { analyze, data: analyzeResult, isAnalyzing, reset: resetAnalysis } = useAnalyzeLink();
```

**Step 2: Add useEffect to auto-trigger analysis**

Add after the existing useEffect blocks (after line 51):

```typescript
useEffect(() => {
  // Auto-trigger AI analysis when we have a valid URL
  if (tabInfo?.url && tabInfo.url.startsWith('http')) {
    analyze({
      url: tabInfo.url,
      title: tabInfo.title,
      selectedText: tabInfo.selectedText,
    });
  }
}, [tabInfo, analyze]);

useEffect(() => {
  // Apply AI suggestions when they arrive
  if (analyzeResult) {
    const suggestedCategory = categories.find(c => c.id === analyzeResult.category);
    if (suggestedCategory) {
      setSelectedCategory(suggestedCategory);
    }
    if (analyzeResult.description) {
      setDescription(analyzeResult.description);
    }
  }
}, [analyzeResult, categories]);
```

**Step 3: Include description in the link object**

In the `handleSubmit` function, update the link object (around line 67):

```typescript
const link = {
  id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
  url,
  title,
  selectedText: selectedText.trim() || undefined,
  description: description.trim() || undefined,
  category: selectedCategory.id,
  timestamp: Date.now()
};
```

**Step 4: Add the description field to the JSX**

Add this block after the "Selected Text" textarea section (after the closing `</div>` of the selectedText field, around line 151) and before the "Category" section:

```tsx
<div>
  <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
    Description {isAnalyzing && <span className="text-blue-500 text-xs ml-1">(AI analyzing...)</span>}
  </label>
  <textarea
    id="description"
    value={description}
    onChange={(e) => setDescription(e.target.value)}
    rows={2}
    className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
      isAnalyzing ? 'border-blue-300 bg-blue-50 animate-pulse' : 'border-gray-300'
    }`}
    placeholder={isAnalyzing ? 'AI is generating a description...' : 'Short description for the blog (used as link text)'}
    disabled={isAnalyzing}
  />
</div>
```

**Step 5: Update the category dropdown to show analyzing state**

Replace the category `<select>` element (lines 157-173) with:

```tsx
<select
  id="category"
  value={selectedCategory?.id || ''}
  onChange={(e) => {
    const category = categories.find(c => c.id === e.target.value);
    setSelectedCategory(category || null);
  }}
  className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
    isAnalyzing ? 'border-blue-300 bg-blue-50' : 'border-gray-300'
  }`}
  required
>
  <option value="">{isAnalyzing ? 'AI selecting category...' : 'Select a category'}</option>
  {categories.map((category) => (
    <option key={category.id} value={category.id}>
      {category.name}
    </option>
  ))}
</select>
```

**Step 6: Run the build to verify no TypeScript errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
git add src/components/LinkForm.tsx
git commit -m "feat: integrate AI analysis in LinkForm with auto-suggest UX"
```

---

### Task 8: Build and manual end-to-end test

**Files:** None (verification only)

**Step 1: Build the extension**

Run: `npm run build`
Expected: Build succeeds with no errors.

**Step 2: Start the backend**

Run: `npm run backend`
Expected: `Blog backend service running on http://localhost:3001`

**Step 3: Verify Ollama is running**

Run: `curl http://localhost:11434/api/tags`
Expected: JSON listing available models, including `qwen3:14b`.

**Step 4: Load extension in Chrome**

1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `dist/` folder
4. Navigate to any tech article
5. Click the Squirrel extension icon

**Step 5: Verify the flow**

Expected behavior:
- Popup opens with URL and title pre-filled from the current tab
- Description field shows "AI is generating a description..." with blue pulsing border
- Category dropdown shows "AI selecting category..."
- After 2-5 seconds, both fields populate with AI suggestions
- User can edit the description and change the category
- Clicking "Add Link" saves with the AI-generated description as the link text

**Step 6: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: adjustments from end-to-end testing"
```

---

### Task 9: Run existing tests to verify nothing is broken

**Files:** None (verification only)

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS. The existing tests should still pass since `description` is optional and `formatLink` falls back to the old behavior when it's absent.

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No type errors.

**Step 3: Final commit if all green**

```bash
git add -A
git commit -m "feat: Ollama auto-categorization complete"
```
