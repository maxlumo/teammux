// The Hub feed's TURNS (board #461): the human messages the user-message anchor
// already tracks, the one rule that decides which of them a rail names, and the
// pure arithmetic of scrubbing along that rail. No DOM here, so every rule below
// is a unit test.
import { parseQuote, splitImages, statusNote } from './hub.ts';
import type { FeedBlock } from './hub.ts';

type MsgBlock = Extract<FeedBlock, { type: 'msg' }>;

/** A block's identity in the feed. ONE definition: the markup keys its rows
 * with it, the anchor reads `[data-ask]` carrying it, and the rail names turns
 * by it, so the three can never disagree about which message is which. */
export function blockKey(b: FeedBlock, i: number): string {
  return b.type === 'msg' ? (b.msg.id ?? `m${b.ts}-${i}`)
    : b.type === 'steps' || b.type === 'sys' ? b.key
    : `${b.type}${b.ts}-${i}`;
}

/** The ONE eligibility rule for "a turn" and for the anchor's `[data-ask]`:
 * a message the person sent. An agent bubble is never a turn. */
export const isAskBlock = (b: FeedBlock | undefined): b is MsgBlock =>
  !!b && b.type === 'msg' && b.msg.from === 'human';

export interface AskTurn {
  key: string;
  ts: number;
  block: MsgBlock;
}

/** The loaded feed's turns, in feed order. Labels are NOT computed here: a poll
 * rebuilds the blocks every few seconds and only the previewed rows need text. */
export function askTurns(blocks: readonly FeedBlock[]): AskTurn[] {
  const turns: AskTurn[] = [];
  blocks.forEach((b, i) => {
    if (isAskBlock(b)) turns.push({ key: blockKey(b, i), ts: b.ts, block: b });
  });
  return turns;
}

/** The turn set's identity: the ordered keys and nothing else, so agent
 * streaming (same keys, new bodies) never compares different. */
export const turnsSig = (turns: readonly { key: string }[]): string =>
  turns.map((t) => t.key).join('\u0000');

export const turnIndex = (turns: readonly { key: string }[], key: string): number =>
  key ? turns.findIndex((t) => t.key === key) : -1;

/** The first line the bubble would show, through the same pipeline the bubble
 * uses (status note, quote, images), or the command text of a sent /command.
 * `image` is true for a turn that is only a picture; the caller names it. */
export function turnLabel(turn: { block: MsgBlock }): { text: string; image: boolean } {
  const b = turn.block;
  if (b.command) {
    const args = b.command.args.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
    return { text: `/${b.command.name}${args ? ` ${args}` : ''}`, image: false };
  }
  const body = b.msg.body;
  const note = statusNote(body);
  const quote = parseQuote(note ? note.text : body);
  const parts = splitImages(quote ? quote.text : note ? note.text : body);
  const line = parts.text.split('\n').map((s) => s.replace(/\s+/gu, ' ').trim()).find(Boolean) ?? '';
  return { text: line, image: !line && parts.images.length > 0 };
}

/** Arrow stepping over REAL turns. With nothing to start from (no preview, no
 * current turn) the first press lands on the newest turn. */
export function stepTurn(count: number, from: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (from < 0 || from >= count) return count - 1;
  return Math.max(0, Math.min(count - 1, from + delta));
}

// -- paint: ticks are a compression of the drawing, never of the turns -------

/** How many ticks fit a band of `height` px at `pitch` px each (at least 2). */
export const tickCapacity = (height: number, pitch: number): number =>
  pitch > 0 ? Math.max(2, Math.floor(height / pitch)) : 2;

/** Ticks drawn for `count` turns: one each until the band is full. */
export const tickCount = (count: number, capacity: number): number =>
  Math.max(0, Math.min(count, capacity));

/** Which drawn tick a turn index falls in. */
export const tickOf = (index: number, count: number, ticks: number): number =>
  index < 0 || count <= 0 || ticks <= 0 ? -1 : Math.min(ticks - 1, Math.floor((index * ticks) / count));

// -- scrubbing: an integrator, so every loaded turn is reachable -------------
//
// A press maps ABSOLUTE once (the slice under the finger). From then on each
// move adds its vertical travel, scaled down by a factor that grows as the
// pointer slides away from the band: at the far end one pixel moves at most one
// turn, so every index between two positions is passed through whatever the
// size of the feed. The position is carried across every factor change, so
// nothing ever jumps; the price is that after a fine excursion the lit tick and
// the finger can sit offset until the next press.

export interface ScrubGeom {
  /** The band's top and height, in the pointer's coordinate space. */
  top: number;
  height: number;
  /** The band's inner edge, the side facing the feed (the rail is at the feed's
   * right edge, board #463): x at or right of it is "on the band"; sliding LEFT
   * of it is sliding away. */
  edge: number;
  /** How far past the edge the factor keeps growing (px); 0 = at once. */
  reach: number;
}

/** The slowest the scrub ever goes: one pixel of travel moves <= 1 turn. */
export const scrubMaxFactor = (count: number, height: number): number =>
  Math.max(1, Math.ceil(count / Math.max(1, height)));

export function scrubFactor(x: number, count: number, g: ScrubGeom): number {
  const max = scrubMaxFactor(count, g.height);
  const dx = Math.max(0, g.edge - x);
  if (max === 1 || dx === 0) return 1;
  const k = g.reach > 0 ? Math.min(1, dx / g.reach) : 1;
  return 1 + (max - 1) * k;
}

const clampSlice = (q: number, count: number): number => Math.max(0, Math.min(count - 1e-9, q));

/** The slice position (0..count) under a fresh press at `y`. */
export const scrubDown = (y: number, count: number, g: ScrubGeom): number =>
  clampSlice(((y - g.top) / Math.max(1, g.height)) * count, count);

/** Carry the position over a move of `dy` px made at horizontal position `x`. */
export const scrubMove = (q: number, dy: number, x: number, count: number, g: ScrubGeom): number =>
  clampSlice(q + (dy * count) / (Math.max(1, g.height) * scrubFactor(x, count, g)), count);

/** The turn index a slice position names. */
export const scrubIndex = (q: number, count: number): number =>
  count <= 0 ? -1 : Math.max(0, Math.min(count - 1, Math.floor(q)));
