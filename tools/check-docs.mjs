/*
 * The handoff was once rewritten wholesale from a stale context: the commit
 * message described a fix and the content was a regression to 0.16.0, with
 * five whole sections gone. Caught by accident — an edit anchor refusing to
 * match. This check makes the catch structural instead of lucky.
 *
 * Two assertions, both cheap:
 *  - the version in the handoff's own header matches package.json, which is
 *    exactly the mismatch the regression carried (0.16.0 against 0.26.0);
 *  - the section count has a floor, because a stale rewrite loses sections
 *    and a legitimate edit almost never removes five of them at once.
 */
import { readFileSync } from 'node:fs';

let failed = false;
const check = (label, ok) => {
  console.log((ok ? 'OK   ' : 'FAIL ') + ' ' + label);
  if (!ok) failed = true;
};

const handoff = readFileSync(new URL('../KERROS-HANDOFF.md', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const stated = handoff.match(/\*\*State at the time of writing: version (\d+\.\d+\.\d+)\.\*\*/);
check(
  'the handoff header states a version',
  stated !== null,
);
check(
  `the handoff's stated version (${stated ? stated[1] : 'none'}) matches package.json (${pkg.version})`,
  stated !== null && stated[1] === pkg.version,
);

const sections = handoff.split('\n').filter((line) => line.startsWith('## ')).length;
const FLOOR = 18;
check(
  `the handoff has at least ${FLOOR} sections (has ${sections}); a drop below means a stale rewrite`,
  sections >= FLOOR,
);

const features = readFileSync(new URL('../docs/KERROS-FEATURES.md', import.meta.url), 'utf8');
const featureSections = features.split('\n').filter((line) => line.startsWith('## ')).length;
const FEATURES_FLOOR = 26;
check(
  `FEATURES has at least ${FEATURES_FLOOR} sections (has ${featureSections})`,
  featureSections >= FEATURES_FLOOR,
);

if (failed) process.exit(1);
console.log('OK    docs are the version the code is');
