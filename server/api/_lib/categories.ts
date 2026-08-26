import type { Category } from './types.js';

/**
 * The canonical section list, ported verbatim from the local backend
 * (`src/blogBackend.js`) so category ids stay stable across the migration.
 *
 * NOTE: this array's order is *not* the order the sections appear in the blog
 * files (the real files run favorites, agile, development, ai, devops, tools).
 * Never derive an insert position from an index here — always look the section
 * up by `anchor`.
 */
export const CATEGORIES: readonly Category[] = Object.freeze([
  { id: 'favorites', name: 'My favorites', anchor: 'favorites' },
  { id: 'agile', name: 'Agile, Leadership and Product', anchor: 'agile' },
  {
    id: 'development',
    name: 'Architecture, Development & Software development practices',
    anchor: 'development',
  },
  { id: 'devops', name: 'DevOps, Observability & Security', anchor: 'devops' },
  { id: 'tools', name: 'Tools and things from Github', anchor: 'tools' },
  { id: 'ai', name: 'AI, LLM & Machine Learning', anchor: 'ai' },
]);

export const DEFAULT_CATEGORY_ID = 'favorites';

export function findCategory(id: string | undefined | null): Category | undefined {
  if (!id) return undefined;
  return CATEGORIES.find((c) => c.id === id);
}

/** Resolve a category id to its anchor, falling back to the default section. */
export function anchorForCategory(id: string | undefined | null): string {
  return (findCategory(id) ?? findCategory(DEFAULT_CATEGORY_ID)!).anchor;
}

export function isValidCategoryId(id: unknown): id is string {
  return typeof id === 'string' && CATEGORIES.some((c) => c.id === id);
}
