/**
 * Supersession on write (ADR-0029), decided by the update judge (ADR-0036).
 *
 * Each new fact is compared with each existing memory shown for the write, one pair per judge
 * call. When the judge says the later note replaces the earlier one, and the pair is not two
 * facts of different individuals (#252), the earlier of the two ends
 * at the instant the later one began (#253): an existing memory that is older than the new fact is
 * ended by it, and a new fact that arrives after a newer value of the same thing is stored as
 * already ended. A replaced memory is never deleted: the store sets its `t_invalid`, so
 * `recall({ asOf })` before that instant still returns it. Every outcome is observable.
 */
import type { Tracer } from '@opentelemetry/api';

import type { HistoryBatchRecord } from '../dip/history-manager.js';
import type { LLM } from '../dip/llm.js';
import type { VectorStore } from '../dip/vector-store.js';
import { emitEvent } from '../memory-event.js';
import type { MemoryItem } from '../memory-item.js';
import type { Filters } from '../scope.js';

import { ownerOf, sameOwner } from './fact-owner.js';
import { nameSetsDiffer } from './name-difference.js';
import { differentPeriods } from './period-anchor.js';
import { judgeUpdate } from './update-judge.js';

export interface SupersessionResult {
  /** Memory id → ids of the memories it invalidated. Only memories that invalidated something. */
  readonly supersededBy: ReadonlyMap<string, readonly string[]>;
  /** Memory id → the instant it ended, for a new memory that arrived after a newer value of the same thing. */
  readonly endedOnArrival: ReadonlyMap<string, Date>;
  readonly history: readonly HistoryBatchRecord[];
}

/**
 * The pairs, by index, that two readings agree are facts of different individuals (#252): the two
 * notes name different people or things beyond a swapped value, and each note, read on its own,
 * belongs to a different owner. The owner is asked only where the names differ. An owner that
 * could not be read counts as no agreement.
 */
export async function pairsOfDifferentIndividuals(
  llm: LLM,
  pairs: readonly (readonly [string, string])[],
  tracer: Tracer | undefined,
): Promise<ReadonlySet<number>> {
  const suspect = pairs.map(([first, second], index) => ({ first, second, index })).filter(({ first, second }) => nameSetsDiffer(first, second));
  const texts = [...new Set(suspect.flatMap(({ first, second }) => [first, second]))];
  const owners = new Map((await inBatches(texts, JUDGE_CONCURRENCY, (text) => ownerOf(llm, text, tracer))).map((owner, index) => [texts[index] as string, owner]));
  return new Set(suspect.filter(({ first, second }) => {
    const mine = owners.get(first) ?? null;
    const theirs = owners.get(second) ?? null;
    return mine !== null && theirs !== null && !sameOwner(mine, theirs);
  }).map(({ index }) => index));
}

/** Judge calls of one write that run at the same time. */
export const JUDGE_CONCURRENCY = 8;

interface Candidate {
  readonly id: string;
  readonly text: string;
  /** Null on a row written before valid time existed; such a row counts as older than any new fact. */
  readonly validFrom: Date | null;
}

interface Pair {
  readonly memory: MemoryItem;
  readonly candidate: Candidate;
  /** True when the existing memory began after the new fact, so the new fact is the earlier note. */
  readonly newIsEarlier: boolean;
}

/** The shown memories that are still current, with the instant each began. */
async function currentCandidates(
  shown: ReadonlyMap<number, { readonly id: string; readonly text: string }>,
  store: Pick<VectorStore, 'get'>,
): Promise<readonly Candidate[]> {
  const candidates: Candidate[] = [];
  for (const { id, text } of shown.values()) {
    const row = await store.get(id);
    if (row === null) continue;
    const invalidFrom = row.payload['t_invalid'];
    if (invalidFrom !== undefined && invalidFrom !== null) continue;
    const validFrom = row.payload['t_valid'];
    const instant = typeof validFrom === 'string' ? new Date(validFrom) : null;
    candidates.push({ id, text, validFrom: instant !== null && !Number.isNaN(instant.getTime()) ? instant : null });
  }
  return candidates;
}

export async function inBatches<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    results.push(...await Promise.all(items.slice(start, start + size).map(work)));
  }
  return results;
}

/**
 * Compare every new memory with every shown memory that is still current, and end the earlier
 * note of each pair the judge says is replaced. A pair about different explicit periods (a 2023
 * count against a 2024 count, #252) is never sent to the judge. A pair the judge gives no verdict
 * for is left alone.
 */
export async function judgeSupersessions(
  memories: readonly MemoryItem[],
  shown: ReadonlyMap<number, { readonly id: string; readonly text: string }>,
  filters: Filters,
  at: Date,
  store: Pick<VectorStore, 'supersede' | 'get'>,
  llm: LLM,
  tracer: Tracer | undefined,
): Promise<SupersessionResult> {
  const supersededBy = new Map<string, readonly string[]>();
  const endedOnArrival = new Map<string, Date>();
  const history: HistoryBatchRecord[] = [];
  if (memories.length === 0 || shown.size === 0) return { supersededBy, endedOnArrival, history };
  if (store.supersede === undefined) {
    emitEvent(tracer, 'supersession_skipped', { reason: 'unsupported_store', count: memories.length });
    return { supersededBy, endedOnArrival, history };
  }

  const candidates = await currentCandidates(shown, store);
  const pairs: Pair[] = [];
  let differentPeriod = 0;
  for (const memory of memories) {
    for (const candidate of candidates) {
      if (candidate.id === memory.id) continue;
      if (differentPeriods(memory.text, candidate.text)) {
        differentPeriod += 1;
        continue;
      }
      pairs.push({ memory, candidate, newIsEarlier: candidate.validFrom !== null && candidate.validFrom.getTime() > at.getTime() });
    }
  }
  if (differentPeriod > 0) emitEvent(tracer, 'supersession_rejected', { reason: 'different_period', count: differentPeriod });
  if (pairs.length === 0) return { supersededBy, endedOnArrival, history };

  const verdicts = await inBatches(pairs, JUDGE_CONCURRENCY, ({ memory, candidate, newIsEarlier }) => {
    const existing = { text: candidate.text, saidAt: candidate.validFrom ?? at };
    const arriving = { text: memory.text, saidAt: at };
    return newIsEarlier ? judgeUpdate(llm, arriving, existing, tracer) : judgeUpdate(llm, existing, arriving, tracer);
  });
  const judgedReplaced = pairs.filter((_, index) => verdicts[index] === 'replaces');
  // The judge also says "replaces" for the same kind of fact about someone else (#252). Two
  // readings that fail in different places have to agree before a pair it would end is kept:
  // the two notes name different people or things beyond a swapped value, and each note, read on
  // its own, is the fact of a different individual. The second reading is asked only where the
  // first one fires. An owner that could not be read counts as no agreement, and the note ends.
  const declinedAt = await pairsOfDifferentIndividuals(llm, judgedReplaced.map(({ memory, candidate }) => [memory.text, candidate.text] as const), tracer);
  const declined = new Set(judgedReplaced.filter((_, index) => declinedAt.has(index)));
  if (declined.size > 0) emitEvent(tracer, 'update_declined', { reason: 'different_owner', count: declined.size });
  const replaced = judgedReplaced.filter((pair) => !declined.has(pair));
  emitEvent(tracer, 'update_judged', { pairs: pairs.length, replaced: replaced.length });

  for (const memory of memories) {
    const mine = replaced.filter((pair) => pair.memory.id === memory.id);
    // A newer value already stored ends this fact where that value began; the earliest one wins.
    const later = mine.filter((pair) => pair.newIsEarlier)
      .sort((a, b) => (a.candidate.validFrom as Date).getTime() - (b.candidate.validFrom as Date).getTime())[0];
    if (later !== undefined) {
      const endsAt = later.candidate.validFrom as Date;
      const ended = await store.supersede(filters, [memory.id], { memoryId: later.candidate.id, at: endsAt });
      if (ended.includes(memory.id)) {
        endedOnArrival.set(memory.id, endsAt);
        emitEvent(tracer, 'memory_ended_on_arrival', { count: 1 });
        history.push({ memoryId: memory.id, previousValue: memory.text, newValue: later.candidate.text, action: 'supersede' });
      }
    }
    const older = new Map(mine.filter((pair) => !pair.newIsEarlier).map((pair) => [pair.candidate.id, pair.candidate.text]));
    if (older.size === 0) continue;
    const invalidated = await store.supersede(filters, [...older.keys()], { memoryId: memory.id, at });
    const declined = older.size - invalidated.length;
    if (declined > 0) emitEvent(tracer, 'supersession_skipped', { reason: 'not_current_or_newer', count: declined });
    if (invalidated.length === 0) continue;
    supersededBy.set(memory.id, invalidated);
    emitEvent(tracer, 'memory_superseded', { count: invalidated.length });
    for (const id of invalidated) {
      history.push({ memoryId: id, previousValue: older.get(id) ?? null, newValue: memory.text, action: 'supersede' });
    }
  }
  return { supersededBy, endedOnArrival, history };
}
