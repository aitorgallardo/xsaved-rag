import type { SearchFilters } from "./types.js";

export interface ParsedArgs {
  query: string;
  filters: SearchFilters;
}

/**
 * Parse a flat argv list into (query, filters). Anything not consumed by
 * a recognised --flag becomes part of the query string.
 *
 * Supported flags:
 *   --author <handle>      exact match on bookmark.author
 *   --tag <tag>            (repeatable) any-of match against bookmark.tags
 *   --since <ISO-date>     bookmarked_at >= date
 *   --until <ISO-date>     bookmarked_at <= date
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const filters: SearchFilters = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--author":
        filters.author = argv[++i];
        break;
      case "--tag":
        (filters.tags ??= []).push(argv[++i]);
        break;
      case "--since":
        filters.bookmarkedAfter = argv[++i];
        break;
      case "--until":
        filters.bookmarkedBefore = argv[++i];
        break;
      default:
        positional.push(arg);
    }
  }

  return { query: positional.join(" ").trim(), filters };
}

export function hasAnyFilter(f: SearchFilters): boolean {
  return Boolean(
    f.author ||
      (f.tags && f.tags.length > 0) ||
      f.bookmarkedAfter ||
      f.bookmarkedBefore
  );
}
