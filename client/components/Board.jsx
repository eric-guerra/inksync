import React, { useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { T } from '../state';

function pointerPos(svg, e) {
  const r = svg.getBoundingClientRect();
  return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
}

function pathData(points) {
  if (!points || points.length < 2) return '';
  let d = `M${points[0]} ${points[1]}`;
  for (let i = 2; i < points.length; i += 2) d += ` L${points[i]} ${points[i + 1]}`;
  return d;
}

function Shape({ s, selected, onPointerDown }) {
  const common = { stroke: s.stroke || '#264653', strokeWidth: selected ? 3 : 2, fill: s.fill || 'none', onPointerDown, style: { cursor: 'move' } };
  switch (s.kind) {
    case 'rect': return <rect x={s.x} y={s.y} width={s.w} height={s.h} rx="4" {...common} />;
    case 'ellipse': return <ellipse cx={s.x + s.w / 2} cy={s.y + s.h / 2} rx={Math.abs(s.w / 2)} ry={Math.abs(s.h / 2)} {...common} />;
    case 'line': return <line x1={s.x} y1={s.y} x2={s.x2} y2={s.y2} {...common} />;
    case 'path': return <path d={pathData(s.points)} {...common} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
    case 'sticky':
      return (
        <g onPointerDown={onPointerDown} style={{ cursor: 'move' }}>
          <rect x={s.x} y={s.y} width={s.w} height={s.h} fill={s.fill || '#ffe66d'} stroke={selected ? '#264653' : 'none'} strokeWidth="2" />
          <foreignObject x={s.x + 6} y={s.y + 6} width={s.w - 12} height={s.h - 12}><div className="sticky-text">{s.text}</div></foreignObject>
        </g>
      );
    case 'text': return <text x={s.x} y={s.y} fontSize={s.fontSize || 18} fill={s.stroke || '#264653'} onPointerDown={onPointerDown}>{s.text}</text>;
    default: return null;
  }
}

/**
 * Drawing surface. Creating shapes is optimistic: the local preview renders while dragging, and a
 * single create (or update) command is dispatched on pointer-up, so peers receive one clean edit.
 */
export default function Board() {
  const dispatch = useDispatch();
  const svgRef = useRef(null);
  const shapes = useSelector((s) => s.board.shapes);
  const peers = useSelector((s) => Object.values(s.presence));
  const { tool, color, selectedId } = useSelector((s) => s.ui);
  const [draft, setDraft] = useState(null);   // shape being drawn
  const [drag, setDrag] = useState(null);     // { id, start, orig }

  const lastCursor = useRef(0);
  const sendCursor = (pos) => {
    const now = Date.now();
    if (now - lastCursor.current > 40) { // ~25 updates/s is plenty for cursors
      lastCursor.current = now;
      dispatch({ type: T.CURSOR, cursor: pos });
    }
  };

  const onDown = (e) => {
    const p = pointerPos(svgRef.current, e);
    if (tool === 'select') { dispatch({ type: T.SELECT, id: null }); return; }
    svgRef.current.setPointerCapture(e.pointerId);
    if (tool === 'path') setDraft({ kind: 'path', points: [p.x, p.y], stroke: color });
    else if (tool === 'line') setDraft({ kind: 'line', x: p.x, y: p.y, x2: p.x, y2: p.y, stroke: color });
    else if (tool === 'text' || tool === 'sticky') {
      const text = window.prompt(tool === 'sticky' ? 'Sticky note text' : 'Text');
      if (text) dispatch({ type: T.CREATE, props: tool === 'sticky'
        ? { kind: 'sticky', x: p.x, y: p.y, w: 160, h: 120, text, fill: '#ffe66d' }
        : { kind: 'text', x: p.x, y: p.y, text, stroke: color, fontSize: 20 } });
    } else setDraft({ kind: tool, x: p.x, y: p.y, w: 0, h: 0, stroke: color, start: p });
  };

  const onMove = (e) => {
    const p = pointerPos(svgRef.current, e);
    sendCursor(p);
    if (drag) {
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      setDrag({ ...drag, dx, dy });
      return;
    }
    if (!draft) return;
    if (draft.kind === 'path') setDraft({ ...draft, points: draft.points.concat([p.x, p.y]) });
    else if (draft.kind === 'line') setDraft({ ...draft, x2: p.x, y2: p.y });
    else {
      const s = draft.start;
      setDraft({ ...draft, x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
    }
  };

  const onUp = () => {
    if (drag) {
      if (drag.dx || drag.dy) {
        const o = drag.orig;
        const changes = { x: o.x + drag.dx, y: o.y + drag.dy };
        if (o.kind === 'line') Object.assign(changes, { x2: o.x2 + drag.dx, y2: o.y2 + drag.dy });
        if (o.kind === 'path') changes.points = o.points.map((v, i) => v + (i % 2 ? drag.dy : drag.dx));
        dispatch({ type: T.UPDATE, id: o.id, changes: o.kind === 'path' ? { points: changes.points } : changes });
      }
      setDrag(null);
      return;
    }
    if (!draft) return;
    const { start, ...props } = draft;
    const big = props.kind === 'path' ? props.points.length >= 4 : props.kind === 'line' ? (props.x !== props.x2 || props.y !== props.y2) : props.w > 3 && props.h > 3;
    if (big) dispatch({ type: T.CREATE, props: props.kind === 'path' ? { ...props, x: props.points[0], y: props.points[1] } : props });
    setDraft(null);
  };

  const startDrag = (s) => (e) => {
    if (tool !== 'select') return;
    e.stopPropagation();
    svgRef.current.setPointerCapture(e.pointerId);
    dispatch({ type: T.SELECT, id: s.id });
    setDrag({ start: pointerPos(svgRef.current, e), orig: s, dx: 0, dy: 0 });
  };

  const rendered = drag
    ? shapes.map((s) => (s.id === drag.orig.id ? { ...s, x: s.x + drag.dx, y: s.y + drag.dy, x2: s.x2 + drag.dx, y2: s.y2 + drag.dy,
        points: s.points && s.points.map((v, i) => v + (i % 2 ? drag.dy : drag.dx)) } : s))
    : shapes;

  return (
    <svg ref={svgRef} className={`board tool-${tool}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
         onPointerLeave={() => dispatch({ type: T.CURSOR, cursor: null })}>
      {rendered.map((s) => <Shape key={s.id} s={s} selected={s.id === selectedId} onPointerDown={startDrag(s)} />)}
      {draft && <Shape s={draft} selected={false} />}
      {peers.filter((p) => p.cursor).map((p) => (
        <g key={p.clientId} transform={`translate(${p.cursor.x} ${p.cursor.y})`} className="cursor">
          <path d="M0 0 L0 16 L4 12 L8 20 L11 19 L7 11 L13 11 Z" fill={p.color} stroke="#fff" />
          <text x="14" y="24" fill={p.color} fontSize="12">{p.name}</text>
        </g>
      ))}
    </svg>
  );
}
