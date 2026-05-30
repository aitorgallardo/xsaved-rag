import { vectorSearch } from "./search/vector.js";
import { keywordSearch } from "./search/keyword.js";
import { hybridSearch } from "./search/hybrid.js";
import { generate, type GenerationResult } from "./generate-native-citations.js";
import type { SearchHit } from "./types.js";

export type Strategy = "vector" | "keyword" | "hybrid";

export interface RagResult {
  question: string;
  hits: SearchHit[];
  generation: GenerationResult | null;
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
    return { question, hits: [], generation: null };
  }

  const generation = await generate(question, hits, model);

  return { question, hits, generation };
}
