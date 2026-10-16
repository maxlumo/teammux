// The connection QR code (board #403): the modules of a QR code for a text, and
// the path that draws them. A thin seam over `qr` (paulmillr, zero
// dependencies, pinned exactly in package.json): the one place the library is
// imported for encoding, so a replacement touches this file only.
//
// The text is a connection link (lib/core/connection-link.ts) and carries the
// token: nothing here logs it, stores it, or sends it anywhere — the code is
// drawn locally from the matrix, never by a web service.
import encodeQR from 'qr';

/** The quiet zone a scanner needs around a code, in modules (the QR standard's 4). */
export const QR_QUIET = 4;

/** The modules of a QR code for `text`, row by row, `true` for a dark module,
 * with no quiet zone (the drawing adds `QR_QUIET` modules of paper around it).
 * Error correction `medium`: a code on a screen is clean, and a smaller
 * version scans faster than a heavier correction level. */
export function qrMatrix(text: string): boolean[][] {
  // The library refuses a border of 0 (a quiet zone is required); its documented
  // way to the bare symbol is border 1 with the padding ring sliced off.
  const padded = encodeQR(text, 'raw', { ecc: 'medium', border: 1 });
  return padded.slice(1, -1).map((row) => row.slice(1, -1));
}

/** The SVG path that draws `matrix` in module units (one unit per module, the
 * origin at the code's top-left): one rectangle per RUN of dark modules in a row. */
export function qrPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) { x++; continue; }
      let end = x;
      while (end < row.length && row[end]) end++;
      parts.push(`M${x} ${y}h${end - x}v1h${x - end}z`);
      x = end;
    }
  });
  return parts.join('');
}
