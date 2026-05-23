# XSaved RAG

CLI that lets you **ask natural-language questions about your Twitter/X bookmark corpus** and get cited, source-grounded answers. Built on Claude + OpenAI embeddings + Postgres (pgvector + full-text search) on Neon.

Instead of scrolling endlessly through saved tweets, you ask: *"What did I save about prompt caching?"* — the system retrieves the most relevant bookmarks using **hybrid search** (semantic + keyword), then Claude synthesises an answer that links back to the original tweets.

---

## Architecture

End-to-end RAG pipeline with hybrid retrieval and an evaluation harness:

```
┌────────────────────────────────────────────────────────────┐
│ Indexing (offline, run once per corpus snapshot)           │
│   Input:  user's bookmarks (text + author + tags + notes)  │
│   Embed:  OpenAI text-embedding-3-small (1536 dim)         │
│   Store:  Neon Postgres                                    │
│           - bookmark_embeddings (vector + HNSW index)      │
│           - bookmarks.text_search (tsvector + GIN index)   │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│ Retrieval (online, per query)                              │
│   1. Embed the question (OpenAI)                           │
│   2. Vector search:  pgvector cosine distance, top-20      │
│   3. Keyword search: Postgres FTS (BM25-style), top-20     │
│   4. Combine with Reciprocal Rank Fusion (RRF)             │
│   5. Apply metadata filters (topic, author, date)          │
│   6. Return top-K with chunk text + source metadata        │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│ Generation                                                 │
│   Model:  claude-sonnet-4-6                                │
│   Input:  retrieved chunks + user question                 │
│   Output: cited answer with links back to bookmark IDs     │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│ Evaluation harness                                         │
│   20–30 labelled queries (question → expected bookmark ids)│
│   Metrics: recall@k, MRR                                   │
│   Re-runs on every retrieval change → measurable progress  │
└────────────────────────────────────────────────────────────┘
```

The pipeline is split so each layer is independently testable. Indexing is the one-time cost; retrieval and generation run per query. The eval harness sits underneath so retrieval quality is **measured**, not vibes-checked.

---

## Why hybrid retrieval (the core engineering decision)

Pure vector search is fuzzy and forgiving — great for paraphrases ("RLHF" matching "reinforcement learning from human feedback"), poor for exact terms (handles, libraries, technical jargon). Pure keyword search is the inverse.

Hybrid retrieval combines both result lists with **Reciprocal Rank Fusion**:

```
score(bookmark) = Σ  1 / (k + rank_in_list_i)
                 i
```

A bookmark that ranks well in *both* lists wins. No training, no extra service, ~10 lines of TypeScript. Empirically lifts recall by 15–25% on most corpora — which is the kind of measurable improvement worth quoting in interviews.

---

## Key engineering decisions

### 1. pgvector on Neon, not a dedicated vector DB

The XSaved backend already runs on Neon Postgres. Adding `CREATE EXTENSION vector;` is one line; standing up Pinecone or Weaviate is a whole new dependency. pgvector with an HNSW index scales comfortably to millions of vectors — well past the point where a single-user bookmark corpus would need to graduate. One database also means one source of truth for bookmarks, embeddings, and metadata filters in the same query.

### 2. OpenAI `text-embedding-3-small` as the embedding model

Cheap (~$0.02 per 1M tokens), 1536-dim, industry-standard baseline. The whole demo corpus re-embeds for cents. The `bookmark_embeddings` table tracks the `model` per row so future model swaps (e.g. Voyage `voyage-3`) can be done incrementally without mixing incompatible vector spaces.

### 3. One bookmark = one chunk (with metadata stuffed into the chunk text)

Bookmarks are short — tweets cap at ~280 chars. Standard RAG chunking strategies (500-token windows with overlap) are over-engineering here. Instead, each bookmark is embedded as a single chunk that *includes* its author handle, tags, and the user's own notes. User notes are particularly high-signal — they're often phrased the way the user will later search.

### 4. Hybrid retrieval over pure vector search

Vector + Postgres full-text search, combined with RRF. See "Why hybrid retrieval" above. The trade-off is one extra index (GIN on a generated `tsvector` column) and ~20 lines of fusion code — paid back in retrieval quality.

### 5. Eval harness from day one

20–30 hand-labelled queries (`question → expected bookmark ids`) live in `eval/test-queries.json`. Every retrieval change is benchmarked against the same set with **recall@k** ("did the right bookmark show up in top K?") and **MRR** ("how high did it rank?"). This turns retrieval engineering from guesswork into a measurable optimisation problem.

### 6. Metadata pre-filters via SQL

Because everything lives in Postgres, retrieval can pre-filter by `topic_id`, `author`, or date range *before* the vector search:
```sql
WHERE topic_id = 'ai-engineering'
  AND author = '@karpathy'
ORDER BY embedding <=> $queryEmbedding
LIMIT 20;
```
Structured + semantic in one query. This is the practical advantage of co-locating vectors and metadata.

---

## Stack

`@anthropic-ai/sdk` · `openai` (embeddings only) · `pg` · `pgvector` · `zod` · `dotenv` · `tsx` · `chalk` · `ora`

Postgres extensions: `vector`, built-in `tsvector` + GIN.

---

## Usage (planned)

```bash
cp .env.example .env  # ANTHROPIC_API_KEY, OPENAI_API_KEY, DATABASE_URL
npm install

# One-time: create schema + indexes
npm run db:migrate

# Index a bookmark export
npm run index -- path/to/xsaved-export.json

# Ask a question
npm run ask -- "what did I save about prompt caching?"

# Run eval harness
npm run eval
```

---

## What this project is part of

This is **Project 4** in a sequenced AI Engineer roadmap covering the Claude API, MCP, agentic patterns, RAG, multi-agent orchestration, and evaluation/observability — all built around the same XSaved bookmark corpus.

See [../ROADMAP.md](../ROADMAP.md) for the full plan and [../xsaved-topics/README.md](../xsaved-topics/README.md) for Project 1.
