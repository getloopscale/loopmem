/**
 * Conflict resolution for `reflect` that asks the update judge about each pair of a cluster.
 *
 * The list judge (`LlmJudgedMergeConflictPolicy`) reads a whole cluster and answers with one kept
 * fact, so a cluster that holds two updates gets one of them resolved per reflect, and it has
 * merged distinct events and different periods into one fact (#237). This policy uses what the
 * write path uses (ADR-0036): the pair judge, the refusal of pairs scoped to different periods,
 * and the two readings that keep facts of different individuals apart. Every pair of the cluster
 * is put to the judge with the earlier note first, so the order facts were logged in does not
 * matter, and each replaced fact is ended by the earliest fact that replaces it.
 *
 * It ends facts and writes no summary. A pair the judge gives no verdict for is left alone.
 */
import type {
  ConflictResolutionPolicy,
  ConflictResolutionResult,
  ConsolidationCandidate,
  ConsolidationContext,
} from '../dip/conflict-resolution-policy.js';
import type { LLM } from '../dip/llm.js';
import { differentPeriods } from '../extraction/period-anchor.js';
import { inBatches, JUDGE_CONCURRENCY, pairsOfDifferentIndividuals } from '../extraction/supersession.js';
import { judgeUpdate } from '../extraction/update-judge.js';
import { emitEvent } from '../memory-event.js';

import { countClusterTooLarge, DEFAULT_CLUSTER_CAP } from './llm-judged-merge.js';

export const PAIR_JUDGED_KIND = 'pair-judged';


export interface PairJudgedConflictPolicyOptions {
  readonly llm: LLM;
  /**
   * Clusters above this size are left alone and counted. Defaults to {@link DEFAULT_CLUSTER_CAP}, the size
   * reflect splits clusters to; the number of judge calls grows with the square of the cluster.
   */
  readonly clusterCap?: number;
}

const validFrom = (candidate: ConsolidationCandidate): number => (candidate.validFrom ?? candidate.createdAt).getTime();

export class PairJudgedConflictPolicy implements ConflictResolutionPolicy {
  readonly kind = PAIR_JUDGED_KIND;
  readonly #llm: LLM;
  readonly #clusterCap: number;

  constructor(options: PairJudgedConflictPolicyOptions) {
    this.#llm = options.llm;
    this.#clusterCap = options.clusterCap ?? DEFAULT_CLUSTER_CAP;
  }

  async consolidate(candidates: readonly ConsolidationCandidate[], context: ConsolidationContext): Promise<readonly ConflictResolutionResult[]> {
    if (candidates.length < 2) return [];
    if (candidates.length > this.#clusterCap) {
      countClusterTooLarge(this.kind);
      return [];
    }
    // Earliest first; the id breaks a tie so that the same cluster is always read the same way.
    const ordered = [...candidates].sort((a, b) => validFrom(a) - validFrom(b) || a.memoryId.localeCompare(b.memoryId));
    const pairs: (readonly [ConsolidationCandidate, ConsolidationCandidate])[] = [];
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const earlier = ordered[i] as ConsolidationCandidate;
        const later = ordered[j] as ConsolidationCandidate;
        if (earlier.text === later.text || differentPeriods(earlier.text, later.text)) continue;
        pairs.push([earlier, later]);
      }
    }
    const verdicts = await inBatches(pairs, JUDGE_CONCURRENCY, ([earlier, later]) =>
      judgeUpdate(this.#llm, { text: earlier.text, saidAt: new Date(validFrom(earlier)) }, { text: later.text, saidAt: new Date(validFrom(later)) }, context.tracer));
    const judged = pairs.filter((_, index) => verdicts[index] === 'replaces');
    const declined = await pairsOfDifferentIndividuals(this.#llm, judged.map(([earlier, later]) => [earlier.text, later.text] as const), context.tracer);
    if (declined.size > 0) emitEvent(context.tracer, 'update_declined', { reason: 'different_owner', count: declined.size });
    emitEvent(context.tracer, 'update_judged', { pairs: pairs.length, replaced: judged.length - declined.size });
    // The pairs of an earlier fact come in order of the later note, so the first one kept is the earliest that replaces it.
    const endedBy = new Map<string, ConsolidationCandidate>();
    judged.forEach(([earlier, later], index) => {
      if (!declined.has(index) && !endedBy.has(earlier.memoryId)) endedBy.set(earlier.memoryId, later);
    });
    const byKept = new Map<string, string[]>();
    for (const [ended, by] of endedBy) byKept.set(by.memoryId, [...(byKept.get(by.memoryId) ?? []), ended]);
    return [...byKept].map(([keptMemoryId, rejectedMemoryIds]) => ({
      keptMemoryId,
      rejectedMemoryIds,
      reason: 'The pair judge found a later value of the same thing.',
      policyName: this.kind,
      originalEpisodeIds: [...rejectedMemoryIds, keptMemoryId],
    }));
  }
}
