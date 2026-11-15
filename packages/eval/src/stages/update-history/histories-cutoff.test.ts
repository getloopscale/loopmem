import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface History {
  readonly id: string;
  readonly language: string;
  readonly messages: readonly { readonly date: string; readonly kind: string; readonly text: string }[];
  readonly questions: readonly {
    readonly kind: string;
    readonly expected: string;
    readonly expectedAll?: readonly string[];
    readonly notExpected: readonly string[];
  }[];
}

const TOP_K = 5;

describe('the committed cut-off histories', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const histories = JSON.parse(readFileSync(resolve(here, 'histories-cutoff.json'), 'utf8')) as History[];

  it('has sixteen histories, half in English and half in Portuguese', () => {
    expect(histories).toHaveLength(16);
    expect(histories.filter((h) => h.language === 'en')).toHaveLength(8);
  });

  it('dates the messages of a history in the order they are written', () => {
    for (const history of histories) {
      const dates = history.messages.map((m) => m.date);
      expect([...dates].sort(), history.id).toEqual(dates);
    }
  });

  it('gives each relative more facts than recall returns, so a full top five can be all about the relative', () => {
    for (const history of histories) {
      const aboutRelative = history.messages.filter((m) => m.kind.startsWith('relative'));
      expect(aboutRelative.length, history.id).toBeGreaterThan(TOP_K);
    }
  });

  it('asks only for values a message of the history states', () => {
    for (const history of histories) {
      for (const question of history.questions) {
        for (const value of question.expectedAll ?? [question.expected]) {
          expect(history.messages.some((m) => m.text.includes(value)), `${history.id} ${value}`).toBe(true);
        }
      }
    }
  });

  it('asks each question that needs both people for one value of the speaker and one of the relative', () => {
    for (const history of histories) {
      for (const question of history.questions.filter((q) => q.kind === 'both-people')) {
        const [own, relative] = question.expectedAll ?? [];
        const stating = (value: string | undefined): string[] =>
          history.messages.filter((m) => value !== undefined && m.text.includes(value)).map((m) => m.kind);
        expect(stating(own).some((kind) => kind.startsWith('own-')), `${history.id} ${String(own)}`).toBe(true);
        expect(stating(relative).some((kind) => kind.startsWith('relative-')), `${history.id} ${String(relative)}`).toBe(true);
      }
    }
  });
});
