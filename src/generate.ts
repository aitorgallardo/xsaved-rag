import Anthropic from "@anthropic-ai/sdk";
import type { SearchHit } from "./types.js";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 2048;

const SYSTEM_PROMPT = `
You are a research assistant for the user's personal Twitter/X bookmark collection.

You will receive a question and a set of bookmarks the retrieval system thinks are
relevant. Your job is to answer the question using ONLY those bookmarks.

Rules:
- If the provided bookmarks do not contain enough information to answer, say so plainly.
  Do not speculate or invent facts.
- Be concise. Synthesise across multiple bookmarks when they make a coherent point.
- Prefer paraphrase over quotation. Quote only when wording matters.
- Do not introduce any information not present in the bookmarks.

Citations are tracked automatically — you do not need to write source markers in your text.
`.trim();

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.");
  }
  client = new Anthropic({ apiKey });
  return client;
}

export interface Citation {
  citedText: string;
  bookmarkId: string;
  author: string;
}

export interface AnswerSegment {
  text: string;
  citations: Citation[];
}

export interface GenerationResult {
  segments: AnswerSegment[];
  inputTokens: number;
  outputTokens: number;
  model: string;
}

function bookmarkAsDocument(h: SearchHit) {
  const lines = [`Author: @${h.author}`];
  if (h.tags.length > 0) lines.push(`Tags: ${h.tags.join(", ")}`);
  if (h.notes) lines.push(`Notes: ${h.notes}`);
  lines.push(`Tweet: ${h.text}`);
  return {
    type: "document" as const,
    source: {
      type: "text" as const,
      media_type: "text/plain" as const,
      data: lines.join("\n"),
    },
    title: `${h.bookmarkId} @${h.author}`,
    citations: { enabled: true },
  };
}

export async function generate(
  question: string,
  hits: SearchHit[],
  model: string = DEFAULT_MODEL
): Promise<GenerationResult> {
  const documents = hits.map(bookmarkAsDocument);

  const response = await getClient().messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          ...documents,
          { type: "text", text: `Question: ${question}` },
        ],
      },
    ],
  });

  const segments: AnswerSegment[] = [];
  for (const block of response.content) {
    if (block.type !== "text") continue;
    const citations: Citation[] = (block.citations ?? []).map((c) => {
      // c is a CitationCharLocation: { document_index, cited_text, ... }
      const docIndex = (c as { document_index: number }).document_index;
      const citedText = (c as { cited_text: string }).cited_text;
      const hit = hits[docIndex];
      return {
        citedText,
        bookmarkId: hit?.bookmarkId ?? "?",
        author: hit?.author ?? "?",
      };
    });
    segments.push({ text: block.text, citations });
  }

  return {
    segments,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: response.model,
  };
}
