import { z } from 'zod';
import { subscriptionSchema } from './push-transport.js';

export const bindingSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  subscription: subscriptionSchema,
  lastTestAt: z.number().optional(),
});
export const stateSchema = z.object({
  bindings: z.array(bindingSchema).max(10_000),
  dispatches: z.record(
    z.string(),
    z.object({ expiresAt: z.number(), attempts: z.number(), retryAt: z.number().nullable() }),
  ),
});
export type State = z.infer<typeof stateSchema>;
export type Binding = z.infer<typeof bindingSchema>;
