import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'compare.html'), 'utf8');

test('inline <script> compiles (catches escaping/template breakage)', () => {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'found an inline <script> block');
  // compile-only: does not execute, so undefined DOM globals are irrelevant
  assert.doesNotThrow(() => { new vm.Script(m[1], { filename: 'compare-inline.js' }); });
});
