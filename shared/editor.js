'use strict';

var crdt = require('./crdt');
var fractional = require('./fractional');

/**
 * High-level editing commands that turn user intent into CRDT ops, plus per-user undo/redo.
 *
 * Each command records two lists of op *templates* (ops without timestamps):
 *   inverse: what undo should do (computed against the document at the time of the edit)
 *   redo:    what redo should do (create → restore, not re-create)
 * Undo/redo re-stamp templates with fresh timestamps, so they are ordinary new edits that sync to
 * peers. A user's undo only touches the fields that user changed; other users' edits survive.
 */
function Editor(doc, clock) {
  this.doc = doc;
  this.clock = clock;
  this.undoStack = [];
  this.redoStack = [];
  this.idSeq = 0;
}

Editor.prototype.newId = function () {
  return this.clock.actor.slice(0, 8) + '-' + Date.now().toString(36) + '-' + (++this.idSeq);
};

Editor.prototype._stamp = function (templates) {
  var self = this;
  return templates.map(function (t) { return Object.assign({}, t, { ts: self.clock.tick() }); });
};

Editor.prototype._run = function (templates, inverse, redo) {
  var ops = this._stamp(templates);
  crdt.applyAll(this.doc, ops);
  if (ops.length) {
    this.undoStack.push({ inverse: inverse, redo: redo });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  return ops;
};

Editor.prototype._topZ = function () {
  var shapes = crdt.view(this.doc);
  return shapes.length ? shapes[shapes.length - 1].z || null : null;
};

/** Creates a shape on top of everything else. Returns { id, ops }. */
Editor.prototype.create = function (props) {
  if (crdt.KINDS.indexOf(props.kind) < 0) throw new Error('unknown kind ' + props.kind);
  var id = props.id || this.newId();
  var fields = Object.assign({}, props, { z: fractional.after(this._topZ()) });
  delete fields.id;
  var templates = Object.keys(fields).map(function (f) { return { type: 'set', id: id, field: f, value: fields[f] }; });
  var ops = this._run(templates, [{ type: 'delete', id: id }], [{ type: 'restore', id: id }]);
  return { id: id, ops: ops };
};

/** Updates fields (e.g. after a drag or resize). */
Editor.prototype.update = function (id, changes) {
  var self = this;
  var templates = [];
  var inverse = [];
  Object.keys(changes).forEach(function (f) {
    var prev = crdt.read(self.doc, id, f);
    if (prev === changes[f]) return;
    templates.push({ type: 'set', id: id, field: f, value: changes[f] });
    // Fields that didn't exist before have nothing to restore to.
    if (prev !== undefined) inverse.push({ type: 'set', id: id, field: f, value: prev });
  });
  return this._run(templates, inverse, templates);
};

Editor.prototype.remove = function (id) {
  if (crdt.isDeleted(this.doc, id) || !crdt.read(this.doc, id, 'kind')) return [];
  return this._run([{ type: 'delete', id: id }], [{ type: 'restore', id: id }], [{ type: 'delete', id: id }]);
};

Editor.prototype.bringToFront = function (id) {
  var shapes = crdt.view(this.doc);
  if (shapes.length && shapes[shapes.length - 1].id === id) return [];
  return this.update(id, { z: fractional.after(this._topZ()) });
};

Editor.prototype.sendToBack = function (id) {
  var shapes = crdt.view(this.doc);
  if (!shapes.length || shapes[0].id === id) return [];
  return this.update(id, { z: fractional.between(null, shapes[0].z || null) });
};

Editor.prototype.undo = function () {
  var entry = this.undoStack.pop();
  if (!entry) return [];
  var ops = this._stamp(entry.inverse);
  crdt.applyAll(this.doc, ops);
  this.redoStack.push(entry);
  return ops;
};

Editor.prototype.redo = function () {
  var entry = this.redoStack.pop();
  if (!entry) return [];
  var ops = this._stamp(entry.redo);
  crdt.applyAll(this.doc, ops);
  this.undoStack.push(entry);
  return ops;
};

Editor.prototype.canUndo = function () { return this.undoStack.length > 0; };
Editor.prototype.canRedo = function () { return this.redoStack.length > 0; };

module.exports = Editor;
