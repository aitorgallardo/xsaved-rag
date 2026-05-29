import Anthropic from "@anthropic-ai/sdk";
import type { SearchHit } from "../types.js";

export const DEFAULT_JUDGE_MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 512;

const JUDGE_SYSTEM = `
You are a strict evaluator of RAG-generated answers.

You will see three things:
1. A user QUESTION.
2. The BOOKMARK CHUNKS the retrieval system found.
3. The ANSWER an AI generated using those chunks.

Score the answer on three dimensions, each 1-10:

- faithfulness: Every claim in the answer is supported by the bookmarks.
  10 = no hallucinations, every claim is in the chunks
  5  = some claims are stretched or inferred beyond what the chunks say
  1  = significant hallucination or invented information

- completeness: The answer covers what was asked, given what the chunks contain.
  10 = captures every relevant point from the chunks
  5  = misses some relevant chunks or partial coverage
  1  = barely addresses the question or ignores most relevant chunks

- conciseness: The answer is appropriately brief without padding.
  10 = tight, no fluff, easy to scan
  5  = some redundancy or unnecessary verbosity
  1  = bloated, hard to extract the actual answer

Also return:
- overall: "pass" if you would ship this answer, "fail" if not. Be strict — any
  meaningful hallucination is an automatic fail regardless of other scores.
- issues: 1-2 sentences naming the biggest weakness (or empty if none).

Return ONLY a single JSON object with this exact shape and no surrounding prose:
{"faithfulness": N, "completeness": N, "conciseness": N, "overall": "pass"|"fail", "issues": "..."}
`.trim();

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.");
  client = new Anthropic({ apiKey });
  return client;
}

export interface JudgeScores {
  faithfulness: number;
  completeness: number;
  conciseness: number;
  overall: "pass" | "fail";
  issues: string;
}

export interface JudgeResult {
  scores: JudgeScores;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

function formatChunks(hits: SearchHit[]): string {
  return hits
    .map((h, i) => {
      const lines = [`[${i + 1}] @${h.author} (${h.bookmarkId})`];
      if (h.tags.length > 0) lines.push(`    Tags: ${h.tags.join(", ")}`);
      if (h.notes) lines.push(`    Notes: ${h.notes}`);
      lines.push(`    Tweet: ${h.text}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export async function judge(
  question: string,
  hits: SearchHit[],
  answer: string,
  model: string = DEFAULT_JUDGE_MODEL
): Promise<JudgeResult> {
  const userMessage =
    `QUESTION:\n${question}\n\n` +
    `BOOKMARK CHUNKS:\n${formatChunks(hits)}\n\n` +
    `ANSWER:\n${answer}\n\n` +
    `Score this answer.`;

  const response = await getClient().messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
  });

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  // Strip optional markdown fence, then extract the first {...} JSON object.
  const stripped = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Judge returned no JSON object: ${raw.slice(0, 200)}`);
  const scores = JSON.parse(match[0]) as JudgeScores;

  return {
    scores,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: response.model,
  };
}
