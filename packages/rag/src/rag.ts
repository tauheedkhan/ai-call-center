import 'dotenv/config';
import { Pool } from 'pg';
import { z } from 'zod';
import { OpenAIEmbeddings, ChatOpenAI } from '@langchain/openai';
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';

const AnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(
    z.object({
      source: z.string(),
      // Required in schema for structured output, but allow null when unknown
      chunk: z.number().nullable(),
    }),
  ),
  confidence: z.number().min(0).max(1),
});

// Maintain a shared pool for the process lifetime to avoid closing the
// connection between requests, which can delay HTTP replies in finally{}.
let sharedPool: Pool | null = null;

export async function createStore() {
  if (!sharedPool) {
    sharedPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  const embeddings = new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  });
  const tableName = process.env.TABLE_NAME || 'docs';
  const store = await PGVectorStore.initialize(embeddings, {
    pool: sharedPool,
    tableName,
  });
  return { store, pool: sharedPool };
}

export async function answerFaq(query: string) {
  console.log('answerFaq', query);
  const { store } = await createStore();
  // Get documents + scores for observability
  const TOP_K = Number(process.env.TOP_K || 5);
  const results = await store.similaritySearchWithScore(query, TOP_K);
  console.log('results', results);
  const contexts = results.map(([doc, score], idx) => ({
    idx,
    score,
    source: String(doc.metadata?.source || ''),
    chunk: doc.metadata?.chunk == null ? null : Number(doc.metadata?.chunk),
    text: doc.pageContent,
  }));

  const contextText = contexts
    .map(
      (c, i) =>
        `# Doc ${i + 1} | score=${c.score.toFixed(4)} | ${c.source}#${c.chunk}\n${c.text}`,
    )
    .join('\n\n');

  const prompt =
    `You are a helpful call-center knowledge assistant. Use ONLY the context to answer.\n\n` +
    `QUESTION: ${query}\n\n` +
    `CONTEXT:\n${contextText}\n\n` +
    `Return ONLY valid JSON (no markdown, no code fences) with keys: answer (string), citations (array of {source, chunk}), confidence (0..1).`;
  console.log('prompt', prompt);
  const model = new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0,
  });
  const structuredModel = (model as any).withStructuredOutput?.(AnswerSchema, {
    name: 'faq_answer',
    strict: true,
  });

  let data: z.infer<typeof AnswerSchema>;
  if (structuredModel) {
    data = await structuredModel.invoke(prompt);
  } else {
    // Fallback: try parsing content and extract JSON if wrapped in markdown
    const raw = await model.invoke(prompt);
    const content = String((raw as any).content ?? '');
    const fenced =
      content.match(/```json\s*([\s\S]*?)```/i) ||
      content.match(/```\s*([\s\S]*?)```/i);
    const jsonCandidate = fenced ? fenced[1] : content;
    let parsed: any;
    try {
      parsed = JSON.parse(jsonCandidate);
    } catch {
      // As a last resort, synthesize a minimal, clean answer from the top context
      parsed = {
        answer: contexts[0]?.text?.split('\n')[0]?.trim() || 'I do not know.',
        citations: contexts
          .slice(0, 3)
          .map((c) => ({ source: c.source, chunk: c.chunk })),
        confidence: 0.4,
      };
    }
    data = AnswerSchema.parse(parsed);
  }
  console.log('data', data);
  return {
    ok: true,
    query,
    answer: data.answer,
    citations: data.citations,
    confidence: data.confidence,
    retrieved: contexts, // for observability
  };
}
