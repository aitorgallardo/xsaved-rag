import pgvector from "pgvector/pg";
import { getPool } from "./db.js";
import { buildChunkText } from "./load-bookmarks.js";
import { embedTexts, EMBEDDING_MODEL } from "./embed.js";
import { enrichBookmarkMedia } from "./enrich-media.js";
import type { BookmarkLite } from "./types.js";

const BATCH_SIZE = 50;

export interface IndexResult {
  total: number;
  embedded: number;
  skipped: number;
  withMedia: number;
  enriched: number;
}

export interface IndexCallbacks {
  onEnrich?: (done: number, total: number) => void;
  onEmbed?: (done: number, total: number) => void;
}

export async function indexBookmarks(
  bookmarks: BookmarkLite[],
  cb: IndexCallbacks = {}
): Promise<IndexResult> {
  let embedded = 0;
  let skipped = 0;

  await upsertBookmarks(bookmarks);

  // Phase 1 — enrich media (fills bookmark.mediaSummary in DB and in memory).
  const { withMedia, enriched } = await enrichPass(bookmarks, cb.onEnrich);

  // Phase 2 — embed. buildChunkText now includes the media summary, and the
  // filter re-embeds anything whose media was enriched after its last embedding.
  for (let i = 0; i < bookmarks.length; i += BATCH_SIZE) {
    const batch = bookmarks.slice(i, i + BATCH_SIZE);
    const needsEmbedding = await filterNeedsEmbedding(batch);
    skipped += batch.length - needsEmbedding.length;

    if (needsEmbedding.length > 0) {
      const chunks = needsEmbedding.map(buildChunkText);
      const vectors = await embedTexts(chunks);
      await upsertEmbeddings(needsEmbedding, chunks, vectors);
      embedded += needsEmbedding.length;
    }

    cb.onEmbed?.(Math.min(i + BATCH_SIZE, bookmarks.length), bookmarks.length);
  }

  return { total: bookmarks.length, embedded, skipped, withMedia, enriched };
}

// ── Phase 1: media enrichment ───────────────────────────────────────────────

async function enrichPass(
  bookmarks: BookmarkLite[],
  onProgress?: (done: number, total: number) => void
): Promise<{ withMedia: number; enriched: number }> {
  const force = process.env.ENRICH_FORCE === "true";
  const withMedia = bookmarks.filter((b) => b.media.length > 0);
  const need = force ? withMedia : await filterUnenriched(withMedia);

  // Captioning is I/O-bound (vision API calls), so run a small pool of them in
  // parallel — turns a multi-minute sequential run into well under a minute.
  const concurrency = Number(process.env.ENRICH_CONCURRENCY ?? 8);
  let done = 0;
  await mapPool(need, concurrency, async (b) => {
    const { summary, model } = await enrichBookmarkMedia(b);
    await saveMediaSummary(b.id, summary, model);
    onProgress?.(++done, need.length);
  });

  // Pull the latest summary (this run's + prior runs') into the in-memory
  // objects so Phase 2 embeds the enriched chunk.
  await hydrateMediaSummaries(bookmarks);

  return { withMedia: withMedia.length, enriched: need.length };
}

/** Run `fn` over `items` with at most `limit` concurrent invocations. */
async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      await fn(items[cursor++]);
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    worker
  );
  await Promise.all(workers);
}

async function filterUnenriched(batch: BookmarkLite[]): Promise<BookmarkLite[]> {
  if (batch.length === 0) return [];
  const ids = batch.map((b) => b.id);
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM bookmarks
     WHERE id = ANY($1::text[]) AND media_enriched_at IS NOT NULL`,
    [ids]
  );
  const enriched = new Set(rows.map((r) => r.id));
  return batch.filter((b) => !enriched.has(b.id));
}

async function saveMediaSummary(
  id: string,
  summary: string | null,
  model: string | null
): Promise<void> {
  await getPool().query(
    `UPDATE bookmarks
     SET media_summary = $2, media_summary_model = $3, media_enriched_at = now()
     WHERE id = $1`,
    [id, summary, model]
  );
}

async function hydrateMediaSummaries(bookmarks: BookmarkLite[]): Promise<void> {
  if (bookmarks.length === 0) return;
  const ids = bookmarks.map((b) => b.id);
  const { rows } = await getPool().query<{
    id: string;
    media_summary: string | null;
    media_summary_model: string | null;
  }>(
    `SELECT id, media_summary, media_summary_model
     FROM bookmarks WHERE id = ANY($1::text[])`,
    [ids]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const b of bookmarks) {
    const row = byId.get(b.id);
    b.mediaSummary = row?.media_summary ?? undefined;
    b.mediaSummaryModel = row?.media_summary_model ?? undefined;
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────

async function upsertBookmarks(bookmarks: BookmarkLite[]): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const b of bookmarks) {
      await client.query(
        `INSERT INTO bookmarks (id, text, author, notes, tags, media, created_at, bookmarked_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           text          = EXCLUDED.text,
           author        = EXCLUDED.author,
           notes         = EXCLUDED.notes,
           tags          = EXCLUDED.tags,
           media         = EXCLUDED.media,
           created_at    = EXCLUDED.created_at,
           bookmarked_at = EXCLUDED.bookmarked_at,
           synced_at     = now()`,
        [
          b.id,
          b.text,
          b.author,
          b.notes ?? null,
          JSON.stringify(b.tags),
          JSON.stringify(b.media),
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

/**
 * A bookmark needs (re)embedding when it has no embedding for the current
 * model, OR when its media was enriched after that embedding was created
 * (so the chunk text changed and the stored vector is stale).
 */
async function filterNeedsEmbedding(
  batch: BookmarkLite[]
): Promise<BookmarkLite[]> {
  if (batch.length === 0) return [];
  const ids = batch.map((b) => b.id);
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT b.id
     FROM bookmarks b
     LEFT JOIN bookmark_embeddings e
       ON e.bookmark_id = b.id AND e.model = $2
     WHERE b.id = ANY($1::text[])
       AND (
         e.bookmark_id IS NULL
         OR (b.media_enriched_at IS NOT NULL AND b.media_enriched_at > e.created_at)
       )`,
    [ids, EMBEDDING_MODEL]
  );
  const need = new Set(rows.map((r) => r.id));
  return batch.filter((b) => need.has(b.id));
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
