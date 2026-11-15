/**
 * Which language the write path names for a short message.
 *
 * Each sentence is written through `remember` with an LLM that answers only the language
 * identification call and stops the write there, so the run costs one small call per sentence.
 * The answer of that call is the language the extraction prompt would have been given.
 *
 * Environment: OPENAI_API_KEY, OPENAI_BASE_URL (e.g. a cost proxy), OPENAI_CHAT_MODEL,
 * INPUT_LANGUAGE_OUTPUT (path), INPUT_LANGUAGE_REPETITIONS (default 3),
 * INPUT_LANGUAGE_SENTENCES (file name in this directory, default sentences.json).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalMemory, InMemoryVectorStore } from '@usetheo/memory';
import { OpenAILLM } from '@usetheo/memory/llms/openai';

interface Sentence { readonly id: string; readonly language: string; readonly opening: string; readonly text: string; readonly readerAmbiguous?: boolean }
interface Row { readonly id: string; readonly language: string; readonly opening: string; readonly repetition: number; readonly identified: string }

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

const output = resolve(requiredEnv('INPUT_LANGUAGE_OUTPUT'));
requiredEnv('OPENAI_API_KEY');
const repetitions = Number(process.env['INPUT_LANGUAGE_REPETITIONS'] ?? '3');
const here = dirname(fileURLToPath(import.meta.url));
// A sentence the blind reader could read as two languages has no single right answer and is left out.
const sentences = (JSON.parse(readFileSync(resolve(here, process.env['INPUT_LANGUAGE_SENTENCES'] ?? 'sentences.json'), 'utf8')) as Sentence[]).filter((sentence) => sentence.readerAmbiguous !== true);

class StopAfterIdentification extends Error {}

async function identify(sentence: Sentence): Promise<string> {
  const real = new OpenAILLM();
  let identified = 'none';
  const llm = {
    async generateResponse(messages: readonly { role: string; content: string }[], format?: { type: 'json' | 'text' }): Promise<unknown> {
      if (!(messages[0]?.content ?? '').startsWith('Name the language')) throw new StopAfterIdentification();
      const raw = await real.generateResponse(messages as never, format);
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      identified = /"language"\s*:\s*\\?"([A-Za-z-]+)/u.exec(text)?.[1]?.toLowerCase() ?? 'malformed';
      return raw;
    },
    generateChat(): Promise<never> {
      return Promise.reject(new StopAfterIdentification());
    },
  };
  const memory = await createLocalMemory({
    vectorStore: new InMemoryVectorStore(),
    embedder: { embed: async () => [1, 0, 0], embedBatch: async (texts) => texts.map(() => [1, 0, 0]) },
    llm,
    embeddingDim: 3,
    entityBoost: false,
  });
  try {
    await memory.user(`input-language-${sentence.id}`).remember(sentence.text);
  } catch {
    // The write is stopped on purpose after the identification call.
  } finally {
    await memory.dispose();
  }
  return identified;
}

const jobs = sentences.flatMap((sentence) => Array.from({ length: repetitions }, (_, repetition) => ({ sentence, repetition })));
const rows: Row[] = [];
let cursor = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let index = cursor++; index < jobs.length; index = cursor++) {
    const { sentence, repetition } = jobs[index] as (typeof jobs)[number];
    rows.push({ id: sentence.id, language: sentence.language, opening: sentence.opening, repetition, identified: await identify(sentence) });
  }
}));
rows.sort((a, b) => a.id.localeCompare(b.id) || a.repetition - b.repetition);
const correct = rows.filter((row) => row.identified === row.language).length;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ sentences: sentences.length, repetitions, correct, rows }, null, 1));
console.log(JSON.stringify({ sentences: sentences.length, repetitions, answers: rows.length, correct }));
