'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var crdt = require('../shared/crdt');
var fractional = require('../shared/fractional');
var clockLib = require('../shared/clock');

// Deterministic PRNG so failures are reproducible.
function rng(seed) {
  return function () {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function shuffle(arr, rand) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function randomOps(rand, n) {
  var actors = ['alice', 'bob', 'carol'].map(function (a) { return new clockLib.LamportClock(a); });
  var ids = ['s1', 's2', 's3', 's4'];
  var ops = [];
  for (var i = 0; i < n; i++) {
    var clock = actors[Math.floor(rand() * actors.length)];
    // Occasionally "receive" others' ops so timestamps interleave like a real session.
    if (rand() < 0.3 && ops.length) clock.observe(ops[Math.floor(rand() * ops.length)].ts);
    var id = ids[Math.floor(rand() * ids.length)];
    var r = rand();
    if (r < 0.7) ops.push({ type: 'set', id: id, field: ['kind', 'x', 'y', 'stroke'][Math.floor(rand() * 4)], value: Math.floor(rand() * 100), ts: clock.tick() });
    else if (r < 0.85) ops.push({ type: 'delete', id: id, ts: clock.tick() });
    else ops.push({ type: 'restore', id: id, ts: clock.tick() });
  }
  return ops;
}

test('replicas converge regardless of delivery order and duplication', function () {
  for (var seed = 1; seed <= 200; seed++) {
    var rand = rng(seed);
    var ops = randomOps(rand, 60);
    var reference = crdt.empty();
    crdt.applyAll(reference, ops);
    for (var replica = 0; replica < 3; replica++) {
      var withDupes = shuffle(ops.concat(ops.filter(function () { return rand() < 0.3; })), rand);
      var doc = crdt.empty();
      crdt.applyAll(doc, withDupes);
      assert.deepEqual(doc, reference, 'seed ' + seed + ' replica ' + replica);
    }
  }
});

test('state merge equals applying the union of operations', function () {
  var rand = rng(42);
  var ops = randomOps(rand, 100);
  var left = crdt.empty(), right = crdt.empty(), all = crdt.empty();
  ops.forEach(function (op, i) { crdt.apply(i % 2 ? left : right, op); });
  crdt.applyAll(all, ops);
  assert.deepEqual(crdt.merge(left, right), all);
  // merge is idempotent
  assert.deepEqual(crdt.merge(JSON.parse(JSON.stringify(all)), all), all);
});

test('last writer wins with deterministic tie-break on actor', function () {
  var doc = crdt.empty();
  crdt.apply(doc, { type: 'set', id: 'a', field: 'x', value: 1, ts: [5, 'bob'] });
  assert.equal(crdt.apply(doc, { type: 'set', id: 'a', field: 'x', value: 2, ts: [5, 'alice'] }), false, 'alice < bob at equal counter');
  assert.equal(crdt.apply(doc, { type: 'set', id: 'a', field: 'x', value: 3, ts: [6, 'alice'] }), true);
  assert.equal(crdt.read(doc, 'a', 'x'), 3);
});

test('delete tombstones hide shapes; later restore revives with fields intact', function () {
  var doc = crdt.empty();
  crdt.applyAll(doc, [
    { type: 'set', id: 'a', field: 'kind', value: 'rect', ts: [1, 'x'] },
    { type: 'set', id: 'a', field: 'x', value: 10, ts: [2, 'x'] },
    { type: 'delete', id: 'a', ts: [3, 'y'] }
  ]);
  assert.deepEqual(crdt.view(doc), []);
  crdt.apply(doc, { type: 'set', id: 'a', field: 'x', value: 20, ts: [4, 'z'] }); // edit races the delete
  crdt.apply(doc, { type: 'restore', id: 'a', ts: [5, 'y'] });
  assert.deepEqual(crdt.view(doc), [{ id: 'a', kind: 'rect', x: 20 }]);
  assert.equal(crdt.maxCounter(doc), 5);
});

test('view orders by z then id and hides kind-less shapes', function () {
  var doc = crdt.empty();
  crdt.applyAll(doc, [
    { type: 'set', id: 'b', field: 'kind', value: 'rect', ts: [1, 'x'] }, { type: 'set', id: 'b', field: 'z', value: 'V', ts: [2, 'x'] },
    { type: 'set', id: 'a', field: 'kind', value: 'rect', ts: [3, 'x'] }, { type: 'set', id: 'a', field: 'z', value: 'k', ts: [4, 'x'] },
    { type: 'set', id: 'c', field: 'x', value: 1, ts: [5, 'x'] }
  ]);
  assert.deepEqual(crdt.view(doc).map(function (s) { return s.id; }), ['b', 'a']);
});

test('network op validation', function () {
  var ok = { type: 'set', id: 's1', field: 'x', value: 5, ts: [1, 'a'] };
  assert.equal(crdt.validate(ok), null);
  assert.match(crdt.validate(Object.assign({}, ok, { field: '__proto__' })), /unknown field/);
  assert.match(crdt.validate(Object.assign({}, ok, { value: 'x' })), /bad number/);
  assert.match(crdt.validate(Object.assign({}, ok, { ts: [0, 'a'] })), /bad timestamp/);
  assert.match(crdt.validate(Object.assign({}, ok, { id: '../etc' })), /bad shape id/);
  assert.match(crdt.validate({ type: 'set', id: 's', field: 'kind', value: 'script', ts: [1, 'a'] }), /unknown kind/);
  assert.match(crdt.validate({ type: 'set', id: 's', field: 'points', value: [1, 'x'], ts: [1, 'a'] }), /bad points/);
  assert.match(crdt.validate({ type: 'nuke', id: 's', ts: [1, 'a'] }), /bad op type/);
});

test('fractional keys always fit strictly between neighbours', function () {
  var rand = rng(7);
  var keys = [fractional.after(null)];
  for (var i = 0; i < 500; i++) {
    var sorted = keys.slice().sort();
    var pos = Math.floor(rand() * (sorted.length + 1));
    var a = pos === 0 ? null : sorted[pos - 1];
    var b = pos === sorted.length ? null : sorted[pos];
    var k = fractional.between(a, b);
    if (a !== null) assert.ok(a < k, a + ' < ' + k);
    if (b !== null) assert.ok(k < b, k + ' < ' + b);
    assert.notEqual(k[k.length - 1], '0', 'keys never end in the minimum digit');
    keys.push(k);
  }
  assert.equal(new Set(keys).size, keys.length);
  assert.throws(function () { fractional.between('b', 'a'); });
});
