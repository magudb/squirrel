#!/usr/bin/env node

/**
 * Optional local AI sidecar for the Squirrel extension.
 *
 * It only suggests a category and a description for a link. It does not write
 * to the blog: the Vercel service commits to GitHub, and a second writer on one
 * machine would corrupt the draft.
 *
 * Everything here handles attacker-controlled input. The URL comes from
 * whatever page the user is looking at, the page body is piped into an AI
 * prompt, and the AI's answer ends up in published markdown — so the fetch is
 * constrained to public hosts and the answer is treated as data, not text.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import dns from 'dns/promises';
import net from 'net';
import { spawn, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 3001;

app.disable('x-powered-by');

// Persistent cache for AI analysis results so we don't re-run (and re-pay for)
// Claude on every popup open for the same link. Survives backend restarts.
const CACHE_DIR = path.join(os.homedir(), '.cache', 'squirrel');
const CACHE_FILE = path.join(CACHE_DIR, 'analyze-cache.json');
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** @type {Map<string, { result: { category: string, description: string }, timestamp: number }>} */
const analyzeCache = new Map();

function cacheKey(url, title, selectedText) {
  return `${url}\n${title || ''}\n${selectedText || ''}`;
}

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf-8');
    const entries = JSON.parse(raw);
    const now = Date.now();
    for (const [key, entry] of Object.entries(entries)) {
      if (entry && now - entry.timestamp < CACHE_TTL_MS) {
        analyzeCache.set(key, entry);
      }
    }
    console.log(`[cache] loaded ${analyzeCache.size} analysis entries`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[cache] could not load cache: ${error.message}`);
    }
  }
}

async function persistCache() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const obj = Object.fromEntries(analyzeCache);
    await fs.writeFile(CACHE_FILE, JSON.stringify(obj), 'utf-8');
  } catch (error) {
    console.warn(`[cache] could not persist cache: ${error.message}`);
  }
}

// Only the extension may talk to this process. Without an origin restriction,
// any page the user visits can POST /api/analyze-link and use this machine as
// an internal network scanner with readback.
const EXTENSION_ID = process.env.SQUIRREL_EXTENSION_ID;
const EXTENSION_ORIGIN = EXTENSION_ID
  ? new RegExp(`^chrome-extension://${EXTENSION_ID.replace(/[^a-p]/g, '')}$`)
  : /^chrome-extension:\/\/[a-p]{32}$/;

// Withholding the CORS headers only blinds the browser to the response; the
// handler would still run. A page can also dodge the preflight with a simple
// request. So a disallowed origin is refused outright, before any route.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin !== undefined && !EXTENSION_ORIGIN.test(origin)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }
  next();
});
app.use(cors({ origin: EXTENSION_ORIGIN }));
app.use(express.json());

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

const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;
const MAX_PAGE_BYTES = 512 * 1024;

/**
 * The eight hextets of an IPv6 literal, or null if it cannot be read as one.
 *
 * Classifying the text is what let `::ffff:7f00:1` through: one address has a
 * dotted-quad, a hex and an uncompressed spelling, and only one of them matched
 * the mapped-address regex. Expanding first means the rules below judge the
 * address rather than how it was written.
 */
function ipv6Hextets(addr) {
  let text = addr;

  // A trailing dotted quad (`::ffff:127.0.0.1`) is the low two hextets.
  const lastColon = text.lastIndexOf(':');
  if (lastColon === -1) return null;
  const trailer = text.slice(lastColon + 1);
  if (trailer.includes('.')) {
    if (!net.isIPv4(trailer)) return null;
    const [a, b, c, d] = trailer.split('.').map(Number);
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const elided = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (elided < 0) return null;

  const groups = [...head, ...Array(elided).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  const hextets = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN,
  );
  return hextets.some(Number.isNaN) ? null : hextets;
}

/**
 * Is this address somewhere only this machine can reach? Anything private is a
 * scan target rather than an article, and 169.254.169.254 in particular is the
 * cloud metadata endpoint.
 */
function isPrivateAddress(ip) {
  const family = net.isIP(ip);

  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0) return true; // "this host"
    if (a === 10) return true;
    if (a === 127) return true; // loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
    if (a === 169 && b === 254) return true; // link-local, incl. metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (family === 6) {
    const hextets = ipv6Hextets(ip.toLowerCase().split('%')[0]); // drop any zone id
    if (hextets === null) return true; // unreadable, so not something to fetch

    // `::ffff:a.b.c.d` (mapped) and the deprecated `::a.b.c.d` (compatible)
    // both carry an IPv4 address in their low 32 bits and both reach the v4
    // host, so the v4 rules decide. `::` and `::1` land here too, as 0.0.0.0
    // and 0.0.0.1, and are private for the same reason 0/8 is.
    const prefix = hextets[5];
    if (hextets.slice(0, 5).every((h) => h === 0) && (prefix === 0xffff || prefix === 0)) {
      const [high, low] = hextets.slice(6);
      return isPrivateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }

    if ((hextets[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((hextets[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
    if ((hextets[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
    return false;
  }

  return true; // not an address we can reason about
}

/**
 * Throws unless every address `target` resolves to *at this moment* is publicly
 * routable.
 *
 * "At this moment" is the honest limit: `fetch` resolves the name again itself,
 * so a record with a short TTL can answer public here and private there.
 * Pinning what was checked would take an undici dispatcher with a fixed
 * `connect.lookup` — undici is not a dependency of this project — or a fetch of
 * an IP literal, which breaks certificate matching on every https article.
 * Neither is worth it for a sidecar bound to 127.0.0.1 that only fetches links
 * this user chose to save, so the rebinding window is accepted, not overlooked.
 */
async function assertPublicTarget(target) {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`Refusing to fetch ${target.protocol} URL`);
  }

  const host = target.hostname.replace(/^\[|\]$/g, ''); // URL keeps IPv6 brackets
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`Refusing to fetch private address ${host}`);
    return;
  }

  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (records.length === 0) throw new Error(`Could not resolve ${host}`);
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error(`Refusing to fetch ${host} — resolves to ${record.address}`);
    }
  }
}

/** Content-Length is attacker-controlled, so the cap is enforced while reading. */
async function readCapped(response, maxBytes) {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let read = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - read;
      if (value.byteLength >= remaining) {
        text += decoder.decode(value.subarray(0, remaining));
        break;
      }
      read += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return text;
}

async function fetchPageContent(url) {
  // One deadline for the whole chase, so redirects cannot extend the budget.
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let target = new URL(url);
  let response;

  for (let hop = 0; ; hop++) {
    // Re-checked on every hop: a public host is free to redirect inwards.
    await assertPublicTarget(target);

    response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Squirrel/2.0; +https://github.com/magudb/squirrel)',
      },
      redirect: 'manual',
      signal,
    });

    if (response.status < 300 || response.status >= 400) break;

    const location = response.headers.get('location');
    if (!location) throw new Error(`Redirect ${response.status} with no Location header`);
    if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
    response.body?.cancel().catch(() => {});
    target = new URL(location, target);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch page: ${response.status}`);
  }

  const html = await readCapped(response, MAX_PAGE_BYTES);
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

// ---------------------------------------------------------------------------
// AI CLI integration (Claude Code / Codex)
//
// Omarchy 4 replaced ~/.local/bin/{claude,codex} with mise wrapper scripts that
// run `mise use -g <tool>` on every invocation. That prints a banner line
//   mise ~/.config/mise/config.toml tools: claude@2.1.241
// to STDOUT, ahead of the tool's own output. So we (a) resolve the real binary
// and skip the wrapper, and (b) never assume stdout is nothing but JSON.
// ---------------------------------------------------------------------------

const AI_PROVIDER = (process.env.SQUIRREL_AI_PROVIDER || 'claude').toLowerCase();
const CLAUDE_MODEL = process.env.SQUIRREL_CLAUDE_MODEL || process.env.CLAUDE_MODEL || 'sonnet';
const CODEX_MODEL = process.env.SQUIRREL_CODEX_MODEL || '';

/**
 * Resolve a CLI to a real executable, preferring the actual binary over any
 * PATH shim. Shims can write to stdout and corrupt machine-readable output, so
 * we ask mise for the real path whenever it can tell us.
 */
function resolveCliBin(name) {
  // `CLAUDE_BIN` is the name the launchd plist and the systemd unit already
  // set, so it stays supported: renaming it would silently strip the override
  // on the machines those install scripts configured, and the fallback lookup
  // below does not work everywhere mise is absent.
  const override =
    process.env[`SQUIRREL_${name.toUpperCase()}_BIN`] || process.env[`${name.toUpperCase()}_BIN`];
  if (override) return override;

  try {
    const real = execFileSync('mise', ['which', name], {
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (real && existsSync(real)) return real;
  } catch {
    // mise absent or doesn't manage this tool — fall back to a PATH lookup.
  }
  return name;
}

const AI_BIN = resolveCliBin(AI_PROVIDER === 'codex' ? 'codex' : 'claude');

/**
 * Pull the first balanced JSON object out of a string, ignoring leading or
 * trailing noise (shim banners, log lines, code fences, prose). Brace matching
 * is string-aware so braces inside JSON strings don't skew the depth count.
 */
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) { escaped = false; continue; }
    if (inString && ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Spawn a CLI, feed it `input` on stdin, and resolve with its stdout. */
function runCli(bin, args, { input, timeout = 120000, tag }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE; // don't let a parent Claude Code session leak in

    const proc = spawn(bin, args, { env, timeout });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[${tag}] exit=${code} stderr=${stderr.slice(0, 300)}`);
        reject(new Error(`${tag} exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      if (stderr) console.warn(`[${tag}] stderr: ${stderr.slice(0, 200)}`);
      resolve(stdout);
    });

    if (input !== undefined) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

async function runClaude(prompt) {
  const stdout = await runCli(AI_BIN, [
    '-p',
    '--model', CLAUDE_MODEL,
    '--output-format', 'json',
    '--no-session-persistence',
    '--append-system-prompt', 'You MUST respond with only a raw JSON object. No markdown, no code fences, no explanation.',
  ], { input: prompt, tag: 'claude' });

  const envelopeText = extractJsonObject(stdout);
  if (!envelopeText) {
    throw new Error(`No JSON envelope in claude output: ${stdout.slice(0, 200)}`);
  }

  const envelope = JSON.parse(envelopeText);
  if (envelope.is_error) {
    throw new Error(`claude reported an error: ${String(envelope.result).slice(0, 200)}`);
  }
  return { text: envelope.result ?? '', cost: envelope.total_cost_usd };
}

async function runCodex(prompt) {
  // `-o` writes the final message to a file, keeping it clear of anything the
  // CLI prints to stdout.
  const outFile = path.join(os.tmpdir(), `squirrel-codex-${crypto.randomUUID()}.txt`);
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color', 'never',
    '--sandbox', 'read-only',
    '-o', outFile,
  ];
  if (CODEX_MODEL) args.push('--model', CODEX_MODEL);

  try {
    await runCli(AI_BIN, args, { input: prompt, tag: 'codex' });
    return { text: (await fs.readFile(outFile, 'utf-8')).trim(), cost: undefined };
  } finally {
    await fs.rm(outFile, { force: true }).catch(() => {});
  }
}

/** Run the configured agent CLI and return its final text plus cost, if known. */
function runAgentCli(prompt) {
  return AI_PROVIDER === 'codex' ? runCodex(prompt) : runClaude(prompt);
}

const MAX_DESCRIPTION_CHARS = 300;

/**
 * The description is derived from a page that can say anything it likes to the
 * model, and it lands verbatim in published markdown. Angle brackets go (no raw
 * HTML in the post), whitespace collapses (no smuggled bullets or front matter)
 * and the length is capped.
 */
function sanitizeDescription(text) {
  return String(text ?? '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}

async function analyzeWithAI(url, title, pageContent, selectedText) {
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
  const { text: resultText, cost } = await runAgentCli(prompt);
  const t1 = performance.now();

  console.log(`[timing] analyzeWithAI(${AI_PROVIDER}): ${(t1 - t0).toFixed(0)}ms, cost=$${cost ?? '?'}`);
  console.log(`[${AI_PROVIDER}] raw result: ${resultText.slice(0, 300)}`);

  // Try direct JSON parse first, then extract from markdown code fences
  let parsed;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    // Model wrapped the object in prose or code fences — dig it back out.
    const inner = extractJsonObject(resultText);
    if (!inner) {
      throw new Error(`Could not parse ${AI_PROVIDER} response as JSON: ${resultText.slice(0, 200)}`);
    }
    parsed = JSON.parse(inner);
  }

  // Validate category exists
  const validCategory = CATEGORIES.find(c => c.id === parsed.category);
  if (!validCategory) {
    parsed.category = CATEGORIES[0].id;
  }

  return {
    category: parsed.category,
    description: sanitizeDescription(parsed.description) || sanitizeDescription(title),
  };
}

// API Routes
app.get('/api/categories', (req, res) => {
  res.json(CATEGORIES);
});

app.post('/api/analyze-link', async (req, res) => {
  const reqStart = performance.now();
  try {
    const { url, title, selectedText, forceRefresh } = req.body;

    // Typed, not just present: both are interpolated into the AI prompt.
    if (typeof url !== 'string' || !url || typeof title !== 'string' || !title) {
      return res.status(400).json({ error: 'url and title are required' });
    }

    const key = cacheKey(url, title, selectedText);

    // Serve from cache unless the caller explicitly asked for a fresh analysis
    if (!forceRefresh) {
      const cached = analyzeCache.get(key);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        console.log(`[cache] hit for ${url} (${(performance.now() - reqStart).toFixed(0)}ms)`);
        return res.json({ ...cached.result, cached: true });
      }
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

    // Analyze with the configured agent CLI (Claude Code or Codex)
    const result = await analyzeWithAI(url, title, pageContent, selectedText);
    analyzeCache.set(key, { result, timestamp: Date.now() });
    persistCache(); // fire-and-forget; don't block the response
    console.log(`[timing] /api/analyze-link total: ${(performance.now() - reqStart).toFixed(0)}ms`);
    res.json({ ...result, cached: false });
  } catch (error) {
    console.warn(`[timing] /api/analyze-link failed after ${(performance.now() - reqStart).toFixed(0)}ms:`, error.message);
    res.json({ category: null, description: null });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
loadCache();
// Bound to loopback: nothing outside this machine has any business here.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Squirrel AI sidecar running on http://localhost:${PORT} (provider: ${AI_PROVIDER})`);
  console.log('API endpoints:');
  console.log('  GET  /api/categories');
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