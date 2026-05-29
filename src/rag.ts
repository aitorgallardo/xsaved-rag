import { vectorSearch } from "./search/vector.js";
import { keywordSearch } from "./search/keyword.js";
import { hybridSearch } from "./search/hybrid.js";
import { generate, type GenerationResult } from "./generate.js";
import type { SearchHit } from "./types.js";

export type Strategy = "vector" | "keyword" | "hybrid";

export interface RagResult {
  question: string;
  answer: string;
  hits: SearchHit[];
  generation: GenerationResult | null;
}

function formatChunks(hits: SearchHit[]): string {
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

function pickSearch(strategy: Strategy) {
  return strategy === "keyword"
    ? keywordSearch
    : strategy === "hybrid"
      ? hybridSearch
      : vectorSearch;
}

export async function ask(
  question: string,
  k: number,
  strategy: Strategy,
  model?: string
): Promise<RagResult> {
  const search = pickSearch(strategy);
  const hits = await search(question, k);

  if (hits.length === 0) {
    return {
      question,
      answer: "No bookmarks matched this question.",
      hits: [],
      generation: null,
    };
  }

  const chunks = formatChunks(hits);
  const generation = await generate(question, chunks, model);

  return {
    question,
    answer: generation.text,
    hits,
    generation,
  };
}
