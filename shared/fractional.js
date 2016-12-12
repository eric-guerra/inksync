'use strict';

/**
 * Fractional indexing for z-order: keys are base-62 strings that sort lexicographically, and a new
 * key can always be generated strictly between any two others. Reordering a shape changes only that
 * shape's key, so concurrent reorders by different users never conflict.
 */
var DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
var BASE = DIGITS.length;

function digit(ch) {
  var i = DIGITS.indexOf(ch);
  if (i < 0) throw new Error('invalid fractional key character ' + ch);
  return i;
}

/** Returns a key k with a < k < b. Either bound may be null (open-ended). */
function between(a, b) {
  if (a !== null && b !== null && a >= b) throw new Error('between: a must sort before b (' + a + ', ' + b + ')');
  var lo = a || '';
  var hi = b;
  var out = '';
  for (var i = 0; ; i++) {
    var l = i < lo.length ? digit(lo[i]) : 0;
    // Keys we generate never end in '0', so hi can't be an exact prefix of the result.
    if (hi !== null && i >= hi.length) throw new Error('between: no key fits between ' + a + ' and ' + b);
    var h = hi !== null ? digit(hi[i]) : BASE;
    if (h - l > 1) {
      // Room between the digits at this position.
      out += DIGITS[Math.floor((l + h) / 2)];
      return out;
    }
    // No room: copy lo's digit and continue one position deeper, now unbounded above
    // (once we've gone below hi's digit at some position, anything after is < hi).
    out += DIGITS[l];
    if (h > l) hi = null;
  }
}

/** Key after the last of `keys` (used when adding a new shape on top). */
function after(lastKey) {
  return between(lastKey || null, null);
}

module.exports = { between: between, after: after };
