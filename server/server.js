'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var WebSocketServer = require('ws').WebSocketServer;
var Room = require('./room');

var STATIC = path.join(__dirname, '..', 'public');
var TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.map': 'application/json' };

/**
 * HTTP for the static client + WebSocket at /ws?room=<id>.
 * Messages: hello {name} → welcome; ops {ops}; presence {cursor}; server sends ops/presence/peer-* to peers.
 */
function createServer(options) {
  options = options || {};
  var rooms = new Map();

  function room(id) {
    var r = rooms.get(id);
    if (!r) {
      r = new Room(id, { dataDir: options.dataDir });
      rooms.set(id, r);
    }
    return r;
  }

  var server = http.createServer(function (req, res) {
    var url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    }
    var file = path.normalize(path.join(STATIC, url.pathname === '/' || url.pathname.startsWith('/b/') ? 'index.html' : url.pathname));
    if (!file.startsWith(STATIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, function (err, data) {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  var wss = new WebSocketServer({ server: server, path: '/ws', maxPayload: 1024 * 1024 });

  wss.on('connection', function (ws, req) {
    var url = new URL(req.url, 'http://x');
    var roomId = (url.searchParams.get('room') || '').slice(0, 64);
    if (!/^[\w-]{1,64}$/.test(roomId)) {
      ws.close(1008, 'invalid room');
      return;
    }
    var r = room(roomId);
    var clientId = crypto.randomUUID();
    var joined = false;
    ws.isAlive = true;
    ws.on('pong', function () { ws.isAlive = true; });

    function send(msg) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    }

    ws.on('message', function (data) {
      var msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        return send({ type: 'error', error: 'invalid JSON' });
      }
      if (msg.type === 'hello' && !joined) {
        joined = true;
        r.join(clientId, String(msg.name || 'Guest').slice(0, 40), send);
      } else if (!joined) {
        send({ type: 'error', error: 'say hello first' });
      } else if (msg.type === 'ops') {
        var result = r.receiveOps(clientId, msg.ops);
        if (result.error) send({ type: 'error', error: result.error });
        else if (msg.ack) send({ type: 'ack', ack: msg.ack, applied: result.applied });
      } else if (msg.type === 'presence') {
        r.presence(clientId, msg.cursor === undefined ? null : msg.cursor);
      }
    });

    ws.on('close', function () {
      r.leave(clientId);
      if (r.isEmpty()) {
        r.flush();
        rooms.delete(roomId);
      }
    });
  });

  // Drop dead connections so their cursors disappear.
  var heartbeat = setInterval(function () {
    wss.clients.forEach(function (ws) {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, options.heartbeatMs || 30000);

  server.on('close', function () {
    clearInterval(heartbeat);
    rooms.forEach(function (r) { r.flush(); });
  });

  return { server: server, wss: wss, rooms: rooms };
}

module.exports = createServer;
