import "dotenv/config";
import chalk from "chalk";
import { vectorSearch } from "./search/vector.js";
import { keywordSearch } from "./search/keyword.js";
import { hybridSearch } from "./search/hybrid.js";
import { closePool } from "./db.js";
import type { SearchHit } from "./types.js";
import { parseArgs, hasAnyFilter } from "./cli-args.js";
import { formatFiltersForDisplay } from "./search/filters.js";

type Strategy = "vector" | "keyword" | "hybrid";

async function main() {
  const { query, filters } = parseArgs(process.argv.slice(2));
  if (!query) {
    console.error(
      chalk.red(
        'Usage: npm run search -- "your question" [--author handle] [--tag t] [--since YYYY-MM-DD] [--until YYYY-MM-DD]'
      )
    );
    process.exit(1);
  }

  const strategy = (process.env.SEARCH_STRATEGY ?? "vector") as Strategy;
  const k = Number(process.env.SEARCH_K ?? 5);
  const filtersOrUndef = hasAnyFilter(filters) ? filters : undefined;

  const hits: SearchHit[] =
    strategy === "keyword"
      ? await keywordSearch(query, k, filtersOrUndef)
      : strategy === "hybrid"
        ? await hybridSearch(query, k, filtersOrUndef)
        : await vectorSearch(query, k, filtersOrUndef);

  console.log(chalk.bold(`\nQuery: ${query}`));
  console.log(
    chalk.dim(
      `Strategy: ${strategy}   Top ${hits.length}${formatFiltersForDisplay(filtersOrUndef)}\n`
    )
  );

  if (hits.length === 0) {
    console.log(chalk.yellow("No matches."));
    await closePool();
    return;
  }

  for (const hit of hits) {
    const head = chalk.cyan(`#${hit.rank}  @${hit.author}`);
    const score =
      hit.distance !== undefined
        ? chalk.dim(`distance=${hit.distance.toFixed(4)}`)
        : chalk.dim(`score=${(hit.keywordScore ?? 0).toFixed(4)}`);
    const tags =
      hit.tags.length > 0 ? chalk.dim(`  [${hit.tags.join(", ")}]`) : "";
    console.log(`${head}  ${score}${tags}`);
    console.log(`     ${hit.text.replace(/\s+/g, " ").slice(0, 200)}`);
    if (hit.notes) console.log(chalk.dim(`     notes: ${hit.notes}`));
    console.log();
  }

  await closePool();
}

main().catch((e) => {
  console.error(chalk.red("Search failed:"), e);
  process.exit(1);
});
