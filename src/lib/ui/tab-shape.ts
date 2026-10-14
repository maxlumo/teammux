// The lit roster tab's silhouette as ONE vector outline (owner, 2026-09-27:
// "这个拐角还是不够连续 感觉线错位了…能不能用最标准的方式"). Chrome draws its
// tab as a single path — outward foot, side, rounded top, side, foot — filled
// once and stroked once. Built from CSS pieces (a bordered box, two radial
// gradient feet, a bordered ring and a join layer), the stroke was four
// rasterisations that had to meet: the side border snaps to device pixels,
// the ring's arc and the gradient's hard stop do not, so at a fractional
// scale the arc landed beside the side stroke and the gradient's edge was
// jagged. One path cannot disagree with itself.
//
// Coordinates are CSS px in the drawing box, which is the marker's paint box
// widened by one foot radius on each side (the feet reach into the
// neighbours) and one pixel into the band below. The floor line is the box's
// second-to-last row; the last row is band.

export interface TabPaths { fill: string; edge: string }

const n = (v: number) => Number(v.toFixed(3));

/**
 * `w`,`h` — the drawing box; `r` — the top corners' radius; `f` — the feet's.
 * The EDGE is the 1px stroke's centre line: half-pixel centres, so at 1x it
 * covers whole pixels and the side meets the floor row tangentially. The FILL
 * is that line offset half a pixel outward (radius r+½ on the convex corners,
 * f−½ on the concave feet) and closed one pixel into the band, so the
 * translucent stroke lies on fill along its whole length, exactly as the
 * strip's floor line lies on a row of band fill.
 */
export function tabPaths(w: number, h: number, r: number, f: number): TabPaths | null {
  const inner = w - 2 * f; // the tab's own width, stroke outer edge to outer edge
  if (!(inner > 2) || !(h > 2)) return null;
  const yf = h - 1.5; // centre of the floor row
  const foot = Math.max(0, Math.min(f, yf - 0.5));
  const xl = f + 0.5, xr = w - f - 0.5, yt = 0.5;
  const rad = Math.max(0, Math.min(r, (xr - xl) / 2, yf - foot - yt));
  const edge = [
    `M${n(xl - foot)} ${n(yf)}`,
    `A${n(foot)} ${n(foot)} 0 0 0 ${n(xl)} ${n(yf - foot)}`,
    `L${n(xl)} ${n(yt + rad)}`,
    `A${n(rad)} ${n(rad)} 0 0 1 ${n(xl + rad)} ${n(yt)}`,
    `L${n(xr - rad)} ${n(yt)}`,
    `A${n(rad)} ${n(rad)} 0 0 1 ${n(xr)} ${n(yt + rad)}`,
    `L${n(xr)} ${n(yf - foot)}`,
    `A${n(foot)} ${n(foot)} 0 0 0 ${n(xr + foot)} ${n(yf)}`,
  ].join('');
  const fr = Math.max(0, foot - 0.5), cr = rad + 0.5;
  const fill = [
    `M${n(xl - foot)} ${n(yf - 0.5)}`,
    `A${n(fr)} ${n(fr)} 0 0 0 ${n(xl - 0.5)} ${n(yf - foot)}`,
    `L${n(xl - 0.5)} ${n(yt + rad)}`,
    `A${n(cr)} ${n(cr)} 0 0 1 ${n(xl + rad)} 0`,
    `L${n(xr - rad)} 0`,
    `A${n(cr)} ${n(cr)} 0 0 1 ${n(xr + 0.5)} ${n(yt + rad)}`,
    `L${n(xr + 0.5)} ${n(yf - foot)}`,
    `A${n(fr)} ${n(fr)} 0 0 0 ${n(xr + foot)} ${n(yf - 0.5)}`,
    `L${n(xr + foot)} ${n(h)}`,
    `L${n(xl - foot)} ${n(h)}Z`,
  ].join('');
  return { fill, edge };
}

const px = (el: Element, name: string) => parseFloat(getComputedStyle(el).getPropertyValue(name)) || 0;

/**
 * Draws the outline into the `<svg>` of `node` from its LAYOUT size, on every
 * size change — including each frame of the marker's width glide, which a
 * ResizeObserver reports after layout and before paint, so the outline never
 * lags the box. The radii come from the tokens on the element
 * (`--tab-radius`, `--tab-foot`), so CSS stays their one owner.
 */
export function tabShape(node: HTMLElement) {
  const fill = node.querySelector<SVGPathElement>('.tab-fill');
  const edge = node.querySelector<SVGPathElement>('.tab-edge');
  const draw = () => {
    const p = tabPaths(node.clientWidth, node.clientHeight, px(node, '--tab-radius'), px(node, '--tab-foot'));
    fill?.setAttribute('d', p?.fill ?? '');
    edge?.setAttribute('d', p?.edge ?? '');
  };
  draw();
  const ro = new ResizeObserver(draw);
  ro.observe(node);
  return { destroy: () => ro.disconnect() };
}
