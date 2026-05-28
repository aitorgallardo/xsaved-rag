import "dotenv/config";
import chalk from "chalk";
import ora from "ora";
import { loadBookmarks } from "./load-bookmarks.js";
import { indexBookmarks } from "./index-bookmarks.js";
import { closePool } from "./db.js";

const DEFAULT_PATH =
  "../../xsaved-landing-page/public/demo/main-demo/data/bookmarks.json";

async function main() {
  const path = process.env.BOOKMARKS_PATH ?? DEFAULT_PATH;
  const limit = Number(process.env.INDEX_LIMIT ?? 100);

  const loader = ora(`Loading bookmarks from ${path}`).start();
  const bookmarks = await loadBookmarks(path, limit);
  loader.succeed(chalk.green(`Loaded ${bookmarks.length} bookmarks`));

  const indexer = ora("Indexing").start();
  const result = await indexBookmarks(bookmarks, (done, total) => {
    indexer.text = `Indexing ${done}/${total}`;
  });
  indexer.succeed(
    chalk.green(
      `Indexed: embedded ${result.embedded}, skipped ${result.skipped} (already had embeddings), total ${result.total}`
    )
  );

  await closePool();
}

main().catch((e) => {
  console.error(chalk.red("Indexing failed:"), e);
  process.exit(1);
});
