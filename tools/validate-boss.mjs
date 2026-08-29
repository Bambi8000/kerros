#!/usr/bin/env node
/**
 * validate-boss.mjs
 *
 * Imports the REAL src/core/boss.ts. A boss is the one thing in RIG that adds
 * material rather than removing it, and its failure mode is quiet: a spoke that
 * does not reach leaves an island, and an island only shows up as a loose disc
 * on the sheet, by which point it is cut.
 *
 *   node tools/validate-boss.mjs
 */

import {
  bossSection,
  bossDistance,
  bossField,
  spokesStickOut,
} from '../src/core/boss.ts';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;
const DEG = Math.PI / 180;

const boss = (patch) => ({
  id: 'b',
  label: 'Boss',
  x: 0,
  y: 0,
  z0: 0,
  z1: 60,
  radius: 10,
  spokes: 3,
  spokeWidth: 4,
  spokeLength: 40,
  angle: 0,
  blend: 0,
  ...patch,
});

console.log('boss: the disc');
{
  const plain = boss({ spokes: 0 });
  check('the centre is one radius in', near(bossSection(plain, 0, 0), -10));
  check('the edge is on the surface', near(bossSection(plain, 10, 0), 0));
  check('and so is the edge in any direction', near(bossSection(plain, 0, 10), 0));
  check('outside is the exact distance', near(bossSection(plain, 25, 0), 15));
  check('a zero radius is clamped rather than collapsing', bossSection(boss({ spokes: 0, radius: 0 }), 0, 0) < 0);

  const moved = boss({ spokes: 0, x: 30, y: -20 });
  check('it sits where the rod does', near(bossSection(moved, 30, -20), -10));
  check('and nowhere else', near(bossSection(moved, 0, 0), Math.hypot(30, 20) - 10));
}

console.log('boss: the spokes');
{
  const spec = boss({});
  check('a spoke runs out along its angle', near(bossSection(spec, 30, 0), -2));
  check('half a width off it is the surface', near(bossSection(spec, 30, 2), 0));
  check('past the tip is the exact distance', near(bossSection(spec, 45, 0), 5));
  check(
    'between spokes there is nothing but the gap',
    near(bossSection(spec, 30 * Math.cos(60 * DEG), 30 * Math.sin(60 * DEG)), 20),
  );

  const turned = boss({ angle: 90 });
  check('the set turns with the angle', near(bossSection(turned, 0, 30), -2));
  check('and leaves the old direction empty', bossSection(turned, 30, 0) > 5);

  const four = boss({ spokes: 4 });
  check('four spokes reach four ways', [0, 90, 180, 270].every((a) =>
    near(bossSection(four, 30 * Math.cos(a * DEG), 30 * Math.sin(a * DEG)), -2),
  ));

  check('no spokes leaves the disc alone', near(bossSection(boss({ spokes: 0 }), 30, 0), 20));
  check('a fractional count rounds rather than producing NaN', Number.isFinite(bossSection(boss({ spokes: 2.6 }), 30, 0)));
}

console.log('boss: the column');
{
  const spec = boss({});
  check('above the top is the height above it', near(bossDistance(spec, 0, 0, 68), 8));
  check('below the bottom likewise', near(bossDistance(spec, 0, 0, -5), 5));
  check('inside at mid height it is the section', near(bossDistance(spec, 0, 0, 30), -10));
  check('the ends are on the surface', near(bossDistance(spec, 0, 0, 60), 0) && near(bossDistance(spec, 0, 0, 0), 0));
  check('ends entered backwards still work', near(bossDistance(boss({ z0: 60, z1: 0 }), 0, 0, 30), -10));

  /*
   * Unit gradient, because a boss is unioned into the form and a smooth union
   * only means what it says over a true distance field — the same property the
   * prism and the cone are held to.
   */
  let worst = 0;
  for (let i = 0; i < 4000; i++) {
    const t = i / 4000;
    const x = Math.sin(t * 91) * 60;
    const y = Math.cos(t * 57) * 60;
    const z = Math.sin(t * 33) * 60 + 30;
    const e = 1e-4;
    const at = (a, b, c) => bossDistance(spec, a, b, c);
    const g = Math.hypot(
      (at(x + e, y, z) - at(x - e, y, z)) / (2 * e),
      (at(x, y + e, z) - at(x, y - e, z)) / (2 * e),
      (at(x, y, z + e) - at(x, y, z - e)) / (2 * e),
    );
    if (Number.isFinite(g)) worst = Math.max(worst, Math.abs(g - 1));
  }
  check('the gradient is unit everywhere sampled', worst < 1e-3, `off by ${worst.toExponential(2)}`);
}

console.log('boss: added to the form, not carved from it');
{
  /*
   * A shelled lamp is a ring and the middle is cavity. The whole point of a
   * boss is that a rod near the axis has something to be drilled through, so
   * the check is that material appears where there was none.
   */
  const cavity = () => 5;
  const withBoss = bossField(cavity, [boss({})]);
  check('the cavity alone is empty at the axis', cavity(0, 0, 30) > 0);
  check('with a boss it is solid there', withBoss(0, 0, 30) < 0);
  check('and still empty where the boss is not', withBoss(50, 50, 30) > 0);
  check('and still empty above it', withBoss(0, 0, 90) > 0);

  check('no bosses returns the very same function', bossField(cavity, []) === cavity);

  /*
   * Discs only. With spokes reaching 40 mm from each axis and the two bosses
   * 60 mm apart, the spokes meet across the middle — which is correct and was
   * the first version of this check asserting the opposite.
   */
  const two = bossField(cavity, [boss({ x: -30, spokes: 0 }), boss({ x: 30, spokes: 0 })]);
  check('two bosses both appear', two(-30, 0, 30) < 0 && two(30, 0, 30) < 0);
  check('and the space between them is untouched', two(0, 0, 30) > 0);
  check(
    'while spokes long enough really do bridge it',
    bossField(cavity, [boss({ x: -30 }), boss({ x: 30 })])(0, 0, 30) < 0,
  );

  /*
   * A blend is a fillet where the boss meets the form: in a flat cut part that
   * is a rounded inside corner rather than a place that tears. It can only add
   * material, never take it away.
   */
  const hard = bossField(cavity, [boss({ blend: 0 })]);
  const soft = bossField(cavity, [boss({ blend: 6 })]);

  /*
   * A smooth union only differs from a hard one where the two fields are within
   * `k` of each other, so the probe has to be somewhere they nearly agree. The
   * cavity here reads 5 everywhere, and 5 mm past a spoke's tip the boss reads
   * 5 too — which is the join.
   */
  const atJoin = [45, 0, 30];
  const farOff = [0, 0, 30];
  check('at the join the two fields agree', near(cavity(), bossDistance(boss({}), ...atJoin), 1e-9));
  check('a blend never removes material', soft(...atJoin) <= hard(...atJoin) + 1e-12);
  check('and it does soften the join', soft(...atJoin) < hard(...atJoin) - 1e-9);
  check('well inside, where nothing is near, the two agree', near(soft(...farOff), hard(...farOff), 1e-9));
}

console.log('boss: kept inside the form');
{
  /*
   * A boss fills the cavity; it must not bulge out of the lamp. The envelope is
   * the form before the shell hollowed it, and intersecting against it is what
   * turns a thickening into something that stops at the wall.
   *
   * A ball of radius 50 about the origin stands in for the form here — the
   * distance to it is the same arithmetic whatever the real shape is.
   */
  const ball = (x, y, z) => Math.hypot(x, y, z - 30) - 50;
  const cavity = () => 5;
  const long = boss({ spokeLength: 90, blend: 0 });

  const loose = bossField(cavity, [long]);
  const clipped = bossField(cavity, [long], ball);

  check('unclipped, a long spoke reaches past the form', loose(80, 0, 30) < 0);
  check('clipped, it stops at the wall', clipped(80, 0, 30) > 0);
  check('and still fills the cavity at the axis', clipped(0, 0, 30) < 0);
  check('and along the spoke inside the form', clipped(40, 0, 30) < 0);
  check(
    'the wall is where it stops, not somewhere near it',
    near(clipped(50, 0, 30), 0, 0.05),
    `${clipped(50, 0, 30).toFixed(4)}`,
  );

  /*
   * Aiming past the wall on purpose then costs nothing, which is the behaviour
   * worth having: the wall decides where the spoke ends.
   */
  const justRight = bossField(cavity, [boss({ spokeLength: 50, blend: 0 })], ball);
  check(
    'a spoke aimed at the wall and one aimed past it agree inside',
    near(justRight(40, 0, 30), clipped(40, 0, 30), 1e-9),
  );

  check('no envelope leaves the boss unclipped', bossField(cavity, [long])(80, 0, 30) < 0);

  /*
   * The blend has to be clipped as well as the boss.
   *
   * At the outer wall the boss and the form are both on the surface, so a
   * fillet blends them into each other and pushes the outline out by up to a
   * quarter of its radius — a bump in the silhouette exactly where a spoke
   * lands. Small, and completely wrong: the outline is the design.
   */
  const form = (x, y, z) => Math.hypot(x, y, z - 30) - 50;
  const filleted = bossField(form, [boss({ spokeLength: 90, blend: 4 })], ball);
  check(
    'a fillet does not push the outline out where a spoke lands',
    filleted(50, 0, 30) >= -1e-9,
    `${filleted(50, 0, 30).toFixed(4)} at the wall on the spoke`,
  );
  check(
    'and the wall away from the spoke is untouched',
    near(filleted(0, 50, 30), 0, 1e-9),
  );
  /*
   * Beside the spoke rather than along it, and 5 mm off it, because the cavity
   * here reads 5 everywhere and a smooth union only differs from a hard one
   * where the two fields are within `k`. Measuring on the spoke's own axis puts
   * them 7 apart and the check proves nothing — which is what the first version
   * of this line did, for the fourth time in this project.
   */
  const besideTheSpoke = [46, 7, 30];
  check(
    'the two fields meet there',
    near(bossDistance(boss({ spokeLength: 90 }), ...besideTheSpoke), 5, 1e-9),
  );
  check(
    'while the fillet still shows on the inside',
    bossField(cavity, [boss({ spokeLength: 90, blend: 4 })], ball)(...besideTheSpoke) <
      bossField(cavity, [boss({ spokeLength: 90, blend: 0 })], ball)(...besideTheSpoke) - 1e-9,
  );
  check('clipping cannot remove the form itself', (() => {
    const solidBall = (x, y, z) => Math.hypot(x, y, z - 30) - 50;
    const withBoss = bossField(solidBall, [long], ball);
    // A point in the ball but nowhere near the boss is still solid.
    return withBoss(0, 45, 30) < 0;
  })());
}

console.log('boss: the mistake that fails quietly');
{
  /*
   * A spoke shorter than the boss is inside it. The boss is then an island in
   * the cavity, `groupContours` makes it a part of its own, and it falls off
   * the sheet loose — on every layer. Whether a spoke reaches the *wall* cannot
   * be answered here, since this module has no idea where the wall is, but
   * whether it reaches past its own edge can be, and that is the mistake people
   * actually make.
   */
  check('a spoke past the edge sticks out', spokesStickOut(boss({})));
  check('one shorter than the boss does not', !spokesStickOut(boss({ spokeLength: 8 })));
  check('one exactly at the edge does not', !spokesStickOut(boss({ spokeLength: 10 })));
  check('no spokes at all does not', !spokesStickOut(boss({ spokes: 0 })));
}

console.log('');
if (failures > 0) {
  console.log(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    bosses');
