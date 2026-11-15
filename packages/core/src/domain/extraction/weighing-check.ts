import type { Tracer } from '@opentelemetry/api';
import { z } from 'zod';

import type { LLM } from '../dip/llm.js';
import { emitEvent } from '../memory-event.js';
import type { Message } from '../message.js';

/**
 * A second look at a message the extractor returned nothing for: is the person weighing a
 * lasting decision?
 *
 * The extraction prompt tells the model that a hypothetical or a suggestion must not become a
 * durable preference, and the model applies that to every undecided statement: "I might take a
 * sabbatical from work, but I'm really unsure." came back empty in about half of the writes
 * (#306). A line added to that prompt stored the plan and also began to store small undecided
 * choices about the moment, so the check is a call of its own, with one narrow question, made
 * only when extraction is empty. What it finds is stored as undecided, never as a decision.
 */
export const WEIGHING_CHECK_PROMPT = [
  'You read one message that a person sent to an assistant and say whether the person is',
  'considering, or has not yet decided, a lasting matter in their own life: where to live, work or',
  'study, a purchase that lasts, a relationship, a commitment.',
  'A small choice about the present moment or about today does not count. Neither does a thought',
  'about the world in general, nor a question or request to the assistant.',
  'Reply with JSON: {"weighing": [{"about": "<what the person is weighing, as a short phrase in the',
  'language of the message that begins with the verb and has no subject, such as: is thinking of',
  'changing jobs, está pensando em mudar de cidade>", "quote": "<the exact words of the message',
  'that say it>"}]}. When the message says no such thing, reply {"weighing": []}.',
].join(' ');

const ResponseSchema = z.object({
  weighing: z.array(z.object({ about: z.string().trim().min(1), quote: z.string().trim().min(1) })),
});

/** Messages of a write the check reads, newest first. */
const MESSAGES_READ = 3;

export interface WeighedMatter {
  readonly id: string;
  readonly text: string;
  readonly evidence: { readonly kind: 'stated'; readonly durability: 'tentative'; readonly sourceQuote: string };
}

function plain(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

async function weighedIn(llm: LLM, message: Message): Promise<readonly { about: string; quote: string }[]> {
  const raw = await llm.generateResponse(
    [
      { role: 'system', content: WEIGHING_CHECK_PROMPT },
      { role: 'user', content: message.content },
    ],
    { type: 'json' },
  );
  const parsed = ResponseSchema.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
  const said = plain(message.content);
  return parsed.weighing.filter((matter) => said.includes(plain(matter.quote)));
}

/**
 * Asks, for each of the latest messages written by a user, whether its author is weighing a
 * lasting decision. An answer is kept only when its quote is found in the message. A failed or
 * malformed call recovers nothing and is counted in `extraction_weighing_check_failed`; it never
 * fails the write.
 */
export async function recoverWeighedMatters(llm: LLM, messages: readonly Message[], tracer: Tracer | undefined): Promise<readonly WeighedMatter[]> {
  const latest = messages.filter((message) => message.role === 'user').slice(-MESSAGES_READ);
  const answers = await Promise.all(latest.map(async (message) => {
    try {
      return await weighedIn(llm, message);
    } catch (error) {
      emitEvent(tracer, 'extraction_weighing_check_failed', { error: error instanceof Error ? error.name : 'UnknownError' });
      return [];
    }
  }));
  const recovered: WeighedMatter[] = answers.flat().map((matter, index) => ({
    id: String(index + 1),
    // The subject is written here, so it is the speaker token in every language.
    text: `user ${matter.about}`,
    evidence: { kind: 'stated', durability: 'tentative', sourceQuote: matter.quote },
  }));
  if (recovered.length > 0) emitEvent(tracer, 'extraction_weighing_check_recovered', { facts: recovered.length });
  return recovered;
}
