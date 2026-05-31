# N-way CSV Side-by-Side Compare — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `compare.html` from a fixed 2-CSV (old/new) diff into an N-CSV side-by-side consensus comparison with per-cell majority vote and outlier highlighting.

**Architecture:** Keep `compare.html` a self-contained, client-side-only static file. The pure comparison logic lives in one DOM-free block delimited by `// ===== PURE CORE START/END =====` markers inside the inline `<script>`. A Node test (`node:test` + `node:vm`, no deps) extracts that block and unit-tests it. DOM/render/export code stays outside the markers and is verified by a compile-check test plus a scripted manual pass.

**Tech Stack:** Vanilla HTML/CSS/JS (no framework, no build). Node v24 built-in `node:test` + `node:vm` for tests. Git on branch `feat/csv-nway-compare`.

**Spec:** `docs/superpowers/specs/2026-06-01-csv-nway-compare-design.md`

---

## File Structure

- **Modify:** `compare.html`
  - Markup: replace the two static file `.field`s with a dynamic `#inputs` container + `＋ 添加 CSV` button.
  - Inline `<script>`: add `PURE CORE START/END` markers; keep existing pure utils (`sniffDelim`, `parseCSV`, `csvToObjects`, `csvQuote`) inside them; add new pure fns (`headerIntersection`, `headerExtras`, `buildIndex`, `majorityOf`, `computeNwayDiff`); rewrite state `S`, `render()`, `exportDiff()`, and event wiring outside the markers.
- **Create:** `test/load-core.mjs` — reads `compare.html`, extracts the pure-core block, evals it in a `vm` context, exports the functions.
- **Create:** `test/compare-core.test.mjs` — unit tests for the pure core.
- **Create:** `test/syntax.test.mjs` — compiles the entire inline `<script>` to catch escaping/template breakage.

Pure-core responsibility: turn N parsed CSV files + a key column into a fully-resolved diff structure. DOM code only reads that structure.

### Canonical pure-core API (used consistently by every task)

```js
// file shape (produced by csvToObjects + a label):
//   { id:string, label:string, name:string, header:string[], rows:Array<Record<string,string>> }

headerIntersection(files) -> string[]              // columns present in ALL files, in files[0].header order
headerExtras(files, common) -> string[]            // columns present in some-but-not-all files
buildIndex(file, keyCol) -> { map:Map<string,row>, dup:number }   // first occurrence wins; dup counts skipped
majorityOf(presentValues:string[]) -> { majority:string|null, top:number, present:number, tie:boolean }
computeNwayDiff(files, keyCol) -> {
  keyCol, labels:string[], fields:string[], onlySomeCols:string[],
  rows: Array<{
    key:string, status:'agree'|'diff', missingIn:string[],
    cells: Record<field, {
      values: Array<{ label:string, value:string, present:boolean, outlier:boolean }>,
      majority:string|null, agree:string, fieldAgree:boolean
    }>
  }>,
  counts:{ agree:number, diff:number }, dup:number
}
```

---

### Task 1: Test harness + `headerIntersection` (TDD)

**Files:**
- Modify: `compare.html` (add markers around existing utils; add `headerIntersection` + `headerExtras`; add export collector line)
- Create: `test/load-core.mjs`
- Create: `test/compare-core.test.mjs`

- [ ] **Step 1: Add pure-core markers + export collector in `compare.html`**

In the inline `<script>`, wrap the existing block from `let lastCsvWarnings = [];` through the end of `function csvQuote(...){...}` with markers, and append the collector as the LAST line before the END marker. `esc`, `downloadFile`, theme, and all DOM code stay OUTSIDE the markers.

Insert immediately after `function esc(...)` (which stays outside) so the core starts at the warnings var:

```js
// ===== PURE CORE START =====  (DOM-free; extracted & unit-tested by test/load-core.mjs)
let lastCsvWarnings = [];
function sniffDelim(text, name){
  if(/\.tsv$/i.test(name||'')) return '\t';
  const first=(String(text||'').split(/\r?\n/,1)[0])||'';
  const tabs=(first.match(/\t/g)||[]).length, commas=(first.match(/,/g)||[]).length;
  return tabs>commas?'\t':',';
}
function parseCSV(text, delim){
  delim=delim||','; lastCsvWarnings=[];
  const rows=[]; let row=[],field='',q=false;
  text=text.replace(/^﻿/,'');
  for(let i=0;i<text.length;i++){
    const c=text[i], n=text[i+1];
    if(q){ if(c==='"'&&n==='"'){field+='"';i++;} else if(c==='"'){q=false;} else field+=c; }
    else { if(c==='"'&&field===''){q=true;} else if(c===delim){row.push(field);field='';} else if(c==='\n'){row.push(field);rows.push(row);row=[];field='';} else if(c==='\r'){} else field+=c; }
  }
  if(q) lastCsvWarnings.push('检测到未闭合的引号,可能有行被合并或截断');
  if(field!==''||row.length){row.push(field);rows.push(row);}
  return rows;
}
function csvToObjects(rows){
  if(!rows.length) return {header:[],rows:[]};
  const seen={};
  const header=rows[0].map(h=>{h=(h==null?'':h); if(seen[h]!=null){seen[h]+=1;return `${h}_${seen[h]}`;} seen[h]=1;return h;});
  const deformula=s=>(typeof s==='string'&&/^'[=+\-@]/.test(s))?s.slice(1):s;
  const out=[];
  for(let i=1;i<rows.length;i++){
    const r=rows[i];
    if(!r.length||(r.length===1&&!r[0])) continue;
    const o={}; header.forEach((k,j)=>{o[k]=deformula(r[j]!==undefined?r[j]:'');});
    out.push(o);
  }
  return {header,rows:out};
}
function csvQuote(v){
  v=String(v??'');
  if(/^[=+\-@\t\r]/.test(v)) v="'"+v;
  return /[,"\n\r]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v;
}
function headerIntersection(files){
  if(!files.length) return [];
  return files[0].header.filter(h => files.every(f => f.header.includes(h)));
}
function headerExtras(files, common){
  const inCommon=new Set(common), extras=[], seen=new Set();
  files.forEach(f=>f.header.forEach(h=>{ if(!inCommon.has(h)&&!seen.has(h)){seen.add(h);extras.push(h);} }));
  return extras;
}
// ↓↓↓ collector MUST stay last; lists every pure fn the tests use ↓↓↓
if (typeof globalThis.__COLLECT_CORE__ === 'function') {
  globalThis.__COLLECT_CORE__({ sniffDelim, parseCSV, csvToObjects, csvQuote, headerIntersection, headerExtras, buildIndex, majorityOf, computeNwayDiff });
}
// ===== PURE CORE END =====
```

Note: `buildIndex`, `majorityOf`, `computeNwayDiff` are referenced in the collector but defined in Tasks 2–4. Add them now as empty stubs `function buildIndex(){}` `function majorityOf(){}` `function computeNwayDiff(){}` right before the collector so the script stays parseable; later tasks fill them in.

- [ ] **Step 2: Write `test/load-core.mjs`**

```js
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

let collected = null;
const context = { globalThis: null, __COLLECT_CORE__: (o) => { collected = o; } };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(coreSrc, context, { filename: 'compare-core.js' });
if (!collected) throw new Error('core collector did not run');

export const core = collected;
```

- [ ] **Step 3: Write the failing test for `headerIntersection`**

Create `test/compare-core.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { core } from './load-core.mjs';

test('headerIntersection keeps only columns present in all files, in first-file order', () => {
  const files = [
    { header: ['id', 'label', 'score', 'note'] },
    { header: ['id', 'score', 'label'] },
    { header: ['label', 'id', 'score', 'extra'] },
  ];
  assert.deepEqual(core.headerIntersection(files), ['id', 'label', 'score']);
});

test('headerExtras returns some-but-not-all columns, de-duped', () => {
  const files = [
    { header: ['id', 'label', 'note'] },
    { header: ['id', 'label', 'extra'] },
  ];
  const common = core.headerIntersection(files); // ['id','label']
  assert.deepEqual(core.headerExtras(files, common), ['note', 'extra']);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/compare-core.test.mjs`
Expected: both tests PASS (the functions exist from Step 1). If a marker/collector error appears, fix `load-core.mjs` or the marker placement.

- [ ] **Step 5: Commit**

```bash
git add compare.html test/load-core.mjs test/compare-core.test.mjs
git commit -m "test: pure-core extractor + headerIntersection/headerExtras for N-way compare"
```

---

### Task 2: `buildIndex` (generalized `buildMap`) (TDD)

**Files:**
- Modify: `compare.html` (replace the `buildIndex` stub)
- Test: `test/compare-core.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/compare-core.test.mjs`:

```js
test('buildIndex maps key->row, first occurrence wins, counts duplicates', () => {
  const file = { rows: [
    { id: 'a', v: '1' },
    { id: 'b', v: '2' },
    { id: 'a', v: '99' }, // duplicate key -> skipped, counted
  ]};
  const { map, dup } = core.buildIndex(file, 'id');
  assert.equal(dup, 1);
  assert.equal(map.get('a').v, '1');
  assert.equal(map.get('b').v, '2');
  assert.equal(map.size, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/compare-core.test.mjs`
Expected: the new test FAILS (stub returns `undefined`, so destructuring `{ map, dup }` throws).

- [ ] **Step 3: Implement `buildIndex` in `compare.html`**

Replace `function buildIndex(){}` with:

```js
function buildIndex(file, keyCol){
  const map=new Map(); let dup=0;
  file.rows.forEach(r=>{ const k=String(r[keyCol]??''); if(map.has(k)){dup++;return;} map.set(k,r); });
  return { map, dup };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/compare-core.test.mjs`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add compare.html test/compare-core.test.mjs
git commit -m "feat: buildIndex (N-way generalization of buildMap)"
```

---

### Task 3: `majorityOf` (TDD)

**Files:**
- Modify: `compare.html` (replace the `majorityOf` stub)
- Test: `test/compare-core.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append:

```js
test('majorityOf: strict majority', () => {
  assert.deepEqual(core.majorityOf(['cat','cat','dog']),
    { majority: 'cat', top: 2, present: 3, tie: false });
});
test('majorityOf: unanimous', () => {
  assert.deepEqual(core.majorityOf(['cat','cat','cat']),
    { majority: 'cat', top: 3, present: 3, tie: false });
});
test('majorityOf: 1:1 tie has no majority', () => {
  const r = core.majorityOf(['cat','dog']);
  assert.equal(r.majority, null);
  assert.equal(r.tie, true);
  assert.equal(r.top, 1);
  assert.equal(r.present, 2);
});
test('majorityOf: 2:2 tie has no majority', () => {
  const r = core.majorityOf(['a','a','b','b']);
  assert.equal(r.majority, null);
  assert.equal(r.tie, true);
});
test('majorityOf: empty -> null', () => {
  assert.deepEqual(core.majorityOf([]),
    { majority: null, top: 0, present: 0, tie: false });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/compare-core.test.mjs`
Expected: the 5 majorityOf tests FAIL.

- [ ] **Step 3: Implement `majorityOf`**

Replace `function majorityOf(){}` with:

```js
function majorityOf(values){
  const counts=new Map();
  values.forEach(v=>counts.set(v,(counts.get(v)||0)+1));
  let top=0, majority=null, topCountHits=0;
  for(const [v,c] of counts){
    if(c>top){ top=c; majority=v; topCountHits=1; }
    else if(c===top){ topCountHits++; }
  }
  const tie = topCountHits>1;
  if(tie || values.length===0) majority=null;
  return { majority, top, present: values.length, tie };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/compare-core.test.mjs`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add compare.html test/compare-core.test.mjs
git commit -m "feat: majorityOf with tie detection"
```

---

### Task 4: `computeNwayDiff` (TDD — the integrator)

**Files:**
- Modify: `compare.html` (replace the `computeNwayDiff` stub)
- Test: `test/compare-core.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append:

```js
function f(label, header, rows){ return { id: label, label, name: label+'.csv', header, rows }; }

test('computeNwayDiff: agree row, majority row, missing key, ignored cols', () => {
  const A = f('A', ['id','label','score','onlyA'], [
    { id:'1', label:'cat', score:'.9', onlyA:'x' },
    { id:'2', label:'cat', score:'.8', onlyA:'y' },
    { id:'3', label:'dog', score:'.5', onlyA:'z' },
  ]);
  const B = f('B', ['id','label','score'], [
    { id:'1', label:'cat', score:'.9' },
    { id:'2', label:'dog', score:'.8' },   // disagrees on label
  ]);
  const C = f('C', ['id','label','score'], [
    { id:'1', label:'cat', score:'.9' },
    { id:'2', label:'cat', score:'.6' },   // disagrees on score
  ]);
  const d = core.computeNwayDiff([A,B,C], 'id');

  assert.deepEqual(d.fields, ['label','score']);   // 'onlyA' excluded
  assert.deepEqual(d.onlySomeCols, ['onlyA']);
  assert.equal(d.labels.join(','), 'A,B,C');

  const byKey = Object.fromEntries(d.rows.map(r=>[r.key,r]));

  // key 1: all agree
  assert.equal(byKey['1'].status, 'agree');
  assert.equal(byKey['1'].missingIn.length, 0);
  assert.equal(byKey['1'].cells.label.fieldAgree, true);
  assert.deepEqual(byKey['1'].cells.label.values.map(v=>v.outlier), [false,false,false]);

  // key 2: label cat/dog/cat -> majority cat, B is outlier; score .8/.8/.6 -> majority .8, C outlier
  assert.equal(byKey['2'].status, 'diff');
  assert.equal(byKey['2'].cells.label.majority, 'cat');
  assert.equal(byKey['2'].cells.label.agree, '2:1');
  assert.deepEqual(byKey['2'].cells.label.values.map(v=>[v.label,v.outlier]),
    [['A',false],['B',true],['C',false]]);
  assert.equal(byKey['2'].cells.score.majority, '.8');
  assert.deepEqual(byKey['2'].cells.score.values.map(v=>[v.label,v.outlier]),
    [['A',false],['B',false],['C',true]]);

  // key 3: only in A -> diff, missing in B and C, cells show present:false
  assert.equal(byKey['3'].status, 'diff');
  assert.deepEqual(byKey['3'].missingIn, ['B','C']);
  assert.deepEqual(byKey['3'].cells.label.values.map(v=>v.present), [true,false,false]);

  // diff rows sort before agree rows
  assert.equal(d.rows[d.rows.length-1].status, 'agree');
  assert.deepEqual(d.counts, { agree: 1, diff: 2 });
});

test('computeNwayDiff: 1:1 tie highlights both, no majority', () => {
  const A = f('A', ['id','x'], [{ id:'1', x:'cat' }]);
  const B = f('B', ['id','x'], [{ id:'1', x:'dog' }]);
  const d = core.computeNwayDiff([A,B], 'id');
  const c = d.rows[0].cells.x;
  assert.equal(c.majority, null);
  assert.deepEqual(c.values.map(v=>v.outlier), [true,true]);
  assert.equal(d.rows[0].status, 'diff');
});

test('computeNwayDiff: integration through parseCSV/csvToObjects', () => {
  const mk = (label, text) => { const p = core.csvToObjects(core.parseCSV(text, ',')); return { id:label, label, name:label, header:p.header, rows:p.rows }; };
  const A = mk('A', 'id,v\n1,a\n2,b\n');
  const B = mk('B', 'id,v\n1,a\n2,c\n');
  const d = core.computeNwayDiff([A,B], 'id');
  assert.equal(d.counts.agree, 1);
  assert.equal(d.counts.diff, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/compare-core.test.mjs`
Expected: the 3 computeNwayDiff tests FAIL (stub returns `undefined`).

- [ ] **Step 3: Implement `computeNwayDiff`**

Replace `function computeNwayDiff(){}` with:

```js
function computeNwayDiff(files, keyCol){
  const labels=files.map(f=>f.label);
  const common=headerIntersection(files);
  const fields=common.filter(h=>h!==keyCol);
  const onlySomeCols=headerExtras(files, common);
  const idx=files.map(f=>buildIndex(f, keyCol));
  const dup=idx.reduce((a,b)=>a+b.dup,0);

  const seen=new Set(), keys=[];
  files.forEach((file,i)=>file.rows.forEach(r=>{ const k=String(r[keyCol]??''); if(!seen.has(k)){seen.add(k);keys.push(k);} }));

  const rows=[]; let cAgree=0, cDiff=0;
  keys.forEach(k=>{
    const present=idx.map(ix=>ix.map.has(k));
    const missingIn=labels.filter((lb,i)=>!present[i]);
    const allPresent=present.every(Boolean);
    const cells={}; let rowAgree=true;
    fields.forEach(field=>{
      const values=files.map((file,i)=>({
        label: labels[i],
        value: present[i] ? String(idx[i].map.get(k)[field]??'') : '',
        present: present[i],
        outlier: false,
      }));
      const presentVals=values.filter(v=>v.present).map(v=>v.value);
      const allEqual=allPresent && presentVals.every(v=>v===presentVals[0]);
      const m=majorityOf(presentVals);
      if(m.majority!==null){
        values.forEach(v=>{ if(v.present && v.value!==m.majority) v.outlier=true; });
      } else if(!allEqual){
        values.forEach(v=>{ if(v.present) v.outlier=true; });
      }
      if(!allEqual) rowAgree=false;
      const agree = m.present ? (m.top + ':' + (m.present - m.top)) : '';
      cells[field]={ values, majority:m.majority, agree, fieldAgree: allEqual };
    });
    const status=(rowAgree && missingIn.length===0) ? 'agree' : 'diff';
    if(status==='agree') cAgree++; else cDiff++;
    rows.push({ key:k, status, missingIn, cells });
  });
  rows.sort((a,b)=>(a.status==='diff'?0:1)-(b.status==='diff'?0:1));
  return { keyCol, labels, fields, onlySomeCols, rows, counts:{agree:cAgree,diff:cDiff}, dup };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/compare-core.test.mjs`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add compare.html test/compare-core.test.mjs
git commit -m "feat: computeNwayDiff consensus comparison core"
```

---

### Task 5: Inline-script compile guard (TDD against escaping breakage)

**Files:**
- Create: `test/syntax.test.mjs`

This catches the documented hazard where a regex/backslash inside the inline `<script>` silently breaks browser JS while `node --check` and grep see only a string.

- [ ] **Step 1: Write the test**

Create `test/syntax.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify it passes**

Run: `node --test test/syntax.test.mjs`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/syntax.test.mjs
git commit -m "test: compile guard for compare.html inline script"
```

---

### Task 6: Dynamic file-input slots (markup + add/remove)

**Files:**
- Modify: `compare.html` (markup of the input `.card`; new state `S`; slot management JS)

No unit test (DOM); verified by the compile guard (Task 5) + manual pass (Task 9).

- [ ] **Step 1: Replace the static two-input row markup**

Replace the entire `<div class="row"> ... </div>` block (the one containing `#old-input`, `#new-input`, `#key-select`) and the following `<div id="col-note">` with:

```html
    <div id="inputs"></div>
    <div class="row" style="margin-top:12px;">
      <button class="btn-link" id="add-file">＋ 添加 CSV</button>
      <div class="field">
        <label>对齐键列</label>
        <select id="key-select" disabled><option>先选至少两份 CSV</option></select>
      </div>
    </div>
    <div id="cap-note" class="col-note"></div>
    <div id="col-note" class="col-note"></div>
```

Also update the hint text on the line with `传两份 CSV(旧 / 新)...` to:

```html
    <div class="hint">传两份或多份 CSV,按键列对齐,逐字段横向并排、按多数票高亮离群、分出一致/分歧。纯本地,数据不上传。 · <a href="index.html">← 回核对/标注工具</a></div>
```

(`<h1>CSV 横向对比</h1>` stays as-is.)

- [ ] **Step 2: Replace the state object and add slot management**

Replace `const S = { old:null, neu:null, keyCol:'', diff:null };` with:

```js
const S = { files: [], keyCol: '', diff: null };
const SOFT_CAP = 8;
let slotSeq = 0;

function labelFor(i){ return '文件' + (i + 1); }

function renderSlots(){
  const host = $('#inputs');
  host.innerHTML = '';
  S.files.forEach((file, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.style.cssText = 'display:inline-flex;margin-right:18px;';
    wrap.innerHTML =
      `<label>${esc(labelFor(i))}${S.files.length>2?` <button class="btn-link rm" data-i="${i}" style="font-size:11px;">×移除</button>`:''}</label>`+
      `<input type="file" accept=".csv,.tsv,text/csv" data-i="${i}">`+
      `<div class="status${file.loaded?' ok':''}" data-status="${i}">${file.loaded?esc('✓ '+file.name+' · '+file.rows.length+' 行 · '+file.header.length+' 列'+(file.warn||'')):''}</div>`;
    host.appendChild(wrap);
  });
  host.querySelectorAll('input[type=file]').forEach(inp=>{
    inp.addEventListener('change', async e=>{
      const idx=+e.target.dataset.i, file=e.target.files[0]; if(!file) return;
      const text=await file.text();
      loadInto(idx, file.name, text);
      e.target.value='';
    });
  });
  host.querySelectorAll('button.rm').forEach(b=>{
    b.addEventListener('click', ()=>{ S.files.splice(+b.dataset.i,1); afterFilesChanged(); });
  });
  const cap=$('#cap-note');
  cap.textContent = S.files.length>SOFT_CAP ? `已加 ${S.files.length} 份,并排列会变窄(建议 ≤ ${SOFT_CAP})。` : '';
}

function addSlot(){
  S.files.push({ id:'f'+(++slotSeq), label:labelFor(S.files.length), name:null, header:[], rows:[], loaded:false, warn:'' });
  renderSlots();
}

function loadInto(idx, name, text){
  const parsed = csvToObjects(parseCSV(text, sniffDelim(text, name)));
  const warn = lastCsvWarnings.length ? ' · ⚠ '+lastCsvWarnings.join(';') : '';
  S.files[idx] = { ...S.files[idx], name, header:parsed.header, rows:parsed.rows, loaded:true, warn, label:labelFor(idx) };
  afterFilesChanged();
}

function loadedFiles(){ return S.files.filter(f=>f.loaded); }
```

- [ ] **Step 3: Commit (UI scaffold; key-options/compare wired in Task 7–8)**

```bash
git add compare.html
git commit -m "feat: dynamic CSV input slots (add/remove) + N-file state"
```

---

### Task 7: Key-column options + render (field-grouped N-way table)

**Files:**
- Modify: `compare.html` (replace `commonHeaders`, `refreshKeyOptions`, `compare`, `render`; remove old `loadFile`)

- [ ] **Step 1: Remove the now-obsolete `loadFile()` function**

Delete the entire old `function loadFile(file, slot){ ... }` (it referenced `#old-status`/`#new-status` and `S[...]`). Loading is now handled by `loadInto` from Task 6.

- [ ] **Step 2: Replace `commonHeaders`/`refreshKeyOptions`/`compare` with N-file versions**

Replace the functions `commonHeaders()`, `refreshKeyOptions()`, and `compare()` (and the old `buildMap()` if still present) with:

```js
function afterFilesChanged(){
  renderSlots();
  refreshKeyOptions();
}

function refreshKeyOptions(){
  const sel=$('#key-select');
  const files=loadedFiles();
  if(files.length<2){ sel.disabled=true; sel.innerHTML='<option>先选至少两份 CSV</option>'; $('#result-card').style.display='none'; $('#col-note').textContent=''; return; }
  const common=headerIntersection(files);
  if(!common.length){
    sel.disabled=true; sel.innerHTML='<option>这些 CSV 没有公共列,无法对齐</option>';
    $('#col-note').textContent='⚠ 已载入的 CSV 没有任何同名列,无法对齐。请检查表头。';
    $('#result-card').style.display='none'; return;
  }
  sel.disabled=false;
  const prev=S.keyCol;
  const def=(prev&&common.includes(prev))?prev:(common.includes('annotation_id')?'annotation_id':common[0]);
  sel.innerHTML=common.map(h=>`<option value="${esc(h)}"${h===def?' selected':''}>${esc(h)}</option>`).join('');
  S.keyCol=def;
  compare();
}

function compare(){
  const files=loadedFiles();
  if(files.length<2||!S.keyCol) return;
  S.diff=computeNwayDiff(files, S.keyCol);
  render();
}
```

- [ ] **Step 3: Replace `render()` with the field-grouped N-way renderer**

Replace the whole existing `function render(){...}` with:

```js
function render(){
  const d=S.diff; if(!d) return;
  $('#result-card').style.display='';
  const n=d.labels.length;
  $('#summary').innerHTML =
    `<span class="pill chg">分歧 ${d.counts.diff}</span>`+
    `<span class="pill same">一致 ${d.counts.agree}</span>`+
    `<span class="muted">键列:<b>${esc(d.keyCol)}</b> · ${n} 份 · 对比 ${d.fields.length} 个公共字段</span>`;
  let note='';
  if(d.onlySomeCols.length) note+=`仅部分文件有的列(对比忽略):${d.onlySomeCols.map(esc).join(', ')}。 `;
  if(d.dup) note+=`⚠ 有 ${d.dup} 个重复键,仅保留首次出现。`;
  $('#col-note').innerHTML=note;

  const diffOnly=$('#diff-only').checked;
  const thead=$('#diff-table thead'), tbody=$('#diff-table tbody');

  // two-level header: each field spans n value cols + 1 consensus col
  let h1='<tr><th rowspan="2">'+esc(d.keyCol)+'</th><th rowspan="2">状态</th>';
  let h2='<tr>';
  d.fields.forEach(f=>{
    h1+='<th colspan="'+(n+1)+'" style="text-align:center;border-left:2px solid var(--border);">'+esc(f)+'</th>';
    d.labels.forEach((lb,i)=>{ h2+='<th'+(i===0?' style="border-left:2px solid var(--border);"':'')+'>'+esc(lb)+'</th>'; });
    h2+='<th class="muted">共识</th>';
  });
  h1+='</tr>'; h2+='</tr>';
  thead.innerHTML=h1+h2;

  let shown=0;
  const rowsHtml=d.rows.filter(r=>!(diffOnly&&r.status==='agree')).map(r=>{
    shown++;
    const statusBadge = r.status==='agree'
      ? '<span class="badge same">一致</span>'
      : '<span class="badge chg">分歧</span>'+(r.missingIn.length?'<span class="muted" style="font-size:11px;"> 缺 '+r.missingIn.map(esc).join(',')+'</span>':'');
    const tds=d.fields.map(f=>{
      const c=r.cells[f];
      const cellHtml=c.values.map((v,i)=>{
        const edge=i===0?' style="border-left:2px solid var(--border);"':'';
        if(!v.present) return '<td'+edge+'><span class="muted">∅</span></td>';
        if(v.outlier) return '<td class="changed"'+edge+'><span class="new">'+esc(v.value)+'</span></td>';
        return '<td'+edge+'>'+esc(v.value)+'</td>';
      }).join('');
      const cons = c.majority!==null
        ? '<td class="muted">'+esc(c.majority)+(c.agree?' <span style="font-size:11px;">('+esc(c.agree)+')</span>':'')+'</td>'
        : '<td class="muted">—'+(c.agree?' <span style="font-size:11px;">('+esc(c.agree)+')</span>':'')+'</td>';
      return cellHtml+cons;
    }).join('');
    return `<tr class="r-${r.status==='agree'?'same':'chg'}"><td class="key">${esc(r.key)}</td><td>${statusBadge}</td>${tds}</tr>`;
  }).join('');
  const totalCols=2+d.fields.length*(n+1);
  tbody.innerHTML = rowsHtml || '<tr><td class="empty" colspan="'+totalCols+'">没有符合当前过滤的行</td></tr>';
  $('#shown-count').textContent = `显示 ${shown} / ${d.rows.length} 行`;
}
```

- [ ] **Step 4: Run the compile guard**

Run: `node --test test/syntax.test.mjs`
Expected: PASS (no escaping breakage introduced).

- [ ] **Step 5: Commit**

```bash
git add compare.html
git commit -m "feat: N-way key options + field-grouped consensus render"
```

---

### Task 8: Export rewrite (N-way diff CSV)

**Files:**
- Modify: `compare.html` (replace `exportDiff`)

- [ ] **Step 1: Replace `exportDiff()`**

```js
function exportDiff(){
  const d=S.diff; if(!d){alert('还没有对比结果');return;}
  const rows=d.rows.filter(r=>r.status==='diff');
  if(!rows.length){alert('没有分歧行可导出');return;}
  const header=[d.keyCol,'__status'];
  d.fields.forEach(f=>{
    d.labels.forEach(lb=>header.push(f+'__'+lb));
    header.push(f+'__majority');
    header.push(f+'__agree');
  });
  const lines=[header.map(csvQuote).join(',')];
  rows.forEach(r=>{
    const statusCol = r.missingIn.length ? ('diff(缺 '+r.missingIn.join(',')+')') : 'diff';
    const line=[csvQuote(r.key), csvQuote(statusCol)];
    d.fields.forEach(f=>{
      const c=r.cells[f];
      c.values.forEach(v=>line.push(csvQuote(v.present?v.value:'')));
      line.push(csvQuote(c.majority??''));
      line.push(csvQuote(c.agree));
    });
    lines.push(line.join(','));
  });
  downloadFile(`diff-nway-${d.labels.length}files.csv`, lines.join('\n'), 'text/csv;charset=utf-8');
}
```

(Removed the old `Date`-based filename to keep output deterministic; the static page has no need for a date stamp.)

- [ ] **Step 2: Run the compile guard**

Run: `node --test test/syntax.test.mjs`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add compare.html
git commit -m "feat: N-way diff CSV export (per-file values + majority + agree)"
```

---

### Task 9: Event wiring + full-suite run + manual verification

**Files:**
- Modify: `compare.html` (event section at the bottom of `<script>`)
- Create: `test/fixtures/a.csv`, `test/fixtures/b.csv`, `test/fixtures/c.csv`

- [ ] **Step 1: Replace the `// ===== 事件 =====` block**

Replace the old listeners that referenced `#old-input`/`#new-input` with:

```js
// ===== 事件 =====
$('#add-file').addEventListener('click', ()=>{ addSlot(); });
$('#key-select').addEventListener('change', e=>{ S.keyCol=e.target.value; compare(); });
$('#diff-only').addEventListener('change', render);
$('#export-diff').addEventListener('click', exportDiff);

// start with two empty slots
addSlot(); addSlot();
```

- [ ] **Step 2: Run the entire test suite**

Run: `node --test test/`
Expected: ALL tests in `compare-core.test.mjs` and `syntax.test.mjs` PASS.

- [ ] **Step 3: Create manual fixtures**

`test/fixtures/a.csv`:

```
annotation_id,label,score,onlyA
1,cat,0.9,x
2,cat,0.8,y
3,dog,0.5,z
```

`test/fixtures/b.csv`:

```
annotation_id,label,score
1,cat,0.9
2,dog,0.8
```

`test/fixtures/c.csv`:

```
annotation_id,label,score
1,cat,0.9
2,cat,0.6
4,bird,0.7
```

- [ ] **Step 4: Manual browser verification**

The page is static; serve and open:

Run: `cd /c/Project/DataReviewer && python -m http.server 8799`
Open: `http://localhost:8799/compare.html`

Verify:
1. Two empty slots show on load; `＋ 添加 CSV` adds a third with `×移除`.
2. Load `a.csv`, `b.csv`, `c.csv`. Key column auto-selects `annotation_id`.
3. Row `1` → 状态 一致; no highlights.
4. Row `2` → 分歧; under `label`, 文件2's `dog` highlighted, 共识 `cat (2:1)`; under `score`, 文件3's `0.6` highlighted, 共识 `0.8 (2:1)`.
5. Row `3` → 分歧, "缺 文件2,文件3"; 文件2/文件3 cells show ∅.
6. Row `4` → 分歧, "缺 文件1,文件2".
7. Note line lists `onlyA` as ignored.
8. Toggle "只看分歧" hides row 1.
9. "⬇ 导出差异 CSV" → downloads a file whose header has `label__文件1,label__文件2,label__文件3,label__majority,label__agree,score__...`.
10. Remove a slot → table recomputes; cannot drop below 2.

If any check fails, fix and re-run Step 2 before committing.

- [ ] **Step 5: Commit**

```bash
git add compare.html test/fixtures/
git commit -m "feat: wire N-way compare events + manual fixtures; finalize"
```

---

### Task 10: Final review pass

- [ ] **Step 1: Re-run full suite + compile guard**

Run: `node --test test/`
Expected: all green.

- [ ] **Step 2: Grep for dead references to the old 2-file API**

Run: `grep -nE "S\.old|S\.neu|#old-input|#new-input|buildMap|loadFile" compare.html`
Expected: NO matches (all replaced).

- [ ] **Step 3: Commit if anything was cleaned**

```bash
git add compare.html
git commit -m "chore: remove dead 2-file compare references" || echo "nothing to clean"
```

---

## Self-Review

**Spec coverage:**
- 共识并排模型 → Task 4 `computeNwayDiff`. ✓
- 按字段分组布局 → Task 7 `render`. ✓
- 多数票 + 离群高亮 + 行状态 → Tasks 3, 4, 7. ✓
- N=2 统一(1:1 无多数) → Task 3 tie test + Task 4 tie test. ✓
- 动态加/移除文件、软上限 8、最少 2 → Task 6. ✓
- 键列 = 全体交集、默认 annotation_id、仅部分文件的列忽略并提示 → Task 7 `refreshKeyOptions` + `render` note. ✓
- 缺失键 ∅ + 行内"缺 X" → Task 4 (`missingIn`, `present:false`) + Task 7. ✓
- 只看分歧过滤 + 计数 → Task 7. ✓
- 导出分歧 CSV(每份值 + majority + agree) → Task 8. ✓
- 复用 parseCSV/csvToObjects/sniffDelim/csvQuote/downloadFile/主题/纯本地 → kept inside/around markers, unchanged. ✓
- 抽出脚本编译检查 + 样本手测 → Task 5 + Task 9. ✓
- 非目标(无离群率统计、无融合数据集导出、无旧方向 diff、不上传) → not implemented. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. The Task 1 stubs are explicitly defined empty functions, intentionally replaced in Tasks 2–4. ✓

**Type/name consistency:** `computeNwayDiff`, `buildIndex`, `majorityOf`, `headerIntersection`, `headerExtras`, `S.files`, `loadedFiles()`, `afterFilesChanged()`, `renderSlots()`, `addSlot()`, `loadInto()`, and the row shape (`status:'agree'|'diff'`, `missingIn`, `cells[field].values[].{label,value,present,outlier}`, `.majority`, `.agree`, `.fieldAgree`) are used identically across tasks. ✓
