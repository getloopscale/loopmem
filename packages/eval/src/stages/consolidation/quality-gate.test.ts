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

  it('fails a metric the report does not carry instead of passing it', () => {
    expect(evaluateReport(report, [{ path: 'summary.questions.past.stale', max: 0 }])).toEqual([
      'summary.questions.past.stale is missing from the report',
    ]);
  });
});
