import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CompromiseEntityExtractor } from './compromise-entity-extractor.js';

describe('CompromiseEntityExtractor with its default loader (#243)', () => {
  it('reads noun phrases with the NLP package, not word pairs', () => {
    const names = new CompromiseEntityExtractor().extract('Barnaby has always been afraid of wasps.').map((entity) => entity.name);

    expect(names).toContain('Barnaby');
    expect(names).toContain('wasps');
    expect(names).not.toContain('has always');
    expect(names).not.toContain('afraid');
  });

  it('does not load the package through a bare require, which an ES module does not have', () => {
    const source = readFileSync(new URL('./compromise-entity-extractor.ts', import.meta.url), 'utf8');
    const code = source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');

    expect(code).not.toMatch(/(?<![\w.])require\(/u);
    expect(code).toMatch(/createRequire\(import\.meta\.url\)/u);
  });
});
