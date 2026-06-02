// Regression tests for the 2026-06-02 full-audit fixes (groups A..).
// Loads index.html's inline <script> into a node:vm DOM-shim and exercises the
// pure CSV functions behaviorally; locks the rest with source contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const SRC = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
assert.ok(SRC, 'found inline <script>');

function makeEl() {
  const el = {
    style: {}, dataset: {}, _html: '', _text: '', checked: false, value: '', disabled: false, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    remove() {}, focus() {}, blur() {}, click() {}, closest() { return null; },
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = v; } });
  Object.defineProperty(el, 'textContent', { get() { return el._text; }, set(v) { el._text = v; } });
  return el;
}
function loadPage() {
  const reg = new Map();
  const get = (s) => { if (!reg.has(s)) reg.set(s, makeEl()); return reg.get(s); };
  const document = {
    querySelector: get, getElementById: (id) => get('#' + id),
    querySelectorAll: (s) => (s === '.detail-foot [data-status]' ? [makeEl(), makeEl(), makeEl()] : []),
    createElement: makeEl, documentElement: makeEl(), body: makeEl(), addEventListener() {},
  };
  const ctx = {
    document, addEventListener() {}, removeEventListener() {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, key() { return null; }, clear() {}, length: 0 },
    console, alert() {},
    MutationObserver: class { observe() {} disconnect() {} },
    URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
    matchMedia() { return { matches: false, addEventListener() {}, addListener() {} }; },
    navigator: { userAgent: 'node', storage: undefined },
    setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {},
  };
  ctx.globalThis = ctx; ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'index-inline.js' });
  return ctx;
}

test('inline <script> compiles', () => { assert.doesNotThrow(() => new vm.Script(SRC)); });

// M1: header dedup must not break Object.prototype-named columns
test('M1 csvToObjects keeps a column literally named "toString"/"constructor"', () => {
  const ctx = loadPage();
  const { header, rows } = ctx.csvToObjects(ctx.parseCSV('toString,constructor,id\na,b,1', ','));
  assert.equal(header.join('|'), 'toString|constructor|id'); // join: vm-realm arrays fail deepStrictEqual
  assert.equal(rows[0].toString, 'a');
  assert.equal(rows[0].constructor, 'b');
  assert.equal(rows[0].id, '1');
});
test('M1 genuine duplicate columns still get _2 suffix (unchanged behavior)', () => {
  const ctx = loadPage();
  const { header } = ctx.csvToObjects(ctx.parseCSV('x,x,y', ','));
  assert.equal(header.join('|'), 'x|x_2|y');
});

// L1: quoted tabs in a comma CSV must NOT be sniffed as TSV
test('L1 sniffDelim: quoted field containing tabs stays comma-delimited', () => {
  const ctx = loadPage();
  assert.equal(ctx.sniffDelim('"a\tb\tc",label,image\n1,2,3', 'data.csv'), ',');
  assert.equal(ctx.sniffDelim('a\tb\tc\n1\t2\t3', 'data.csv'), '\t');
  assert.equal(ctx.sniffDelim('whatever', 'x.tsv'), '\t');
});

// L2: deformula strips the injection-guard quote before TAB/CR too
test('L2 deformula symmetric: leading quote before TAB is stripped on import', () => {
  const ctx = loadPage();
  const { rows } = ctx.csvToObjects(ctx.parseCSV('col\n"\'\t1"', ','));
  assert.equal(rows[0].col, '\t1');
  const { rows: r2 } = ctx.csvToObjects(ctx.parseCSV("col\n'=1+1", ','));
  assert.equal(r2[0].col, '=1+1');
});

const contracts = [
  ['M1 null-proto seen', /const seen = Object\.create\(null\)/],
  ['M2 ragged warning', /行列数多于表头/],
  ['L1 countFields', /const countFields = \(s, d\) =>/],
  ['H4 orphan-cascade else', /父值切回、子分支重新激活/],
];
for (const [name, re] of contracts) {
  test('fix present: ' + name, () => assert.ok(re.test(SRC), name + ' not found'));
}

// ---------- Group B ----------
test('B datasetFingerprint is deterministic and content-sensitive', () => {
  const ctx = loadPage();
  const a = ctx.datasetFingerprint(['id', 'label'], 100);
  assert.equal(a, ctx.datasetFingerprint(['id', 'label'], 100));   // deterministic
  assert.notEqual(a, ctx.datasetFingerprint(['id', 'label'], 101)); // row count change
  assert.notEqual(a, ctx.datasetFingerprint(['id', 'name'], 100));  // header change
  assert.equal(typeof a, 'string');
});
const groupB = [
  ['B persist() requested', /navigator\.storage\.persist\(\)/],
  ['B persisted() guard', /navigator\.storage\.persisted/],
  ['B throttled storage warn', /_storeWriteCount % 30/],
  ['B safeSet warns on success', /localStorage\.setItem\(key, val\); maybeWarnStorage\(\)/],
  ['B initApp requests persistence', /requestPersistentStorage\(\);/],
  ['B import sample union (H2)', /抽样 id 取并集/],
  ['B import config keeps local (H2)', /本地工作状态优先/],
  ['B import tsOf reads at', /v\.reviewed_at \|\| v\.annotated_at \|\| v\.at/],
  ['B H1 guard on CSV load', /guardDatasetIdentity\(pendingCSV\.name/],
  ['B M3 clearDetail saves draft', /切到空过滤前先存草稿/],
];
for (const [name, re] of groupB) {
  test('fix present: ' + name, () => assert.ok(re.test(SRC), name + ' not found'));
}

// ---------- Group C ----------
const groupC = [
  ['C H3 annotate filename id', /annotation_id: f\.name, image: f\.name/],
  ['C H3 ensureUniqueIds on annotate', /image: f\.name \}\)\); \/\/ H3[\s\S]{0,80}ensureUniqueIds\(state\.rows\)/],
  ['C H3 migration helper', /function migrateAnnotateIndexIds\(orderedImgs\)/],
  ['C H3 migration is non-destructive', /localStorage\.getItem\(newK\) == null\) localStorage\.setItem\(newK, ov\)/],
  ['C H3 migration call', /migrateAnnotateIndexIds\(imgs\)/],
  ['C ZIP frees second copy', /entries\.forEach\(en => \{ en\.data = null; \}\)/],
  ['C ZIP large-pack warning', /MB 图片会常驻内存/],
  ['C zip compat message FF/Safari', /Firefox 113\+ · Safari 16\.4\+/],
  ['C zip deflate-raw try/catch', /浏览器可能不支持 deflate-raw/],
  ['C mobile folder hint', /手机\/平板浏览器无法选择整个图片文件夹/],
  ['C L4 LRU cap 64', /imgUrlCache\.size > 64/],
  ['C L4 bidirectional prefetch', /\[nextVisibleIndex\(idx\), prevVisibleIndex\(idx\)\]/],
];
for (const [name, re] of groupC) {
  test('fix present: ' + name, () => assert.ok(re.test(SRC), name + ' not found'));
}

// ---------- Group D (Flask + compare.html) ----------
import { readFileSync as _rf } from 'node:fs';
test('D app.py caches a single SQLite connection (L5)', () => {
  const py = _rf(path.join(here, '..', 'app.py'), 'utf8');
  assert.ok(/_CONN = None/.test(py) && /if _CONN is None:/.test(py), 'connection caching not found');
});
test('D compare.html has a solid color-mix fallback', () => {
  const cmp = _rf(path.join(here, '..', 'compare.html'), 'utf8');
  assert.ok(/tr\.r-chg\{background:var\(--chg-bg\);background:color-mix/.test(cmp), 'color-mix fallback not found');
});
