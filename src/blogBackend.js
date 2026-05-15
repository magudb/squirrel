#!/usr/bin/env node

/**
 * Simple Node.js backend service for handling blog file operations
 * This can be run as a local service to handle file operations that the browser extension cannot do directly
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration — override via env on a per-machine basis.
const DRAFTS_DIR = process.env.SQUIRREL_DRAFTS_DIR
  || path.join(os.homedir(), 'Documents/projects/magudb.github.io/_drafts');
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
  const displayText = ((link.description && link.description.trim()) || (link.selectedText && link.selectedText.trim()) || link.title).replace(/\|/g, '-');
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

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'sonnet';

async function analyzeWithClaude(url, title, pageContent, selectedText) {
  const categoryList = CATEGORIES.map(c => `- ${c.id}: ${c.name}`).join('\n');

  const prompt = `You are writing link descriptions for a curated tech newsletter from the perspective of a CTO and hands-on developer with almost two decades in tech. The curator builds useful software, helps teams do their best work, and shares what they learn — code, tools, and hard-won mistakes — so others can move faster.

The tone is curious, practical, and direct. Write as someone who has been in the trenches — leading teams, shipping products, and still learning every day. Descriptions should feel like a personal recommendation from a peer, not a summary from a robot.

## Categories

Pick the single best-fit category from this list:
${categoryList}

Category guidance:
- "favorites": Only for truly exceptional, must-read articles that changed how you think or work
- "agile": Leadership, team dynamics, product management, agile practices, organizational culture
- "development": Software architecture, coding practices, design patterns, programming languages, software craftsmanship
- "devops": CI/CD, infrastructure, cloud, monitoring, observability, security, reliability, platform engineering
- "tools": Developer tools, CLI utilities, GitHub projects, open source libraries, productivity tools
- "ai": Artificial intelligence, machine learning, LLMs, AI coding assistants, AI strategy

## Article

Title: ${title}
URL: ${url}
${selectedText ? `Highlighted by reader: ${selectedText}\n` : ''}
${pageContent ? `Article content:\n${pageContent}` : ''}

## Task

1. Pick the single most relevant category ID from the list above.
2. Write a concise description (1-2 sentences, max 30 words) in the curator's voice. Focus on the practical takeaway — what will the reader gain? Write like you're recommending this to a fellow developer or tech lead over coffee.

IMPORTANT: Respond with ONLY a raw JSON object, no markdown, no explanation, no code fences:
{"category": "<category_id>", "description": "<your description>"}`;

  const t0 = performance.now();
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const result = await new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, [
      '-p',
      '--model', CLAUDE_MODEL,
      '--output-format', 'json',
      '--no-session-persistence',
      '--append-system-prompt', 'You MUST respond with only a raw JSON object. No markdown, no code fences, no explanation.',
    ], { env, timeout: 120000 });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[claude] exit=${code} stderr=${stderr}`);
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        if (stderr) console.warn(`[claude] stderr: ${stderr.slice(0, 200)}`);
        resolve(stdout);
      }
    });
    proc.on('error', reject);
  });
  const t1 = performance.now();

  // --output-format json wraps result in {"type":"result",...,"result":"<actual text>"}
  const envelope = JSON.parse(result);
  const resultText = envelope.result || result;
  console.log(`[timing] analyzeWithClaude: ${(t1 - t0).toFixed(0)}ms, cost=$${envelope.total_cost_usd || '?'}`);
  console.log(`[claude] raw result: ${resultText.slice(0, 300)}`);

  // Try direct JSON parse first, then extract from markdown code fences
  let parsed;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    const jsonMatch = resultText.match(/\{[\s\S]*"category"[\s\S]*"description"[\s\S]*\}/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error(`Could not parse Claude response as JSON: ${resultText.slice(0, 200)}`);
    }
  }

  // Validate category exists
  const validCategory = CATEGORIES.find(c => c.id === parsed.category);
  if (!validCategory) {
    parsed.category = CATEGORIES[0].id;
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

    // Find the section for the category — match anchor regardless of inner text
    const anchorRegex = new RegExp(`<a\\s+name=["']${category.anchor}["'][^>]*>(?:[^<]*)</a>`);
    const anchorMatch = content.match(anchorRegex);

    if (!anchorMatch) {
      throw new Error(`Category section not found: ${category.name}`);
    }
    const anchorIndex = content.indexOf(anchorMatch[0]);

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
  const reqStart = performance.now();
  try {
    const { url, title, selectedText } = req.body;

    if (!url || !title) {
      return res.status(400).json({ error: 'url and title are required' });
    }

    // Fetch page content (gracefully degrade if it fails)
    let pageContent = '';
    const fetchStart = performance.now();
    try {
      pageContent = await fetchPageContent(url);
      console.log(`[timing] fetchPageContent: ${(performance.now() - fetchStart).toFixed(0)}ms, ${pageContent.length} chars`);
    } catch (err) {
      console.warn(`[timing] fetchPageContent: failed after ${(performance.now() - fetchStart).toFixed(0)}ms — ${err.message}`);
    }

    // Analyze with Claude
    const result = await analyzeWithClaude(url, title, pageContent, selectedText);
    console.log(`[timing] /api/analyze-link total: ${(performance.now() - reqStart).toFixed(0)}ms`);
    res.json(result);
  } catch (error) {
    console.warn(`[timing] /api/analyze-link failed after ${(performance.now() - reqStart).toFixed(0)}ms:`, error.message);
    res.json({ category: null, description: null });
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