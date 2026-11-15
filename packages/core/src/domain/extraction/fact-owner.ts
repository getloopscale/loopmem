/**
 * Whose fact a note is (#252).
 *
 * The update judge is asked whether a later note makes an earlier one no longer true, and asked
 * that way it also says yes to the same kind of fact about someone else: "my sister's dentist is
 * Dr. A", then "my dentist is Dr. B". Here each note is read on its own, with no second note and
 * no question about change, and split into value, attribute and owner. Naming the value first
 * keeps a manager or a doctor from being taken for the owner. The caller compares the two owners
 * in code. On its own this reading takes a named mechanic or doctor at the start of a note for
 * the owner, so it only counts together with a second signal (`name-difference.ts`).
 *
 * No owner is returned when the call fails or the answer is unusable.
 */
import type { Tracer } from '@opentelemetry/api';
import { z } from 'zod';

import type { LLM } from '../dip/llm.js';
import { emitEvent } from '../memory-event.js';

/** System prompt of the owner call. It names no case and sees one note. */
export const FACT_OWNER_PROMPT = [
  'You read one note kept in a person\'s memory. The person who keeps the memory is called "user". Split the fact the note gives into three parts.',
  'Answer JSON only, with these fields in this order:',
  '- "value": the piece of information the note gives, such as a city, a company, a model, a date, or the name of the manager, doctor or relative it names.',
  '- "attribute": what that value is, in a few words, such as "home city", "employer", "manager", "phone", "pet".',
  '- "owner": the individual the attribute belongs to: the one who lives in the city, works for the company, has that manager, owns that phone. Write "user" when it is user, and otherwise that individual\'s name as written in the note. A note saying that user stated, recorded or corrected something about someone else belongs to that someone. The owner is never the value.',
].join('\n');

const answerSchema = z.object({ owner: z.string().trim().min(1) });

/** How many times the model is asked before the note is left with no owner. */
const ATTEMPTS = 2;

async function attempt(llm: LLM, text: string): Promise<{ readonly owner: string } | { readonly failure: Record<string, string> }> {
  let raw: unknown;
  try {
    raw = await llm.generateResponse(
      [
        { role: 'system', content: FACT_OWNER_PROMPT },
        { role: 'user', content: `Note: ${text}` },
      ],
      { type: 'json' },
    );
  } catch (error) {
    return { failure: { reason: 'llm_error', error_type: error instanceof Error ? error.name : 'unknown' } };
  }
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { failure: { reason: 'malformed_answer' } };
    }
  }
  const parsed = answerSchema.safeParse(value);
  return parsed.success ? { owner: parsed.data.owner } : { failure: { reason: 'malformed_answer' } };
}

/** The individual the fact of one note belongs to, as the model names them; null when it could not be read. */
export async function ownerOf(llm: LLM, text: string, tracer: Tracer | undefined): Promise<string | null> {
  let last: Record<string, string> = { reason: 'malformed_answer' };
  for (let tries = 0; tries < ATTEMPTS; tries += 1) {
    const result = await attempt(llm, text);
    if ('owner' in result) return result.owner;
    last = result.failure;
  }
  emitEvent(tracer, 'fact_owner_failed', last);
  return null;
}

const USER_WORDS = new Set(['user', 'usuario', 'usuaria', 'utilisateur', 'benutzer', 'utente']);
const ARTICLES = new Set(['the', 'o', 'a', 'el', 'la', 'le', 'il', 'der', 'die']);

function tokens(owner: string): string[] {
  return owner
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !ARTICLES.has(token));
}

const isUser = (owner: readonly string[]): boolean => owner.length === 1 && USER_WORDS.has(owner[0] as string);

/**
 * Whether two owners, as the model wrote them, are one individual. The user is only the user.
 * Anyone else is compared by the last word of the name, so "user's sister Ana" and "Ana" match,
 * and "user's sister" and "user's brother" do not.
 */
export function sameOwner(first: string, second: string): boolean {
  const a = tokens(first);
  const b = tokens(second);
  if (a.length === 0 || b.length === 0) return false;
  if (isUser(a) || isUser(b)) return isUser(a) && isUser(b);
  return a[a.length - 1] === b[b.length - 1];
}
