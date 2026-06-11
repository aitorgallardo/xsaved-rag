import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BookmarkLite, MediaItem } from "./types.js";

export async function loadBookmarks(
  path: string,
  limit: number
): Promise<BookmarkLite[]> {
  const absolute = resolve(path);
  const raw = await readFile(absolute, "utf-8");
  const all = JSON.parse(raw) as RawBookmark[];

  return all.slice(0, limit).map((b) => ({
    id: b.id,
    text: b.text,
    author: b.author,
    notes: b.notes,
    tags: Array.isArray(b.tags) ? b.tags : [],
    createdAt: b.created_at,
    bookmarkedAt: b.bookmarked_at,
    media: Array.isArray(b.media) ? b.media : [],
  }));
}

export function buildChunkText(b: BookmarkLite): string {
  // EMBED_MEDIA=false builds a text-only chunk (used by the eval A/B to measure
  // the lift media enrichment adds). Default: include the media summary.
  const includeMedia = process.env.EMBED_MEDIA !== "false";
  return [
    `Author: @${b.author}`,
    b.tags.length > 0 ? `Tags: ${b.tags.join(", ")}` : null,
    b.notes ? `Notes: ${b.notes}` : null,
    `Tweet: ${b.text}`,
    includeMedia && b.mediaSummary ? `Media: ${b.mediaSummary}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

interface RawBookmark {
  id: string;
  text: string;
  author: string;
  notes?: string;
  tags?: string[];
  created_at: string;
  bookmarked_at: string;
  media?: MediaItem[];
}
