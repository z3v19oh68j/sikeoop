/** Embedding models known to work with each provider's OpenAI-compatible /embeddings endpoint. */
export const EMBEDDING_MODELS: Record<string, string> = {
  openai: "text-embedding-3-small",
  qwen: "text-embedding-v4",
  zhipu: "embedding-3",
  gemini: "gemini-embedding-001",
  ollama: "nomic-embed-text",
  openrouter: "openai/text-embedding-3-small",
};
