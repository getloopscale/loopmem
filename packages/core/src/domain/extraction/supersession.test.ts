import type { Tracer } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import type { LLM } from '../dip/llm.js';
import type { VectorStore } from '../dip/vector-store.js';
import type { MemoryItem } from '../memory-item.js';
import type { Filters } from '../scope.js';

import { FACT_OWNER_PROMPT } from './fact-owner.js';
import { judgeSupersessions } from './supersession.js';
import { UPDATE_JUDGE_PROMPT } from './update-judge.js';

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

/** An LLM that answers the judge call with a fixed verdict and the owner call per note text. */
function llmAnswering(verdict: unknown, ownerByText: (text: string) => unknown): LLM {
  return {
    generateResponse: vi.fn(async (messages: readonly { content: string }[]) => {
      if (messages[0]?.content === UPDATE_JUDGE_PROMPT) return verdict;
      if (messages[0]?.content === FACT_OWNER_PROMPT) {
        const owner = ownerByText((messages[1]?.content ?? '').replace(/^Note: /u, ''));
        if (owner instanceof Error) throw owner;
        return { owner };
      }
      throw new Error('unexpected call');
    }),
    generateChat: vi.fn(),
  };
}

const at = new Date('2024-05-01T12:00:00Z');
const filters = { user_id: 'u' } as unknown as Filters;
const own = { id: 'new', text: "user's insurer is Unimais" } as unknown as MemoryItem;
const ownEarlier = new Map([[0, { id: 'old', text: "user's insurer is Vida Plena" }]]);
const relatives = new Map([[0, { id: 'old', text: "user's aunt Ottoline's insurer is Vida Plena" }]]);

function store(): Pick<VectorStore, 'supersede' | 'get'> & { supersede: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async () => ({ id: 'old', payload: { t_valid: '2024-01-01T12:00:00Z' } })),
    supersede: vi.fn(async (_filters: Filters, ids: readonly string[]) => [...ids]),
  };
}

const ownerByName = (text: string): string => (text.includes('Ottoline') ? 'Ottoline' : 'user');

describe('judgeSupersessions', () => {
  it('ends the earlier note without asking whose it is when the two notes differ only by the value', async () => {
    const s = store();
    const llm = llmAnswering({ verdict: 'replaces' }, ownerByName);

    const result = await judgeSupersessions([own], ownEarlier, filters, at, s, llm, undefined);

    expect(result.supersededBy.get('new')).toEqual(['old']);
    expect(llm.generateResponse).toHaveBeenCalledTimes(1);
  });

  it('keeps both notes, and says why, when the names differ and the two notes are facts of two individuals', async () => {
    const s = store();
    const events: Recorded[] = [];

    const result = await judgeSupersessions([own], relatives, filters, at, s, llmAnswering({ verdict: 'replaces' }, ownerByName), recordingTracer(events));

    expect(result.supersededBy.size).toBe(0);
    expect(s.supersede).not.toHaveBeenCalled();
    expect(events).toEqual([
      { event: 'update_declined', attributes: { reason: 'different_owner', count: 1 } },
      { event: 'update_judged', attributes: { pairs: 1, replaced: 0 } },
    ]);
  });

  it('ends the earlier note when the names differ and both notes are facts of one individual', async () => {
    const s = store();

    const result = await judgeSupersessions([own], relatives, filters, at, s, llmAnswering({ verdict: 'replaces' }, () => 'user'), undefined);

    expect(result.supersededBy.get('new')).toEqual(['old']);
  });

  it('ends the earlier note, as before, when an owner cannot be read', async () => {
    const s = store();
    const events: Recorded[] = [];

    const result = await judgeSupersessions([own], relatives, filters, at, s, llmAnswering({ verdict: 'replaces' }, () => new TypeError('socket closed')), recordingTracer(events));

    expect(result.supersededBy.get('new')).toEqual(['old']);
    expect(events.map((e) => e.event)).toContain('fact_owner_failed');
  });

  it('asks for no owner when the judge says both hold', async () => {
    const llm = llmAnswering({ verdict: 'both' }, ownerByName);

    await judgeSupersessions([own], relatives, filters, at, store(), llm, undefined);

    expect(llm.generateResponse).toHaveBeenCalledTimes(1);
  });
});
