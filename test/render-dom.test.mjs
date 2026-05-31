// Headless integration test for compare.html's DOM render pipeline.
// Loads the real inline <script> into a vm with a minimal DOM stub, drives
// loadInto() with the 3 fixtures, and asserts the rendered table HTML.
// No browser, no dependencies — pairs with compare-core.test.mjs (pure logic)
// to cover the render/wiring layer that unit tests can't reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'compare.html'), 'utf8');
const scriptSrc = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
assert.ok(scriptSrc, 'found inline <script>');

function makeEl(){
  const el = {
    style:{}, dataset:{}, _html:'', _text:'', checked:false, value:'', disabled:false,
    classList:{ add(){}, remove(){}, toggle(){} },
    appendChild(){}, addEventListener(){}, setAttribute(){}, removeAttribute(){},
    querySelector(){ return makeEl(); }, querySelectorAll(){ return []; },
  };
  Object.defineProperty(el, 'innerHTML', { get(){ return el._html; }, set(v){ el._html = v; } });
  Object.defineProperty(el, 'textContent', { get(){ return el._text; }, set(v){ el._text = v; } });
  return el;
}

function loadPage(){
  const reg = new Map();
  const document = {
    querySelector(sel){ if(!reg.has(sel)) reg.set(sel, makeEl()); return reg.get(sel); },
    querySelectorAll(){ return []; },
    createElement(){ return makeEl(); },
    documentElement: makeEl(),
    addEventListener(){},
  };
  const ctx = {
    document,
    localStorage: { getItem(){ return null; }, setItem(){} },
    console, alert(){},
  };
  ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(scriptSrc, ctx, { filename: 'compare-inline.js' });
  return ctx;
}

const A = 'annotation_id,label,score,onlyA\n1,cat,0.9,x\n2,cat,0.8,y\n3,dog,0.5,z\n';
const B = 'annotation_id,label,score\n1,cat,0.9\n2,dog,0.8\n';
const C = 'annotation_id,label,score\n1,cat,0.9\n2,cat,0.6\n4,bird,0.7\n';

test('render pipeline: 3 files produce the correct N-way table', () => {
  const ctx = loadPage();
  ctx.addSlot();                                            // page starts with 2 slots; add a 3rd
  ctx.document.querySelector('#diff-only').checked = false; // show all rows incl. agree
  ctx.loadInto(0, 'a.csv', A);
  ctx.loadInto(1, 'b.csv', B);
  ctx.loadInto(2, 'c.csv', C);

  const $ = (s) => ctx.document.querySelector(s).innerHTML;

  // summary: 1 agree, 3 diff (key 1 agree; 2 diff; 3 missing b,c; 4 missing a,b)
  const summary = $('#summary');
  assert.match(summary, /分歧 3/, 'summary diff count');
  assert.match(summary, /一致 1/, 'summary agree count');
  assert.match(summary, /3 份/, 'file count');
  assert.match(summary, /对比 2 个公共字段/, 'compared field count (onlyA excluded)');

  // note: onlyA is in only one file -> ignored
  assert.match($('#col-note'), /onlyA/, 'ignored column note');

  // two-level header: field groups span n+1 (=4) cols, with per-file labels + 共识
  const thead = $('#diff-table thead');
  for (const lb of ['文件1','文件2','文件3','共识','label','score']) assert.match(thead, new RegExp(lb), 'header has '+lb);
  assert.match(thead, /colspan="4"/, 'field group spans 4 cols (3 files + consensus)');

  const tbody = $('#diff-table tbody');
  // 4 data rows shown
  assert.equal((tbody.match(/<tr/g) || []).length, 4, '4 rows rendered');
  // outliers highlighted: file2 label "dog" and file3 score "0.6" carry the changed class
  assert.match(tbody, /class="changed"[^>]*><span class="new">dog<\/span>/, 'dog outlier highlighted');
  assert.match(tbody, /class="changed"[^>]*><span class="new">0\.6<\/span>/, '0.6 outlier highlighted');
  // consensus cells show majority + ratio
  assert.match(tbody, /cat <span[^>]*>\(2:1\)/, 'label consensus cat (2:1)');
  assert.match(tbody, /0\.8 <span[^>]*>\(2:1\)/, 'score consensus 0.8 (2:1)');
  // missing-file cells render ∅, and the row badge notes the missing file
  assert.match(tbody, /∅/, 'missing cells show ∅');
  assert.match(tbody, /缺 文件2,文件3/, 'key 3 missing in files 2 and 3');
  assert.match(tbody, /缺 文件1,文件2/, 'key 4 missing in files 1 and 2');
  // status badges present
  assert.match(tbody, /一致/, 'agree badge');
  assert.match(tbody, /分歧/, 'diff badge');

  assert.match(ctx.document.querySelector('#shown-count').textContent, /显示 4 \/ 4 行/, 'shown count');
});

test('diff-only filter hides the agree row', () => {
  const ctx = loadPage();
  ctx.addSlot();
  ctx.document.querySelector('#diff-only').checked = true; // hide agree rows
  ctx.loadInto(0, 'a.csv', A);
  ctx.loadInto(1, 'b.csv', B);
  ctx.loadInto(2, 'c.csv', C);
  const tbody = ctx.document.querySelector('#diff-table tbody').innerHTML;
  assert.equal((tbody.match(/<tr/g) || []).length, 3, 'only 3 diff rows shown');
  assert.match(ctx.document.querySelector('#shown-count').textContent, /显示 3 \/ 4 行/);
});

test('fewer than 2 loaded files: key-select disabled, no result card', () => {
  const ctx = loadPage();
  ctx.loadInto(0, 'a.csv', A); // only one file loaded
  assert.equal(ctx.document.querySelector('#key-select').disabled, true, 'key-select disabled');
  assert.equal(ctx.document.querySelector('#result-card').style.display, 'none', 'result hidden');
});
