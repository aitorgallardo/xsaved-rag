import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { ask, type Strategy } from "./rag.js";
import { judge, type JudgeScores } from "./eval/judge.js";
import { mean } from "./eval/metrics.js";
import { closePool } from "./db.js";

interface TestQuery {
  query: string;
  relevant_bookmark_ids: string[];
}

interface PerQueryResult {
  query: string;
  answer: string;
  scores: JudgeScores;
  genTokens: { in: number; out: number };
  judgeTokens: { in: number; out: number };
}

const QUERIES_PATH = process.env.EVAL_QUERIES_PATH ?? "eval/test-queries.json";
const STRATEGY = (process.env.SEARCH_STRATEGY ?? "vector") as Strategy;
const RESULTS_PATH =
  process.env.EVAL_RESULTS_PATH ?? `eval/results-gen-${STRATEGY}.json`;
const K = Number(process.env.ASK_K ?? 5);
const GEN_MODEL = process.env.GEN_MODEL;
const JUDGE_MODEL = process.env.JUDGE_MODEL;

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
  "claude-opus-4-7": { input: 15, output: 75 },
};

function priceFor(modelId: string) {
  const exact = PRICING[modelId];
  if (exact) return exact;
  const prefix = Object.keys(PRICING).find((k) => modelId.startsWith(k));
  return prefix ? PRICING[prefix] : null;
}

async function main() {
  const raw = await readFile(resolve(QUERIES_PATH), "utf-8");
  const queries: TestQuery[] = JSON.parse(raw);
  const spinner = ora(
    `Running gen-eval on ${queries.length} queries (strategy=${STRATEGY})`
  ).start();
  const results: PerQueryResult[] = [];

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    spinner.text = `[${i + 1}/${queries.length}] ${q.query}`;
    const askResult = await ask(q.query, K, STRATEGY, GEN_MODEL);
    if (!askResult.generation || askResult.hits.length === 0) continue;

    const answerText = askResult.generation.segments
      .map((s) => s.text)
      .join("");
    const judgeResult = await judge(
      q.query,
      askResult.hits,
      answerText,
      JUDGE_MODEL
    );

    results.push({
      query: q.query,
      answer: answerText,
      scores: judgeResult.scores,
      genTokens: {
        in: askResult.generation.inputTokens,
        out: askResult.generation.outputTokens,
      },
      judgeTokens: {
        in: judgeResult.inputTokens,
        out: judgeResult.outputTokens,
      },
    });
  }
  spinner.succeed(`Scored ${results.length} answers`);

  printTable(results);
  const summary = printSummary(results);

  await mkdir(dirname(resolve(RESULTS_PATH)), { recursive: true });
  await writeFile(
    resolve(RESULTS_PATH),
    JSON.stringify({ strategy: STRATEGY, summary, results }, null, 2)
  );
  console.log(chalk.dim(`\nFull results written to ${RESULTS_PATH}`));

  await closePool();
}

function printTable(results: PerQueryResult[]) {
  console.log(chalk.bold("\nPer-query judge scores"));
  console.log(chalk.dim("─".repeat(95)));
  console.log(
    chalk.bold(" # │ Query                                             │ Faith │ Comp │ Conc │ Verdict")
  );
  console.log(chalk.dim("─".repeat(95)));
  results.forEach((r, i) => {
    const q = r.query.padEnd(50).slice(0, 50);
    const f = String(r.scores.faithfulness).padStart(2);
    const c = String(r.scores.completeness).padStart(2);
    const k = String(r.scores.conciseness).padStart(2);
    const v =
      r.scores.overall === "pass"
        ? chalk.green("pass")
        : chalk.red("fail");
    const num = String(i + 1).padStart(2);
    console.log(` ${num} │ ${q} │  ${f}   │  ${c}  │  ${k}  │ ${v}`);
  });
  console.log(chalk.dim("─".repeat(95)));
}

function printSummary(results: PerQueryResult[]) {
  const totals = results.reduce(
    (acc, r) => {
      acc.genIn += r.genTokens.in;
      acc.genOut += r.genTokens.out;
      acc.judgeIn += r.judgeTokens.in;
      acc.judgeOut += r.judgeTokens.out;
      return acc;
    },
    { genIn: 0, genOut: 0, judgeIn: 0, judgeOut: 0 }
  );
  const summary = {
    meanFaithfulness: mean(results.map((r) => r.scores.faithfulness)),
    meanCompleteness: mean(results.map((r) => r.scores.completeness)),
    meanConciseness: mean(results.map((r) => r.scores.conciseness)),
    passRate: results.filter((r) => r.scores.overall === "pass").length / Math.max(results.length, 1),
    totalGenTokens: { in: totals.genIn, out: totals.genOut },
    totalJudgeTokens: { in: totals.judgeIn, out: totals.judgeOut },
  };

  const genPrice = priceFor(GEN_MODEL ?? "claude-sonnet-4-6");
  const judgePrice = priceFor(JUDGE_MODEL ?? "claude-sonnet-4-6");
  const cost =
    (genPrice
      ? (totals.genIn / 1e6) * genPrice.input + (totals.genOut / 1e6) * genPrice.output
      : 0) +
    (judgePrice
      ? (totals.judgeIn / 1e6) * judgePrice.input + (totals.judgeOut / 1e6) * judgePrice.output
      : 0);

  console.log(chalk.bold("\nAggregate"));
  console.log(`  Faithfulness: ${chalk.cyan(summary.meanFaithfulness.toFixed(2))} / 10`);
  console.log(`  Completeness: ${chalk.cyan(summary.meanCompleteness.toFixed(2))} / 10`);
  console.log(`  Conciseness:  ${chalk.cyan(summary.meanConciseness.toFixed(2))} / 10`);
  console.log(`  Pass rate:    ${chalk.cyan((summary.passRate * 100).toFixed(0))}%`);
  console.log(
    chalk.dim(
      `\nCost: gen ${totals.genIn}+${totals.genOut}, judge ${totals.judgeIn}+${totals.judgeOut}` +
        ` → $${cost.toFixed(4)}`
    )
  );

  return summary;
}

main().catch((e) => {
  console.error(chalk.red("Gen eval failed:"), e);
  process.exit(1);
});
