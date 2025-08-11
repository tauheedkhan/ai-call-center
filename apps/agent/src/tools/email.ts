import { z } from 'zod';

export const emailSendSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
});

export async function emailSend(input: z.infer<typeof emailSendSchema>) {
  // Replace with SendGrid, SES, etc.
  return { queued: true, to: input.to };
}
