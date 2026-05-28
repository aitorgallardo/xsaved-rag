import { getPool } from "../db.js";
import type { SearchHit } from "../types.js";

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
  k: number
): Promise<SearchHit[]> {
  const tsquery = toOrTsquery(query);
  if (!tsquery) return [];

  const sql = `
    SELECT
      b.id,
      b.author,
      b.text,
      b.notes,
      b.tags,
      ts_rank_cd(b.text_search, q) AS score
    FROM bookmarks b, to_tsquery('english', $1) q
    WHERE b.text_search @@ q
    ORDER BY score DESC
    LIMIT $2;
  `;
  const { rows } = await getPool().query(sql, [tsquery, k]);

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
