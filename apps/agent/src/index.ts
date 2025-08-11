import 'dotenv/config';
import { z } from 'zod';
import pino from 'pino';
import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from 'langchain/tools';
import { initializeAgentExecutorWithOptions } from 'langchain/agents';
import { crmLookup, crmLookupSchema } from './tools/crm';
import { ticketCreate, ticketCreateSchema } from './tools/ticket';
import { emailSend, emailSendSchema } from './tools/email';
import { webSearch, searchSchema } from './tools/search';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

function structuredToolFromZod<T extends z.ZodTypeAny>(
  name: string,
  description: string,
  schema: T,
  func: (input: z.infer<T>) => Promise<any>,
) {
  return new DynamicStructuredTool({
    name,
    description,
    schema: schema as any,
    func: async (input) => {
      const res = await func(schema.parse(input));
      return JSON.stringify(res);
    },
  });
}

export async function createAgent() {
  const model = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
  });

  const tools = [
    structuredToolFromZod(
      'crm_lookup',
      'Lookup a customer by customerId',
      crmLookupSchema,
      crmLookup,
    ),
    structuredToolFromZod(
      'ticket_create',
      'Create a support ticket',
      ticketCreateSchema,
      ticketCreate,
    ),
    structuredToolFromZod(
      'email_send',
      'Send an email to a customer',
      emailSendSchema,
      emailSend,
    ),
    structuredToolFromZod(
      'web_search',
      'Search the web for quick info',
      searchSchema,
      webSearch,
    ),
  ];

  const executor = await initializeAgentExecutorWithOptions(tools, model, {
    agentType: 'openai-functions',
    returnIntermediateSteps: true,
    maxIterations: 4,
  });

  return executor;
}

export type AgentInput = {
  sessionId: string; // used later for memory persistence
  query: string;
};

export async function runAgent(input: AgentInput) {
  const agent = await createAgent();
  const res = await agent.call({ input: input.query });
  log.info(
    { sessionId: input.sessionId, steps: res.intermediateSteps },
    'agent_steps',
  );
  return {
    output: res.output as string,
    steps:
      res.intermediateSteps?.map((s: any) => ({
        tool: s.action.tool,
        toolInput: s.action.toolInput,
        observation: s.observation,
      })) ?? [],
  };
}
