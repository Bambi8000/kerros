#!/usr/bin/env node
/**
 * validate-twist.mjs
 *
 * Imports the REAL src/core/twist.ts. A twist that turns the holes the wrong
 * way looks perfectly fine on screen and cannot be assembled, so the sign is
 * checked rather than assumed.
 */

import {
  NO_TWIST,
  parseTwistOverrides,
  writeTwistOverrides,
  twistAt,
  untwistPoint,
  twistPoint,
  twistPeriod,
} from '../src/core/twist.ts';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

console.log('twist: how far each layer turns');
{
  const spiral = { perLayer: 5, overrides: '' };
  check('the bottom layer is never turned', twistAt(spiral, 1) === 0);
  check('and the spiral is measured from it', twistAt(spiral, 4) === 15);
  check('no twist means no twist', twistAt(NO_TWIST, 12) === 0);
  check('a negative spiral turns the other way', twistAt({ perLayer: -5, overrides: '' }, 3) === -10);

  /*
   * An override replaces the spiral rather than adding to it. "This one at 40
   * degrees" is what people mean, and a value that quietly compounded with the
   * spiral would be impossible to aim.
   */
  const withHand = { perLayer: 5, overrides: '4:40 9:-10' };
  check('a hand-set layer takes its own angle', twistAt(withHand, 4) === 40);
  check('and does not add to the spiral', twistAt(withHand, 4) !== 15 + 40);
  check('a negative override is honoured', twistAt(withHand, 9) === -10);
  check('layers around it keep the spiral', twistAt(withHand, 5) === 20);
}

console.log('twist: the overrides people hand-edit');
{
  const table = parseTwistOverrides('7:15 12:-20');
  check('two entries', table.size === 2);
  check('read as numbers', table.get(7) === 15 && table.get(12) === -20);
  check('an empty string is no overrides', parseTwistOverrides('').size === 0);
  check('extra whitespace does not matter', parseTwistOverrides('  7:15\n12:-20 ').size === 2);
  check('garbage is skipped, not guessed at', parseTwistOverrides('7:15 nonsense 12:x').size === 1);
  check('round-trips in layer order', writeTwistOverrides(parseTwistOverrides('12:-20 7:15')) === '7:15 12:-20');
  check('and an empty map writes nothing', writeTwistOverrides(new Map()) === '');
}

console.log('twist: which way the holes go');
{
  /*
   * The sign, which is the one thing here that looks fine on screen and cannot
   * be assembled. A hole is drilled turned **back**, so that turning the sheet
   * forward at assembly puts it on the axis it belongs to.
   */
  const [hx, hy] = untwistPoint(40, 0, 90);
  check('a hole is drilled turned back', near(hx, 0, 1e-9) && near(hy, -40, 1e-9), `${hx.toFixed(3)}, ${hy.toFixed(3)}`);

  const [bx, by] = twistPoint(hx, hy, 90);
  check('and turning the sheet puts it back on its axis', near(bx, 40, 1e-9) && near(by, 0, 1e-9));

  check('no twist moves nothing', untwistPoint(17, -3, 0).join() === '17,-3');
  check('a point on the axis stays there', untwistPoint(0, 0, 137).every((v) => near(v, 0)));

  // Turning about the stack's axis, which is not always the origin.
  const [ox, oy] = untwistPoint(140, 100, 90, 100, 100);
  check('it turns about the axis it is given', near(ox, 100, 1e-9) && near(oy, 60, 1e-9));

  check('the two directions undo each other', (() => {
    const [x1, y1] = untwistPoint(31, -12, 37);
    const [x2, y2] = twistPoint(x1, y1, 37);
    return near(x2, 31, 1e-9) && near(y2, -12, 1e-9);
  })());

  // The error that would be invisible: a whole rod's clearance out of line.
  const drift = Math.hypot(...untwistPoint(40, 0, 2 * 17).map((v, i) => v - [40, 0][i]));
  check('two degrees over eighteen layers is more than a rod can take', drift > 5.3, `${drift.toFixed(2)} mm`);
}

console.log('twist: a spiral that comes back round');
{
  check('45 degrees repeats every eighth sheet', twistPeriod(45) === 8);
  check('90 every fourth', twistPeriod(90) === 4);
  check('no twist is every sheet', twistPeriod(0) === 1);
  check('7 degrees never comes back round', twistPeriod(7) === 0);
  // 2.5 divides 360 exactly, so it does repeat — just a long way up. The first
  // version of this line claimed it did not and then asserted that it did.
  check('2.5 does, after 144 layers', twistPeriod(2.5) === 144);
  check('a stack is never that tall, but the number is honest', twistPeriod(2.5) > 60);
}

console.log('');
if (failures > 0) { console.log(`FAIL  ${failures} check(s) failed`); process.exit(1); }
console.log('OK    twist');
