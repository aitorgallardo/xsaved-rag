import "dotenv/config";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { loadBookmarks } from "./load-bookmarks.js";

/**
 * Hydrate local media files for the demo corpus using the demo's own
 * asset-manifest.json. The bookmarks reference local placeholder paths
 * (".../assets/media/<id>_0_0.webp"); the manifest maps each of those to the
 * real pbs.twimg.com URL. We download the ones the indexed bookmarks need into
 * MEDIA_ASSETS_DIR so the enrichment pass can caption real images.
 *
 *   npm run download:media
 *
 * Env:
 *   BOOKMARKS_PATH      which corpus to hydrate (same one the indexer uses)
 *   INDEX_LIMIT         only fetch media for the bookmarks that get indexed
 *   ASSET_MANIFEST      manifest path (default: alongside BOOKMARKS_PATH)
 *   MEDIA_ASSETS_DIR    output dir (default: ./data/media)
 *   DOWNLOAD_CONCURRENCY  parallel downloads (default: 12)
 */

const MEDIA_MARKER = "/assets/media/";
const DOWNLOADABLE = /^https?:\/\/(pbs|ton|video)\.twimg\.com\//i;

async function main() {
  const bookmarksPath = process.env.BOOKMARKS_PATH ?? "./data/bookmarks.json";
  const limit = Number(process.env.INDEX_LIMIT ?? 100);
  const manifestPath =
    process.env.ASSET_MANIFEST ??
    join(dirname(resolve(bookmarksPath)), "asset-manifest.json");
  const outDir = resolve(process.env.MEDIA_ASSETS_DIR ?? "./data/media");
  const concurrency = Number(process.env.DOWNLOAD_CONCURRENCY ?? 12);

  let media: Record<string, string> = {};
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      media?: Record<string, string>;
    };
    media = manifest.media ?? {};
  } catch {
    console.log(
      chalk.yellow(
        `No asset manifest at ${manifestPath} — skipping media download.\n` +
          `Image/video bookmarks will fall back to metadata stubs (still indexable).`
      )
    );
    return;
  }

  const bookmarks = await loadBookmarks(bookmarksPath, limit);

  // Collect (stem → real URL) for every image + video thumbnail we'd caption.
  const wanted = new Map<string, string>();
  let noManifest = 0;
  let notDownloadable = 0;
  for (const b of bookmarks) {
    for (const m of b.media) {
      const refs: (string | undefined)[] =
        m.type === "image"
          ? m.urls
          : m.type === "video"
            ? [m.metadata?.thumbnail as string | undefined]
            : [];
      for (const ref of refs) {
        const stem = stemOf(ref);
        if (!stem) continue;
        const url = media[stem];
        if (!url) {
          noManifest++;
          continue;
        }
        if (!DOWNLOADABLE.test(url)) {
          notDownloadable++;
          continue;
        }
        wanted.set(stem, url);
      }
    }
  }

  await mkdir(outDir, { recursive: true });

  const entries = [...wanted.entries()];
  const spinner = ora(
    `Downloading ${entries.length} media files → ${outDir}`
  ).start();

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < entries.length) {
      const [stem, url] = entries[cursor++];
      const out = join(outDir, `${stem}${extOf(url)}`);
      if (await exists(out)) {
        skipped++;
      } else if (await download(url, out)) {
        downloaded++;
      } else {
        failed++;
      }
      spinner.text = `Downloading ${downloaded + skipped + failed}/${entries.length}`;
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, entries.length)) }, worker)
  );

  spinner.succeed(
    chalk.green(
      `Media ready: ${downloaded} downloaded, ${skipped} already present, ${failed} failed`
    )
  );
  if (noManifest > 0 || notDownloadable > 0) {
    console.log(
      chalk.gray(
        `(skipped ${noManifest} with no manifest entry, ${notDownloadable} non-image links)`
      )
    );
  }
  console.log(
    chalk.cyan(`Images ready in ${outDir} — captions run on the next  npm run index`)
  );
  console.log(
    chalk.dim(`(already-indexed? re-caption with  ENRICH_FORCE=true npm run index)`)
  );
}

function stemOf(url?: string): string | null {
  if (!url) return null;
  const i = url.indexOf(MEDIA_MARKER);
  const name = i >= 0 ? url.slice(i + MEDIA_MARKER.length) : null;
  return name ? name.replace(/\.\w+$/, "") : null;
}

function extOf(url: string): string {
  const fromPath = url.match(/\.(jpe?g|png|gif|webp)(?:[?#]|$)/i);
  if (fromPath) return `.${fromPath[1].toLowerCase()}`;
  const fromQuery = url.match(/[?&]format=(jpe?g|png|gif|webp)/i);
  if (fromQuery) return `.${fromQuery[1].toLowerCase()}`;
  return ".jpg";
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

async function download(url: string, out: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    if (!r.ok) return false;
    await writeFile(out, Buffer.from(await r.arrayBuffer()));
    return true;
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error(chalk.red("Download failed:"), e);
  process.exit(1);
});
