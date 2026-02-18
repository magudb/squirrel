#!/usr/bin/env node

/**
 * Simple Node.js backend service for handling blog file operations
 * This can be run as a local service to handle file operations that the browser extension cannot do directly
 */

import fs from 'fs/promises';
import path from 'path';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const DRAFTS_DIR = '/home/mlu/Documents/project/magudb.github.io/_drafts';
const CATEGORIES = [
  {
    id: "favorites",
    name: "My favorites",
    anchor: "favorites"
  },
  {
    id: "agile",
    name: "Agile, Leadership and Product",
    anchor: "agile"
  },
  {
    id: "development",
    name: "Architecture, Development & Software development practices",
    anchor: "development"
  },
  {
    id: "devops",
    name: "DevOps, Observability & Security",
    anchor: "devops"
  },
  {
    id: "tools",
    name: "Tools and things from Github",
    anchor: "tools"
  },
  {
    id: "ai",
    name: "AI, LLM & Machine Learning",
    anchor: "ai"
  }
];

// Helper functions
function formatLink(link) {
  const displayText = ((link.selectedText && link.selectedText.trim()) || link.title).replace(/\|/g, '-');
  return `- [${displayText}](${link.url}){:target="_blank"}`;
}

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

async function findCuratedInsightsFiles() {
  try {
    const files = await fs.readdir(DRAFTS_DIR);
    const curatedFiles = [];

    for (const filename of files) {
      if (filename.endsWith('.md') || filename.endsWith('.markdown')) {
        const filepath = path.join(DRAFTS_DIR, filename);
        try {
          const content = await fs.readFile(filepath, 'utf-8');
          
          // Check if file has 'category: "Curated Insights"' in front matter
          if (content.includes('category: "Curated Insights"')) {
            // Extract title from front matter
            const titleMatch = content.match(/title:\s*["'](.+?)["']/);
            const title = titleMatch ? titleMatch[1] : filename;
            
            curatedFiles.push({
              path: filepath,
              filename: filename,
              title: title
            });
          }
        } catch (error) {
          console.warn(`Could not read file ${filepath}:`, error.message);
        }
      }
    }

    return curatedFiles;
  } catch (error) {
    console.error('Error finding curated insights files:', error);
    return [];
  }
}

async function addLinkToBlogFile(link, blogFilePath) {
  try {
    // Find the category
    const category = CATEGORIES.find(c => c.id === link.category);
    if (!category) {
      throw new Error(`Category not found: ${link.category}`);
    }

    // Read the blog file
    const content = await fs.readFile(blogFilePath, 'utf-8');
    
    // Check for duplicate
    if (content.includes(link.url)) {
      throw new Error('Link already exists in blog');
    }

    // Find the section for the category
    const anchorPattern = `<a name="${category.anchor}"></a>`;
    const anchorIndex = content.indexOf(anchorPattern);
    
    if (anchorIndex === -1) {
      throw new Error(`Category section not found: ${category.name}`);
    }

    // Find where to insert the link
    const sectionStart = anchorIndex;
    const nextSection = content.indexOf('\n##', sectionStart + 1);
    const sectionEnd = nextSection === -1 ? content.length : nextSection;
    
    // Find the last link in the section
    const sectionContent = content.substring(sectionStart, sectionEnd);
    const lines = sectionContent.split('\n');
    
    let insertPosition = sectionStart;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('- [')) {
        // Find this line in the original content
        const linePos = content.indexOf(line, insertPosition);
        if (linePos !== -1) {
          insertPosition = linePos + line.length;
        }
      }
    }
    
    // If no existing links found, add after the header
    if (insertPosition === sectionStart) {
      const headerEnd = content.indexOf('\n', sectionStart);
      if (headerEnd !== -1) {
        insertPosition = headerEnd;
      }
    }
    
    // Format and insert the new link
    const linkText = formatLink(link);
    const newContent = content.slice(0, insertPosition) + '\n' + linkText + content.slice(insertPosition);
    
    // Write back to file
    await fs.writeFile(blogFilePath, newContent, 'utf-8');
    
    return { success: true };
    
  } catch (error) {
    console.error('Error adding link to blog file:', error);
    throw error;
  }
}

// API Routes
app.get('/api/categories', (req, res) => {
  res.json(CATEGORIES);
});

app.get('/api/blog-files', async (req, res) => {
  try {
    const files = await findCuratedInsightsFiles();
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

app.post('/api/add-link', async (req, res) => {
  try {
    const { link, blogFile } = req.body;

    if (!link || !blogFile) {
      return res.status(400).json({ error: 'Link and blogFile are required' });
    }

    // Validate link structure
    if (!link.url || !link.title || !link.category) {
      return res.status(400).json({ error: 'Link must have url, title, and category' });
    }

    // Add link to blog file
    await addLinkToBlogFile(link, blogFile.path);
    
    res.json({ 
      success: true, 
      message: `Link added to ${blogFile.filename}` 
    });
    
  } catch (error) {
    console.error('Error in add-link endpoint:', error);
    res.status(500).json({ 
      error: error.message,
      success: false 
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`Blog backend service running on http://localhost:${PORT}`);
  console.log(`Monitoring drafts directory: ${DRAFTS_DIR}`);
  console.log('API endpoints:');
  console.log('  GET  /api/categories');
  console.log('  GET  /api/blog-files');
  console.log('  POST /api/add-link');
  console.log('  POST /api/analyze-link');
  console.log('  GET  /health');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  process.exit(0);
});