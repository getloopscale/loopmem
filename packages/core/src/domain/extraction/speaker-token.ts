/**
 * Writes the speaker back as the token `user` when the extractor translated it (#258).
 *
 * The extraction prompt asks for the literal token `user` in every language. For a message in
 * Portuguese, Spanish, French, Italian or German the model sometimes writes the local word
 * instead ("o usuário é intolerante a glúten", "la fille de l'utilisateur"), and in English it
 * sometimes writes "The user" or "User". The speaker's facts then stop sharing one subject: a
 * search for `user` misses them, and so does every rule that looks for the token. A prompt rule
 * did not remove it, so the text is repaired after extraction.
 *
 * A message can be about users of something ("in our app the user can reset the password").
 * The repair therefore runs only when the speaker word found in the fact does not occur in what
 * was said: a word the message never used can only be the model's name for the speaker.
 */
import type { Tracer } from '@opentelemetry/api';

import { emitEvent } from '../memory-event.js';

const L = '\\p{L}\\p{N}_';
const START = `(?<![${L}])`;
const END = `(?![${L}])`;

interface SpeakerForm {
  /** The speaker word of a language, as it may appear in the message. */
  readonly word: RegExp;
  /** Phrases built on the word, most specific first, with what replaces each. */
  readonly phrases: readonly (readonly [RegExp, string])[];
}

function form(word: string, phrases: readonly (readonly [string, string])[]): SpeakerForm {
  return {
    word: new RegExp(`${START}(?:${word})${END}`, 'iu'),
    phrases: [...phrases, ['', 'user'] as const].map(([before, to]) => [new RegExp(`${START}${before}(?:${word})${END}`, 'giu'), to] as const),
  };
}

const APOSTROPHE = "['’]";

const FORMS: readonly SpeakerForm[] = [
  form('usu[áa]ri[oa]', [
    ['(?:do|da|del|de\\s+la)\\s+', 'de user'],
    ['(?:ao|à|al|a\\s+la)\\s+', 'a user'],
    ['(?:o|a|el|la)\\s+', 'user'],
  ]),
  form('utilisateur|utilisatrice', [
    [`de\\s+l${APOSTROPHE}`, 'de user'],
    [`à\\s+l${APOSTROPHE}`, 'à user'],
    [`l${APOSTROPHE}`, 'user'],
  ]),
  form('utente', [
    [`dell${APOSTROPHE}`, 'di user'],
    [`all${APOSTROPHE}`, 'a user'],
    [`l${APOSTROPHE}`, 'user'],
  ]),
  form('benutzers|nutzers', [['des\\s+', 'von user']]),
  form('benutzerin|nutzerin|benutzer|nutzer', [['(?:der|die|den|dem)\\s+', 'user']]),
];

// English already uses the word; only its article and its capital letter differ from the token.
const ENGLISH_WORD = new RegExp(`${START}user${END}`, 'iu');
const ENGLISH_PHRASES: readonly (readonly [RegExp, string])[] = [
  [new RegExp(`${START}the\\s+user${END}`, 'giu'), 'user'],
  [new RegExp(`${START}User${END}`, 'gu'), 'user'],
];

function repaired(text: string, said: string): string {
  let out = text;
  for (const { word, phrases } of FORMS) {
    if (!word.test(out) || word.test(said)) continue;
    for (const [phrase, to] of phrases) out = out.replace(phrase, to);
  }
  if (!ENGLISH_WORD.test(said)) {
    for (const [phrase, to] of ENGLISH_PHRASES) out = out.replace(phrase, to);
  }
  return out;
}

/** `said` is the text of the messages the facts were extracted from. */
export function restoreSpeakerToken<T extends { readonly text: string }>(facts: readonly T[], said: string, tracer: Tracer | undefined): readonly T[] {
  let restored = 0;
  const result = facts.map((fact) => {
    const text = repaired(fact.text, said);
    if (text === fact.text) return fact;
    restored += 1;
    return { ...fact, text };
  });
  if (restored > 0) emitEvent(tracer, 'extraction_speaker_token_restored', { restored });
  return result;
}
