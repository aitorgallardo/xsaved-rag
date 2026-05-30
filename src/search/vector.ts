import pgvector from "pgvector/pg";
import { getPool } from "../db.js";
import { embedOne } from "../embed.js";
import type { SearchHit, SearchFilters } from "../types.js";
import { buildFilterClause } from "./filters.js";

export async function vectorSearch(
  query: string,
  k: number,
  filters?: SearchFilters
): Promise<SearchHit[]> {
  const queryEmbedding = await embedOne(query);
  return vectorSearchByEmbedding(queryEmbedding, k, filters);
}

export async function vectorSearchByEmbedding(
  queryEmbedding: number[],
  k: number,
  filters?: SearchFilters
): Promise<SearchHit[]> {
  // $1 = embedding, $2 = k, filters start at $3
  const filter = buildFilterClause(filters, 3);

  const sql = `
    SELECT
      b.id,
      b.author,
      b.text,
      b.notes,
      b.tags,
      e.embedding <=> $1 AS distance
    FROM bookmark_embeddings e
    JOIN bookmarks b ON b.id = e.bookmark_id
    WHERE 1=1${filter.sql}
    ORDER BY e.embedding <=> $1
    LIMIT $2;
  `;
  const { rows } = await getPool().query(sql, [
    pgvector.toSql(queryEmbedding),
    k,
    ...filter.params,
  ]);

  return rows.map((r, i) => ({
    bookmarkId: r.id as string,
    author: r.author as string,
    text: r.text as string,
    notes: r.notes ?? undefined,
    tags: r.tags as string[],
    distance: Number(r.distance),
    rank: i + 1,
  }));
}
