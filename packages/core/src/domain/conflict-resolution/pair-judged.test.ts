import * as otel from '@opentelemetry/api';
import type { Tracer } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConsolidationCandidate, ConsolidationContext } from '../dip/conflict-resolution-policy.js';
import type { LLM } from '../dip/llm.js';
import { FACT_OWNER_PROMPT } from '../extraction/fact-owner.js';
import { UPDATE_JUDGE_PROMPT } from '../extraction/update-judge.js';

import { __resetCounterCacheForTesting } from './llm-judged-merge.js';
import { PairJudgedConflictPolicy } from './pair-judged.js';

const CTX: ConsolidationContext = { scope: { kind: 'user', userId: 'u' }, observationDate: new Date('2024-06-01T00:00:00Z') };
const fact = (memoryId: string, text: string, day: string): ConsolidationCandidate => ({ memoryId, text, createdAt: new Date('2024-05-20T00:00:00Z'), validFrom: new Date(`${day}T12:00:00Z`) });

/** Says "replaces" when both notes of the pair contain `sameThing`, "both" otherwise; names owners by `ownerOf`. */
function llm(replaces: (first: string, second: string) => boolean, ownerOf: (text: string) => string = () => 'user'): LLM & { pairs: string[] } {
  const pairs: string[] = [];
  return {
    pairs,
    generateResponse: vi.fn(async (messages: readonly { content: string }[]) => {
      const user = messages[1]?.content ?? '';
      if (messages[0]?.content === UPDATE_JUDGE_PROMPT) {
        const [, first = '', second = ''] = /First note \(written [^)]*\): (.*)\nSecond note \(written [^)]*\): (.*)/su.exec(user) ?? [];
        pairs.push(`${first} -> ${second}`);
        return { verdict: replaces(first, second) ? 'replaces' : 'both' };
      }
      if (messages[0]?.content === FACT_OWNER_PROMPT) return { owner: ownerOf(user.replace(/^Note: /u, '')) };
      throw new Error('unexpected call');
    }),
    generateChat: vi.fn(),
  };
}
const sameWord = (word: string) => (first: string, second: string): boolean => first.includes(word) && second.includes(word);

describe('PairJudgedConflictPolicy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetCounterCacheForTesting();
  });

  it('resolves every update of a cluster, each old value ended by the value that came next', async () => {
    const cluster = [
      fact('city-1', 'user lives in Lyon', '2024-01-10'),
      fact('city-2', 'user lives in Porto', '2024-03-10'),
      fact('city-3', 'user lives in Kiel', '2024-05-10'),
      fact('job-1', 'user works at Halvorsen Freight', '2024-02-01'),
      fact('job-2', 'user works at Brightwater Labs', '2024-04-01'),
      fact('pet', 'user has a tortoise', '2024-02-15'),
    ];
    const policy = new PairJudgedConflictPolicy({ llm: llm((a, b) => sameWord('lives in')(a, b) || sameWord('works at')(a, b)) });

    const results = await policy.consolidate(cluster, CTX);

    const ended = new Map(results.flatMap((r) => r.rejectedMemoryIds.map((id) => [id, r.keptMemoryId] as const)));
    expect([...ended].sort()).toEqual([['city-1', 'city-2'], ['city-2', 'city-3'], ['job-1', 'job-2']]);
    expect(results.every((r) => r.policyName === 'pair-judged')).toBe(true);
  });

  it('always gives the judge the earlier note first, whatever the order of the cluster', async () => {
    const stub = llm(() => false);
    await new PairJudgedConflictPolicy({ llm: stub }).consolidate([fact('b', 'user lives in Porto', '2024-03-10'), fact('a', 'user lives in Lyon', '2024-01-10')], CTX);
    expect(stub.pairs).toEqual(['user lives in Lyon -> user lives in Porto']);
  });

  it('does not ask about two facts scoped to different periods', async () => {
    const stub = llm(() => true);
    const results = await new PairJudgedConflictPolicy({ llm: stub }).consolidate(
      [fact('a', 'user ran 800 km in 2023', '2024-01-10'), fact('b', 'user ran 950 km in 2024', '2024-03-10')], CTX);
    expect(results).toEqual([]);
    expect(stub.pairs).toEqual([]);
  });

  it('keeps both when the names differ and the notes are facts of two individuals', async () => {
    const stub = llm(() => true, (text) => (text.includes('Ottoline') ? 'Ottoline' : 'user'));
    const results = await new PairJudgedConflictPolicy({ llm: stub }).consolidate(
      [fact('a', "user's aunt Ottoline's insurer is Vida Plena", '2024-01-10'), fact('b', "user's insurer is Unimais", '2024-03-10')], CTX);
    expect(results).toEqual([]);
  });

  it('abstains on a cluster above its cap and on a single fact', async () => {
    const stub = llm(() => true);
    const policy = new PairJudgedConflictPolicy({ llm: stub, clusterCap: 2 });
    expect(await policy.consolidate([fact('a', 'x one', '2024-01-01'), fact('b', 'x two', '2024-01-02'), fact('c', 'x three', '2024-01-03')], CTX)).toEqual([]);
    expect(await policy.consolidate([fact('a', 'x one', '2024-01-01')], CTX)).toEqual([]);
    expect(stub.pairs).toEqual([]);
  });

  it('counts a cluster it leaves alone for being above its cap, naming itself', async () => {
    const add = vi.fn();
    __resetCounterCacheForTesting();
    vi.spyOn(otel.metrics, 'getMeter').mockReturnValue({ createCounter: () => ({ add }) } as unknown as otel.Meter);
    const policy = new PairJudgedConflictPolicy({ llm: llm(() => true), clusterCap: 2 });
    await policy.consolidate([fact('a', 'x one', '2024-01-01'), fact('b', 'x two', '2024-01-02'), fact('c', 'x three', '2024-01-03')], CTX);
    expect(add).toHaveBeenCalledWith(1, { policy: 'pair-judged' });
  });

  it('reports through the context tracer the pairs it judged and the pairs it kept as facts of two individuals', async () => {
    const events: { event: string; attributes: Record<string, unknown> }[] = [];
    const tracer = {
      startActiveSpan(name: string, fn: (span: unknown) => void): void {
        const attributes: Record<string, unknown> = {};
        fn({ setAttribute: (k: string, v: unknown) => { attributes[k] = v; }, end: () => undefined });
        events.push({ event: name, attributes });
      },
    } as unknown as Tracer;
    const stub = llm(() => true, (text) => (text.includes('Ottoline') ? 'Ottoline' : 'user'));
    const cluster = [fact('a', "user's aunt Ottoline's insurer is Vida Plena", '2024-01-10'), fact('b', "user's insurer is Unimais", '2024-03-10')];

    const results = await new PairJudgedConflictPolicy({ llm: stub }).consolidate(cluster, { ...CTX, tracer });

    expect(results).toEqual([]);
    expect(events).toEqual([
      { event: 'update_declined', attributes: { reason: 'different_owner', count: 1 } },
      { event: 'update_judged', attributes: { pairs: 1, replaced: 0 } },
    ]);
  });

  it('leaves a pair alone when the judge gives no verdict', async () => {
    const failing = { generateResponse: vi.fn(async () => { throw new TypeError('down'); }), generateChat: vi.fn() } as unknown as LLM;
    expect(await new PairJudgedConflictPolicy({ llm: failing }).consolidate([fact('a', 'user lives in Lyon', '2024-01-10'), fact('b', 'user lives in Porto', '2024-03-10')], CTX)).toEqual([]);
  });
});
