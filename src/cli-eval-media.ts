import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { loadBookmarks } from "./load-bookmarks.js";
import { indexBookmarks } from "./index-bookmarks.js";
import { vectorSearch } from "./search/vector.js";
import { getPool, closePool } from "./db.js";
import { recallAtK, reciprocalRank, mean } from "./eval/metrics.js";

/**
 * Media A/B — measures the recall lift that media enrichment adds.
 *
 * It rebuilds the vector index twice over the SAME corpus and queries:
 *   - text-only  (EMBED_MEDIA=false): chunk = author/tags/notes/tweet
 *   - +media     (EMBED_MEDIA=true):  chunk also includes the media summary
 *
 * Captions are NOT regenerated between runs (they're cached in media_summary);
 * only the embedded chunk changes, so this isolates the embedding-side effect.
 * Vector strategy only, so the keyword leg (which also indexes media_summary)
 * doesn't muddy the comparison. The corpus ends in the +media state.
 *
 *   npm run eval:media
 */

const QUERIES_PATH = process.env.EVAL_QUERIES_PATH ?? "eval/test-queries-media.json";
const RESULTS_PATH = process.env.EVAL_RESULTS_PATH ?? "eval/results-media-ab.json";
const BOOKMARKS_PATH = process.env.BOOKMARKS_PATH ?? "./data/bookmarks.json";
const INDEX_LIMIT = Number(process.env.INDEX_LIMIT ?? 1000);
const K_RETRIEVAL = 20;

interface TestQuery {
  query: string;
  relevant_bookmark_ids: string[];
}

interface QueryScore {
  query: string;
  recallAt5: number;
  recallAt10: number;
  reciprocalRank: number;
  firstRank: number | null;
}

interface VariantResult {
  label: string;
  perQuery: QueryScore[];
  meanRecallAt5: number;
  meanRecallAt10: number;
  mrr: number;
}

async function main() {
  const queries: TestQuery[] = JSON.parse(
    await readFile(resolve(QUERIES_PATH), "utf-8")
  );
  const bookmarks = await loadBookmarks(BOOKMARKS_PATH, INDEX_LIMIT);

  const textOnly = await runVariant("text-only", false, bookmarks, queries);
  const withMedia = await runVariant("+media", true, bookmarks, queries);

  printComparison(textOnly, withMedia);

  await mkdir(dirname(resolve(RESULTS_PATH)), { recursive: true });
  await writeFile(
    resolve(RESULTS_PATH),
    JSON.stringify({ strategy: "vector", textOnly, withMedia }, null, 2)
  );
  console.log(chalk.dim(`\nFull results written to ${RESULTS_PATH}`));

  await closePool();
}

async function runVariant(
  label: string,
  includeMedia: boolean,
  bookmarks: Awaited<ReturnType<typeof loadBookmarks>>,
  queries: TestQuery[]
): Promise<VariantResult> {
  process.env.EMBED_MEDIA = includeMedia ? "true" : "false";

  const spinner = ora(`Building "${label}" index`).start();
  await getPool().query("TRUNCATE bookmark_embeddings");
  await indexBookmarks(bookmarks);
  spinner.text = `Querying "${label}"`;

  const perQuery: QueryScore[] = [];
  for (const q of queries) {
    const hits = await vectorSearch(q.query, K_RETRIEVAL);
    const ids = hits.map((h) => h.bookmarkId);
    const first = ids.findIndex((id) => q.relevant_bookmark_ids.includes(id));
    perQuery.push({
      query: q.query,
      recallAt5: recallAtK(ids, q.relevant_bookmark_ids, 5),
      recallAt10: recallAtK(ids, q.relevant_bookmark_ids, 10),
      reciprocalRank: reciprocalRank(ids, q.relevant_bookmark_ids),
      firstRank: first === -1 ? null : first + 1,
    });
  }
  spinner.succeed(`"${label}" done`);

  return {
    label,
    perQuery,
    meanRecallAt5: mean(perQuery.map((r) => r.recallAt5)),
    meanRecallAt10: mean(perQuery.map((r) => r.recallAt10)),
    mrr: mean(perQuery.map((r) => r.reciprocalRank)),
  };
}

function printComparison(a: VariantResult, b: VariantResult) {
  console.log(chalk.bold("\nMedia A/B — vector strategy, media-dependent queries\n"));
  console.log(
    chalk.bold(
      ` Query                                              │ text-only │  +media`
    )
  );
  console.log(chalk.dim("─".repeat(78)));
  a.perQuery.forEach((qa, i) => {
    const qb = b.perQuery[i];
    const q = qa.query.padEnd(50).slice(0, 50);
    const ra = rankCell(qa.firstRank);
    const rb = rankCell(qb.firstRank);
    console.log(` ${q} │   ${ra}    │   ${rb}`);
  });
  console.log(chalk.dim("─".repeat(78)));
  console.log(chalk.bold("\nAggregate"));
  row("Mean Recall@5 ", a.meanRecallAt5, b.meanRecallAt5);
  row("Mean Recall@10", a.meanRecallAt10, b.meanRecallAt10);
  row("MRR           ", a.mrr, b.mrr);
}

function rankCell(rank: number | null): string {
  if (rank === null) return chalk.red("miss");
  const s = `#${rank}`.padStart(4);
  return rank <= 5 ? chalk.green(s) : chalk.yellow(s);
}

function row(label: string, before: number, after: number) {
  const delta = after - before;
  const pct = before > 0 ? ` (+${Math.round((delta / before) * 100)}%)` : "";
  console.log(
    `  ${label}  ${chalk.dim(before.toFixed(3))} → ${chalk.cyan(after.toFixed(3))}` +
      chalk.green(`  ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}${pct}`)
  );
}

main().catch((e) => {
  console.error(chalk.red("Media eval failed:"), e);
  process.exit(1);
});
