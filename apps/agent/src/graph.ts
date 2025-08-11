import 'dotenv/config';
import { z } from 'zod';
import pino from 'pino';
import { ChatOpenAI } from '@langchain/openai';
import {
  StateGraph,
  START,
  END,
  Annotation,
  MemorySaver,
} from '@langchain/langgraph';
// Reuse your Phase‑1 tools
import { crmLookup, crmLookupSchema } from './tools/crm';
import { ticketCreate, ticketCreateSchema } from './tools/ticket';
// Reuse your Phase‑2 RAG answerer
import { answerFaq } from 'rag/src/rag';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// ----------
// State shape
// ----------
const State = Annotation.Root({
  query: Annotation<string>(),
  intent: Annotation<string | null>({ default: null }),
  answer: Annotation<string | null>({ default: null }),
  confidence: Annotation<number | null>({ default: null }),
  citations: Annotation<Array<{ source: string; chunk?: number }>>({
    default: [],
  }),
  customerId: Annotation<string | null>({ default: null }),
});

// ----------
// Models
// ----------
function classifierModel() {
  return new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_CLASSIFIER || 'gpt-4o-mini',
    temperature: 0,
  });
}

function generalModel() {
  return new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
  });
}

// ----------
// Nodes
// ----------
async function ingest_input(state: any) {
  const query = String(state.query || '').trim();
  if (!query) throw new Error('Empty query');
  return { query };
}

// Classify into intents: faq | account | billing | handoff
async function classify_intent(state: any) {
  const model = classifierModel();
  const prompt =
    `Classify the USER QUERY into one of: faq, account, billing, handoff.\n` +
    `- faq: general question answerable by knowledge base\n` +
    `- account: look up customer or account details\n` +
    `- billing: refunds, payments, disputes, invoices\n` +
    `- handoff: unclear or needs human\n` +
    `Return ONLY the label.\n` +
    `USER QUERY: ${state.query}`;
  const res = await model.invoke(prompt);
  const label = String(res.content || '')
    .toLowerCase()
    .trim();
  const intent = ['faq', 'account', 'billing', 'handoff'].includes(label)
    ? label
    : 'faq';
  return { intent };
}

// FAQ via RAG
async function faq_agent(state: any) {
  const rag = await answerFaq(state.query);
  return {
    answer: rag.answer,
    confidence: rag.confidence,
    citations: rag.citations,
  };
}

// Very simple Account agent: extract ID then lookup
async function account_agent(state: any) {
  const m =
    state.query.match(/(customer|account)\s*#?\s*(\d{3,})/i) ||
    state.query.match(/\b(\d{4,})\b/);
  const customerId = m ? m[2] || m[1] : null;
  if (!customerId) {
    return {
      answer: 'Please provide a customer ID to proceed with account lookup.',
      confidence: 0.4,
    };
  }
  const res = await crmLookup(crmLookupSchema.parse({ customerId }));
  if (!res.found) {
    return { answer: `Customer ${customerId} was not found.`, confidence: 0.6 };
  }
  const c = res.customer;
  const ans = `Customer ${c.id}: ${c.name} (tier: ${c.tier}). Current balance: ${c.balance}.`;
  return { customerId, answer: ans, confidence: 0.9 };
}

// Simple Billing agent: open a ticket when refund/dispute mentioned
async function billing_agent(state: any) {
  const wantsRefund = /refund|chargeback|dispute|return/i.test(state.query);
  if (!wantsRefund) {
    return {
      answer:
        'For billing, please describe your issue (refund, invoice, dispute).',
      confidence: 0.5,
    };
  }
  const customerId =
    (state.customerId as string) ||
    (state.query.match(/\b(\d{4,})\b/)?.[0] ?? 'unknown');
  const ticket = await ticketCreate(
    ticketCreateSchema.parse({
      customerId,
      subject: 'Refund request',
      description: `Caller requested refund. Query: ${state.query}`,
      priority: 'medium',
    }),
  );
  const ans = `I opened ticket ${ticket.id} for your refund request. You will get updates via email within 24 hours.`;
  return { customerId, answer: ans, confidence: 0.85 };
}

// Summarize into a friendly final message (optionally include citations)
async function summarize(state: any) {
  const model = generalModel();
  const citeText = (state.citations || [])
    .map(
      (c: any) =>
        `${c.source}${typeof c.chunk === 'number' ? '#' + c.chunk : ''}`,
    )
    .slice(0, 3)
    .join(', ');
  const prompt =
    `You are a concise call-center assistant.\n` +
    `Base your final reply on this DRAFT ANSWER: ${state.answer || ''}\n` +
    `${citeText ? 'CITATIONS: ' + citeText : ''}\n` +
    `Reply clearly and helpfully.`;
  const res = await model.invoke(prompt);
  return { answer: String(res.content || state.answer || '') };
}

// Pass-through responder (split for clarity; could be END directly)
async function respond(state: any) {
  return state;
}

// ----------
// Graph assembly
// ----------
export function compileGraph() {
  const graph = new StateGraph(State)
    .addNode('ingest_input', ingest_input)
    .addNode('classify_intent', classify_intent)
    .addNode('faq_agent', faq_agent)
    .addNode('account_agent', account_agent)
    .addNode('billing_agent', billing_agent)
    .addNode('summarize', summarize)
    .addNode('respond', respond)
    .addEdge(START, 'ingest_input')
    .addEdge('ingest_input', 'classify_intent')
    .addConditionalEdges('classify_intent', (state: any) => state.intent, {
      faq: 'faq_agent',
      account: 'account_agent',
      billing: 'billing_agent',
      handoff: 'summarize', // could be a human_review node later
    })
    .addEdge('faq_agent', 'summarize')
    .addEdge('account_agent', 'summarize')
    .addEdge('billing_agent', 'summarize')
    .addEdge('summarize', 'respond')
    .addEdge('respond', END);

  const checkpointer = new MemorySaver();
  const app = graph.compile({ checkpointer });
  return app;
}

let _app: any;
export function ensureGraph() {
  if (!_app) _app = compileGraph();
  return _app;
}

export async function runGraph(query: string, threadId: string) {
  const app = ensureGraph();
  const res = await app.invoke(
    { query },
    { configurable: { thread_id: threadId } },
  );
  log.info(
    { threadId, intent: res.intent, confidence: res.confidence },
    'graph_result',
  );
  return res;
}
