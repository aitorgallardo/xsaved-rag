# XSaved RAG

CLI that lets you **ask natural-language questions about your Twitter/X bookmark corpus** and get cited, source-grounded answers. Built on Claude + OpenAI embeddings + Postgres (pgvector + full-text search).

Instead of scrolling endlessly through saved tweets, you ask: *"What did I save about prompt caching?"* — the system retrieves the most relevant bookmarks, then Claude synthesises an answer with structured citations back to the original tweets.

The headline engineering decision is **eval-first** — every retrieval strategy gets measured against a labelled query set with recall@k and MRR before anything ships. The eval told us hybrid retrieval *didn't* improve on pure vector for this corpus, so pure vector is what ships. That measured negative result is more credible than a tutorial-flavoured "+18% lift" claim.

---

## Architecture

Three layers with an evaluation harness underneath:

```
┌────────────────────────────────────────────────────────────┐
│ Indexing (offline, one-time per corpus snapshot)           │
│   Input:  bookmarks (text + author + tags + notes)         │
│   Embed:  OpenAI text-embedding-3-small (1536 dim)         │
│   Store:  Postgres                                         │
│           - bookmark_embeddings (vector + HNSW index)      │
│           - bookmarks.text_search (tsvector + GIN index)   │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│ Retrieval (online, per query)                              │
│   Three strategies, dispatched by SEARCH_STRATEGY env var: │
│     vector   — pgvector cosine via `<=>`, top-K            │
│     keyword  — Postgres FTS, ts_rank_cd (BM25-family)      │
│     hybrid   — Reciprocal Rank Fusion of vector + keyword  │
│                (weight-tunable per leg)                    │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│ Generation                                                 │
│   Model:    claude-sonnet-4-6 (configurable)               │
│   Citations: native Anthropic citations API                │
│              (structured cited_text spans, not inline tags)│
│   Output:   answer + per-claim citations + sources         │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│ Evaluation                                                 │
│   10 labelled queries in eval/test-queries.json            │
│   Metrics: recall@5, recall@10, MRR                        │
│   `npm run eval` is re-runnable on every retrieval change  │
│   Strategy-dispatched: results-{vector,keyword,hybrid}.json│
└────────────────────────────────────────────────────────────┘
```

The pipeline is split so each layer is independently testable. The eval sits underneath so retrieval quality is *measured*, not vibes-checked.

---

## Numbers from a real run

100-bookmark demo corpus, OpenAI `text-embedding-3-small`, `claude-sonnet-4-6`.

### Retrieval eval — all three strategies, same 10 queries

| Metric | Vector | Keyword | Hybrid 1:1 | Hybrid 2:1 | Hybrid 3:1 |
|---|---|---|---|---|---|
| Mean Recall@5 | **0.863** | 0.487 | 0.750 | 0.833 | 0.846 |
| Mean Recall@10 | **0.933** | 0.833 | 0.933 | 0.933 | 0.933 |
| MRR | **1.000** | 0.613 | 0.833 | 0.900 | 0.950 |

Pure vector wins on this corpus. Weighted hybrid asymptotically approaches vector but never beats it — vector strictly dominates, so any keyword influence in the fusion costs MRR.

### End-to-end cost + latency

| Operation | Cost | Time |
|---|---|---|
| Index 100 bookmarks (embed + upsert) | **~$0.0002** | ~3s |
| Vector search (per query) | ~$0.000002 | <100ms |
| `npm run ask` (Sonnet 4.6, k=5, native citations) | **~$0.008** | ~3–8s |

Generation is ~35× the cost of indexing the entire corpus. Model selection, k, and prompt caching are the real cost levers once usage grows.

---

## Key engineering decisions

### 1. Eval harness *before* any retrieval optimisation

`recallAtK`, `reciprocalRank`, `mean` live as pure functions in `src/eval/metrics.ts`. The runner dispatches by `SEARCH_STRATEGY`, so the same harness scores any strategy and saves to `eval/results-{strategy}.json` for diffing. Every change to retrieval — chunk shape, embedding model, fusion weights — gets a measurable verdict in <5 seconds. This is the single most career-relevant chunk of code in the repo.

### 2. Honest measurement → ship pure vector

The textbook claim is "hybrid lifts recall by 15–25%." On this corpus, **hybrid lost** to pure vector (R@5 −0.11, MRR −0.17 at 1:1 weights). I parameterised the RRF leg weights and swept 1:1, 2:1, 3:1 — recall and MRR improved monotonically toward vector but never beat it. Conclusion: vector strictly dominates here. Pure vector ships. The same code on a larger or more keyword-anchor-heavy corpus would likely flip the verdict.

### 3. pgvector on Postgres, not a dedicated vector DB

`CREATE EXTENSION vector;` plus an HNSW index on `vector_cosine_ops`. One database, one source of truth for bookmarks + embeddings + (future) metadata filters in the same query. HNSW handles millions of vectors before you'd outgrow it. Local dev runs against Docker + the `pgvector/pgvector:pg16` image; the same `DATABASE_URL` swap works for managed Postgres (Neon, RDS).

### 4. OpenAI `text-embedding-3-small`, with `model` column for safe swaps

1536-dim, ~$0.02 per 1M tokens, industry-standard baseline. The `bookmark_embeddings` table tracks the `model` per row — future model swaps (Voyage `voyage-3`, OpenAI `text-embedding-3-large`) can run side by side without mixing incompatible vector spaces.

### 5. One bookmark = one chunk, with metadata in the chunk text

Tweets are short — standard 500-token chunking is over-engineering. Each bookmark embeds as a single chunk that concatenates `Author + Tags + Notes + Tweet`. User notes are particularly high-signal because they're phrased the way the user will later search. The exact same fields populate the `text_search` `tsvector` for keyword search, so both strategies query the same surface area.

### 6. Keyword search with explicit OR semantics

First-pass keyword used `plainto_tsquery`, which joins all query tokens with **AND** — collapsed recall to 0.20. Fixed by tokenising in JS and joining with `|` (OR) before passing to `to_tsquery`. Same data, same index — Recall@10 jumped from 0.20 to 0.83. **A 60-point lift from a query-construction bug.** Worth remembering: when keyword search performs catastrophically, suspect query construction before suspecting the index.

### 7. Native Anthropic citations API for trustworthy attribution

First version used inline `[bookmark_id:X]` tags in the model's text. First demo surfaced the failure: Claude garbled a 19-digit ID. Migrated to Anthropic's native citations API — each retrieved chunk is passed as a `document` content block, and citations return as structured objects with `cited_text` spans. The model never has to write an ID, so it can't get one wrong. Costs roughly 2× input tokens (the document wrapper has overhead) for reliable, span-level citations.

---

## Generation system prompt

```
You are a research assistant for the user's personal Twitter/X bookmark collection.

You will receive a question and a set of bookmarks the retrieval system thinks are
relevant. Your job is to answer the question using ONLY those bookmarks.

Rules:
- If the provided bookmarks do not contain enough information to answer, say so plainly.
  Do not speculate or invent facts.
- Be concise. Synthesise across multiple bookmarks when they make a coherent point.
- Prefer paraphrase over quotation. Quote only when wording matters.
- Do not introduce any information not present in the bookmarks.

Citations are tracked automatically — you do not need to write source markers in your text.
```

The last line works in tandem with the native citations API: by handing chunks as `document` blocks, citations come back as structured metadata. Less for the prompt to do, less for the model to get wrong.

---

## Usage

```bash
# 1. Local Postgres + pgvector via Docker
docker compose up -d --wait

# 2. Setup
cp .env.example .env   # fill in OPENAI_API_KEY + ANTHROPIC_API_KEY
npm install
npm run db:migrate     # create schema + HNSW + GIN indexes

# 3. Index the bookmarks
npm run index          # defaults to 100 demo bookmarks

# 4. Search (any strategy)
npm run search -- "tips on writing prompts for Claude"
SEARCH_STRATEGY=keyword npm run search -- "Anthropic SWE interview"
SEARCH_STRATEGY=hybrid  npm run search -- "design tools for engineers"

# 5. Ask (full RAG with cited answers)
npm run ask -- "what did I save about Elon Musk and rockets"
SEARCH_STRATEGY=hybrid HYBRID_VECTOR_WEIGHT=2 npm run ask -- "..."
GEN_MODEL=claude-haiku-4-5-20251001 npm run ask -- "..."   # cheaper

# 6. Run the eval (per strategy)
SEARCH_STRATEGY=vector  npm run eval
SEARCH_STRATEGY=keyword npm run eval
SEARCH_STRATEGY=hybrid  npm run eval
```

`SEARCH_STRATEGY`, `ASK_K`, `GEN_MODEL`, and the `HYBRID_*` weights all compose. Change one env var, re-run, compare.

---

## Stack

`@anthropic-ai/sdk` (generation + citations) · `openai` (embeddings) · `pg` + `pgvector` · `zod` · `dotenv` · `tsx` · `chalk` · `ora`

Postgres extensions: `vector`, built-in `tsvector` + GIN.

---

## What this project is part of

This is **Project 4** in a sequenced AI Engineer roadmap covering the Claude API, MCP, agentic patterns, RAG, multi-agent orchestration, and evaluation/observability — all built around the same XSaved bookmark corpus.

See [../ROADMAP.md](../ROADMAP.md) for the full plan and [../xsaved-topics/README.md](../xsaved-topics/README.md) for Project 1.
