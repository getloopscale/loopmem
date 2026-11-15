import { describe, expect, test } from 'vitest';

import type { LLM, Message } from '../dip/llm.js';

import { FIRST_WORD_NAME_PROMPT, identifyInputLanguage, maskNamesAndNumbers, openingWord } from './language-identification.js';

const answering = (answer: unknown): LLM & { seen: (readonly Message[])[] } => {
  const seen: (readonly Message[])[] = [];
  return {
    seen,
    generateResponse: (messages) => {
      seen.push(messages);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    generateChat: () => Promise.resolve({ role: 'assistant' as const, content: '' }),
  };
};

describe('maskNamesAndNumbers', () => {
  test('masks capitalised words and words with digits, keeping possessives and punctuation', () => {
    expect(maskNamesAndNumbers("Mihaela's nephew Sorin is a pilot.")).toBe("X's nephew X is a pilot.");
    expect(maskNamesAndNumbers('Bogdan owns a Peugeot 208.')).toBe('X owns a X N');
    expect(maskNamesAndNumbers('Zsófia supports Ferencváros.')).toBe('X supports X.');
  });

  test('drops a name particle between two names (#254)', () => {
    expect(maskNamesAndNumbers('Gonçalo reads Eça de Queirós.')).toBe('X reads X X.');
    expect(maskNamesAndNumbers('Pieter van der Velde installs solar panels.')).toBe('X X installs solar panels.');
  });

  test('keeps a particle that is not between two names', () => {
    expect(maskNamesAndNumbers('a irmã de Débora mora em Manaus')).toBe('a irmã de X mora em X');
  });

  test('leaves lower-case words, accents included, untouched', () => {
    expect(maskNamesAndNumbers('a irmã de Débora mora em Manaus')).toBe('a irmã de X mora em X');
  });
});

describe('identifyInputLanguage', () => {
  test('sends the masked text and returns a supported language', async () => {
    const llm = answering({ language: 'EN' });
    const result = await identifyInputLanguage(llm, 'Ilinca keeps tortoises.');
    expect(result).toEqual({ ok: true, language: { iso6391: 'en', name: 'English' } });
    expect(llm.seen.map((messages) => messages[1]?.content)).toContain('X keeps tortoises.');
  });

  test('accepts an answer given as a JSON string', async () => {
    expect(await identifyInputLanguage(answering('{"language":"pt"}'), 'Eu moro em Lisboa')).toEqual({
      ok: true,
      language: { iso6391: 'pt', name: 'Portuguese' },
    });
  });

  test('reports an unsupported language with its code', async () => {
    expect(await identifyInputLanguage(answering({ language: 'pl' }), 'Ola mieszka w Krakowie')).toEqual({
      ok: false,
      reason: 'unsupported_language',
      code: 'pl',
    });
  });

  test('reports a malformed answer', async () => {
    expect(await identifyInputLanguage(answering({ lang: 'en' }), 'x')).toEqual({ ok: false, reason: 'malformed_answer' });
    expect(await identifyInputLanguage(answering('not json'), 'x')).toEqual({ ok: false, reason: 'malformed_answer' });
  });

  test('reports a failed call without throwing', async () => {
    const error = new TypeError('network down');
    expect(await identifyInputLanguage(answering(error), 'x')).toEqual({ ok: false, reason: 'llm_error', error: 'TypeError' });
  });
});

/** Answers the name question with `isName` and each identification by what the masked text starts with. */
const scripted = (isName: unknown, byText: (masked: string) => string): LLM & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    generateResponse: (messages) => {
      const [system, user] = messages;
      asked.push(`${system?.content === FIRST_WORD_NAME_PROMPT ? 'name' : 'language'}:${user?.content ?? ''}`);
      if (system?.content === FIRST_WORD_NAME_PROMPT) return isName instanceof Error ? Promise.reject(isName) : Promise.resolve(isName);
      return Promise.resolve({ language: byText(user?.content ?? '') });
    },
    generateChat: () => Promise.resolve({ role: 'assistant' as const, content: '' }),
  };
};
const keptOrMasked = (masked: string): string => (masked.startsWith('X') ? 'es' : 'pt');

describe('openingWord', () => {
  test('is the first word when only its position explains the capital', () => {
    expect(openingWord('Não como carne desde 2019.')).toBe('Não');
    expect(openingWord('Ilinca keeps tortoises.')).toBe('Ilinca');
  });

  test('is absent when the word is marked as a name, has a digit or no capital', () => {
    expect(openingWord("Mihaela's nephew is a pilot.")).toBeNull();
    expect(openingWord('Marguerite Dunn runs the team.')).toBeNull();
    expect(openingWord('Pieter van der Velde installs solar panels.')).toBeNull();
    expect(openingWord('Sorin flies, and everyone trusts Sorin.')).toBeNull();
    expect(openingWord('eu moro em Braga')).toBeNull();
    expect(openingWord('3D printing is my hobby')).toBeNull();
  });
});

describe('identifyInputLanguage with an opening word (#302)', () => {
  test('keeps the opening word in the text when the model says it is not a name', async () => {
    const llm = scripted({ name: false }, keptOrMasked);
    const result = await identifyInputLanguage(llm, 'Não como carne desde 2019.');
    expect(result).toEqual({ ok: true, language: { iso6391: 'pt', name: 'Portuguese' } });
    expect([...llm.asked].sort()).toEqual(['language:X como carne desde N', 'language:não como carne desde N', 'name:Não']);
  });

  test('uses the fully masked text when the model says the opening word is a name', async () => {
    const result = await identifyInputLanguage(scripted({ name: true }, keptOrMasked), 'Mihaela come carne.');
    expect(result).toEqual({ ok: true, language: { iso6391: 'es', name: 'Spanish' } });
  });

  test('uses the fully masked text when the name question fails or is unusable', async () => {
    for (const answer of [new TypeError('down'), { nome: true }, 'not json']) {
      const result = await identifyInputLanguage(scripted(answer, keptOrMasked), 'Não como carne desde 2019.');
      expect(result).toEqual({ ok: true, language: { iso6391: 'es', name: 'Spanish' } });
    }
  });

  test('falls back to the fully masked answer when the other one names no supported language', async () => {
    const llm = scripted({ name: false }, (masked) => (masked.startsWith('X') ? 'es' : 'xx'));
    expect(await identifyInputLanguage(llm, 'Não como carne desde 2019.')).toEqual({ ok: true, language: { iso6391: 'es', name: 'Spanish' } });
  });

  test('asks one question when there is no opening word to decide about', async () => {
    const llm = scripted({ name: false }, () => 'en');
    await identifyInputLanguage(llm, "Mihaela's nephew Sorin is a pilot.");
    expect(llm.asked).toEqual(["language:X's nephew X is a pilot."]);
  });
});

