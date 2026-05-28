import { vectorSearch } from "./vector.js";
import { keywordSearch } from "./keyword.js";
import type { SearchHit } from "../types.js";

const RRF_K = 60;
const PER_LEG_K = 20;

export async function hybridSearch(
  query: string,
  k: number
): Promise<SearchHit[]> {
  const [vectorHits, keywordHits] = await Promise.all([
    vectorSearch(query, PER_LEG_K),
    keywordSearch(query, PER_LEG_K),
  ]);

  const fused = new Map<string, { hit: SearchHit; score: number }>();

  for (const hit of vectorHits) {
    fused.set(hit.bookmarkId, { hit, score: 1 / (RRF_K + hit.rank) });
  }

  for (const hit of keywordHits) {
    const existing = fused.get(hit.bookmarkId);
    const rrf = 1 / (RRF_K + hit.rank);
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
