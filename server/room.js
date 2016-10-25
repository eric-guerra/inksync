'use strict';

var fs = require('fs');
var path = require('path');
var crdt = require('../shared/crdt');

var COLORS = ['#e63946', '#2a9d8f', '#e9c46a', '#264653', '#f4a261', '#6a4c93', '#1982c4', '#8ac926'];
var MAX_OPS_PER_MESSAGE = 500;

/**
 * One whiteboard. Holds the authoritative merged document, relays ops to peers, tracks presence,
 * and persists a snapshot to disk (debounced) so a restart loses at most a second of work.
 */
function Room(id, options) {
  this.id = id;
  this.clients = new Map(); // clientId -> { send, name, color, cursor }
  this.doc = crdt.empty();
  this.dataDir = options && options.dataDir;
  this.saveTimer = null;
  this.dirty = false;
  this.colorIndex = 0;
  this.load();
}

Room.prototype.file = function () {
  return this.dataDir ? path.join(this.dataDir, encodeURIComponent(this.id) + '.json') : null;
};

Room.prototype.load = function () {
  var f = this.file();
  if (!f || !fs.existsSync(f)) return;
  try {
    crdt.merge(this.doc, JSON.parse(fs.readFileSync(f, 'utf8')));
  } catch (e) {
    console.error('room ' + this.id + ': could not load snapshot (' + e.message + '); starting empty');
  }
};

Room.prototype.scheduleSave = function () {
  var f = this.file();
  if (!f) return;
  this.dirty = true;
  if (this.saveTimer) return;
  var self = this;
  this.saveTimer = setTimeout(function () { self.flush(); }, 1000);
};

Room.prototype.flush = function () {
  clearTimeout(this.saveTimer);
  this.saveTimer = null;
  var f = this.file();
  if (!f || !this.dirty) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  var tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(this.doc));
  fs.renameSync(tmp, f); // atomic replace: never a half-written snapshot
  this.dirty = false;
};

Room.prototype.join = function (clientId, name, send) {
  var color = COLORS[this.colorIndex++ % COLORS.length];
  var peers = [];
  this.clients.forEach(function (c, id) { peers.push({ clientId: id, name: c.name, color: c.color, cursor: c.cursor }); });
  this.clients.set(clientId, { send: send, name: name, color: color, cursor: null });
  send({ type: 'welcome', clientId: clientId, color: color, snapshot: this.doc, peers: peers });
  this.broadcast(clientId, { type: 'peer-joined', clientId: clientId, name: name, color: color });
};

Room.prototype.leave = function (clientId) {
  if (!this.clients.delete(clientId)) return;
  this.broadcast(clientId, { type: 'peer-left', clientId: clientId });
};

/** Validates and applies ops from a client; only ops that changed state are relayed. */
Room.prototype.receiveOps = function (clientId, ops) {
  var client = this.clients.get(clientId);
  if (!client) return { error: 'not joined' };
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS_PER_MESSAGE) return { error: 'ops must be 1-' + MAX_OPS_PER_MESSAGE + ' operations' };
  for (var i = 0; i < ops.length; i++) {
    var err = crdt.validate(ops[i]);
    if (err) return { error: 'op ' + i + ': ' + err };
  }
  var self = this;
  var effective = ops.filter(function (op) { return crdt.apply(self.doc, op); });
  if (effective.length) {
    this.broadcast(clientId, { type: 'ops', from: clientId, ops: effective });
    this.scheduleSave();
  }
  return { applied: effective.length };
};

Room.prototype.presence = function (clientId, cursor) {
  var client = this.clients.get(clientId);
  if (!client) return;
  if (cursor !== null && !(cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y))) return;
  client.cursor = cursor;
  this.broadcast(clientId, { type: 'presence', clientId: clientId, cursor: cursor, name: client.name, color: client.color });
};

Room.prototype.broadcast = function (exceptId, message) {
  this.clients.forEach(function (c, id) {
    if (id !== exceptId) c.send(message);
  });
};

Room.prototype.isEmpty = function () {
  return this.clients.size === 0;
};

module.exports = Room;
