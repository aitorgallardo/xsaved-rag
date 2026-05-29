/**
 * Portable generation module using INLINE [bookmark_id:X] citation tags.
 *
 * Use this instead of `src/generate.ts` (which uses Anthropic's native
 * citations API) when you need to swap to a non-Anthropic model — OpenAI,
 * Mistral, Gemini, open-source LLMs via a proxy, etc. The native citations
 * API is Anthropic-specific; the inline-tag pattern works with any LLM
 * that has a messages API.
 *
 * Trade-off vs the native version:
 *   ✓ Lower input tokens (no document wrapper overhead — ~2x cheaper input)
 *   ✓ Vendor-portable: swap the SDK + model id, you're done
 *   ✗ Model can occasionally garble long IDs when echoing them in text
 *     (real failure seen in our step 2 demo: 19-digit IDs get a digit wrong)
 *   ✗ Whole-bookmark granularity only — no per-span cited_text
 *
 * HOW TO SWAP THIS INTO THE PIPELINE:
 *   1. In `src/rag.ts`, change the import line from:
 *        import { generate, type GenerationResult } from "./generate.js";
 *      to:
 *        import { generate, type GenerationResult } from "./generate-inline.js";
 *      and pass `formatChunks(hits)` instead of `hits` to generate().
 *   2. Update `src/cli-ask.ts` to render `result.generation.text` directly
 *      instead of walking segments + citations.
 *
 * The code below uses the Anthropic SDK as the demo implementation, but
 * the only Anthropic-specific call is `client.messages.create(...)`. To
 * swap to OpenAI / Mistral / etc., replace that block with the equivalent
 * messages call from your chosen SDK. The system prompt, chunk-formatting,
 * and return shape stay identical.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SearchHit } from "./types.js";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 2048;

const SYSTEM_PROMPT = `
You are a research assistant for the user's personal Twitter/X bookmark collection.

You will receive a question and a set of bookmarks the retrieval system thinks are
relevant. Your job is to answer the question using ONLY those bookmarks.

Rules:
- Cite specific bookmarks inline using the format [bookmark_id:ID], where ID is the
  bookmark's exact id from the input. Cite every claim that comes from a bookmark.
- If the provided bookmarks do not contain enough information to answer, say so plainly.
  Do not speculate or invent facts.
- Be concise. Synthesise across multiple bookmarks when they make a coherent point.
- Prefer paraphrase over quotation. Quote only when wording matters.
- Do not introduce any information not present in the bookmarks.
`.trim();

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.");
  }
  client = new Anthropic({ apiKey });
  return client;
}

export interface GenerationResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/** Concatenate hits into a single chunk string for the user message. */
export function formatChunks(hits: SearchHit[]): string {
  return hits
    .map((h) => {
      const lines = [`[bookmark_id:${h.bookmarkId}]`, `Author: @${h.author}`];
      if (h.tags.length > 0) lines.push(`Tags: ${h.tags.join(", ")}`);
      if (h.notes) lines.push(`Notes: ${h.notes}`);
      lines.push(`Tweet: ${h.text}`);
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

export async function generate(
  question: string,
  chunksFormatted: string,
  model: string = DEFAULT_MODEL
): Promise<GenerationResult> {
  const userMessage = `Question: ${question}\n\nRelevant bookmarks:\n\n${chunksFormatted}`;

  // ---- VENDOR-SPECIFIC CALL: replace this block to swap providers. ----
  const response = await getClient().messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((b) => b.text)
    .join("\n");

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: response.model,
  };
  // ---- END VENDOR-SPECIFIC CALL ----
}
