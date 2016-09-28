'use strict';

var redux = require('redux');
var crdt = require('../shared/crdt');

/**
 * Redux holds what the UI renders: the derived shape list, presence, tool state and connection
 * status. The CRDT document and editor live outside Redux (they're mutable, op-driven); the
 * middleware bridges commands to the editor and the network, then publishes a fresh view.
 */
var T = {
  CREATE: 'cmd/create', UPDATE: 'cmd/update', REMOVE: 'cmd/remove', UNDO: 'cmd/undo', REDO: 'cmd/redo',
  FRONT: 'cmd/front', BACK: 'cmd/back',
  DOC_CHANGED: 'doc/changed', SET_TOOL: 'ui/tool', SET_COLOR: 'ui/color', SELECT: 'ui/select',
  STATUS: 'conn/status', PEERS: 'presence/peers', PEER: 'presence/peer', PEER_LEFT: 'presence/left', CURSOR: 'presence/cursor'
};

function board(state, action) {
  state = state || { shapes: [], canUndo: false, canRedo: false, pending: 0 };
  if (action.type === T.DOC_CHANGED) return { shapes: action.shapes, canUndo: action.canUndo, canRedo: action.canRedo, pending: action.pending };
  return state;
}

function ui(state, action) {
  state = state || { tool: 'select', color: '#264653', selectedId: null };
  switch (action.type) {
    case T.SET_TOOL: return Object.assign({}, state, { tool: action.tool, selectedId: null });
    case T.SET_COLOR: return Object.assign({}, state, { color: action.color });
    case T.SELECT: return Object.assign({}, state, { selectedId: action.id });
    case T.DOC_CHANGED:
      // Deselect a shape someone else deleted.
      if (state.selectedId && !action.shapes.some(function (s) { return s.id === state.selectedId; })) {
        return Object.assign({}, state, { selectedId: null });
      }
      return state;
    default: return state;
  }
}

function presence(state, action) {
  state = state || {};
  var next;
  switch (action.type) {
    case T.PEERS:
      next = {};
      action.peers.forEach(function (p) { next[p.clientId] = p; });
      return next;
    case T.PEER:
      next = Object.assign({}, state);
      next[action.peer.clientId] = Object.assign({}, state[action.peer.clientId], action.peer);
      return next;
    case T.PEER_LEFT:
      next = Object.assign({}, state);
      delete next[action.clientId];
      return next;
    default: return state;
  }
}

function connection(state, action) {
  state = state || { status: 'connecting' };
  return action.type === T.STATUS ? { status: action.status } : state;
}

/** Bridges editor + sync. Commands never reach reducers directly; they become DOC_CHANGED. */
function boardMiddleware(editor, sync) {
  return function (store) {
    function publish() {
      store.dispatch({ type: T.DOC_CHANGED, shapes: crdt.view(editor.doc), canUndo: editor.canUndo(), canRedo: editor.canRedo(), pending: sync ? sync.pending() : 0 });
    }
    return function (next) {
      return function (action) {
        var ops;
        switch (action.type) {
          case T.CREATE: ops = editor.create(action.props).ops; break;
          case T.UPDATE: ops = editor.update(action.id, action.changes); break;
          case T.REMOVE: ops = editor.remove(action.id); break;
          case T.UNDO: ops = editor.undo(); break;
          case T.REDO: ops = editor.redo(); break;
          case T.FRONT: ops = editor.bringToFront(action.id); break;
          case T.BACK: ops = editor.sendToBack(action.id); break;
          case 'doc/remote': publish(); return undefined;
          case T.CURSOR: if (sync) sync.presence(action.cursor); return undefined;
          default: return next(action);
        }
        if (sync && ops.length) sync.send(ops);
        publish();
        return ops;
      };
    };
  };
}

function createAppStore(editor, sync) {
  return redux.createStore(
    redux.combineReducers({ board: board, ui: ui, presence: presence, connection: connection }),
    redux.applyMiddleware(boardMiddleware(editor, sync)));
}

module.exports = { T: T, createAppStore: createAppStore, reducers: { board: board, ui: ui, presence: presence, connection: connection } };
