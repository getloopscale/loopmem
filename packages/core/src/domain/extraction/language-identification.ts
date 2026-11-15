/**
 * Identifies the language of the input messages before extraction (#254). Both a
 * character-statistics detector and the model itself name the language of a short sentence
 * from its proper names: "Mihaela's nephew Sorin is a pilot." comes back as Romanian. The text
 * is therefore masked first, every word that starts with a capital letter becoming `X` and
 * every word with a digit becoming `N`, so only the common words are left to decide. A
 * lower-case name particle between two names ("Eça de Queirós", "van der Velde") is dropped
 * too: left in, "X reads X de X." was named Spanish. The model then names the language of
 * the masked text.
 */
import { z } from 'zod';

import type { LLM } from '../dip/llm.js';

import { languageFromCode, type DetectedLanguage } from './language.js';

/** Why an identification produced no language. */
export type LanguageIdentificationFailure = 'unsupported_language' | 'malformed_answer' | 'llm_error';

export type LanguageIdentification =
  | { readonly ok: true; readonly language: DetectedLanguage }
  | { readonly ok: false; readonly reason: LanguageIdentificationFailure; readonly code?: string; readonly error?: string };

const answerSchema = z.object({ language: z.string().min(1) });

/** System prompt of the identification call. */
export const LANGUAGE_IDENTIFICATION_PROMPT =
  'Name the language this text is written in, from its words. Answer JSON {"language": "<ISO 639-1>"}.';

const CAPITALISED = /^[("'“‘]?\p{Lu}/u;
const POSSESSIVE = /['’]s[.,!?;:]*$/u;
const TRAILING_PUNCTUATION = /[.,!?;:]+$/u;

/** Lower-case particles that join the parts of a proper name. */
const NAME_PARTICLES: ReadonlySet<string> = new Set(['de', 'da', 'do', 'dos', 'das', 'del', 'della', 'di', 'du', 'van', 'von', 'der', 'den', 'ter', 'la', 'le', 'al', 'bin', 'ibn']);

/**
 * Replace each whitespace-separated word that contains a digit with `N`, and each word that
 * starts with a capital letter (after an opening quote or parenthesis) with `X`, keeping a
 * possessive `'s` and trailing punctuation. A run of name particles between two capitalised words
 * is dropped.
 */
export function maskNamesAndNumbers(text: string): string {
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  const isParticle = (i: number): boolean => NAME_PARTICLES.has(words[i] ?? '');
  // A run of particles ("van der", "de la") joins names when the words on both sides of the run are capitalised.
  const joinsNames = (i: number): boolean => {
    let before = i - 1;
    while (before >= 0 && isParticle(before)) before -= 1;
    let after = i + 1;
    while (after < words.length && isParticle(after)) after += 1;
    return before >= 0 && after < words.length && CAPITALISED.test(words[before]!) && CAPITALISED.test(words[after]!);
  };
  const masked: string[] = [];
  words.forEach((word, i) => {
    if (/\d/u.test(word)) {
      masked.push('N');
    } else if (CAPITALISED.test(word)) {
      masked.push(`X${word.match(POSSESSIVE)?.[0] ?? word.match(TRAILING_PUNCTUATION)?.[0] ?? ''}`);
    } else if (!(isParticle(i) && joinsNames(i))) {
      masked.push(word);
    }
  });
  return masked.join(' ');
}

function parseAnswer(raw: unknown): string | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = answerSchema.safeParse(value);
  return parsed.success ? parsed.data.language.trim().toLowerCase() : null;
}

/** System prompt of the call that says whether the opening word is a person's name. */
export const FIRST_WORD_NAME_PROMPT = 'Is the word a given name of a person? Answer JSON {"name": true|false}.';

const nameAnswerSchema = z.object({ name: z.boolean() });
const OPENING_QUOTE = /^[("'“‘]/u;

/**
 * The first word of the text when only its position explains its capital: no digit, no
 * possessive, no capitalised word right after it (name particles skipped) and no second
 * occurrence. Null when there is no such word.
 */
export function openingWord(text: string): string | null {
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  const first = words[0];
  if (first === undefined || !CAPITALISED.test(first) || /\d/u.test(first) || POSSESSIVE.test(first)) return null;
  const bare = (word: string): string => word.replace(TRAILING_PUNCTUATION, '').replace(/['’]s$/u, '').replace(OPENING_QUOTE, '');
  let after = 1;
  while (after < words.length && NAME_PARTICLES.has(words[after] as string)) after += 1;
  const next = words[after];
  if (next !== undefined && CAPITALISED.test(next) && !/\d/u.test(next) && !TRAILING_PUNCTUATION.test(first)) return null;
  if (words.some((other, index) => index > 0 && bare(other) === bare(first))) return null;
  return bare(first);
}

/** The masked text with the opening word left in, in lower case. */
function maskKeepingOpeningWord(text: string, word: string): string {
  const start = text.indexOf(word);
  const rest = text.slice(start + word.length);
  const maskedRest = maskNamesAndNumbers(rest);
  const gap = /^\s/u.test(rest) && maskedRest.length > 0 ? ' ' : '';
  return `${text.slice(0, start)}${word.toLowerCase()}${gap}${maskedRest}`;
}

/** True, false, or null when the call fails or the answer is unusable. */
async function isGivenName(llm: LLM, word: string): Promise<boolean | null> {
  let raw: unknown;
  try {
    raw = await llm.generateResponse(
      [
        { role: 'system', content: FIRST_WORD_NAME_PROMPT },
        { role: 'user', content: word },
      ],
      { type: 'json' },
    );
  } catch {
    return null;
  }
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = nameAnswerSchema.safeParse(value);
  return parsed.success ? parsed.data.name : null;
}

/**
 * Identify the language of `text`. Never throws; a failure is returned with its reason.
 *
 * The first word of a sentence has a capital whatever it is, so the mask hides it, and in a short
 * first-person message it is often the one word that tells two close languages apart: "Não como
 * carne desde 2019." masked is "X como carne desde N", which reads as Spanish (#302). When the
 * text opens with such a word, three calls run together: whether the word is a person's name, the
 * language of the fully masked text, and the language of the text with the word left in. A name,
 * or no usable answer about it, keeps the fully masked reading.
 */
export async function identifyInputLanguage(llm: LLM, text: string): Promise<LanguageIdentification> {
  const word = openingWord(text);
  if (word === null) return identifyMasked(llm, maskNamesAndNumbers(text));
  const [isName, masked, kept] = await Promise.all([
    isGivenName(llm, word),
    identifyMasked(llm, maskNamesAndNumbers(text)),
    identifyMasked(llm, maskKeepingOpeningWord(text, word)),
  ]);
  return isName === false && kept.ok ? kept : masked;
}

async function identifyMasked(llm: LLM, masked: string): Promise<LanguageIdentification> {
  let raw: unknown;
  try {
    raw = await llm.generateResponse(
      [
        { role: 'system', content: LANGUAGE_IDENTIFICATION_PROMPT },
        { role: 'user', content: masked },
      ],
      { type: 'json' },
    );
  } catch (error) {
    return { ok: false, reason: 'llm_error', error: error instanceof Error ? error.name : 'UnknownError' };
  }
  const code = parseAnswer(raw);
  if (code === null) return { ok: false, reason: 'malformed_answer' };
  const language = languageFromCode(code);
  return language === null ? { ok: false, reason: 'unsupported_language', code } : { ok: true, language };
}
