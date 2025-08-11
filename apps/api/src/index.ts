import Fastify from 'fastify';
import dotenv from 'dotenv';
import { Client } from 'pg';
import { runAgent } from 'agent/src/index';
import { answerFaq } from 'rag/src/rag';
import { runGraph } from 'agent/src/graph';
import formbody from '@fastify/formbody';
import Twilio from 'twilio';

dotenv.config();

const fastify = Fastify({ logger: true });
await fastify.register(formbody);

function verifyTwilio(req: any) {
  const signature = req.headers['x-twilio-signature'];
  const url = (process.env.PUBLIC_BASE_URL || '') + req.raw.url; // absolute URL Twilio hits
  const valid = Twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN || '',
    signature,
    url,
    req.body || {},
  );
  if (!valid) throw new Error('Invalid Twilio signature');
}

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
      // Trim heavy text, keep provenance
      const brief = (res.retrieved || []).slice(0, 5).map((r: any) => ({
        score: r.score,
        source: r.source,
        chunk: r.chunk,
      }));
      req.log.info(
        { event: 'rag_retrieved', query, brief },
        'retrieval_context',
      );
      return reply.code(200).send(res);
    } catch (err: any) {
      req.log.error({ err }, 'faq_error');
      return reply
        .code(500)
        .send({ ok: false, error: err?.message || 'FAQ failed' });
    }
  });

  fastify.post('/graph/run', async (req, reply) => {
    const body: any = req.body || {};
    const query = String(body.query || '');
    const threadId = String(body.threadId || 'local-thread');
    if (!query) return reply.code(400).send({ error: 'query is required' });
    try {
      const res = await runGraph(query, threadId);
      return {
        ok: true,
        threadId,
        intent: res.intent,
        answer: res.answer,
        citations: res.citations,
        confidence: res.confidence,
      };
    } catch (err: any) {
      req.log.error({ err }, 'graph_error');
      return reply
        .code(500)
        .send({ ok: false, error: err?.message || 'Graph failed' });
    }
  });

  // 1) Answer the call and start a speech Gather
  fastify.post('/twilio/voice', async (req, reply) => {
    // verifyTwilio(req); // enable once PUBLIC_BASE_URL is correct
    const vr = new Twilio.twiml.VoiceResponse();
    const gather = vr.gather({
      input: 'speech',
      speechTimeout: 'auto', // end of utterance detection
      language: 'en-US', // change if needed
      action: '/twilio/handle-speech', // relative to PUBLIC_BASE_URL
      method: 'POST',
    });
    gather.say({ voice: 'Polly.Amy' }, 'Hello. How can I help you today?');
    vr.redirect('/twilio/voice'); // if nothing heard, prompt again
    reply.header('Content-Type', 'text/xml');
    return reply.send(vr.toString());
  });

  // 2) Handle the speech result -> run graph -> reply to caller
  fastify.post('/twilio/handle-speech', async (req, reply) => {
    // verifyTwilio(req);
    const vr = new Twilio.twiml.VoiceResponse();
    const body: any = req.body || {};
    const callSid = String(body.CallSid || 'local-call');
    const transcript = String(body.SpeechResult || '').trim();

    if (!transcript) {
      vr.say(
        { voice: 'Polly.Amy' },
        'I did not catch that. Please say it again.',
      );
      vr.redirect('/twilio/voice');
      reply.header('Content-Type', 'text/xml');
      return reply.send(vr.toString());
    }

    try {
      const { runGraph } = await import('../../agent/src/graph');
      const res = await runGraph(transcript, callSid);

      // Respond with the agent answer
      const answer = res?.answer || 'Sorry, I could not find that information.';
      vr.say({ voice: 'Polly.Amy' }, answer);

      // Loop for another turn
      vr.redirect('/twilio/voice');
      reply.header('Content-Type', 'text/xml');
      return reply.send(vr.toString());
    } catch (err) {
      req.log.error({ err }, 'twilio_handle_error');
      vr.say({ voice: 'Polly.Amy' }, 'Sorry, something went wrong. Goodbye.');
      reply.header('Content-Type', 'text/xml');
      return reply.send(vr.toString());
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
