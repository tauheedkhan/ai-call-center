import { z } from 'zod';
import { randomUUID } from 'crypto';

export const ticketCreateSchema = z.object({
  customerId: z.string().min(1),
  subject: z.string().min(3),
  description: z.string().min(3),
  priority: z.enum(['low', 'medium', 'high']).default('low'),
});

export async function ticketCreate(input: z.infer<typeof ticketCreateSchema>) {
  return { id: randomUUID(), ...input, status: 'open' as const };
}
