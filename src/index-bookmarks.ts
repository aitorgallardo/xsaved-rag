import pgvector from "pgvector/pg";
import { getPool } from "./db.js";
import { buildChunkText } from "./load-bookmarks.js";
import { embedTexts, EMBEDDING_MODEL } from "./embed.js";
import type { BookmarkLite } from "./types.js";

const BATCH_SIZE = 50;

export interface IndexResult {
  total: number;
  embedded: number;
  skipped: number;
}

export async function indexBookmarks(
  bookmarks: BookmarkLite[],
  onProgress?: (done: number, total: number) => void
): Promise<IndexResult> {
  const pool = getPool();
  let embedded = 0;
  let skipped = 0;

  await upsertBookmarks(bookmarks);

  for (let i = 0; i < bookmarks.length; i += BATCH_SIZE) {
    const batch = bookmarks.slice(i, i + BATCH_SIZE);
    const needsEmbedding = await filterUnembedded(batch);
    skipped += batch.length - needsEmbedding.length;

    if (needsEmbedding.length > 0) {
      const chunks = needsEmbedding.map(buildChunkText);
      const vectors = await embedTexts(chunks);
      await upsertEmbeddings(needsEmbedding, chunks, vectors);
      embedded += needsEmbedding.length;
    }

    onProgress?.(Math.min(i + BATCH_SIZE, bookmarks.length), bookmarks.length);
  }

  return { total: bookmarks.length, embedded, skipped };
}

async function upsertBookmarks(bookmarks: BookmarkLite[]): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const b of bookmarks) {
      await client.query(
        `INSERT INTO bookmarks (id, text, author, notes, tags, created_at, bookmarked_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           text          = EXCLUDED.text,
           author        = EXCLUDED.author,
           notes         = EXCLUDED.notes,
           tags          = EXCLUDED.tags,
           created_at    = EXCLUDED.created_at,
           bookmarked_at = EXCLUDED.bookmarked_at,
           synced_at     = now()`,
        [
          b.id,
          b.text,
          b.author,
          b.notes ?? null,
          JSON.stringify(b.tags),
          b.createdAt,
          b.bookmarkedAt,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function filterUnembedded(
  batch: BookmarkLite[]
): Promise<BookmarkLite[]> {
  if (batch.length === 0) return [];
  const ids = batch.map((b) => b.id);
  const { rows } = await getPool().query<{ bookmark_id: string }>(
    `SELECT bookmark_id FROM bookmark_embeddings
     WHERE bookmark_id = ANY($1::text[]) AND model = $2`,
    [ids, EMBEDDING_MODEL]
  );
  const already = new Set(rows.map((r) => r.bookmark_id));
  return batch.filter((b) => !already.has(b.id));
}

async function upsertEmbeddings(
  bookmarks: BookmarkLite[],
  chunks: string[],
  vectors: number[][]
): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < bookmarks.length; i++) {
      await client.query(
        `INSERT INTO bookmark_embeddings (bookmark_id, chunk_text, embedding, model)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (bookmark_id) DO UPDATE SET
           chunk_text = EXCLUDED.chunk_text,
           embedding  = EXCLUDED.embedding,
           model      = EXCLUDED.model,
           created_at = now()`,
        [
          bookmarks[i].id,
          chunks[i],
          pgvector.toSql(vectors[i]),
          EMBEDDING_MODEL,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
