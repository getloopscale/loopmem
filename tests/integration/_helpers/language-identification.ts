/**
 * The write path names the input language with its own LLM call before extraction (#254).
 * Extraction stubs that queue answers or read a call by position answer that call here,
 * so their queue and their call indexes keep counting extraction calls only.
 */
import { FIRST_WORD_NAME_PROMPT, LANGUAGE_IDENTIFICATION_PROMPT } from '../../../packages/core/src/domain/extraction/language-identification.js';

/** True for a call of the input-language identification: the language itself, or whether the opening word is a name (#302). */
export const isLanguageIdentification = (messages: readonly { readonly content: string }[]): boolean =>
  messages[0]?.content === LANGUAGE_IDENTIFICATION_PROMPT || messages[0]?.content === FIRST_WORD_NAME_PROMPT;

/** The answer a stub gives to the identification call: English. */
export const ENGLISH = { language: 'en' } as const;
