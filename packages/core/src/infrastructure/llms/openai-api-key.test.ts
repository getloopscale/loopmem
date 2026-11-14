import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructed: { apiKey?: string }[] = [];
const chatCreate = vi.fn();
const embedCreate = vi.fn();

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: chatCreate } };
    embeddings = { create: embedCreate };
    constructor(options: { apiKey?: string }) {
      constructed.push(options);
    }
  },
}));

const { OpenAILLM } = await import('./openai.js');
const { OpenAIEmbedder } = await import('../embedders/openai.js');

describe('an explicit OpenAI key (#218)', () => {
  beforeEach(() => {
    constructed.length = 0;
    chatCreate.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });
    embedCreate.mockResolvedValue({ data: [{ embedding: [0.1] }] });
  });

  it('gives the LLM a client of its own, built with that key', async () => {
    await new OpenAILLM({ apiKey: 'key-one' }).generateResponse([{ role: 'user', content: 'hi' }]);
    await new OpenAILLM({ apiKey: 'key-two' }).generateResponse([{ role: 'user', content: 'hi' }]);
    expect(constructed.map((options) => options.apiKey)).toEqual(['key-one', 'key-two']);
  });

  it('gives the embedder a client of its own, built with that key', async () => {
    await new OpenAIEmbedder({ apiKey: 'key-one' }).embed('hi');
    await new OpenAIEmbedder({ apiKey: 'key-two' }).embed('hi');
    expect(constructed.map((options) => options.apiKey)).toEqual(['key-one', 'key-two']);
  });

  it('builds the client once per instance', async () => {
    const llm = new OpenAILLM({ apiKey: 'key-one' });
    await llm.generateResponse([{ role: 'user', content: 'a' }]);
    await llm.generateResponse([{ role: 'user', content: 'b' }]);
    expect(constructed).toHaveLength(1);
  });

  it('rejects an empty key', () => {
    expect(() => new OpenAILLM({ apiKey: '' })).toThrow(RangeError);
    expect(() => new OpenAIEmbedder({ apiKey: ' ' })).toThrow(RangeError);
  });
});
