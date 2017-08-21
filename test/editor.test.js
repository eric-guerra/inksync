'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var crdt = require('../shared/crdt');
var Editor = require('../shared/editor');
var LamportClock = require('../shared/clock').LamportClock;
var state = require('../client/state');

function replica(actor) {
  var doc = crdt.empty();
  return { doc: doc, clock: new LamportClock(actor), editor: null };
}

function pair() {
  var a = replica('alice'), b = replica('bob');
  a.editor = new Editor(a.doc, a.clock);
  b.editor = new Editor(b.doc, b.clock);
  function deliver(from, to, ops) {
    ops.forEach(function (op) { to.clock.observe(op.ts); });
    crdt.applyAll(to.doc, ops);
  }
  return { a: a, b: b, deliver: deliver };
}

test('create, update, undo, redo', function () {
  var r = replica('alice');
  var ed = new Editor(r.doc, r.clock);
  var id = ed.create({ kind: 'rect', x: 10, y: 10, w: 50, h: 40 }).id;
  ed.update(id, { x: 100 });
  assert.equal(crdt.read(r.doc, id, 'x'), 100);

  ed.undo();
  assert.equal(crdt.read(r.doc, id, 'x'), 10);
  ed.undo();
  assert.deepEqual(crdt.view(r.doc), [], 'undoing the create deletes the shape');
  assert.equal(ed.canUndo(), false);

  ed.redo();
  assert.equal(crdt.view(r.doc).length, 1, 'redo restores rather than re-creating');
  ed.redo();
  assert.equal(crdt.read(r.doc, id, 'x'), 100);
  assert.deepEqual(ed.update(id, { x: 100 }), [], 'no-op updates produce no ops');
});

test('new edits clear the redo stack', function () {
  var r = replica('alice');
  var ed = new Editor(r.doc, r.clock);
  var id = ed.create({ kind: 'ellipse', x: 0, y: 0, w: 10, h: 10 }).id;
  ed.update(id, { x: 5 });
  ed.undo();
  ed.update(id, { y: 7 });
  assert.equal(ed.canRedo(), false);
});

test('undo only reverts my own fields, not concurrent edits by others', function () {
  var p = pair();
  var created = p.a.editor.create({ kind: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#000000' });
  p.deliver(p.a, p.b, created.ops);

  var aliceMove = p.a.editor.update(created.id, { x: 50 });
  var bobColor = p.b.editor.update(created.id, { stroke: '#ff0000' });
  p.deliver(p.a, p.b, aliceMove);
  p.deliver(p.b, p.a, bobColor);

  var undo = p.a.editor.undo();
  p.deliver(p.a, p.b, undo);
  [p.a.doc, p.b.doc].forEach(function (doc) {
    assert.equal(crdt.read(doc, created.id, 'x'), 0);
    assert.equal(crdt.read(doc, created.id, 'stroke'), '#ff0000', "bob's color survives alice's undo");
  });
  assert.deepEqual(p.a.doc, p.b.doc);
});

test('concurrent edits to the same field converge', function () {
  var p = pair();
  var created = p.a.editor.create({ kind: 'rect', x: 0, y: 0, w: 10, h: 10 });
  p.deliver(p.a, p.b, created.ops);
  var x1 = p.a.editor.update(created.id, { x: 1 });
  var x2 = p.b.editor.update(created.id, { x: 2 });
  p.deliver(p.a, p.b, x1);
  p.deliver(p.b, p.a, x2);
  assert.equal(crdt.read(p.a.doc, created.id, 'x'), crdt.read(p.b.doc, created.id, 'x'));
});

test('z-order commands', function () {
  var r = replica('alice');
  var ed = new Editor(r.doc, r.clock);
  var a = ed.create({ kind: 'rect', x: 0, y: 0, w: 1, h: 1 }).id;
  var b = ed.create({ kind: 'rect', x: 0, y: 0, w: 1, h: 1 }).id;
  var c = ed.create({ kind: 'rect', x: 0, y: 0, w: 1, h: 1 }).id;
  var order = function () { return crdt.view(r.doc).map(function (s) { return s.id; }); };
  assert.deepEqual(order(), [a, b, c]);
  ed.bringToFront(a);
  assert.deepEqual(order(), [b, c, a]);
  ed.sendToBack(c);
  assert.deepEqual(order(), [c, b, a]);
  assert.deepEqual(ed.sendToBack(c), [], 'already at the back');
});

test('redux middleware turns commands into document changes', function () {
  var r = replica('alice');
  var ed = new Editor(r.doc, r.clock);
  var sent = [];
  var fakeSync = { send: function (ops) { sent.push(ops); }, pending: function () { return 0; }, presence: function () {} };
  var store = state.createAppStore(ed, fakeSync);
  store.dispatch({ type: state.T.CREATE, props: { kind: 'rect', x: 1, y: 2, w: 3, h: 4 } });
  var s = store.getState();
  assert.equal(s.board.shapes.length, 1);
  assert.equal(s.board.canUndo, true);
  assert.equal(sent.length, 1);

  store.dispatch({ type: state.T.SELECT, id: s.board.shapes[0].id });
  store.dispatch({ type: state.T.UNDO });
  assert.equal(store.getState().board.shapes.length, 0);
  assert.equal(store.getState().ui.selectedId, null, 'selection cleared when the shape disappears');
  assert.equal(sent.length, 2, 'undo is synced like any edit');
});
