const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

interface OpenRouterEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

export async function generateEmbedding(input: string): Promise<number[]> {
  const text = input.trim();
  if (!text) throw new Error("Cannot generate embedding for empty input");

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const modelName = process.env.OPENROUTER_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  let response: Response;
  try {
    response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://agents.local",
      },
      body: JSON.stringify({
        model: modelName,
        input: text,
      }),
    });
  } catch (error) {
    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding request failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as OpenRouterEmbeddingResponse;
  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("Embedding response missing vector data");
  }
  return embedding;
}
