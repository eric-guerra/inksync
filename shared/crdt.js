'use strict';

var compare = require('./clock').compare;

/**
 * The whiteboard document is a map of shapes; each shape is a map of last-writer-wins registers
 * (one per field: kind, x, y, w, h, color, points, text, z…) plus an LWW `deleted` flag.
 *
 * Operations:
 *   { type: 'set',    id, field, value, ts }
 *   { type: 'delete', id, ts }          // tombstone (keeps registers so undo/redo can revive)
 *   { type: 'restore', id, ts }
 *
 * apply() is commutative, associative and idempotent, so any two replicas that have seen the same set
 * of operations, in any order and with any duplicates, end up identical (strong eventual consistency).
 */

var FIELDS = ['kind', 'x', 'y', 'w', 'h', 'x2', 'y2', 'color', 'fill', 'stroke', 'points', 'text', 'z', 'fontSize'];
var KINDS = ['rect', 'ellipse', 'line', 'path', 'text', 'sticky'];

function empty() {
  return { shapes: {} };
}

function shape(doc, id) {
  if (!doc.shapes[id]) doc.shapes[id] = { fields: {}, deleted: { value: false, ts: [0, ''] } };
  return doc.shapes[id];
}

/** Mutates `doc` in place; returns true if anything visible changed. */
function apply(doc, op) {
  var s = shape(doc, op.id);
  if (op.type === 'set') {
    var cur = s.fields[op.field];
    if (cur && compare(cur.ts, op.ts) >= 0) return false;
    s.fields[op.field] = { value: op.value, ts: op.ts };
    return true;
  }
  if (op.type === 'delete' || op.type === 'restore') {
    if (compare(s.deleted.ts, op.ts) >= 0) return false;
    s.deleted = { value: op.type === 'delete', ts: op.ts };
    return true;
  }
  throw new Error('unknown op type ' + op.type);
}

function applyAll(doc, ops) {
  var changed = false;
  for (var i = 0; i < ops.length; i++) changed = apply(doc, ops[i]) || changed;
  return changed;
}

/** State-based merge (used to combine snapshots, e.g. a server restoring from disk + a client's offline work). */
function merge(target, source) {
  Object.keys(source.shapes).forEach(function (id) {
    var src = source.shapes[id];
    Object.keys(src.fields).forEach(function (f) {
      apply(target, { type: 'set', id: id, field: f, value: src.fields[f].value, ts: src.fields[f].ts });
    });
    if (src.deleted.ts[0] > 0) apply(target, { type: src.deleted.value ? 'delete' : 'restore', id: id, ts: src.deleted.ts });
  });
  return target;
}

/** Highest Lamport counter in a document (so a client joining from a snapshot never reuses timestamps). */
function maxCounter(doc) {
  var max = 0;
  Object.keys(doc.shapes).forEach(function (id) {
    var s = doc.shapes[id];
    if (s.deleted.ts[0] > max) max = s.deleted.ts[0];
    Object.keys(s.fields).forEach(function (f) { if (s.fields[f].ts[0] > max) max = s.fields[f].ts[0]; });
  });
  return max;
}

/** Visible shapes as plain objects, sorted by z (then id for determinism). */
function view(doc) {
  var out = [];
  Object.keys(doc.shapes).forEach(function (id) {
    var s = doc.shapes[id];
    if (s.deleted.value || !s.fields.kind) return;
    var o = { id: id };
    Object.keys(s.fields).forEach(function (f) { o[f] = s.fields[f].value; });
    out.push(o);
  });
  return out.sort(function (a, b) {
    var za = a.z || '', zb = b.z || '';
    return za < zb ? -1 : za > zb ? 1 : a.id < b.id ? -1 : 1;
  });
}

function read(doc, id, field) {
  var s = doc.shapes[id];
  return s && s.fields[field] ? s.fields[field].value : undefined;
}

function isDeleted(doc, id) {
  return !!(doc.shapes[id] && doc.shapes[id].deleted.value);
}

/** Validates an op from the network. Returns an error string or null. */
function validate(op) {
  if (!op || typeof op !== 'object') return 'op must be an object';
  if (['set', 'delete', 'restore'].indexOf(op.type) < 0) return 'bad op type';
  if (typeof op.id !== 'string' || !/^[\w-]{1,64}$/.test(op.id)) return 'bad shape id';
  if (!Array.isArray(op.ts) || op.ts.length !== 2 || !Number.isInteger(op.ts[0]) || op.ts[0] < 1 || typeof op.ts[1] !== 'string') return 'bad timestamp';
  if (op.type === 'set') {
    if (FIELDS.indexOf(op.field) < 0) return 'unknown field ' + op.field;
    if (op.field === 'kind' && KINDS.indexOf(op.value) < 0) return 'unknown kind ' + op.value;
    if (op.field === 'points') {
      if (!Array.isArray(op.value) || op.value.length > 4000 || !op.value.every(Number.isFinite)) return 'bad points';
    } else if (op.field === 'text') {
      if (typeof op.value !== 'string' || op.value.length > 2000) return 'bad text';
    } else if (['x', 'y', 'w', 'h', 'x2', 'y2', 'fontSize'].indexOf(op.field) >= 0) {
      if (!Number.isFinite(op.value) || Math.abs(op.value) > 1e6) return 'bad number for ' + op.field;
    } else if (typeof op.value !== 'string' || op.value.length > 64) {
      return 'bad value for ' + op.field;
    }
  }
  return null;
}

module.exports = { empty: empty, apply: apply, applyAll: applyAll, merge: merge, view: view, read: read, isDeleted: isDeleted, maxCounter: maxCounter, validate: validate, FIELDS: FIELDS, KINDS: KINDS };
