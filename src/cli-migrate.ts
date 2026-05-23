import "dotenv/config";
import chalk from "chalk";
import ora from "ora";
import { migrate } from "./migrate.js";
import { closePool } from "./db.js";

async function main() {
  const spinner = ora("Running migrations").start();
  try {
    await migrate();
    spinner.succeed(chalk.green("Schema ready"));
  } catch (e) {
    spinner.fail(chalk.red("Migration failed"));
    console.error(e);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
