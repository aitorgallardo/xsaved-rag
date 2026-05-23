import OpenAI from "openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIM = 1536;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Copy .env.example to .env.");
  }
  client = new OpenAI({ apiKey });
  return client;
}

export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];

  const response = await getClient().embeddings.create({
    model: EMBEDDING_MODEL,
    input: inputs,
  });

  return response.data
    .sort((a, b) => a.index - b.index)
    .map((row) => row.embedding);
}

export async function embedOne(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  return vector;
}
