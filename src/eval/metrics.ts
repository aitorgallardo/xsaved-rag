export function recallAtK(
  retrieved: string[],
  relevant: string[],
  k: number
): number {
  if (relevant.length === 0) return 0;
  const topK = new Set(retrieved.slice(0, k));
  const hits = relevant.filter((id) => topK.has(id)).length;
  return hits / relevant.length;
}

export function reciprocalRank(
  retrieved: string[],
  relevant: string[]
): number {
  if (relevant.length === 0) return 0;
  const relevantSet = new Set(relevant);
  for (let i = 0; i < retrieved.length; i++) {
    if (relevantSet.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

export function mean(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  return numbers.reduce((s, n) => s + n, 0) / numbers.length;
}
