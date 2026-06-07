import test from 'node:test';
import assert from 'node:assert/strict';
import { core } from './load-core.mjs';

test('csvToObjects keeps Object.prototype-named columns intact', () => {
  const { header, rows } = core.csvToObjects(core.parseCSV('toString,constructor,id\na,b,1', ','));
  assert.deepEqual(header, ['toString', 'constructor', 'id']);
  assert.equal(rows[0].toString, 'a');
  assert.equal(rows[0].constructor, 'b');
  assert.equal(rows[0].id, '1');
});

test('csvToObjects keeps a literal "__proto__" column as data', () => {
  const { header, rows } = core.csvToObjects(core.parseCSV('__proto__,id\nliteral,1', ','));
  assert.deepEqual(header, ['__proto__', 'id']);
  assert.equal(Object.hasOwn(rows[0], '__proto__'), true);
  assert.equal(rows[0].__proto__, 'literal');
  assert.equal(rows[0].id, '1');
});

test('csvToObjects suffixes genuine duplicate columns', () => {
  const { header, rows } = core.csvToObjects(core.parseCSV('x,x,y\n1,2,3', ','));
  assert.deepEqual(header, ['x', 'x_2', 'y']);
  assert.deepEqual(rows[0], { x: '1', x_2: '2', y: '3' });
});

test('sniffDelim ignores tabs inside quoted CSV fields', () => {
  assert.equal(core.sniffDelim('"a\tb\tc\td",label,image\n1,2,3', 'data.csv'), ',');
  assert.equal(core.sniffDelim('a\tb\tc\n1\t2\t3', 'data.csv'), '\t');
  assert.equal(core.sniffDelim('whatever', 'x.tsv'), '\t');
});

test('csvToObjects removes csvQuote formula guard prefixes symmetrically', () => {
  const { rows } = core.csvToObjects(core.parseCSV('col\n"\'\t1"\n"\'\r2"\n"\'+3"', ','));
  assert.equal(rows[0].col, '\t1');
  assert.equal(rows[1].col, '\r2');
  assert.equal(rows[2].col, '+3');
});

test('csvToObjects warns when rows contain more cells than the header', () => {
  core.csvToObjects(core.parseCSV('a\n1,2,3', ','));
  assert.match(core.getLastCsvWarnings().join('\n'), /列数多于表头/);
});

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

test('headerExtras de-dupes an extra column shared by multiple files', () => {
  const files = [
    { header: ['id', 'label', 'note'] },
    { header: ['id', 'label', 'extra'] },
    { header: ['id', 'label', 'note', 'extra'] },
  ];
  const common = core.headerIntersection(files); // ['id','label']
  assert.deepEqual(core.headerExtras(files, common), ['note', 'extra']);
});

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

  assert.equal(byKey['1'].status, 'agree');
  assert.equal(byKey['1'].missingIn.length, 0);
  assert.equal(byKey['1'].cells.label.fieldAgree, true);
  assert.deepEqual(byKey['1'].cells.label.values.map(v=>v.outlier), [false,false,false]);

  assert.equal(byKey['2'].status, 'diff');
  assert.equal(byKey['2'].cells.label.majority, 'cat');
  assert.equal(byKey['2'].cells.label.agree, '2:1');
  assert.deepEqual(byKey['2'].cells.label.values.map(v=>[v.label,v.outlier]),
    [['A',false],['B',true],['C',false]]);
  assert.equal(byKey['2'].cells.score.majority, '.8');
  assert.deepEqual(byKey['2'].cells.score.values.map(v=>[v.label,v.outlier]),
    [['A',false],['B',false],['C',true]]);

  assert.equal(byKey['3'].status, 'diff');
  assert.deepEqual(byKey['3'].missingIn, ['B','C']);
  assert.deepEqual(byKey['3'].cells.label.values.map(v=>v.present), [true,false,false]);

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

test('computeNwayDiff: 4-way plurality marks the minority as outliers', () => {
  const mk=(label,x)=>f(label,['id','x'],[{id:'1',x}]);
  const d=core.computeNwayDiff([mk('A','a'),mk('B','a'),mk('C','b'),mk('D','c')],'id');
  const c=d.rows[0].cells.x;
  assert.equal(c.majority,'a');
  assert.equal(c.agree,'2:2');
  assert.deepEqual(c.values.map(v=>v.outlier),[false,false,true,true]);
  assert.equal(d.rows[0].status,'diff');
});

test('computeNwayDiff: absent cell is present:false, not a false agreement', () => {
  const A=f('A',['id','x'],[{id:'1',x:''}]);
  const B=f('B',['id','x'],[{id:'1',x:''}]);
  const C=f('C',['id','x'],[{id:'2',x:'z'}]); // lacks key '1'
  const d=core.computeNwayDiff([A,B,C],'id');
  const r=d.rows.find(r=>r.key==='1');
  assert.deepEqual(r.cells.x.values.map(v=>v.present),[true,true,false]);
  assert.equal(r.cells.x.values[2].outlier,false);
  assert.equal(r.cells.x.values[2].value,'');
  assert.equal(r.status,'diff');
  assert.deepEqual(r.missingIn,['C']);
});

test('computeNwayDiff: 3-way all-distinct has no majority, all outliers', () => {
  const mk=(label,x)=>f(label,['id','x'],[{id:'1',x}]);
  const d=core.computeNwayDiff([mk('A','a'),mk('B','b'),mk('C','c')],'id');
  const c=d.rows[0].cells.x;
  assert.equal(c.majority,null);
  assert.deepEqual(c.values.map(v=>v.outlier),[true,true,true]);
  assert.equal(c.agree,'1:2');
});
