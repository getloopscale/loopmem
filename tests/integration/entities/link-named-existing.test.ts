/**
 * PgMemoryEntityStore.linkNamedExisting against a real database (#243): a memory is linked to
 * the entities its scope already has and its text names, by the word rule recall uses.
 *
 * Gated by THEOMEM_PG_URI.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';

import { PgMemoryEntityStore, runMigrations } from '@usetheo/memory';

const PG_URI = process.env['THEOMEM_PG_URI'];
const ZERO_VEC = `[${new Array(1536).fill(0).join(',')}]`;
const EMBEDDING = new Array<number>(1536).fill(0);

async function seedMemory(pool: pg.Pool, text: string, userId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO memories (id, text, hash, embedding, payload, user_id) VALUES ($1,$2,$3,$4::vector,'{}'::jsonb,$5)`,
    [id, text, randomUUID(), ZERO_VEC, userId],
  );
  return id;
}

if (PG_URI === undefined || PG_URI === '') {
  describe.skip('PgMemoryEntityStore.linkNamedExisting (THEOMEM_PG_URI not set)', () => {
    test('placeholder', () => undefined);
  });
} else {
  const pool = new pg.Pool({ connectionString: PG_URI, max: 4 });
  const store = new PgMemoryEntityStore(pool);
  const alice = { user_id: 'alice' };
  const entity = (name: string, type = 'PERSON') => ({ type, name, normalizedKey: name.toLowerCase().replace(/\s+/gu, '_'), embedding: EMBEDDING });
  const keysOf = async (memoryId: string): Promise<string[]> =>
    (await pool.query<{ normalized_key: string }>(
      `SELECT e.normalized_key FROM memory_entities me JOIN entities e ON e.id = me.entity_id WHERE me.memory_id = $1 ORDER BY 1`,
      [memoryId],
    )).rows.map((row) => row.normalized_key);

  afterAll(async () => {
    await pool.query('TRUNCATE memories, entities, memory_entities CASCADE');
    await pool.end();
  });

  beforeEach(async () => {
    await runMigrations(pool);
    await pool.query('TRUNCATE memories, entities, memory_entities RESTART IDENTITY CASCADE');
  });

  describe('PgMemoryEntityStore.linkNamedExisting', () => {
    test('links a later memory to the entities of the scope that its text names', async () => {
      const first = await seedMemory(pool, 'Thorvald works as a beekeeper in São Paulo.', 'alice');
      await store.upsertAndLink({ memoryId: first, workspaceId: 'default', filters: alice, entities: [entity('Thorvald'), entity('São Paulo', 'PLACE'), entity('user')] });
      const later = await seedMemory(pool, 'user says Thorvald drives a green Volvo estate.', 'alice');

      const added = await store.linkNamedExisting({ memoryId: later, text: 'user says Thorvald drives a green Volvo estate.', workspaceId: 'default', filters: alice });

      expect(added).toBe(1);
      // The speaker token is in the text and is an entity of the scope, and is still not linked.
      expect(await keysOf(later)).toEqual(['thorvald']);
    });

    test('does not link a key that only occurs inside a longer word, nor an entity of another scope', async () => {
      const first = await seedMemory(pool, 'Paul lives in Kiel.', 'alice');
      await store.upsertAndLink({ memoryId: first, workspaceId: 'default', filters: alice, entities: [entity('Paul')] });
      const others = await seedMemory(pool, 'Greta lives in Kiel.', 'bruno');
      await store.upsertAndLink({ memoryId: others, workspaceId: 'default', filters: { user_id: 'bruno' }, entities: [entity('Greta')] });
      const later = await seedMemory(pool, 'Paulina and Greta share a flat.', 'alice');

      const added = await store.linkNamedExisting({ memoryId: later, text: 'Paulina and Greta share a flat.', workspaceId: 'default', filters: alice });

      expect(added).toBe(0);
      expect(await keysOf(later)).toEqual([]);
    });

    test('adds nothing when the link is already there', async () => {
      const memory = await seedMemory(pool, 'Thorvald keeps bees.', 'alice');
      await store.upsertAndLink({ memoryId: memory, workspaceId: 'default', filters: alice, entities: [entity('Thorvald')] });

      expect(await store.linkNamedExisting({ memoryId: memory, text: 'Thorvald keeps bees.', workspaceId: 'default', filters: alice })).toBe(0);
      expect(await keysOf(memory)).toEqual(['thorvald']);
    });
  });
}
