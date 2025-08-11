import Fastify from 'fastify';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { runAgent } from 'agent/src/index';
import { answerFaq } from 'rag/src/rag';

dotenv.config();

const fastify = Fastify({ logger: true });

fastify.get('/health', async () => {
  return { ok: true, ts: new Date().toISOString() };
});

async function connectDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('SELECT 1');
  await client.end();
}

async function start() {
  try {
    await connectDb();
    fastify.log.info('DB connection OK');
  } catch (err) {
    fastify.log.error({ err }, 'DB connection failed');
    process.exit(1);
  }

  fastify.post('/agent/answer', async (req, reply) => {
    const body: any = req.body || {};
    const sessionId = body.sessionId || 'local-dev';
    const query = String(body.query || '');
    if (!query) return reply.code(400).send({ error: 'query is required' });
    try {
      const result = await runAgent({ sessionId, query });
      return { ok: true, ...result };
    } catch (err: any) {
      fastify.log.error({ err }, 'agent_error');
      return reply
        .code(500)
        .send({ ok: false, error: err?.message || 'Agent failed' });
    }
  });

  fastify.post('/agent/faq', async (req, reply) => {
    const body: any = req.body || {};
    const query = String(body.query || '');
    if (!query) return reply.code(400).send({ error: 'query is required' });
    try {
      const res = await answerFaq(query);
      console.log('res', res);
      return reply.code(200).send(res);
    } catch (err: any) {
      req.log.error({ err }, 'faq_error');
      return reply
        .code(500)
        .send({ ok: false, error: err?.message || 'FAQ failed' });
    }
  });

  const port = Number(process.env.PORT || 3000);
  await fastify.listen({ port, host: '0.0.0.0' });
  fastify.log.info(`API listening on :${port}`);
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
