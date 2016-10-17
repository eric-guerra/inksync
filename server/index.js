'use strict';

var path = require('path');
var createServer = require('./server');

var app = createServer({ dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data') });
var port = Number(process.env.PORT) || 3000;
app.server.listen(port, function () {
  console.log('InkSync on http://localhost:' + port);
});

function shutdown() {
  app.wss.clients.forEach(function (ws) { ws.close(1001, 'server shutting down'); });
  app.server.close(function () { process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
