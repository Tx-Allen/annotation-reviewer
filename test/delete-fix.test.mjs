// Regression tests for the "有的时候无法点击删除" (delete/exclude button) fixes.
// index.html is a single-file SPA; we load its inline <script> into a node:vm
// with a minimal DOM shim (same approach as render-dom.test.mjs for compare.html).
//
// Covers:
//   1. inline script still compiles (no syntax breakage from the patch)
//   2. BEHAVIORAL: clearDetail() disables #exclude-btn + the [data-status] buttons
//      (the bug was: button stayed enabled-looking but excludeCurrent() no-op'd)
//   3. SOURCE CONTRACT: every one of the 9 fixes is present, so they can't
//      silently regress in a future refactor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const scriptSrc = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
assert.ok(scriptSrc, 'found inline <script> in index.html');

// ---------- 1. compile ----------
test('index.html inline <script> compiles', () => {
  assert.doesNotThrow(() => { new vm.Script(scriptSrc, { filename: 'index-inline.js' }); });
});

// ---------- DOM shim ----------
function makeEl() {
  const el = {
    style: {}, dataset: {}, _html: '', _text: '', checked: false, value: '',
    disabled: false, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, addEventListener() {}, removeEventListener() {},
    setAttribute() {}, removeAttribute() {}, remove() {}, focus() {}, blur() {}, click() {},
    closest() { return null; },
    querySelector() { return makeEl(); }, querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'innerHTML', { get() { return el._html; }, set(v) { el._html = v; } });
  Object.defineProperty(el, 'textContent', { get() { return el._text; }, set(v) { el._text = v; } });
  return el;
}

function loadPage() {
  const reg = new Map();                       // selector -> element (stable identity)
  const statusBtns = [makeEl(), makeEl(), makeEl()]; // the pass/fail/doubt buttons
  const get = (sel) => { if (!reg.has(sel)) reg.set(sel, makeEl()); return reg.get(sel); };
  const document = {
    querySelector(sel) { return get(sel); },
    getElementById(id) { return get('#' + id); },   // share identity with querySelector('#id')
    querySelectorAll(sel) {
      if (sel === '.detail-foot [data-status]') return statusBtns;
      return [];
    },
    createElement() { return makeEl(); },
    documentElement: makeEl(),
    body: makeEl(),
    addEventListener() {},
  };
  const alerts = [];
  const ctx = {
    document,
    addEventListener() {}, removeEventListener() {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {}, key() { return null; }, clear() {}, length: 0 },
    console,
    alert(m) { alerts.push(m); },
    MutationObserver: class { observe() {} disconnect() {} },
    URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
    matchMedia() { return { matches: false, addEventListener() {}, addListener() {}, removeListener() {} }; },
    setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {},
  };
  ctx.globalThis = ctx; ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(scriptSrc, ctx, { filename: 'index-inline.js' });
  return { ctx, excludeBtn: get('#exclude-btn'), statusBtns, alerts };
}

// ---------- 2. behavioral: clearDetail disables the footer action buttons ----------
test('clearDetail() disables #exclude-btn and the [data-status] buttons', () => {
  const { ctx, excludeBtn, statusBtns } = loadPage();
  assert.equal(typeof ctx.clearDetail, 'function', 'clearDetail is a global function');

  // precondition: buttons start enabled
  excludeBtn.disabled = false;
  statusBtns.forEach(b => { b.disabled = false; });

  ctx.clearDetail();   // the no-visible-row state that used to leave a live-but-dead button

  assert.equal(excludeBtn.disabled, true, '#exclude-btn must be disabled when no row is selected');
  statusBtns.forEach((b, i) => assert.equal(b.disabled, true, `status button ${i} must be disabled`));
});

// ---------- 3. source contract: all 9 fixes present ----------
const SRC = scriptSrc;
const FULL = html;   // includes <style> for CSS contracts
const contracts = [
  ['A .btn:disabled style',                /\.btn:disabled\s*\{[^}]*cursor:\s*not-allowed/,                       FULL],
  ['B drawer overlay pointer-events:none', /\.app\.drawer-open::after\s*\{[^}]*pointer-events:\s*none/,           FULL],
  ['C selectIndex re-enables buttons',     /state\.index = idx;[\s\S]{0,200}#exclude-btn'\); if \(xb\) xb\.disabled = false/, SRC],
  ['D clearDetail disables buttons',       /state\.index = -1;[\s\S]{0,200}#exclude-btn'\); if \(xb\) xb\.disabled = true/,   SRC],
  ['E doExclude alerts on quota fail',     /浏览器存储已满，本次「排除」没有保存/,                                SRC],
  ['F lightbox swallows only after drag',  /lb\.addEventListener\('click', \(e\) => \{ if \(moved\) \{ e\.stopPropagation/, SRC],
  ['F2 old stuck condition removed',       /if \(scale > 1 \|\| moved\) \{ e\.stopPropagation/,                   SRC, /*absent=*/true],
  ['G lightbox resets on open+close',      /new MutationObserver\(\(\) => \{ reset\(\); \}\)\.observe\(lb/,        SRC],
  ['H initApp clears leftover overlays',   /document\.querySelectorAll\('\.modal\.show'\)\.forEach\(m => m\.classList\.remove\('show'\)\)/, SRC],
  ['J detail-head reserves toggle corner', /\.detail-head \{[^}]*padding-right: 130px/, FULL],
  ['I distribute-modal backdrop close',    /#distribute-modal'\)\.addEventListener\('click', \(e\) => \{ if \(e\.target\.id === 'distribute-modal'\)/, SRC],
];

for (const [name, re, body, mustBeAbsent] of contracts) {
  test('fix present: ' + name, () => {
    const found = re.test(body);
    if (mustBeAbsent) assert.equal(found, false, name + ' — old buggy code must be gone');
    else assert.ok(found, name + ' — expected patched code not found');
  });
}
