import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getOpenAI } from "./embed.js";
import type { BookmarkLite, MediaItem } from "./types.js";

/**
 * Media enrichment — turn a bookmark's media into a short text summary so it
 * lands in the embedding + the full-text index.
 *
 * Two extraction paths:
 *   - metadata-only (repost / card / article / link): text is already in the
 *     payload — quoted tweet, card title, link domain. No model call, no cost.
 *   - vision (image / video): caption the image / video thumbnail with a cheap
 *     multimodal model. Only fires when the image bytes can actually be loaded
 *     (a local assets dir, or a real http(s) URL).
 *
 * If image bytes can't be resolved, vision degrades to a metadata stub so the
 * bookmark is still enriched (and re-runs cleanly once the bytes are available).
 */

export const VISION_MODEL = "gpt-5.4-nano";

// Vision can be turned off entirely (metadata-only) with ENRICH_VISION=false.
const VISION_ENABLED = process.env.ENRICH_VISION !== "false";

// Where local media files live. The demo's media `urls` are web-style paths
// (".../assets/media/<id>_0_0.webp"); set this to the directory that holds them.
const ASSETS_DIR = process.env.MEDIA_ASSETS_DIR;

const CAPTION_PROMPT =
  "You are indexing a social-media bookmark for search. Describe this image in " +
  "one concise, factual sentence. Transcribe any visible text verbatim (it is " +
  "often the whole point of the bookmark). Mention key people, objects, charts, " +
  "or UI. No preamble, no markdown — just the sentence.";

export interface EnrichResult {
  /** The combined media summary, or null if nothing extractable. */
  summary: string | null;
  /** VISION_MODEL if at least one caption was generated, else null. */
  model: string | null;
}

/** Build the media summary for one bookmark. */
export async function enrichBookmarkMedia(b: BookmarkLite): Promise<EnrichResult> {
  const parts: string[] = [];
  let usedVision = false;

  for (const m of b.media) {
    const meta = m.metadata ?? {};
    switch (m.type) {
      case "repost": {
        const quoted = meta.data?.legacy?.full_text as string | undefined;
        const author = meta.quotedAuthor as string | undefined;
        if (quoted) parts.push(`Quoted @${author ?? "?"}: "${clip(quoted, 400)}"`);
        else if (author) parts.push(`Quoted @${author}`);
        break;
      }
      case "card": {
        const title = joinText(meta.title, meta.description);
        if (title) parts.push(`Link card (${meta.domain ?? "link"}): ${clip(title, 400)}`);
        break;
      }
      case "article": {
        const title = joinText(meta.title, meta.description);
        if (title) parts.push(`Article: ${clip(title, 400)}`);
        break;
      }
      case "link": {
        const where = meta.displayUrl ?? meta.domain;
        if (where) parts.push(`Link: ${where}`);
        break;
      }
      case "image": {
        const caption = await captionFirst(m.urls);
        if (caption) {
          parts.push(`Image: ${caption}`);
          usedVision = true;
        } else {
          parts.push(stub(m, "image"));
        }
        break;
      }
      case "video": {
        const caption = await captionFirst([meta.thumbnail as string | undefined]);
        if (caption) {
          parts.push(`Video: ${caption}`);
          usedVision = true;
        } else {
          parts.push("Video (no preview available)");
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    summary: parts.length ? parts.join("\n") : null,
    model: usedVision ? VISION_MODEL : null,
  };
}

/** Caption the first URL in the list whose bytes we can actually load. */
async function captionFirst(urls: (string | undefined)[]): Promise<string | null> {
  if (!VISION_ENABLED) return null;
  for (const url of urls) {
    const bytes = await resolveImageBytes(url);
    if (!bytes) continue;
    try {
      return await captionImage(bytes.base64, bytes.mime);
    } catch {
      return null; // a failed caption shouldn't abort the whole run
    }
  }
  return null;
}

async function captionImage(base64: string, mime: string): Promise<string> {
  const resp = await getOpenAI().chat.completions.create({
    model: VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: CAPTION_PROMPT },
          {
            type: "image_url",
            // "low" detail keeps image-token cost down — plenty for a caption.
            image_url: { url: `data:${mime};base64,${base64}`, detail: "low" },
          },
        ],
      },
    ],
  });
  return resp.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * Resolve a media URL to raw image bytes.
 *   - http(s)            → fetch it (what production xsaved actually stores)
 *   - local-ish path     → look it up under MEDIA_ASSETS_DIR, trying common
 *                          extensions (.webp/.jpg/.png) since exports vary
 *   - otherwise          → null (caller falls back to a metadata stub)
 */
async function resolveImageBytes(
  url?: string
): Promise<{ base64: string; mime: string } | null> {
  if (!url) return null;

  if (/^https?:\/\//i.test(url)) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      const mime = r.headers.get("content-type")?.split(";")[0] || guessMime(url);
      return { base64: buf.toString("base64"), mime };
    } catch {
      return null;
    }
  }

  if (!ASSETS_DIR) return null;
  const marker = "/assets/media/";
  const idx = url.indexOf(marker);
  const name = idx >= 0 ? url.slice(idx + marker.length) : basename(url);
  for (const candidate of withExtFallbacks(name)) {
    try {
      const buf = await readFile(join(ASSETS_DIR, candidate));
      return { base64: buf.toString("base64"), mime: guessMime(candidate) };
    } catch {
      // try the next extension
    }
  }
  return null;
}

function withExtFallbacks(name: string): string[] {
  const stem = name.replace(/\.\w+$/, "");
  return [name, `${stem}.webp`, `${stem}.jpg`, `${stem}.jpeg`, `${stem}.png`];
}

function guessMime(p: string): string {
  if (/\.png$/i.test(p)) return "image/png";
  if (/\.webp$/i.test(p)) return "image/webp";
  if (/\.gif$/i.test(p)) return "image/gif";
  return "image/jpeg";
}

function stub(m: MediaItem, kind: string): string {
  const count = (m.metadata?.count as number | undefined) ?? m.urls.length ?? 1;
  return `${count} ${kind}${count === 1 ? "" : "s"} (no preview available)`;
}

function joinText(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(" — ");
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
