import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 2048;

const SYSTEM_PROMPT = `
You are a research assistant for the user's personal Twitter/X bookmark collection.

You will receive a question and a set of bookmarks the retrieval system thinks are
relevant. Your job is to answer the question using ONLY those bookmarks.

Rules:
- Cite specific bookmarks inline using the format [bookmark_id:ID], where ID is the
  bookmark's exact id from the input. Cite every claim that comes from a bookmark.
- If the provided bookmarks do not contain enough information to answer, say so plainly.
  Do not speculate or invent facts.
- Be concise. Synthesise across multiple bookmarks when they make a coherent point.
- Prefer paraphrase over quotation. Quote only when wording matters.
- Do not introduce any information not present in the bookmarks.
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

export interface GenerationResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export async function generate(
  question: string,
  chunksFormatted: string,
  model: string = DEFAULT_MODEL
): Promise<GenerationResult> {
  const userMessage = `Question: ${question}\n\nRelevant bookmarks:\n\n${chunksFormatted}`;

  const response = await getClient().messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((b) => b.text)
    .join("\n");

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: response.model,
  };
}
