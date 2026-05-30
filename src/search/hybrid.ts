import { vectorSearch } from "./vector.js";
import { keywordSearch } from "./keyword.js";
import type { SearchHit, SearchFilters } from "../types.js";

const RRF_K = 60;
const PER_LEG_K = 20;
const VECTOR_WEIGHT = Number(process.env.HYBRID_VECTOR_WEIGHT ?? 1);
const KEYWORD_WEIGHT = Number(process.env.HYBRID_KEYWORD_WEIGHT ?? 1);

export async function hybridSearch(
  query: string,
  k: number,
  filters?: SearchFilters
): Promise<SearchHit[]> {
  const [vectorHits, keywordHits] = await Promise.all([
    vectorSearch(query, PER_LEG_K, filters),
    keywordSearch(query, PER_LEG_K, filters),
  ]);

  const fused = new Map<string, { hit: SearchHit; score: number }>();

  for (const hit of vectorHits) {
    const rrf = VECTOR_WEIGHT / (RRF_K + hit.rank);
    fused.set(hit.bookmarkId, { hit, score: rrf });
  }

  for (const hit of keywordHits) {
    const existing = fused.get(hit.bookmarkId);
    const rrf = KEYWORD_WEIGHT / (RRF_K + hit.rank);
    if (existing) {
      fused.set(hit.bookmarkId, {
        hit: { ...existing.hit, keywordScore: hit.keywordScore },
        score: existing.score + rrf,
      });
    } else {
      fused.set(hit.bookmarkId, { hit, score: rrf });
    }
  }

  return Array.from(fused.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((entry, i) => ({ ...entry.hit, rank: i + 1 }));
}
