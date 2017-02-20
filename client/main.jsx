import React from 'react';
import ReactDOM from 'react-dom';
import { Provider } from 'react-redux';
import crdt from '../shared/crdt';
import { LamportClock } from '../shared/clock';
import Editor from '../shared/editor';
import SyncClient from './sync';
import { createAppStore, T } from './state';
import App from './components/App';

const room = (location.pathname.match(/^\/b\/([\w-]+)/) || [])[1] || 'lobby';
let actor = sessionStorage.getItem('inksync.actor');
if (!actor) {
  actor = crypto.randomUUID();
  sessionStorage.setItem('inksync.actor', actor);
}
const name = localStorage.getItem('inksync.name') || prompt('Your name?') || 'Guest';
localStorage.setItem('inksync.name', name);

const doc = crdt.empty();
const clock = new LamportClock(actor);
const editor = new Editor(doc, clock);
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
let store;
const sync = new SyncClient({
  url: `${proto}://${location.host}/ws?room=${room}`,
  name, doc, clock,
  handlers: {
    change: () => store.dispatch({ type: 'doc/remote' }),
    acked: () => store.dispatch({ type: 'doc/remote' }),
    status: (status) => store.dispatch({ type: T.STATUS, status }),
    welcome: (msg) => store.dispatch({ type: T.PEERS, peers: msg.peers }),
    'peer-joined': (p) => store.dispatch({ type: T.PEER, peer: p }),
    presence: (p) => store.dispatch({ type: T.PEER, peer: p }),
    'peer-left': (p) => store.dispatch({ type: T.PEER_LEFT, clientId: p.clientId })
  }
});
store = createAppStore(editor, sync);
sync.connect();

ReactDOM.render(<Provider store={store}><App room={room} /></Provider>, document.getElementById('root'));
