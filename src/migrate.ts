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
