import { describe, expect, it } from 'vitest';

import { evaluateReport, readMetric } from './quality-gate.js';

const report = {
  summary: {
    questions: { current: { total: 18, stale: 0 } },
    distinctMissing: [],
    answerLostByReflect: ['q1', 'q2'],
  },
};

describe('readMetric', () => {
  it('reads a number at a dotted path', () => {
    expect(readMetric(report, 'summary.questions.current.stale')).toBe(0);
  });

  it('reads the length of an array when the path ends in length', () => {
    expect(readMetric(report, 'summary.answerLostByReflect.length')).toBe(2);
  });

  it('gives undefined for a path the report does not have', () => {
    expect(readMetric(report, 'summary.questions.past.stale')).toBeUndefined();
  });
});

describe('evaluateReport', () => {
  it('passes a report whose every metric is within its limit', () => {
    expect(evaluateReport(report, [{ path: 'summary.questions.current.stale', max: 1 }, { path: 'summary.questions.current.total', min: 18 }])).toEqual([]);
  });

  it('names the metric, its value and its limit when a maximum is exceeded', () => {
    expect(evaluateReport(report, [{ path: 'summary.answerLostByReflect.length', max: 1 }])).toEqual([
      'summary.answerLostByReflect.length is 2, above the maximum of 1',
    ]);
  });

  it('names the metric when it falls below a minimum', () => {
    expect(evaluateReport(report, [{ path: 'summary.questions.current.total', min: 19 }])).toEqual([
      'summary.questions.current.total is 18, below the minimum of 19',
    ]);
  });

  it('adds the values of several paths and names the sum by its label', () => {
    const answered = { summary: { questions: { a: { answer: 3 }, b: { answer: 4 } } } };
    expect(evaluateReport(answered, [{ label: 'answered', sum: ['summary.questions.a.answer', 'summary.questions.b.answer'], min: 8 }])).toEqual([
      'answered is 7, below the minimum of 8',
    ]);
  });

  it('fails a sum when one of its paths is missing', () => {
    expect(evaluateReport(report, [{ label: 'answered', sum: ['summary.questions.current.total', 'summary.questions.past.total'], min: 0 }])).toEqual([
      'answered is missing from the report (summary.questions.past.total)',
    ]);
  });

  it('fails a metric the report does not carry instead of passing it', () => {
    expect(evaluateReport(report, [{ path: 'summary.questions.past.stale', max: 0 }])).toEqual([
      'summary.questions.past.stale is missing from the report',
    ]);
  });
});
