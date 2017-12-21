# InkSync

A real-time collaborative whiteboard. Several people draw, move and edit shapes at once, see each other's cursors, keep working offline, and always converge to the same board. It's built on a **CRDT** document synced over **WebSockets**, with a **React + Redux** client.

> Portfolio reference implementation of a 2016 graduate-coursework project on collaborative editing, the precursor to my MS thesis on causally consistent state synchronization.

## How it stays consistent

The document ([shared/crdt.js](shared/crdt.js)) is a map of shapes, where each field of each shape is a **last-writer-wins register** timestamped with a **Lamport clock** `[counter, actorId]`, plus an LWW tombstone for deletion.

- `apply` is commutative, associative and idempotent, so replicas that have seen the same operations in **any order, with duplicates**, are identical. A 200-seed fuzz test checks this across shuffled, duplicated delivery.
- Field-level registers mean concurrent edits to *different* properties both survive (Alice moves a shape while Bob recolors it).
- Deletes are tombstones, so a delete racing an edit is resolved deterministically and undo can revive the shape.
- **Z-order** uses [fractional indexing](shared/fractional.js): bringing a shape forward rewrites only that shape's key, so concurrent reorders never conflict. Keys never end in the minimum digit, so a key always exists between two neighbors (property-tested).

## Undo that respects collaborators

[shared/editor.js](shared/editor.js) records, for each command, the inverse ops computed at edit time and a separate redo plan (undoing a create deletes the shape, and redo *restores* it rather than re-creating it). Undo and redo are re-stamped as new edits that sync like any other. Your undo reverts *your* fields only, so a collaborator's concurrent change survives (covered by a test).

## Sync protocol

```
client                                   server (room)
  hello {name}            ───────────▶   join, assign color
                          ◀───────────   welcome {clientId, snapshot, peers}
  ops {ops, ack}          ───────────▶   validate → apply → relay only ops that changed state
                          ◀───────────   ack {ack}            ops {from, ops} ──▶ other peers
  presence {cursor}       ───────────▶   presence ──▶ peers (not persisted)
```

- **Offline-first client** ([client/sync.js](client/sync.js)): edits apply locally at once and wait in an outbox until acknowledged. The outbox is resent in full on reconnect, which is safe because ops are idempotent. The welcome snapshot is *merged* (not replaced), so offline work survives. Reconnects use exponential backoff with jitter.
- **Server** ([server/room.js](server/room.js)): strict op validation (field allow-list, numeric bounds, kind allow-list, size caps); a debounced, atomic (write-temp-then-rename) snapshot per room; heartbeat pings to drop dead peers; empty rooms are flushed and unloaded.

## Client

Redux holds the derived view (shapes, undo state, unsynced count), presence and tool state. The CRDT document and editor live outside Redux, bridged by middleware that turns commands (`cmd/create`, `cmd/update`, `cmd/undo`…) into ops, sends them, and publishes a fresh view. The SVG board shows optimistic previews while you drag, and a drag or draw commits as a single edit on pointer-up. Cursors are throttled to about 25 updates per second.

## Run

```bash
npm install
npm run build
npm start          # http://localhost:3000/b/my-board   (share the URL)
```

## Test

```bash
npm test           # 18 tests: CRDT convergence fuzzing, fractional keys, editor/undo semantics,
                   # Redux middleware, and real WebSocket sessions (convergence, late join, offline replay,
                   # presence, validation, persistence across restarts)
```
