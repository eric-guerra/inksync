import React, { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { T } from '../state';
import Toolbar from './Toolbar';
import Board from './Board';

export default function App({ room }) {
  const dispatch = useDispatch();
  const status = useSelector((s) => s.connection.status);
  const pending = useSelector((s) => s.board.pending);
  const peers = useSelector((s) => Object.values(s.presence));
  const selectedId = useSelector((s) => s.ui.selectedId);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? T.REDO : T.UNDO });
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        dispatch({ type: T.REMOVE, id: selectedId });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, selectedId]);

  return (
    <div className="app">
      <header>
        <strong>InkSync</strong> <span className="room">/{room}</span>
        <span className={`status ${status}`}>{status}{pending ? ` · ${pending} unsynced` : ''}</span>
        <span className="peers">
          {peers.map((p) => <span key={p.clientId} className="avatar" style={{ background: p.color }} title={p.name}>{(p.name || '?')[0]}</span>)}
        </span>
      </header>
      <Toolbar />
      <Board />
    </div>
  );
}
