import type { Tracer } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import type { LLM } from '../dip/llm.js';
import type { Message } from '../message.js';

import { recoverWeighedMatters, WEIGHING_CHECK_PROMPT } from './weighing-check.js';

const undecided: Message = { role: 'user', content: 'I might take a sabbatical from work, but I am really unsure.' };

function llmReturning(response: unknown): LLM {
  return { generateResponse: vi.fn(async () => response), generateChat: vi.fn(async () => ({ role: 'assistant' as const, content: '' })) };
}

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

describe('recoverWeighedMatters', () => {
  it('returns what the person is weighing as a stated, undecided fact with its quote', async () => {
    const llm = llmReturning({ weighing: [{ about: 'is considering a sabbatical from work', quote: 'I might take a sabbatical from work' }] });
    const events: Recorded[] = [];

    expect(await recoverWeighedMatters(llm, [undecided], recordingTracer(events))).toEqual([
      { id: '1', text: 'user is considering a sabbatical from work', evidence: { kind: 'stated', durability: 'tentative', sourceQuote: 'I might take a sabbatical from work' } },
    ]);
    const sent = vi.mocked(llm.generateResponse).mock.calls[0]?.[0];
    expect(sent?.[0]?.content).toBe(WEIGHING_CHECK_PROMPT);
    expect(sent?.[1]?.content).toBe(undecided.content);
    expect(events).toEqual([{ event: 'extraction_weighing_check_recovered', attributes: { facts: 1 } }]);
  });

  it('returns nothing, and reports nothing, when the message weighs no lasting matter', async () => {
    const events: Recorded[] = [];
    expect(await recoverWeighedMatters(llmReturning({ weighing: [] }), [undecided], recordingTracer(events))).toEqual([]);
    expect(events).toEqual([]);
  });

  it('drops an answer whose quote is not in the message', async () => {
    const llm = llmReturning({ weighing: [{ about: 'is thinking of moving abroad', quote: 'I may move abroad' }] });
    expect(await recoverWeighedMatters(llm, [undecided], undefined)).toEqual([]);
  });

  it('accepts a quote that differs in case and spacing, and a response sent as a string', async () => {
    const llm = llmReturning(JSON.stringify({ weighing: [{ about: 'is considering a sabbatical', quote: 'i MIGHT  take a sabbatical' }] }));
    expect(await recoverWeighedMatters(llm, [undecided], undefined)).toHaveLength(1);
  });

  it('asks only about the three most recent messages a user wrote', async () => {
    const llm = llmReturning({ weighing: [] });
    const messages: Message[] = [
      { role: 'user', content: 'one' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'two' },
      { role: 'user', content: 'three' }, { role: 'user', content: 'four' },
    ];
    await recoverWeighedMatters(llm, messages, undefined);
    expect(vi.mocked(llm.generateResponse).mock.calls.map((call) => call[0][1]?.content).sort()).toEqual(['four', 'three', 'two']);
  });

  it('does not ask about a message that only asks something', async () => {
    const llm = llmReturning({ weighing: [{ about: 'está pensando em mandar currículo', quote: 'mandar currículo' }] });
    const questions: Message[] = [
      { role: 'user', content: 'Vale a pena mandar currículo para a Tamsin Logistics?' },
      { role: 'user', content: 'Is it a good employer? Or do people leave quickly?' },
      { role: 'user', content: '転職したほうがいいですか？' },
    ];
    expect(await recoverWeighedMatters(llm, questions, undefined)).toEqual([]);
    expect(llm.generateResponse).not.toHaveBeenCalled();
  });

  it('still asks about a message that states something next to its question', async () => {
    const llm = llmReturning({ weighing: [{ about: 'is thinking of moving abroad', quote: "I can't decide whether to move abroad" }] });
    const mixed: Message = { role: 'user', content: "I can't decide whether to move abroad. What would you weigh?" };
    expect(await recoverWeighedMatters(llm, [mixed], undefined)).toHaveLength(1);
  });

  it('reports a failed or malformed call and recovers nothing, without throwing', async () => {
    const events: Recorded[] = [];
    const failing: LLM = { generateResponse: vi.fn(async () => { throw new TypeError('down'); }), generateChat: vi.fn(async () => ({ role: 'assistant' as const, content: '' })) };
    expect(await recoverWeighedMatters(failing, [undecided], recordingTracer(events))).toEqual([]);
    expect(await recoverWeighedMatters(llmReturning({ nope: 1 }), [undecided], recordingTracer(events))).toEqual([]);
    expect(events.map((e) => e.event)).toEqual(['extraction_weighing_check_failed', 'extraction_weighing_check_failed']);
  });
});
