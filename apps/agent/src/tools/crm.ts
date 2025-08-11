import { z } from 'zod';

export const crmLookupSchema = z.object({
  customerId: z.string().min(1),
});

// Very simple mock; replace with real HTTP later
const MOCK_DB: Record<string, any> = {
  '1001': {
    id: '1001',
    name: 'Aisha Al-Saud',
    tier: 'Gold',
    email: 'aisha@example.com',
    balance: 1250.75,
  },
  '1002': {
    id: '1002',
    name: 'Omar Al-Faisal',
    tier: 'Silver',
    email: 'omar@example.com',
    balance: -20.1,
  },
};

export async function crmLookup(input: z.infer<typeof crmLookupSchema>) {
  const rec = MOCK_DB[input.customerId];
  if (!rec) return { found: false };
  return { found: true, customer: rec };
}
