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
