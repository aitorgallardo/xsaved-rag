import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { vectorSearch } from "./search/vector.js";
import { keywordSearch } from "./search/keyword.js";
import { hybridSearch } from "./search/hybrid.js";
import { closePool } from "./db.js";
import { recallAtK, reciprocalRank, mean } from "./eval/metrics.js";

type Strategy = "vector" | "keyword" | "hybrid";

interface TestQuery {
  query: string;
  relevant_bookmark_ids: string[];
}

interface PerQueryResult {
  query: string;
  relevantCount: number;
  recallAt5: number;
  recallAt10: number;
  reciprocalRank: number;
  firstRelevantRank: number | null;
  retrievedIds: string[];
}

const QUERIES_PATH = process.env.EVAL_QUERIES_PATH ?? "eval/test-queries.json";
const STRATEGY = (process.env.SEARCH_STRATEGY ?? "vector") as Strategy;
const RESULTS_PATH =
  process.env.EVAL_RESULTS_PATH ?? `eval/results-${STRATEGY}.json`;
const K_RETRIEVAL = 20;

const search =
  STRATEGY === "keyword"
    ? keywordSearch
    : STRATEGY === "hybrid"
      ? hybridSearch
      : vectorSearch;

async function main() {
  const raw = await readFile(resolve(QUERIES_PATH), "utf-8");
  const queries: TestQuery[] = JSON.parse(raw);

  const spinner = ora(
    `Running ${queries.length} queries (strategy=${STRATEGY})`
  ).start();
  const results: PerQueryResult[] = [];

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    spinner.text = `Running ${i + 1}/${queries.length}: ${q.query}`;
    const hits = await search(q.query, K_RETRIEVAL);
    const retrievedIds = hits.map((h) => h.bookmarkId);
    const rr = reciprocalRank(retrievedIds, q.relevant_bookmark_ids);
    const firstHit = retrievedIds.findIndex((id) =>
      q.relevant_bookmark_ids.includes(id)
    );
    results.push({
      query: q.query,
      relevantCount: q.relevant_bookmark_ids.length,
      recallAt5: recallAtK(retrievedIds, q.relevant_bookmark_ids, 5),
      recallAt10: recallAtK(retrievedIds, q.relevant_bookmark_ids, 10),
      reciprocalRank: rr,
      firstRelevantRank: firstHit === -1 ? null : firstHit + 1,
      retrievedIds,
    });
  }
  spinner.succeed(`Ran ${queries.length} queries`);

  printPerQueryTable(results);
  const summary = printSummary(results);

  await mkdir(dirname(resolve(RESULTS_PATH)), { recursive: true });
  await writeFile(
    resolve(RESULTS_PATH),
    JSON.stringify(
      { strategy: STRATEGY, summary, results },
      null,
      2
    )
  );
  console.log(chalk.dim(`\nFull results written to ${RESULTS_PATH}`));

  await closePool();
}

function printPerQueryTable(results: PerQueryResult[]) {
  console.log(chalk.bold("\nPer-query results"));
  console.log(chalk.dim("─".repeat(95)));
  console.log(
    chalk.bold(
      ` # │ Query                                              │ R@5  │ R@10 │ 1st rank`
    )
  );
  console.log(chalk.dim("─".repeat(95)));
  results.forEach((r, i) => {
    const query = r.query.padEnd(50).slice(0, 50);
    const r5 = r.recallAt5.toFixed(2).padStart(4);
    const r10 = r.recallAt10.toFixed(2).padStart(4);
    const rank = r.firstRelevantRank ? String(r.firstRelevantRank) : chalk.red("—");
    const num = String(i + 1).padStart(2);
    console.log(` ${num} │ ${query} │ ${r5} │ ${r10} │ ${rank}`);
  });
  console.log(chalk.dim("─".repeat(95)));
}

function printSummary(results: PerQueryResult[]) {
  const summary = {
    meanRecallAt5: mean(results.map((r) => r.recallAt5)),
    meanRecallAt10: mean(results.map((r) => r.recallAt10)),
    mrr: mean(results.map((r) => r.reciprocalRank)),
    queriesWithZeroRecall: results.filter((r) => r.recallAt10 === 0).length,
  };
  console.log(chalk.bold("\nAggregate"));
  console.log(
    `  Mean Recall@5:  ${chalk.cyan(summary.meanRecallAt5.toFixed(3))}  ` +
      chalk.dim(`(of relevant bookmarks, fraction in top 5)`)
  );
  console.log(
    `  Mean Recall@10: ${chalk.cyan(summary.meanRecallAt10.toFixed(3))}  ` +
      chalk.dim(`(of relevant bookmarks, fraction in top 10)`)
  );
  console.log(
    `  MRR:            ${chalk.cyan(summary.mrr.toFixed(3))}  ` +
      chalk.dim(`(mean of 1/rank of first relevant hit)`)
  );
  if (summary.queriesWithZeroRecall > 0) {
    console.log(
      chalk.yellow(
        `  ${summary.queriesWithZeroRecall} queries missed entirely in top ${K_RETRIEVAL}`
      )
    );
  }
  return summary;
}

main().catch((e) => {
  console.error(chalk.red("Eval failed:"), e);
  process.exit(1);
});
