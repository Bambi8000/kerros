#!/usr/bin/env node
/**
 * validate-pdf.mjs
 *
 * Imports the REAL src/core/pdf.ts. A PDF that a reader refuses is not a
 * document, and the failure is total rather than partial — so the structure is
 * checked rather than eyeballed.
 *
 *   node tools/validate-pdf.mjs
 */

import { writePdf, commonScale } from '../src/core/pdf.ts';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) < tol;

const page = (polylines) => ({ width: 210, height: 297, polylines });
const square = { points: [10, 10, 100, 10, 100, 60, 10, 60], closed: true };

console.log('pdf: the file a reader has to accept');
{
  const out = writePdf([page([square])]);

  check('it starts with a version header', out.startsWith('%PDF-1.'));
  check('and ends with the marker', out.trimEnd().endsWith('%%EOF'));
  check('there is a catalogue', out.includes('/Type /Catalog'));
  check('a page tree', out.includes('/Type /Pages'));
  check('and a page in it', out.includes('/Type /Page /Parent'));

  /*
   * ASCII only, and this is a constraint rather than tidiness. Every file leaves
   * through `download.ts`, which writes strings — a Blob in the browser,
   * `write_text_file` in the native shell. A compressed stream or a binary
   * marker would not survive that, and the xref's byte offsets would stop being
   * character counts.
   */
  check('every byte is printable ASCII', /^[\x09\x0a\x20-\x7e]*$/.test(out));
  check('nothing is compressed', !out.includes('/Filter'));
  check('and no font is embedded', !out.includes('/Font'));

  /*
   * The cross-reference table is the part that is silently wrong or exactly
   * right: a reader seeks to those offsets and finds an object or gives up.
   */
  const xrefAt = Number(out.slice(out.lastIndexOf('startxref')).split('\n')[1]);
  check('startxref points at the table', out.slice(xrefAt, xrefAt + 4) === 'xref', `${xrefAt}`);

  const table = out.slice(xrefAt).split('\n');
  const count = Number(table[1].split(' ')[1]);
  check('the table declares every object', count === 5, `${count} for one page`);

  // table[0] is 'xref', table[1] the range, table[2] the free entry, so object i
  // is on table[2 + i]. The first version read one line early and compared every
  // object against the offset of the one before it.
  let offsetsGood = true;
  for (let i = 1; i < count; i++) {
    const offset = Number(table[2 + i].slice(0, 10));
    if (!out.slice(offset).startsWith(`${i} 0 obj`)) offsetsGood = false;
  }
  check('and every offset lands on its object', offsetsGood);

  const declared = Number(out.slice(out.indexOf('/Length ') + 8).split(' ')[0]);
  const start = out.indexOf('stream\n') + 'stream\n'.length;
  const actual = out.indexOf('endstream') - start;
  check('the stream length is the stream length', declared === actual, `${declared} against ${actual}`);
}

console.log('pdf: what ends up on the page');
{
  const out = writePdf([page([square])]);

  // 210 mm is 595.276 pt. A page the wrong size is a document that prints wrong
  // and looks right on screen.
  check('the page is A4 in points', out.includes('/MediaBox [0 0 595.276 841.890]'), out.slice(out.indexOf('/MediaBox'), out.indexOf('/MediaBox') + 40));
  check('millimetres become points', out.includes('28.346 28.346 m'));
  check('a closed path is closed', out.includes('h\n'));
  check('and stroked, never filled', out.includes('S\n') && !out.includes(' f\n'));

  const open = writePdf([page([{ points: [0, 0, 10, 10] }])]);
  check('an open run is not closed', !open.includes('h\n'));

  check('a two-point line is drawn', writePdf([page([{ points: [0, 0, 5, 5] }])]).includes(' l\n'));
  check('a single point is dropped', !writePdf([page([{ points: [1, 1] }])]).includes(' m\n'));

  /*
   * Width and grey are emitted only when they change. Not an optimisation for
   * its own sake — a stream that restates the same state a thousand times is
   * unreadable when something goes wrong in it.
   */
  const repeated = writePdf([page([square, square, square])]);
  check('state is set once, not per line', (repeated.match(/ w\n/g) ?? []).length === 1);
  const mixed = writePdf([page([square, { ...square, grey: 0.5 }])]);
  check('and again when it actually changes', (mixed.match(/ G\n/g) ?? []).length === 2);

  check('no negative zero', !writePdf([page([{ points: [-0.00001, 0, 5, 5] }])]).includes('-0.000'));
}

console.log('pdf: several pages');
{
  const three = writePdf([page([square]), page([square]), page([square])]);
  check('all three are in the tree', three.includes('/Count 3'));
  // `stream\n` also matches the end of `endstream\n`, so the opening keyword
  // needs its own newline in front of it.
  check('and each has its own content', (three.match(/\nstream\n/g) ?? []).length === 3);
  check('an empty document is still a file', writePdf([]).includes('/Count 0'));
  check('a page with nothing on it is legal', writePdf([page([])]).includes('/Length 0'));
}

console.log('pdf: one scale for every drawing');
{
  /*
   * The whole trick of the identification pages. Fitting each drawing to its own
   * box makes a 40 mm ring and a 200 mm ring the same size on the page, and
   * telling those apart is the job.
   */
  const boxes = [{ w: 200, h: 200 }, { w: 40, h: 40 }];
  const scale = commonScale(boxes, 100, 100);
  check('the scale comes from the largest', near(scale, 0.5));
  check('so the small one stays small', near(40 * scale, 20));
  check('the tighter axis wins', near(commonScale([{ w: 100, h: 50 }], 100, 25), 0.5));
  check('nothing to fit is not a division by zero', Number.isFinite(commonScale([], 100, 100)));
  check('and neither is a zero-sized drawing', Number.isFinite(commonScale([{ w: 0, h: 0 }], 100, 100)));
}

console.log('');
if (failures > 0) {
  console.log(`FAIL  ${failures} check(s) failed`);
  process.exit(1);
}
console.log('OK    pdf');
