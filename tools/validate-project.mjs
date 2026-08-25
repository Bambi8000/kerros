#!/usr/bin/env node
/**
 * validate-project.mjs
 *
 * A project file is the one artefact a person keeps for years, edits by hand,
 * and opens in a newer build than the one that wrote it. This checks the round
 * trip and, more importantly, everything that can be wrong with a file on the
 * way in.
 *
 *   node tools/validate-project.mjs
 */

import {
  PROJECT_FORMAT,
  PROJECT_FORMAT_VERSION,
  serializeProject,
  parseProject,
  projectFilename,
  highestFeatureNumber,
} from '../src/core/project.ts';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const sample = {
  name: 'Blob Lamp 1',
  machine: { name: 'Laser 730x410', bedWidth: 730, bedHeight: 410, margin: 5 },
  material: { name: 'Cardboard 3 mm', thickness: 3, kerf: 0.22, notes: 'B flute' },
  stack: { spacerHeight: 6, spacerHeightTop: 6, spacerThickness: 0 },
  seed: 7,
  features: [
    {
      id: 'f1',
      kind: 'sphere',
      stage: 'SHAPE',
      name: 'Body',
      enabled: true,
      params: { op: 'union', r: 60, pz: 65, k: 10 },
    },
    {
      id: 'f2',
      kind: 'capsule',
      stage: 'SHAPE',
      name: 'Bore',
      enabled: true,
      params: { op: 'subtract', h: 300, r: 22, pz: 65 },
    },
    {
      id: 'f4',
      kind: 'sculpt',
      stage: 'SHAPE',
      name: 'Sculpt',
      enabled: true,
      params: {},
      strokes: [
        { op: 'smoothUnion', radius: 8, k: 6, points: [0, 0, 40, 5, 2, 45, 11, 4, 51] },
        { op: 'subtract', radius: 4, k: 0, points: [20, 0, 30] },
      ],
    },
    {
      id: 'f3',
      kind: 'rod',
      stage: 'RIG',
      name: 'Rod 1',
      enabled: true,
      params: { size: 'M5', px: 46, py: 0, pz: 65, length: 130, diameter: 0 },
    },
  ],
  slicing: { sliceRes: 200, sliceTolerance: 0.05, sliceSmoothing: 1, minFeature: 1, previewRes: 64 },
  layout: {
    partGap: 4,
    labelHeight: 4,
    ringWidth: 4,
    makeSpacers: true,
    fluteDirection: 'vertical',
    flutePitch: 6.5,
    scatterAngle: 30,
    partPlacements: {
      'slice-3-0': { sheet: 1, dx: 120.5, dy: 88, rot: 37.5 },
    },
  },
};

console.log('project: round trip');
{
  const text = serializeProject(sample, '0.5.5', '2026-08-18T09:00:00.000Z');
  const parsed = parseProject(text);

  check('it parses', parsed.ok && parsed.error === null);
  check('with no warnings', parsed.warnings.length === 0, parsed.warnings.join(' | '));
  check(
    'and comes back identical',
    JSON.stringify(parsed.data) === JSON.stringify(sample),
    'round trip changed the data',
  );

  const file = JSON.parse(text);
  check('the format is tagged', file.format === PROJECT_FORMAT);
  check('the format version is recorded', file.formatVersion === PROJECT_FORMAT_VERSION);
  check('the app version is recorded', file.app === '0.5.5');
  check('the save time is recorded', file.savedAt === '2026-08-18T09:00:00.000Z');
  check('it is indented for reading', text.includes('\n  "'));
  check('it ends with a newline', text.endsWith('\n'));

  check(
    'transient interface state is not saved',
    !('mode' in file) && !('currentLayer' in file) && !('selectedPartId' in file),
  );
  check('hand placements survive', parsed.data.layout.partPlacements['slice-3-0'].rot === 37.5);
  check(
    'the rod feature survives with its params',
    parsed.data.features.find((f) => f.kind === 'rod').params.length === 130,
  );
}

console.log('project: a stack written before gradients existed');
{
  /*
   * The claim in `parseProject` is that an older file opens as exactly the lamp
   * it was. It was a comment and nothing more until this test — which is the
   * failure mode the round-trip check caught by going red when the fields were
   * added: the fixture said one thing and the parser another.
   */
  const older = JSON.parse(JSON.stringify({ ...sample, stack: { spacerHeight: 6 } }));
  const text = JSON.stringify({
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    ...older,
  });
  const opened = parseProject(text);

  check('it opens', opened.ok && opened.data !== null);
  check('the gap it asked for survives', opened.data.stack.spacerHeight === 6);
  check(
    'the top gap defaults to the bottom one, so the stack stays uniform',
    opened.data.stack.spacerHeightTop === 6,
  );
  check(
    'and the ring thickness defaults to following the stock',
    opened.data.stack.spacerThickness === 0,
  );
  check('with nothing to warn about', opened.warnings.length === 0, opened.warnings.join('; '));

  // A file that does say so keeps what it says.
  const graded = JSON.stringify({
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    ...sample,
    stack: { spacerHeight: 3, spacerHeightTop: 12, spacerThickness: 1 },
  });
  const openedGraded = parseProject(graded).data;
  check(
    'a graded stack survives the round trip',
    openedGraded.stack.spacerHeight === 3 &&
      openedGraded.stack.spacerHeightTop === 12 &&
      openedGraded.stack.spacerThickness === 1,
  );

  const nonsense = JSON.stringify({
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    ...sample,
    stack: { spacerHeight: 6, spacerHeightTop: -4, spacerThickness: 'thick' },
  });
  const openedBad = parseProject(nonsense).data;
  check('a negative top gap is clamped rather than inverting the stack', openedBad.stack.spacerHeightTop === 0);
  check('a ring thickness that is not a number falls back', openedBad.stack.spacerThickness === 0);
}

console.log('project: filenames');
{
  check('a name becomes a slug', projectFilename('Blob Lamp 1') === 'blob-lamp-1.kerros.json');
  check('punctuation is stripped', projectFilename('Lamp #2 (v3)') === 'lamp-2-v3.kerros.json');
  check('an empty name still gives a file', projectFilename('   ') === 'kerros-project.kerros.json');
  check('no leading or trailing dashes', !projectFilename('  -x-  ').startsWith('-'));
}

console.log('project: bad input');
{
  const notJson = parseProject('this is not json');
  check('garbage is refused, not thrown', !notJson.ok && notJson.error !== null);
  check('and says what is wrong', notJson.error.includes('JSON'));

  const wrongFile = parseProject(JSON.stringify({ format: 'something-else', features: [] }));
  check('a foreign file is refused', !wrongFile.ok && wrongFile.error.includes('Kerros'));

  const future = parseProject(
    JSON.stringify({ format: PROJECT_FORMAT, formatVersion: PROJECT_FORMAT_VERSION + 5 }),
  );
  check('a file from a newer build is refused rather than guessed at', !future.ok);
  check('and the message names both versions', future.error.includes(String(PROJECT_FORMAT_VERSION)));

  const older = parseProject(JSON.stringify({ format: PROJECT_FORMAT, formatVersion: 0, features: [] }));
  check('an older format opens with a warning', older.ok && older.warnings.length > 0);

  const empty = parseProject(JSON.stringify({ format: PROJECT_FORMAT, formatVersion: 1 }));
  check('a file with nothing in it still opens', empty.ok);
  check('with defaults filled in', empty.data.machine.bedWidth === 730 && empty.data.material.thickness === 3);
  check('and warns that the tree was missing', empty.warnings.some((w) => w.includes('feature list')));
}

console.log('project: broken contents survive');
{
  const messy = parseProject(
    JSON.stringify({
      format: PROJECT_FORMAT,
      formatVersion: 1,
      machine: { bedWidth: 'wide', bedHeight: -50, margin: -3 },
      material: { thickness: 0, kerf: -1 },
      seed: 'abc',
      features: [
        { id: 'f1', kind: 'sphere', stage: 'SHAPE', name: 'A', enabled: true, params: { r: 40 } },
        { kind: '', stage: 'SHAPE', name: 'nameless' },
        { id: 'f1', kind: 'torus', stage: 'BOGUS', name: 'B', enabled: 'yes', params: { R: [1, 2], r: 8 } },
      ],
      layout: {
        fluteDirection: 'diagonal',
        scatterAngle: 900,
        partPlacements: {
          good: { sheet: 2, dx: 10, dy: 20, rot: 45 },
          bad: { sheet: 1, dy: 20 },
        },
      },
    }),
  );

  check('it opens despite everything', messy.ok);
  check('a feature with no kind is skipped', messy.data.features.length === 2, `${messy.data.features.length} features`);
  check('and the skip is reported', messy.warnings.some((w) => w.includes('no kind')));
  check('an unknown stage falls back to SHAPE', messy.data.features[1].stage === 'SHAPE');
  check('and that is reported too', messy.warnings.some((w) => w.includes('unknown stage')));
  check('a duplicate id is renumbered', messy.data.features[0].id !== messy.data.features[1].id);
  check('a non-value parameter is dropped', messy.data.features[1].params.R === undefined);
  check('but its siblings survive', messy.data.features[1].params.r === 8);
  check('a non-boolean enabled falls back to true', messy.data.features[1].enabled === true);

  check('a nonsense bed width falls back', messy.data.machine.bedWidth === 730);
  check('a negative bed height is clamped up', messy.data.machine.bedHeight >= 1);
  check('a negative margin is clamped to zero', messy.data.machine.margin === 0);
  check('a zero thickness is clamped off zero', messy.data.material.thickness >= 0.1);
  check('a negative kerf is clamped to zero', messy.data.material.kerf === 0);
  check('a nonsense seed falls back', messy.data.seed === 1);

  check('an unknown flute direction falls back', messy.data.layout.fluteDirection === 'horizontal');
  check('an out-of-range scatter angle is clamped', messy.data.layout.scatterAngle === 180);
  check('a placement without a position is dropped', messy.data.layout.partPlacements.bad === undefined);
  check('and the good one survives', messy.data.layout.partPlacements.good.rot === 45);
  check('the drop is reported', messy.warnings.some((w) => w.includes('usable position')));
}

console.log('project: sculpt strokes');
{
  const parsed = parseProject(serializeProject(sample, '0.10.0', 'now'));
  const sculpt = parsed.data.features.find((f) => f.kind === 'sculpt');
  check('a sculpt feature survives', sculpt !== undefined);
  check('with both strokes', sculpt.strokes.length === 2);
  check('and their points intact', sculpt.strokes[0].points.length === 9);
  check('a single-point stroke survives', sculpt.strokes[1].points.length === 3);
  check('features without strokes do not gain an empty array', 
    parsed.data.features.filter((f) => f.kind !== 'sculpt').every((f) => f.strokes === undefined));

  const text = serializeProject(sample, '0.10.0', 'now');
  check('the file lists points as numbers, not a blob', /"points": \[/.test(text));

  const broken = parseProject(
    JSON.stringify({
      format: PROJECT_FORMAT,
      formatVersion: 1,
      features: [
        {
          id: 'f1',
          kind: 'sculpt',
          stage: 'SHAPE',
          name: 'S',
          enabled: true,
          params: {},
          strokes: [
            { op: 'union', radius: 5, k: 0, points: [0, 0, 0, 1, 1] },
            { op: 'union', radius: 0, k: 0, points: [0, 0, 0] },
            { op: 'union', points: [5, 5, 5] },
            { op: 'union', radius: 5, k: 0, points: [1, 2] },
            { op: 'union', radius: 5, k: 0, points: [9, 9, 9, 10, 10, 10] },
          ],
        },
      ],
    }),
  );
  check('it opens', broken.ok);
  const kept = broken.data.features[0].strokes;
  check('a stroke ending mid-point is trimmed, not dropped', kept.some((k) => k.points.length === 3));
  check('and the trim is reported', broken.warnings.some((w) => w.includes('mid-point')));
  check('a stroke with no radius is dropped', kept.every((k) => k.radius > 0));
  check('and that is reported', broken.warnings.some((w) => w.includes('no radius')));
  check('a stroke with under one point is dropped', broken.warnings.some((w) => w.includes('no usable points')));
  check('the good stroke survives all of it', kept.some((k) => k.points.length === 6));
}

console.log('project: feature numbering');
{
  check('an empty tree starts at one', highestFeatureNumber([]) + 1 === 1);
  check(
    'numbering continues past the highest loaded id',
    highestFeatureNumber([{ id: 'f3' }, { id: 'f11' }, { id: 'f7' }]) === 11,
  );
  check(
    'non-numeric ids are ignored rather than breaking it',
    highestFeatureNumber([{ id: 'slice-3' }, { id: 'f2' }]) === 2,
  );

  const parsed = parseProject(serializeProject(sample, '0.5.5', 'now'));
  check('a loaded project reports the next free number', parsed.nextFeatureNumber === 5);
}

console.log('');
if (failures > 0) {
  console.error(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    project files');
