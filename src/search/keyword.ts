import { getPool } from "../db.js";
import type { SearchHit, SearchFilters } from "../types.js";
import { buildFilterClause } from "./filters.js";

function toOrTsquery(input: string): string {
  return input
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length > 1)
    .join(" | ");
}

export async function keywordSearch(
  query: string,
  k: number,
  filters?: SearchFilters
): Promise<SearchHit[]> {
  const tsquery = toOrTsquery(query);
  if (!tsquery) return [];

  // $1 = tsquery, $2 = k, filters start at $3
  const filter = buildFilterClause(filters, 3);

  const sql = `
    SELECT
      b.id,
      b.author,
      b.text,
      b.notes,
      b.tags,
      ts_rank_cd(b.text_search, q) AS score
    FROM bookmarks b, to_tsquery('english', $1) q
    WHERE b.text_search @@ q${filter.sql}
    ORDER BY score DESC
    LIMIT $2;
  `;
  const { rows } = await getPool().query(sql, [tsquery, k, ...filter.params]);

  return rows.map((r, i) => ({
    bookmarkId: r.id as string,
    author: r.author as string,
    text: r.text as string,
    notes: r.notes ?? undefined,
    tags: r.tags as string[],
    keywordScore: Number(r.score),
    rank: i + 1,
  }));
}
