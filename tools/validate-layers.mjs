#!/usr/bin/env node
/**
 * validate-layers.mjs
 *
 * Imports the REAL src/core/layers.ts. The selector decides which sheets get
 * drilled, so getting it wrong is not a wrong pixel — it is a hole in the wrong
 * piece of board.
 *
 *   node tools/validate-layers.mjs
 */

import {
  LAYER_SELECTOR_KINDS,
  DEFAULT_LAYER_SELECTOR,
  selectorFromParams,
  resolveLayers,
  resolveLayerSet,
  describeSelector,
} from '../src/core/layers.ts';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sel = (patch) => ({ ...DEFAULT_LAYER_SELECTOR, ...patch });

/** A plain stack: 12 sheets, 3 mm thick, 9 mm pitch, first mid-plane at 1.5. */
const stack = [];
for (let k = 0; k < 12; k++) stack.push({ index: k + 1, z: 1.5 + k * 9 });

console.log('layers: the registry');
{
  check('four kinds', LAYER_SELECTOR_KINDS.length === 4);
  check('the default takes everything', DEFAULT_LAYER_SELECTOR.kind === 'all');
  check(
    'and every kind resolves without throwing',
    LAYER_SELECTOR_KINDS.every((kind) => Array.isArray(resolveLayers(sel({ kind }), stack))),
  );
}

console.log('layers: all');
{
  check('every layer', resolveLayers(sel({ kind: 'all' }), stack).length === 12);
  check('numbered as the inspector numbers them', resolveLayers(sel({ kind: 'all' }), stack)[0] === 1);
  check('an empty stack picks nothing', resolveLayers(sel({ kind: 'all' }), []).length === 0);
}

console.log('layers: band');
{
  /*
   * These are the assertions that used to live on `fixtureSpansZ`, moved here
   * with the mechanism. The band has to behave exactly as it did or every
   * fixture in every saved project lands on different sheets.
   */
  const band = (z, length) => resolveLayers(sel({ kind: 'band', z, length }), stack);

  check('a band around the middle takes the sheets in it', band(28.5, 20).join(',') === '3,4,5');
  check('inclusive at the low edge', band(19.5, 0).join(',') === '3');
  // 28.5 +- 9 lands exactly on the mid-planes of layers 3 and 5, so this checks
  // both edges at once. The first version of this line asserted layers 2 and 6,
  // which are a pitch outside the band — the test was wrong, not the band.
  check('inclusive at both edges when they land on mid-planes', band(28.5, 18).join(',') === '3,4,5');
  check('a band shorter than a pitch reaches one layer', band(37.5, 1).join(',') === '5');
  check('a zero-height band on a mid-plane still reaches it', band(1.5, 0).join(',') === '1');
  check('a zero-height band between mid-planes reaches none', band(6, 0).length === 0);
  check('a band below the stack takes nothing', band(-50, 10).length === 0);
  check('a band above the stack takes nothing', band(400, 10).length === 0);
  check('a negative height is treated as zero, not inverted', band(1.5, -20).join(',') === '1');
  check('a band taller than the stack takes all of it', band(50, 400).length === 12);
}

console.log('layers: range');
{
  const range = (from, to) => resolveLayers(sel({ kind: 'range', from, to }), stack);

  check('the bottom three sheets', range(1, 3).join(',') === '1,2,3');
  check('a single sheet', range(7, 7).join(',') === '7');
  check('ends the wrong way round are ordered, not refused', range(9, 4).join(',') === '4,5,6,7,8,9');
  check('a range past the top is clipped', range(10, 99).join(',') === '10,11,12');
  check('a range below the bottom is clipped', range(-5, 2).join(',') === '1,2');
  check('a range entirely outside takes nothing', range(50, 60).length === 0);

  /*
   * Layer numbers, not plane indices. A model with a void along Z examines a
   * plane there and produces no sheet; "the bottom three sheets" means three
   * sheets a person can hold.
   */
  const withVoid = [
    { index: 1, z: 1.5 },
    { index: 2, z: 10.5 },
    { index: 3, z: 46.5 },
    { index: 4, z: 55.5 },
  ];
  check(
    'a gap in the stack does not renumber the sheets',
    resolveLayers(sel({ kind: 'range', from: 1, to: 3 }), withVoid).join(',') === '1,2,3',
  );
}

console.log('layers: every nth');
{
  const every = (n, offset) => resolveLayers(sel({ kind: 'every', n, offset }), stack);

  check('every layer at n = 1', every(1, 0).length === 12);
  check('every second', every(2, 0).join(',') === '1,3,5,7,9,11');
  check('and the other half at offset 1', every(2, 1).join(',') === '2,4,6,8,10,12');
  check('the two halves cover the stack exactly once', every(2, 0).length + every(2, 1).length === 12);
  check('every third', every(3, 0).join(',') === '1,4,7,10');
  check('an offset past n wraps rather than emptying', every(2, 5).join(',') === '2,4,6,8,10,12');
  check('a negative offset wraps too', every(2, -1).join(',') === '2,4,6,8,10,12');
  check('n below 1 is clamped rather than dividing by zero', every(0, 0).length === 12);
  check('a fractional n rounds', every(2.4, 0).join(',') === '1,3,5,7,9,11');

  /*
   * Interleaved pins are the reason this exists: consecutive runs must not
   * share a sheet, and between them every sheet must be caught.
   */
  const a = new Set(every(3, 0));
  const b = new Set(every(3, 1));
  const c = new Set(every(3, 2));
  check('three phases never overlap', [...a].every((n) => !b.has(n) && !c.has(n)));
  check('and together they are the whole stack', a.size + b.size + c.size === 12);

  // Counted by position, so a void does not put the phase out.
  const withVoid = [1, 2, 3, 4].map((index, at) => ({ index, z: at < 2 ? 1.5 + at * 9 : 46.5 + (at - 2) * 9 }));
  check(
    'phase counts by position in the stack, not by layer number',
    resolveLayers(sel({ kind: 'every', n: 2, offset: 0 }), withVoid).join(',') === '1,3',
  );
}

console.log('layers: reading a selector out of parameters');
{
  check('nothing at all gives the default', selectorFromParams(undefined).kind === 'all');
  check('an empty bag gives the default', selectorFromParams({}).kind === 'all');
  check(
    'a feature that predates selectors takes everything',
    resolveLayers(selectorFromParams({ diameter: 10.5 }), stack).length === 12,
  );

  const read = selectorFromParams({
    selKind: 'band',
    selZ: 28.5,
    selLength: 20,
    selFrom: 2,
    selTo: 5,
    selN: 3,
    selOffset: 1,
  });
  check('every field is read', read.kind === 'band' && read.z === 28.5 && read.n === 3);
  check('and it resolves', resolveLayers(read, stack).join(',') === '3,4,5');

  check('an unknown kind falls back rather than throwing', selectorFromParams({ selKind: 'sideways' }).kind === 'all');
  check('a kind that is not a string falls back', selectorFromParams({ selKind: 7 }).kind === 'all');
  check('a length that is not a number falls back', selectorFromParams({ selLength: 'tall' }).length === DEFAULT_LAYER_SELECTOR.length);
  check('NaN falls back', selectorFromParams({ selZ: Number.NaN }).z === DEFAULT_LAYER_SELECTOR.z);

  // A caller can move the default without editing this module: a fixture wants
  // a band by default, perforation wants everything.
  const fixtureish = selectorFromParams({}, { kind: 'band', z: 40, length: 12 });
  check('a caller can supply its own default', fixtureish.kind === 'band' && fixtureish.z === 40);
  check(
    'and stored parameters still win over it',
    selectorFromParams({ selKind: 'all' }, { kind: 'band' }).kind === 'all',
  );
}

console.log('layers: the set is the same answer');
{
  const s = sel({ kind: 'every', n: 3, offset: 1 });
  const list = resolveLayers(s, stack);
  const set = resolveLayerSet(s, stack);
  check('same size', set.size === list.length);
  check('same members', list.every((n) => set.has(n)));
  check('and nothing extra', [...set].every((n) => list.includes(n)));
}

console.log('layers: it says what it did');
{
  check('all', describeSelector(sel({ kind: 'all' }), stack).includes('12 of 12'));
  check(
    'a band names its ends',
    describeSelector(sel({ kind: 'band', z: 28.5, length: 20 }), stack).includes('3 to 5'),
  );
  check(
    'every second says so',
    describeSelector(sel({ kind: 'every', n: 2, offset: 0 }), stack).includes('every 2nd layer'),
  );
  check('a third is a 3rd, not a 3th', describeSelector(sel({ kind: 'every', n: 3 }), stack).includes('every 3rd layer'));
  check('and the teens do not follow their last digit', describeSelector(sel({ kind: 'every', n: 11 }), stack).includes('every 11th layer'));

  /*
   * The rule this program keeps relearning: a selection that comes to nothing
   * has to say what it refused and why. "0 layers" reads as a bug; "the band
   * sits above the top sheet" reads as something to fix.
   */
  const above = describeSelector(sel({ kind: 'band', z: 400, length: 10 }), stack);
  check('a band above the stack explains itself', above.includes('highest sheet'), above);
  const below = describeSelector(sel({ kind: 'band', z: -400, length: 10 }), stack);
  check('and one below it too', below.includes('lowest sheet'), below);
  const between = describeSelector(sel({ kind: 'band', z: 6, length: 0 }), stack);
  check('one that falls between sheets says that', between.includes('between two sheets'), between);
  const outside = describeSelector(sel({ kind: 'range', from: 50, to: 60 }), stack);
  check('a range outside the stack names the count it had', outside.includes('12 there are'), outside);
  check('nothing sliced yet is its own answer', describeSelector(sel({}), []).includes('Nothing sliced'));
}

console.log('');
if (failures > 0) {
  console.log(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    layer selection');
