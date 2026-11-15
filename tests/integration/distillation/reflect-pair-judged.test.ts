import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';

import { createLocalMemory, PairJudgedConflictPolicy, PgvectorStore, StubEmbedder } from '@usetheo/memory';
import type { LLM, LLMResponse, Message } from '@usetheo/memory';

import { FACT_OWNER_PROMPT } from '../../../packages/core/src/domain/extraction/fact-owner.js';
import { UPDATE_JUDGE_PROMPT } from '../../../packages/core/src/domain/extraction/update-judge.js';
import { createIsolatedDb, type IsolatedDb } from '../_helpers/isolated-db.js';

/**
 * `reflect` with the pair-judged policy (#237): each pair of a cluster goes to the update judge,
 * the earlier note first. The stub judge answers "replaces" only for two notes about where the user
 * lives, so the older city is ended by the newer one and the unrelated fact stays.
 */
const judgedPairs: string[] = [];
const pairJudgeLlm: LLM = {
  async generateResponse(messages: readonly Message[]): Promise<unknown> {
    const prompt = String(messages[0]?.content ?? '');
    const user = String(messages[1]?.content ?? '');
    if (prompt === UPDATE_JUDGE_PROMPT) {
      const [, first = '', second = ''] = /First note \(written [^)]*\): (.*)\nSecond note \(written [^)]*\): (.*)/su.exec(user) ?? [];
      judgedPairs.push(`${first} -> ${second}`);
      return Promise.resolve({ verdict: first.includes('lives in') && second.includes('lives in') ? 'replaces' : 'both' });
    }
    if (prompt === FACT_OWNER_PROMPT) return Promise.resolve({ owner: 'user' });
    return Promise.resolve([]);
  },
  async generateChat(_messages: readonly Message[]): Promise<LLMResponse> {
    return Promise.resolve({ role: 'assistant', content: '[]' });
  },
};

const PG_URI = process.env['THEOMEM_PG_URI'] ?? '';

describe.skipIf(PG_URI === '')('reflect({ conflictResolution: PairJudgedConflictPolicy })', () => {
  let db: IsolatedDb;
  let pool: pg.Pool;
  const TEST_USER = 'pair-judged-policy-user';

  async function reset(): Promise<void> {
    await pool.query(`DELETE FROM consolidation_history WHERE policy_name = 'pair-judged'`);
    await pool.query(`DELETE FROM memories WHERE user_id = $1`, [TEST_USER]);
  }

  async function seed(text: string, createdOffsetMs: number): Promise<string> {
    const embedding = Array.from({ length: 1536 }, () => 0);
    embedding[0] = 1;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO memories (
         text, hash, embedding, payload, user_id, created_at, t_valid,
         last_accessed_at, access_count, llm_importance_score
       ) VALUES ($1, $2, $3::vector, $4, $5, NOW() + ($6 || ' milliseconds')::interval,
                 NOW() + ($6 || ' milliseconds')::interval, NOW(), 0, 0.5)
       RETURNING id`,
      [text, `pair-judged-${String(Date.now())}-${String(Math.random())}`, `[${embedding.join(',')}]`, { text, user_id: TEST_USER }, TEST_USER, String(createdOffsetMs)],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('seed: no row');
    return id;
  }

  beforeAll(async () => {
    db = await createIsolatedDb();
    pool = db.poolPinnedTo('default');
  });

  afterAll(async () => {
    await db.dropDb();
  });

  beforeEach(async () => {
    judgedPairs.length = 0;
    await reset();
  });

  it('ends the older value with the newer one, keeps the unrelated fact, and records the decision', async () => {
    const memory = await createLocalMemory({
      vectorStore: new PgvectorStore(pool),
      embedder: new StubEmbedder(),
      llm: pairJudgeLlm,
      reflectionPolicy: { kind: 'manual' },
    });
    // The newer city is stored first: the policy reads the cluster by when each fact held, not by insertion.
    const porto = await seed('user lives in Porto', -3_000);
    const lyon = await seed('user lives in Lyon', -10_000);
    const dog = await seed('user has a dog', -7_000);

    await memory.user(TEST_USER).reflect({ conflictResolution: new PairJudgedConflictPolicy({ llm: pairJudgeLlm }) });

    expect(judgedPairs).toContain('user lives in Lyon -> user lives in Porto');
    expect(judgedPairs).not.toContain('user lives in Porto -> user lives in Lyon');
    const { rows } = await pool.query<{ id: string; t_invalid: Date | null }>(
      `SELECT id, t_invalid FROM memories WHERE user_id = $1 AND kind IS DISTINCT FROM 'derived'`,
      [TEST_USER],
    );
    const invalid = new Map(rows.map((row) => [row.id, row.t_invalid !== null]));
    expect(invalid.get(lyon)).toBe(true);
    expect(invalid.get(porto)).toBe(false);
    expect(invalid.get(dog)).toBe(false);

    const { rows: audit } = await pool.query<{ kept_memory_id: string; rejected_memory_ids: string[]; reason: string }>(
      `SELECT kept_memory_id, rejected_memory_ids, reason FROM consolidation_history WHERE policy_name = 'pair-judged'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.kept_memory_id).toBe(porto);
    expect(audit[0]?.rejected_memory_ids).toEqual([lyon]);
    expect(audit[0]?.reason).toBe('The pair judge found a later value of the same thing.');

    await memory.dispose();
  });
});
