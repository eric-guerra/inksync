import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { T } from '../state';

const TOOLS = [
  ['select', '↖ Select'], ['rect', '▭ Rect'], ['ellipse', '◯ Ellipse'], ['line', '╱ Line'],
  ['path', '✎ Pen'], ['sticky', '🗒 Sticky'], ['text', 'T Text']
];
const COLORS = ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51', '#6a4c93', '#000000'];

export default function Toolbar() {
  const dispatch = useDispatch();
  const { tool, color, selectedId } = useSelector((s) => s.ui);
  const { canUndo, canRedo } = useSelector((s) => s.board);

  return (
    <div className="toolbar">
      {TOOLS.map(([id, label]) => (
        <button key={id} className={tool === id ? 'active' : ''} onClick={() => dispatch({ type: T.SET_TOOL, tool: id })}>{label}</button>
      ))}
      <span className="sep" />
      {COLORS.map((c) => (
        <button key={c} className={`swatch ${color === c ? 'active' : ''}`} style={{ background: c }}
                aria-label={`color ${c}`}
                onClick={() => {
                  dispatch({ type: T.SET_COLOR, color: c });
                  if (selectedId) dispatch({ type: T.UPDATE, id: selectedId, changes: { stroke: c } });
                }} />
      ))}
      <span className="sep" />
      <button disabled={!canUndo} onClick={() => dispatch({ type: T.UNDO })}>Undo</button>
      <button disabled={!canRedo} onClick={() => dispatch({ type: T.REDO })}>Redo</button>
      <button disabled={!selectedId} onClick={() => dispatch({ type: T.FRONT, id: selectedId })}>Front</button>
      <button disabled={!selectedId} onClick={() => dispatch({ type: T.BACK, id: selectedId })}>Back</button>
      <button disabled={!selectedId} onClick={() => dispatch({ type: T.REMOVE, id: selectedId })}>Delete</button>
    </div>
  );
}
