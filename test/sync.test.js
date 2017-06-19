'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var createServer = require('../server/server');
var crdt = require('../shared/crdt');
var Editor = require('../shared/editor');
var LamportClock = require('../shared/clock').LamportClock;
var SyncClient = require('../client/sync');

function startServer(dataDir) {
  return new Promise(function (resolve) {
    var app = createServer({ dataDir: dataDir });
    app.server.listen(0, function () {
      resolve({
        app: app,
        url: function (room) { return 'ws://localhost:' + app.server.address().port + '/ws?room=' + room; },
        close: function () {
          app.wss.clients.forEach(function (c) { c.terminate(); });
          return new Promise(function (r) { app.server.close(r); });
        }
      });
    });
  });
}

function waitFor(predicate, label) {
  var deadline = Date.now() + 3000;
  return new Promise(function (resolve, reject) {
    (function poll() {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out waiting for ' + label));
      setTimeout(poll, 10);
    })();
  });
}

function client(url, name) {
  var doc = crdt.empty();
  var clock = new LamportClock(name + '-' + Math.random().toString(36).slice(2));
  var events = { presence: [], left: [], errors: [] };
  var sync = new SyncClient({
    url: url, name: name, doc: doc, clock: clock,
    handlers: {
      presence: function (p) { events.presence.push(p); },
      'peer-left': function (p) { events.left.push(p.clientId); },
      error: function (e) { events.errors.push(e); }
    }
  });
  sync.connect();
  return { doc: doc, clock: clock, editor: new Editor(doc, clock), sync: sync, events: events };
}

function edit(c, fn) {
  var ops = fn(c.editor);
  c.sync.send(Array.isArray(ops) ? ops : ops.ops);
  return ops;
}

test('two clients converge; late joiner receives the snapshot', async function (t) {
  var srv = await startServer();
  var a = client(srv.url('room1'), 'ana');
  var b = client(srv.url('room1'), 'ben');
  t.after(function () { a.sync.close(); b.sync.close(); return srv.close(); });
  await waitFor(function () { return a.sync.connected && b.sync.connected; }, 'connect');

  var created = edit(a, function (e) { return e.create({ kind: 'rect', x: 1, y: 1, w: 10, h: 10 }); });
  edit(b, function (e) { return e.create({ kind: 'ellipse', x: 5, y: 5, w: 4, h: 4 }); });
  await waitFor(function () { return crdt.view(a.doc).length === 2 && crdt.view(b.doc).length === 2; }, 'both shapes');
  edit(b, function (e) { return e.update(created.id, { x: 99 }); });
  await waitFor(function () { return crdt.read(a.doc, created.id, 'x') === 99; }, 'remote update');
  assert.deepEqual(crdt.view(a.doc), crdt.view(b.doc));

  var late = client(srv.url('room1'), 'cy');
  t.after(function () { late.sync.close(); });
  await waitFor(function () { return late.sync.connected; }, 'late join');
  assert.deepEqual(crdt.view(late.doc), crdt.view(a.doc));
  await waitFor(function () { return a.sync.pending() === 0 && b.sync.pending() === 0; }, 'acks');
});

test('rooms are isolated', async function (t) {
  var srv = await startServer();
  var a = client(srv.url('alpha'), 'ana');
  var b = client(srv.url('beta'), 'ben');
  t.after(function () { a.sync.close(); b.sync.close(); return srv.close(); });
  await waitFor(function () { return a.sync.connected && b.sync.connected; }, 'connect');
  edit(a, function (e) { return e.create({ kind: 'rect', x: 1, y: 1, w: 1, h: 1 }); });
  await waitFor(function () { return a.sync.pending() === 0; }, 'ack');
  assert.equal(crdt.view(b.doc).length, 0);
});

test('offline edits are queued, merged and delivered after reconnect', async function (t) {
  var srv = await startServer();
  var a = client(srv.url('room2'), 'ana');
  var b = client(srv.url('room2'), 'ben');
  t.after(function () { a.sync.close(); b.sync.close(); return srv.close(); });
  await waitFor(function () { return a.sync.connected && b.sync.connected; }, 'connect');

  // Drop A's socket server-side to simulate a network blip.
  srv.app.wss.clients.forEach(function (ws) { ws.terminate(); });
  await waitFor(function () { return !a.sync.connected; }, 'disconnect');
  var offline = edit(a, function (e) { return e.create({ kind: 'sticky', x: 0, y: 0, w: 100, h: 80, text: 'written offline' }); });
  assert.equal(a.sync.pending(), offline.ops.length);

  await waitFor(function () { return a.sync.connected && b.sync.connected; }, 'reconnect');
  await waitFor(function () { return crdt.read(b.doc, offline.id, 'text') === 'written offline'; }, 'offline edit delivered');
  await waitFor(function () { return a.sync.pending() === 0; }, 'outbox drained');
});

test('presence and departure are broadcast; invalid ops are rejected', async function (t) {
  var srv = await startServer();
  var a = client(srv.url('room3'), 'ana');
  var b = client(srv.url('room3'), 'ben');
  t.after(function () { a.sync.close(); return srv.close(); });
  await waitFor(function () { return a.sync.connected && b.sync.connected; }, 'connect');

  b.sync.presence({ x: 10, y: 20 });
  await waitFor(function () { return a.events.presence.length > 0; }, 'presence');
  assert.equal(a.events.presence[0].name, 'ben');
  assert.deepEqual(a.events.presence[0].cursor, { x: 10, y: 20 });

  a.sync.ws.send(JSON.stringify({ type: 'ops', ops: [{ type: 'set', id: 'x', field: 'onclick', value: 'alert(1)', ts: [1, 'a'] }] }));
  await waitFor(function () { return a.events.errors.length > 0; }, 'error');
  assert.match(a.events.errors[0], /unknown field onclick/);

  var bId = b.sync.clientId;
  b.sync.close();
  await waitFor(function () { return a.events.left.indexOf(bId) >= 0; }, 'peer-left');
});

test('room state persists across server restarts', async function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inksync-'));
  var srv = await startServer(dir);
  var a = client(srv.url('saved'), 'ana');
  await waitFor(function () { return a.sync.connected; }, 'connect');
  var created = edit(a, function (e) { return e.create({ kind: 'text', x: 3, y: 4, text: 'hello', fontSize: 20 }); });
  await waitFor(function () { return a.sync.pending() === 0; }, 'ack');
  a.sync.close();
  await srv.close();
  assert.ok(fs.existsSync(path.join(dir, 'saved.json')));

  var srv2 = await startServer(dir);
  var b = client(srv2.url('saved'), 'ben');
  await waitFor(function () { return b.sync.connected; }, 'reconnect');
  assert.equal(crdt.read(b.doc, created.id, 'text'), 'hello');
  b.sync.close();
  await srv2.close();
});
