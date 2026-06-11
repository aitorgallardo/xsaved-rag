import "dotenv/config";
import chalk from "chalk";
import ora from "ora";
import { loadBookmarks } from "./load-bookmarks.js";
import { indexBookmarks } from "./index-bookmarks.js";
import { closePool } from "./db.js";

const DEFAULT_PATH = "./data/bookmarks.json";

async function main() {
  const path = process.env.BOOKMARKS_PATH ?? DEFAULT_PATH;
  const limit = Number(process.env.INDEX_LIMIT ?? 100);

  const loader = ora(`Loading bookmarks from ${path}`).start();
  const bookmarks = await loadBookmarks(path, limit);
  loader.succeed(chalk.green(`Loaded ${bookmarks.length} bookmarks`));

  const enricher = ora("Enriching media").start();
  const embedder = ora("Indexing");
  const result = await indexBookmarks(bookmarks, {
    onEnrich: (done, total) => {
      enricher.text =
        total === 0 ? "Enriching media (nothing to do)" : `Enriching media ${done}/${total}`;
    },
    onEmbed: (done, total) => {
      if (!embedder.isSpinning) {
        enricher.succeed(chalk.green("Media enrichment done"));
        embedder.start();
      }
      embedder.text = `Indexing ${done}/${total}`;
    },
  });

  if (enricher.isSpinning) enricher.succeed(chalk.green("Media enrichment done"));
  if (embedder.isSpinning) embedder.stop();

  console.log(
    chalk.green(
      `Enriched: ${result.enriched} of ${result.withMedia} bookmarks with media`
    )
  );
  console.log(
    chalk.green(
      `Indexed: embedded ${result.embedded}, skipped ${result.skipped} (already current), total ${result.total}`
    )
  );

  await closePool();
}

main().catch((e) => {
  console.error(chalk.red("Indexing failed:"), e);
  process.exit(1);
});
