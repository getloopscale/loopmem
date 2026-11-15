import type { Tracer } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import type { LLM } from '../dip/llm.js';

import { FACT_OWNER_PROMPT, ownerOf, sameOwner } from './fact-owner.js';

interface Recorded { event: string; attributes: Record<string, unknown> }

function recordingTracer(sink: Recorded[]): Tracer {
  return {
    startActiveSpan(name: string, fn: (span: unknown) => void): void {
      const attributes: Record<string, unknown> = {};
      fn({ setAttribute: (k: string, v: unknown) => { attributes[k] = v; }, end: () => undefined });
      sink.push({ event: name, attributes });
    },
  } as unknown as Tracer;
}

const answering = (answer: unknown): LLM & { generateResponse: ReturnType<typeof vi.fn> } =>
  ({ generateResponse: vi.fn(async () => answer), generateChat: vi.fn() });

describe('ownerOf', () => {
  it('returns the owner the model names for the note', async () => {
    const llm = answering({ value: 'Dr. Reyes', attribute: 'dentist', owner: 'Ana' });

    expect(await ownerOf(llm, "user's sister Ana sees Dr. Reyes, her dentist", undefined)).toBe('Ana');
    expect(llm.generateResponse).toHaveBeenCalledWith(
      [
        { role: 'system', content: FACT_OWNER_PROMPT },
        { role: 'user', content: "Note: user's sister Ana sees Dr. Reyes, her dentist" },
      ],
      { type: 'json' },
    );
  });

  it('accepts the answer as a JSON string', async () => {
    expect(await ownerOf(answering('{"owner":"user"}'), 'user lives in Lyon', undefined)).toBe('user');
  });

  it('asks once more when the owner is missing, and uses the second answer', async () => {
    const llm: LLM = {
      generateResponse: vi.fn().mockResolvedValueOnce({ value: 'Lyon' }).mockResolvedValueOnce({ owner: 'user' }),
      generateChat: vi.fn(),
    };
    const events: Recorded[] = [];

    expect(await ownerOf(llm, 'user lives in Lyon', recordingTracer(events))).toBe('user');
    expect(events).toEqual([]);
  });

  it('gives no owner, and says why, when the answer has none twice', async () => {
    const events: Recorded[] = [];

    expect(await ownerOf(answering({ owner: '  ' }), 'x', recordingTracer(events))).toBeNull();
    expect(events).toEqual([{ event: 'fact_owner_failed', attributes: { reason: 'malformed_answer' } }]);
  });

  it('gives no owner, and says why, when the call fails', async () => {
    const events: Recorded[] = [];
    const failing: LLM = { generateResponse: vi.fn(async () => { throw new TypeError('socket closed'); }), generateChat: vi.fn() };

    expect(await ownerOf(failing, 'x', recordingTracer(events))).toBeNull();
    expect(events).toEqual([{ event: 'fact_owner_failed', attributes: { reason: 'llm_error', error_type: 'TypeError' } }]);
  });
});

describe('sameOwner', () => {
  it.each([
    ['user', 'user', true],
    ['user', 'User', true],
    ['o usuário', 'user', true],
    ['user', 'Ana', false],
    ["user's sister Ana", 'user', false],
    ['Ana', "user's sister Ana", true],
    ['Mr. Achterberg', 'Achterberg', true],
    ['Leocádia', 'Leocadia', true],
    ["user's sister", "user's brother", false],
    ['Ana', 'Bram', false],
  ])('%s and %s: %s', (first, second, expected) => {
    expect(sameOwner(first, second)).toBe(expected);
  });
});
