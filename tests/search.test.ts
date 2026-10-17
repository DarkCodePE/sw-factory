import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSearch } from '../src/search/index.ts';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fab-search-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'calc.py'), 'def add(a, b):\n    return a + b\n');
  writeFileSync(join(root, 'README.md'), 'toy\n-rf flag mention\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

for (const backend of ['fff', 'rg'] as const) {
  test(`${backend}: finds files and grep hits`, async () => {
    const s = await openSearch(root, backend);
    try {
      expect(s.name).toBe(backend);
      expect((await s.files('calc')).map((f) => f.path)).toContain('src/calc.py');
      const hits = await s.grep('def add');
      expect(hits[0]).toMatchObject({ path: 'src/calc.py', line: 1 });
    } finally {
      s.close();
    }
  });

  test(`${backend}: a pattern starting with "-" is searched, not parsed as a flag`, async () => {
    const s = await openSearch(root, backend);
    try {
      const hits = await s.grep('-rf');
      expect(hits.map((h) => h.path)).toContain('README.md');
    } finally {
      s.close();
    }
  });
}
