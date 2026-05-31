import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'compare.html'), 'utf8');

const START = '// ===== PURE CORE START =====';
const END = '// ===== PURE CORE END =====';
const s = html.indexOf(START), e = html.indexOf(END);
if (s < 0 || e < 0) throw new Error('pure-core markers not found in compare.html');
const coreSrc = html.slice(s, e);

// Run in the host realm (vm.runInThisContext) so that array/object literals
// produced by core functions are host-realm instances and pass deepStrictEqual.
// We temporarily attach the collector to globalThis, then remove it.
let collected = null;
globalThis.__COLLECT_CORE__ = (o) => { collected = o; };
try {
  vm.runInThisContext(coreSrc, { filename: 'compare-core.js' });
} finally {
  delete globalThis.__COLLECT_CORE__;
}
if (!collected) throw new Error('core collector did not run');

export const core = collected;
