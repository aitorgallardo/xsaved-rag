import type { SearchFilters } from "../types.js";

export interface FilterClause {
  sql: string;
  params: unknown[];
}

/**
 * Build a Postgres WHERE-clause fragment from a SearchFilters spec.
 * Returns " AND <...>" so it composes cleanly after an existing WHERE.
 * Parameter placeholders start at `startIndex` so the caller can append
 * the params after its own bound parameters without renumbering.
 */
export function buildFilterClause(
  filters: SearchFilters | undefined,
  startIndex: number
): FilterClause {
  if (!filters) return { sql: "", params: [] };

  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;

  if (filters.author) {
    clauses.push(`b.author = $${i++}`);
    params.push(filters.author);
  }
  if (filters.tags && filters.tags.length > 0) {
    clauses.push(`b.tags ?| $${i++}::text[]`);
    params.push(filters.tags);
  }
  if (filters.bookmarkedAfter) {
    clauses.push(`b.bookmarked_at >= $${i++}`);
    params.push(filters.bookmarkedAfter);
  }
  if (filters.bookmarkedBefore) {
    clauses.push(`b.bookmarked_at <= $${i++}`);
    params.push(filters.bookmarkedBefore);
  }

  if (clauses.length === 0) return { sql: "", params: [] };
  return { sql: " AND " + clauses.join(" AND "), params };
}

export function formatFiltersForDisplay(filters: SearchFilters | undefined): string {
  if (!filters) return "";
  const parts: string[] = [];
  if (filters.author) parts.push(`author=@${filters.author}`);
  if (filters.tags && filters.tags.length > 0) parts.push(`tags=[${filters.tags.join("|")}]`);
  if (filters.bookmarkedAfter) parts.push(`since=${filters.bookmarkedAfter}`);
  if (filters.bookmarkedBefore) parts.push(`until=${filters.bookmarkedBefore}`);
  return parts.length > 0 ? `  filters: ${parts.join(" ")}` : "";
}
