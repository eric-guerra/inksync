'use strict';

/**
 * Lamport timestamps tagged with an actor id: [counter, actor].
 * Total order: counter first, then actor string, so concurrent writes resolve identically everywhere.
 */
function compare(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] === b[1]) return 0;
  return a[1] < b[1] ? -1 : 1;
}

function LamportClock(actor, start) {
  if (!actor) throw new Error('actor id required');
  this.actor = actor;
  this.counter = start || 0;
}

LamportClock.prototype.tick = function () {
  this.counter += 1;
  return [this.counter, this.actor];
};

/** Advance past a timestamp seen from a peer. */
LamportClock.prototype.observe = function (ts) {
  if (ts && ts[0] > this.counter) this.counter = ts[0];
};

module.exports = { compare: compare, LamportClock: LamportClock };
