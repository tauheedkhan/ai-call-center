import 'dotenv/config';
import { Pool } from 'pg';
import { z } from 'zod';
import { OpenAIEmbeddings, ChatOpenAI } from '@langchain/openai';
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector';
import { RunnableLambda } from 'langchain/schema/runnable';

const AnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(
    z.object({ source: z.string(), chunk: z.number().optional() }),
  ),
  confidence: z.number().min(0).max(1),
});

export async function createStore() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const embeddings = new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  });
  const tableName = process.env.TABLE_NAME || 'docs';
  const store = await PGVectorStore.initialize(embeddings, { pool, tableName });
  return { store, pool };
}

export async function answerFaq(query: string) {
  console.log('answerFaq', query);
  const { store, pool } = await createStore();
  try {
    // Get documents + scores for observability
    const TOP_K = Number(process.env.TOP_K || 5);
    const results = await store.similaritySearchWithScore(query, TOP_K);
    console.log('results', results);
    const contexts = results.map(([doc, score], idx) => ({
      idx,
      score,
      source: String(doc.metadata?.source || ''),
      chunk: Number(doc.metadata?.chunk ?? -1),
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
      `Return strict JSON with keys: answer (string), citations (array of {source, chunk}), confidence (0..1).`;
    console.log('prompt', prompt);
    const model = new ChatOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0,
    });
    console.log('model', model);
    const raw = await model.invoke(prompt);
    console.log('raw', raw);
    let parsed: any;
    try {
      parsed = JSON.parse(raw.content as string);
    } catch {
      // If not valid JSON, wrap as best effort
      parsed = {
        answer: String(raw.content),
        citations: contexts
          .slice(0, 3)
          .map((c) => ({ source: c.source, chunk: c.chunk })),
        confidence: 0.5,
      };
    }
    const data = AnswerSchema.parse(parsed);
    console.log('data', data);
    return {
      ok: true,
      query,
      answer: data.answer,
      citations: data.citations,
      confidence: data.confidence,
      retrieved: contexts, // for observability
    };
  } finally {
    await pool.end();
  }
}
