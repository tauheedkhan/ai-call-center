import { z } from 'zod';

export const searchSchema = z.object({
  query: z.string().min(2),
});

export async function webSearch(input: z.infer<typeof searchSchema>) {
  // Stub: in Phase 2 we'll use RAG instead
  return {
    results: [
      {
        title: 'Contact Center Hours',
        url: 'https://example.com/hours',
        snippet: 'We are open 9am-9pm KSA time.',
      },
    ],
  };
}
