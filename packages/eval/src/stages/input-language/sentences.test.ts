import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface Sentence { readonly id: string; readonly language: string; readonly opening: string; readonly text: string; readonly name?: string }

const sentences = JSON.parse(readFileSync(new URL('./sentences.json', import.meta.url), 'utf8')) as Sentence[];

describe('input-language sentences', () => {
  it('has 40 sentences for each of six languages, with unique ids', () => {
    const perLanguage = new Map<string, number>();
    for (const sentence of sentences) perLanguage.set(sentence.language, (perLanguage.get(sentence.language) ?? 0) + 1);
    expect([...perLanguage.entries()].sort()).toEqual([['de', 40], ['en', 40], ['es', 40], ['fr', 40], ['it', 40], ['pt', 40]]);
    expect(new Set(sentences.map((sentence) => sentence.id)).size).toBe(sentences.length);
  });

  it('starts each name sentence with its name and every sentence with a capital letter', () => {
    for (const sentence of sentences) {
      expect(sentence.text).toMatch(/^\p{Lu}/u);
      if (sentence.opening === 'person-name') expect(sentence.text.startsWith(`${sentence.name ?? ''} `)).toBe(true);
    }
  });

  it('has no digits and no second capitalised word right after an opening name', () => {
    for (const sentence of sentences) {
      expect(sentence.text).not.toMatch(/\d/u);
      if (sentence.opening === 'person-name') expect(sentence.text.split(/\s+/u)[1]).not.toMatch(/^\p{Lu}/u);
    }
  });
});
