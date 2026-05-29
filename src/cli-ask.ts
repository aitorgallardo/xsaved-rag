import "dotenv/config";
import chalk from "chalk";
import ora from "ora";
import { ask, type Strategy } from "./rag.js";
import { closePool } from "./db.js";

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
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error(chalk.red('Usage: npm run ask -- "your question"'));
    process.exit(1);
  }

  const strategy = (process.env.SEARCH_STRATEGY ?? "vector") as Strategy;
  const k = Number(process.env.ASK_K ?? 5);
  const model = process.env.GEN_MODEL;

  const spinner = ora(
    `Retrieving top ${k} (strategy=${strategy}), asking Claude`
  ).start();
  const result = await ask(question, k, strategy, model);
  spinner.succeed("Done");

  console.log(chalk.bold(`\nQuestion: ${question}\n`));
  console.log(chalk.bold("Answer:"));
  console.log(result.answer);

  if (result.hits.length > 0) {
    console.log(chalk.bold("\nSources:"));
    result.hits.forEach((h, i) => {
      console.log(
        chalk.dim(`  [${i + 1}] bookmark_id:${h.bookmarkId}  @${h.author}`)
      );
      console.log(`       ${h.text.replace(/\s+/g, " ").slice(0, 140)}`);
    });
  }

  const gen = result.generation;
  if (gen) {
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
  }

  await closePool();
}

main().catch((e) => {
  console.error(chalk.red("Ask failed:"), e);
  process.exit(1);
});
