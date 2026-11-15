/**
 * Regression gate over the reports of `write-run.ts` and `judge-run.ts`.
 *
 * Each check in the limits file names a report and the metrics to hold in it, by dotted path into
 * the report JSON (a path ending in `length` reads the length of an array). The limits are the
 * values of the last accepted decision on that case set, with the margin written next to them. A
 * metric the report does not carry fails the gate: a renamed field must not pass silently.
 *
 * Usage: quality-gate.ts <limits.json> <reports directory>. Exits 1 and lists every violation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MetricLimit {
  readonly path: string;
  readonly max?: number;
  readonly min?: number;
}

export interface ReportCheck {
  readonly name: string;
  readonly report: string;
  readonly metrics: readonly MetricLimit[];
}

/** The number at `path` in `report`, or undefined when the path does not lead to a number or an array length. */
export function readMetric(report: unknown, path: string): number | undefined {
  let node: unknown = report;
  for (const key of path.split('.')) {
    if (key === 'length' && Array.isArray(node)) return node.length;
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'number' ? node : undefined;
}

/** One line per metric outside its limit; empty when the report holds every limit. */
export function evaluateReport(report: unknown, metrics: readonly MetricLimit[]): string[] {
  const violations: string[] = [];
  for (const { path, max, min } of metrics) {
    const value = readMetric(report, path);
    if (value === undefined) {
      violations.push(`${path} is missing from the report`);
      continue;
    }
    if (max !== undefined && value > max) violations.push(`${path} is ${String(value)}, above the maximum of ${String(max)}`);
    if (min !== undefined && value < min) violations.push(`${path} is ${String(value)}, below the minimum of ${String(min)}`);
  }
  return violations;
}

function main(limitsPath: string, reportsDir: string): void {
  const checks = (JSON.parse(readFileSync(limitsPath, 'utf8')) as { checks: ReportCheck[] }).checks;
  let failed = 0;
  for (const check of checks) {
    const report: unknown = JSON.parse(readFileSync(join(reportsDir, check.report), 'utf8'));
    const violations = evaluateReport(report, check.metrics);
    console.log(`[quality-gate] ${check.name}: ${violations.length === 0 ? 'pass' : 'FAIL'}`);
    for (const violation of violations) console.log(`  ${violation}`);
    failed += violations.length;
  }
  if (failed > 0) process.exit(1);
}

const [limitsArg, reportsArg] = process.argv.slice(2);
if (limitsArg !== undefined && reportsArg !== undefined) main(limitsArg, reportsArg);
