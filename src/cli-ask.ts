import "dotenv/config";
import chalk from "chalk";
import ora from "ora";
import { ask, type Strategy } from "./rag.js";
import { closePool } from "./db.js";
import type { Citation } from "./generate-native-citations.js";
import { parseArgs, hasAnyFilter } from "./cli-args.js";
import { formatFiltersForDisplay } from "./search/filters.js";

// Per million tokens.
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
  const { query: question, filters } = parseArgs(process.argv.slice(2));
  if (!question) {
    console.error(
      chalk.red(
        'Usage: npm run ask -- "your question" [--author handle] [--tag t] [--since YYYY-MM-DD] [--until YYYY-MM-DD]'
      )
    );
    process.exit(1);
  }

  const strategy = (process.env.SEARCH_STRATEGY ?? "vector") as Strategy;
  const k = Number(process.env.ASK_K ?? 5);
  const model = process.env.GEN_MODEL;
  const filtersOrUndef = hasAnyFilter(filters) ? filters : undefined;

  const spinner = ora(
    `Retrieving top ${k} (strategy=${strategy})${formatFiltersForDisplay(filtersOrUndef)}, asking Claude`
  ).start();
  const result = await ask(question, k, strategy, model, filtersOrUndef);
  spinner.succeed("Done");

  console.log(chalk.bold(`\nQuestion: ${question}\n`));
  console.log(chalk.bold("Answer:"));

  if (!result.generation) {
    console.log(chalk.yellow("No bookmarks matched this question."));
    await closePool();
    return;
  }

  // Render text with footnote markers inline; collect citations at the end.
  const allCitations: Citation[] = [];
  const citationKey = (c: Citation) => `${c.bookmarkId}::${c.citedText}`;
  const seen = new Map<string, number>();

  let rendered = "";
  for (const seg of result.generation.segments) {
    rendered += seg.text;
    if (seg.citations.length === 0) continue;
    const markers: number[] = [];
    for (const c of seg.citations) {
      const key = citationKey(c);
      let idx = seen.get(key);
      if (idx === undefined) {
        idx = allCitations.length + 1;
        seen.set(key, idx);
        allCitations.push(c);
      }
      markers.push(idx);
    }
    rendered += chalk.cyan(
      markers.map((n) => `[${n}]`).join("")
    );
  }
  console.log(rendered);

  if (allCitations.length > 0) {
    console.log(chalk.bold("\nCitations:"));
    allCitations.forEach((c, i) => {
      console.log(
        chalk.cyan(`  [${i + 1}]`) +
          chalk.dim(`  bookmark_id:${c.bookmarkId}  @${c.author}`)
      );
      console.log(
        chalk.dim(`       cited: "${c.citedText.slice(0, 140)}"`)
      );
    });
  }

  console.log(chalk.bold("\nRetrieved sources:"));
  result.hits.forEach((h, i) => {
    console.log(
      chalk.dim(`  (${i + 1}) bookmark_id:${h.bookmarkId}  @${h.author}`)
    );
    console.log(`       ${h.text.replace(/\s+/g, " ").slice(0, 140)}`);
  });

  const gen = result.generation;
  const price = priceFor(gen.model);
  const cost = price
    ? (gen.inputTokens / 1e6) * price.input +
      (gen.outputTokens / 1e6) * price.output
    : null;
  console.log(
    chalk.dim(
      `\n${gen.model}  ·  ${gen.inputTokens} in / ${gen.outputTokens} out` +
        (cost !== null ? `  ·  $${cost.toFixed(4)}` : "")
    )
  );

  await closePool();
}

main().catch((e) => {
  console.error(chalk.red("Ask failed:"), e);
  process.exit(1);
});
