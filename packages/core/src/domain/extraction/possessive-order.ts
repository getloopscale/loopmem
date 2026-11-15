/**
 * Puts a Portuguese fact about something of the speaker's back in Portuguese word order (#307).
 *
 * The extraction prompt shows the speaker's things as `user's X`. For a Portuguese message the
 * model often keeps that position and drops the marker: "Meu pai se aposentou em março." is
 * stored as "user pai se aposentou em março". The same write path also produces "O pai de user
 * mora em Campinas", so one relation ends up in two forms, one of them not Portuguese.
 *
 * The repair is grounded in what was said: it acts only when the fact starts with the token and a
 * noun, and the message has that same noun right after a first-person possessive. The article
 * comes from the possessive (meu, minha, meus, minhas). A word of one or two letters is left
 * alone: after a possessive it is usually a verb with the noun left out ("o meu é mais barato").
 */
import type { Tracer } from '@opentelemetry/api';

import { emitEvent } from '../memory-event.js';

const WORD = "[\\p{L}\\p{N}][\\p{L}\\p{N}\\-]*";
const FACT_START = new RegExp(`^user\\s+(${WORD})(?=\\s|[,.;]|$)`, 'u');
// What completes the noun ("provedor de internet", "plano de saúde") stays with it.
const COMPLEMENT = new RegExp(`^\\s+d[eao]s?\\s+(?!user(?![\\p{L}\\p{N}]))\\p{Ll}[\\p{L}\\p{N}\\-]*`, 'u');
const NAME_AFTER = /^\s+(\p{Lu}[\p{L}\-]*(?:\s+\p{Lu}[\p{L}\-]*)*)(?=\s|[,.;]|$)/u;
const ARTICLES: Readonly<Record<string, string>> = { meu: 'O', minha: 'A', meus: 'Os', minhas: 'As' };

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function repaired(text: string, said: string): string {
  const start = FACT_START.exec(text);
  const noun = start?.[1];
  if (start === null || noun === undefined || noun.length < 3) return text;
  const possessive = new RegExp(`(?<![\\p{L}\\p{N}])(meu|minha|meus|minhas)\\s+${escaped(noun)}(?![\\p{L}\\p{N}\\-])`, 'iu').exec(said)?.[1];
  if (possessive === undefined) return text;
  const article = ARTICLES[possessive.toLowerCase()] as string;
  const afterNoun = text.slice(start[0].length);
  const complement = COMPLEMENT.exec(afterNoun)?.[0] ?? '';
  const phrase = `${article} ${noun}${complement} de user`;
  const rest = afterNoun.slice(complement.length);
  const name = NAME_AFTER.exec(rest)?.[1];
  if (name === undefined) return `${phrase}${rest}`;
  const afterName = rest.slice(rest.indexOf(name) + name.length);
  return `${phrase}, ${name}${afterName.startsWith(',') ? '' : ','}${afterName}`;
}

/** `said` is the text of the messages the facts were extracted from. */
export function restorePossessiveOrder<T extends { readonly text: string }>(facts: readonly T[], said: string, tracer: Tracer | undefined): readonly T[] {
  let restored = 0;
  const result = facts.map((fact) => {
    const text = repaired(fact.text, said);
    if (text === fact.text) return fact;
    restored += 1;
    return { ...fact, text };
  });
  if (restored > 0) emitEvent(tracer, 'extraction_possessive_order_restored', { restored });
  return result;
}
