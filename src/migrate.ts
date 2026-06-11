import { getPool } from "./db.js";

const SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS bookmarks (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  author        TEXT NOT NULL,
  notes         TEXT,
  tags          JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ,
  bookmarked_at TIMESTAMPTZ,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- V2 (media enrichment): the raw media array + the text we extract from it.
--   media               raw media items, kept so enrichment can re-run without the source file
--   media_summary       human-readable text distilled from the media (captions, quoted tweets, card titles)
--   media_summary_model which vision model produced it (NULL when no vision call was needed)
--   media_enriched_at   when enrichment last ran (the cache key + the re-embed trigger)
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS media               JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS media_summary       TEXT;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS media_summary_model TEXT;
ALTER TABLE bookmarks ADD COLUMN IF NOT EXISTS media_enriched_at   TIMESTAMPTZ;

-- Recreate the full-text vector so it also indexes media_summary. A generated
-- column's expression can't be altered in place, so we drop + re-add. Dropping
-- the column also drops its GIN index, which the CREATE INDEX below restores.
ALTER TABLE bookmarks DROP COLUMN IF EXISTS text_search;
ALTER TABLE bookmarks
  ADD COLUMN text_search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      author || ' ' ||
      coalesce(text, '') || ' ' ||
      coalesce(notes, '') || ' ' ||
      coalesce(tags::text, '') || ' ' ||
      coalesce(media_summary, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS bookmarks_text_search_gin
  ON bookmarks USING gin(text_search);

CREATE TABLE IF NOT EXISTS bookmark_embeddings (
  bookmark_id   TEXT PRIMARY KEY REFERENCES bookmarks(id) ON DELETE CASCADE,
  chunk_text    TEXT NOT NULL,
  embedding     vector(1536) NOT NULL,
  model         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bookmark_embeddings_hnsw
  ON bookmark_embeddings USING hnsw (embedding vector_cosine_ops);
`;

export async function migrate(): Promise<void> {
  const pool = getPool();
  await pool.query(SQL);
}
