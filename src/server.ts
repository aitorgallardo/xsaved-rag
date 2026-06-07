import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getPool } from "./db.js";
import { keywordSearch } from "./search/keyword.js";
import { vectorSearch } from "./search/vector.js";
import { hybridSearch } from "./search/hybrid.js";
import type { SearchHit } from "./types.js";

// --- HTTP API in front of the RAG retrieval engine -------------------------
//
// This turns xsaved-rag from a CLI-only library into a small *service*. The
// MCP server (xsaved-mcp) calls these endpoints instead of re-implementing
// search — so all retrieval logic (keyword FTS, pgvector, hybrid RRF) lives in
// exactly ONE place. This is the "thin bridge" architecture: rag = engine,
// mcp = doorway.

const app = new Hono();

const strategies = {
  keyword: keywordSearch,
  vector: vectorSearch,
  hybrid: hybridSearch,
} as const;
type Strategy = keyof typeof strategies;

app.get("/health", (c) => c.json({ ok: true }));

// GET /search?q=...&strategy=keyword|vector|hybrid&limit=10
app.get("/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ error: "missing ?q" }, 400);

  const strategy = (c.req.query("strategy") ?? "vector") as Strategy;
  const search = strategies[strategy];
  if (!search) {
    return c.json(
      { error: `unknown strategy '${strategy}' (use keyword | vector | hybrid)` },
      400
    );
  }

  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 10), 1), 50);
  const hits: SearchHit[] = await search(q, limit);
  return c.json({ query: q, strategy, count: hits.length, hits });
});

// GET /bookmarks/:id — a single bookmark by tweet id
app.get("/bookmarks/:id", async (c) => {
  const id = c.req.param("id");
  const { rows } = await getPool().query(
    `SELECT id, text, author, notes, tags, created_at, bookmarked_at
       FROM bookmarks WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) return c.json({ error: "not found" }, 404);
  return c.json(rows[0]);
});

// GET /stats — corpus overview
app.get("/stats", async (c) => {
  const pool = getPool();
  const [{ rows: totals }, { rows: authors }, { rows: tags }, { rows: range }] =
    await Promise.all([
      pool.query(`SELECT count(*)::int AS total,
                         count(DISTINCT author)::int AS authors
                    FROM bookmarks`),
      pool.query(`SELECT author AS name, count(*)::int AS count
                    FROM bookmarks GROUP BY author
                    ORDER BY count DESC LIMIT 10`),
      pool.query(`SELECT t AS name, count(*)::int AS count
                    FROM bookmarks, jsonb_array_elements_text(tags) t
                    GROUP BY t ORDER BY count DESC LIMIT 15`),
      pool.query(`SELECT min(bookmarked_at) AS earliest,
                         max(bookmarked_at) AS latest FROM bookmarks`),
    ]);
  return c.json({
    totalBookmarks: totals[0].total,
    uniqueAuthors: totals[0].authors,
    dateRange: { earliest: range[0].earliest, latest: range[0].latest },
    topAuthors: authors,
    topTags: tags,
  });
});

// GET /tags — every tag with its count
app.get("/tags", async (c) => {
  const { rows } = await getPool().query(
    `SELECT t AS name, count(*)::int AS count
       FROM bookmarks, jsonb_array_elements_text(tags) t
       GROUP BY t ORDER BY count DESC`
  );
  return c.json({ count: rows.length, tags: rows });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.error(`[xsaved-rag] search API listening on http://localhost:${port}`);
