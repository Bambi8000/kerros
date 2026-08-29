/**
 * PDF writer.
 *
 * Hand-written, for the same reasons `dxf.ts` is: a PDF is a text format with a
 * small index at the end, and writing it correctly is a smaller job than owning
 * a library for it.
 *
 * ASCII ONLY, AND THAT IS A CONSTRAINT RATHER THAN A STYLE. Every file in this
 * program leaves through `download.ts`, which writes strings — a Blob in the
 * browser, `write_text_file` in the native shell. So the PDF has to be a string:
 * no compression, no binary streams, no byte offsets that a string cannot
 * count. Uncompressed content streams made of `m`, `l`, `S` and numbers are
 * plain text, and the xref's byte offsets are then just character counts.
 *
 * TEXT IS DRAWN, NOT SET. There is no font in this file and no font in the
 * output. Labels arrive as polylines from `font.ts`, the same strokes the laser
 * engraves, which means no font to embed, no encoding to get wrong, and no
 * reader that can render it differently from another one. It is the same
 * argument that keeps the DXF free of TEXT entities.
 *
 * DELIBERATE CONSTRAINT: no imports. Node validators load this as the real
 * module.
 */

/** PDF user space is 1/72 inch. Everything above this file speaks millimetres. */
const PT_PER_MM = 72 / 25.4;

export interface PdfPolyline {
  /** Flat [x0, y0, x1, y1, ...] in mm, origin at the bottom left of the page. */
  points: number[];
  /** Line width in mm. */
  width?: number;
  /** 0 is black, 1 is white. */
  grey?: number;
  closed?: boolean;
}

export interface PdfPage {
  /** Page size in mm. A4 is 210 x 297. */
  width: number;
  height: number;
  polylines: PdfPolyline[];
}

/** Fixed notation, no exponents, no negative zero — as in the DXF writer. */
function fmt(value: number): string {
  const v = Math.abs(value) < 5e-4 ? 0 : value;
  return v.toFixed(3);
}

function contentStream(page: PdfPage): string {
  let out = '';
  let width = -1;
  let grey = -1;

  for (const line of page.polylines) {
    if (line.points.length < 4) continue;

    const w = line.width ?? 0.2;
    if (w !== width) {
      out += `${fmt(w * PT_PER_MM)} w\n`;
      width = w;
    }
    const g = line.grey ?? 0;
    if (g !== grey) {
      out += `${fmt(g)} G\n`;
      grey = g;
    }

    out += `${fmt(line.points[0] * PT_PER_MM)} ${fmt(line.points[1] * PT_PER_MM)} m\n`;
    for (let i = 2; i < line.points.length; i += 2) {
      out += `${fmt(line.points[i] * PT_PER_MM)} ${fmt(line.points[i + 1] * PT_PER_MM)} l\n`;
    }
    if (line.closed) out += 'h\n';
    out += 'S\n';
  }

  return out;
}

/**
 * A whole document as a string.
 *
 * The object layout is the simplest one that is legal: catalogue, page tree,
 * then a page and a content stream for each sheet. The cross-reference table at
 * the end needs every object's byte offset, which is why the body is assembled
 * before the table rather than streamed.
 */
export function writePdf(pages: PdfPage[]): string {
  const objects: string[] = [];

  // 1 catalogue, 2 page tree, then two objects per page.
  const pageIds = pages.map((_, i) => 3 + i * 2);

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds
      .map((id) => `${id} 0 R`)
      .join(' ')}] >>`,
  );

  pages.forEach((page, i) => {
    const contentId = pageIds[i] + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(page.width * PT_PER_MM)} ` +
        `${fmt(page.height * PT_PER_MM)}] /Contents ${contentId} 0 R /Resources << >> >>`,
    );
    const stream = contentStream(page);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  });

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];

  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefAt}\n%%EOF\n`;

  return body;
}

/**
 * Fit a set of outlines into a box, keeping every drawing at one scale.
 *
 * The scale is worked out from the **largest** of them and applied to all, which
 * is the whole point when the drawings are there to be told apart: refitting
 * each one to its own box makes a 40 mm ring and a 200 mm ring the same size on
 * the page, and telling those two apart is exactly the job.
 */
export function commonScale(
  extents: { w: number; h: number }[],
  boxW: number,
  boxH: number,
): number {
  let widest = 0;
  let tallest = 0;
  for (const e of extents) {
    widest = Math.max(widest, e.w);
    tallest = Math.max(tallest, e.h);
  }
  if (widest <= 0 || tallest <= 0) return 1;
  return Math.min(boxW / widest, boxH / tallest);
}
