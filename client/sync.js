'use strict';

var crdt = require('../shared/crdt');

/**
 * WebSocket sync with offline support.
 *
 * - Local ops go into an outbox and are sent when connected; each batch carries an ack id and is
 *   dropped from the outbox only once the server acknowledges it.
 * - On reconnect the whole unacked outbox is resent. That's safe because CRDT ops are idempotent.
 * - The welcome snapshot is *merged* into the local document, so edits made offline survive.
 * - Reconnects use exponential backoff with jitter, capped at 10 s.
 */
function SyncClient(options) {
  this.url = options.url;
  this.name = options.name || 'Guest';
  this.doc = options.doc;
  this.clock = options.clock;
  this.WebSocketImpl = options.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  this.handlers = options.handlers || {};
  this.outbox = [];       // [{ ack, ops }]
  this.ackSeq = 0;
  this.attempt = 0;
  this.ws = null;
  this.connected = false;
  this.closed = false;
  this.clientId = null;
}

SyncClient.prototype.emit = function (event, payload) {
  if (this.handlers[event]) this.handlers[event](payload);
};

SyncClient.prototype.connect = function () {
  var self = this;
  this.closed = false;
  var ws = new this.WebSocketImpl(this.url);
  this.ws = ws;
  ws.onopen = function () {
    self.attempt = 0;
    ws.send(JSON.stringify({ type: 'hello', name: self.name }));
  };
  ws.onmessage = function (event) {
    var msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
    self.onMessage(msg);
  };
  ws.onclose = function () {
    var wasConnected = self.connected;
    self.connected = false;
    if (wasConnected) self.emit('status', 'offline');
    if (!self.closed) self.scheduleReconnect();
  };
  ws.onerror = function () { /* onclose follows */ };
};

SyncClient.prototype.scheduleReconnect = function () {
  var self = this;
  var delay = Math.min(10000, 250 * Math.pow(2, this.attempt++)) * (0.75 + Math.random() * 0.5);
  this.emit('status', 'reconnecting');
  this.reconnectTimer = setTimeout(function () { self.connect(); }, delay);
};

SyncClient.prototype.onMessage = function (msg) {
  switch (msg.type) {
    case 'welcome':
      this.clientId = msg.clientId;
      crdt.merge(this.doc, msg.snapshot);
      this.clock.observe([crdt.maxCounter(this.doc), '']);
      this.connected = true;
      this.emit('status', 'online');
      this.emit('welcome', msg);
      this.emit('change');
      this.flush(true);
      break;
    case 'ops':
      msg.ops.forEach(function (op) { this.clock.observe(op.ts); }, this);
      if (crdt.applyAll(this.doc, msg.ops)) this.emit('change');
      break;
    case 'ack':
      this.outbox = this.outbox.filter(function (b) { return b.ack !== msg.ack; });
      this.emit('acked', msg.ack);
      break;
    case 'presence':
    case 'peer-joined':
    case 'peer-left':
      this.emit(msg.type, msg);
      break;
    case 'error':
      this.emit('error', msg.error);
      break;
  }
};

/** Queue local ops (already applied to the local doc by the editor). */
SyncClient.prototype.send = function (ops) {
  if (!ops.length) return;
  var batch = { ack: 'a' + (++this.ackSeq), ops: ops };
  this.outbox.push(batch);
  if (this.connected) this.ws.send(JSON.stringify({ type: 'ops', ops: batch.ops, ack: batch.ack }));
};

SyncClient.prototype.flush = function () {
  var ws = this.ws;
  this.outbox.forEach(function (b) { ws.send(JSON.stringify({ type: 'ops', ops: b.ops, ack: b.ack })); });
};

SyncClient.prototype.presence = function (cursor) {
  if (this.connected) this.ws.send(JSON.stringify({ type: 'presence', cursor: cursor }));
};

SyncClient.prototype.pending = function () {
  return this.outbox.reduce(function (n, b) { return n + b.ops.length; }, 0);
};

SyncClient.prototype.close = function () {
  this.closed = true;
  clearTimeout(this.reconnectTimer);
  if (this.ws) this.ws.close();
};

module.exports = SyncClient;
