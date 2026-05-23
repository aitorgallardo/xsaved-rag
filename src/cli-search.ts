import "dotenv/config";
import chalk from "chalk";
import { vectorSearch } from "./search/vector.js";
import { closePool } from "./db.js";

async function main() {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.error(chalk.red('Usage: npm run search -- "your question"'));
    process.exit(1);
  }

  const k = Number(process.env.SEARCH_K ?? 5);
  const hits = await vectorSearch(query, k);

  console.log(chalk.bold(`\nQuery: ${query}`));
  console.log(chalk.dim(`Top ${hits.length} by cosine distance:\n`));

  for (const hit of hits) {
    const head = chalk.cyan(`#${hit.rank}  @${hit.author}`);
    const score = chalk.dim(`distance=${hit.distance.toFixed(4)}`);
    const tags = hit.tags.length > 0 ? chalk.dim(`  [${hit.tags.join(", ")}]`) : "";
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
