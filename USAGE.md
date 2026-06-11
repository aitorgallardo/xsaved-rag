# How to run the RAG engine — the source of truth for setup

**rag = the engine** (data + search). `xsaved-mcp` and `xsaved-research-agent`
both sit on top of it. Start the engine here; this is the one place the startup
steps live — the sibling projects link back to this file.

```
xsaved-mcp / xsaved-research-agent  →  HTTP  →  xsaved-rag engine  →  Postgres (pgvector + FTS)
```

**Prereq:** OrbStack (Docker) running.

## Start the engine

```bash
# 0. start OrbStack (your local Docker runtime), if it isn't already running
open -a OrbStack              # macOS — give it a few seconds to boot
docker ps                     # sanity check — errors if the daemon isn't ready yet

# 1. launch the local database
cd xsaved-rag
docker compose up -d --wait   # Postgres + pgvector container (xsaved-rag-db on :5432)

# 2. one-time setup — tables, media, embeddings (idempotent; safe to re-run)
npm run setup                 # = db:migrate + download:media + index
                              #   · downloads ~165 tweet images via the asset manifest
                              #   · captions images/videos with gpt-5.4-nano (OCR) — ~$0.07 one-time
                              #   · embeds tweet text + captions (~$0.0002)
                              #   skip the paid captions: ENRICH_VISION=false npm run setup

# 3. start the search API (leave this running)
npm run serve                 # http://localhost:8790 — LEAVE THIS RUNNING
```

## Try it — including the media search

```bash
# plain hybrid search
curl "http://localhost:8790/search?q=motivation&strategy=hybrid&limit=3"

# metadata filters (structured + semantic in one query)
curl "http://localhost:8790/search?q=rockets&strategy=hybrid&author=elonmusk"

# MEDIA search — matched by an image/video caption, not the tweet text:
curl "http://localhost:8790/search?q=green+circuit+board+animation&strategy=vector&limit=3"
#   → top hit is @AdamKPx, whose tweet ("I'm mad I didn't think of this first")
#     never mentions circuits — it matched via the video's caption (OCR + vision).
```

You can also search straight from the CLI without the HTTP server:

```bash
npm run search -- "green circuit board animation"
```

**Measure what media adds** (rebuilds the vector index text-only vs +media and
reports recall on media-dependent queries):

```bash
npm run eval:media            # Recall@5 0.333 → 1.000, MRR 0.284 → 1.000
```

The serve terminal logs one coloured line per call:

```
8:16:58 AM GET /search?...&strategy=hybrid 200 660ms → 2 hits [hybrid] "discipline"
```

## Drive the engine from the other projects

Once `npm run serve` is up, point either consumer at it:

- **MCP server** (Claude Desktop / MCP Inspector) → `xsaved-mcp/USAGE.md`
- **Research agent** (ask a question → cited report) → `xsaved-research-agent/USAGE.md`

## If the engine breaks

- `docker compose` says **"cannot connect to the Docker daemon"** → OrbStack isn't running yet (`open -a OrbStack`, wait a few seconds, retry).
- `/search` empty or errors → not set up yet (`npm run setup`).
- **captions missing / "(no preview available)"** → images weren't downloaded. Run `npm run download:media`, then `ENRICH_FORCE=true npm run index`. (Or `ENRICH_VISION=false` to skip captions on purpose.)
- `EADDRINUSE: :::8790` → a server is already on that port; `lsof -ti tcp:8790 | xargs kill`.
