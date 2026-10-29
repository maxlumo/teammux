import type { AnchorRect } from '../ui/placement.ts';

export const ALL_TARGET = 'all';
const TEAM_TARGET_PREFIX = 'team:';

export const teamRoot = (path: string | null | undefined): string | null => path?.split('/')[0] || null;
export const teamTarget = (root: string): string => `${TEAM_TARGET_PREFIX}${root}`;
export const targetTeam = (target: string): string | null =>
  target.startsWith(TEAM_TARGET_PREFIX) ? target.slice(TEAM_TARGET_PREFIX.length) || null : null;

interface TargetAgent {
  name: string;
  managed: boolean;
  team?: string | null;
}

/** One recipient resolution for delivery, selection and interruption.
 * `team:` cannot collide with a window name: valid_name forbids colons. */
export function targetMembers(target: string, agents: readonly TargetAgent[]): string[] {
  if (!target) return [];
  const team = targetTeam(target);
  const names = new Set<string>();
  for (const agent of agents) {
    if (agent.managed && (target === ALL_TARGET || (team ? teamRoot(agent.team) === team : agent.name === target))) {
      names.add(agent.name);
    }
  }
  return [...names];
}

/** The reading-filter lock (#482, owner 2026-10-30: "如果我选了show only后，要选中
 * 这个agent不能选其他agent不然经常发错消息"). While the filter shows one agent
 * (`shown`, '' when off or on "Only mine"), the ONE target it allows is that
 * agent while it runs, and nobody ('' — nothing is deliverable) while it is
 * stopped. Every other target — another agent, everyone, a team — is refused,
 * whoever asks (a card, a menu, an automatic pick). Off, everything goes. */
export function canAddress(target: string, shown: string, live = true): boolean {
  return !shown || target === (live ? shown : '');
}

/** Why a send is refused while the filter shows `shown`, or null when it may
 * go: the shown agent stopped (it cannot receive), the target is not it, or
 * the text itself names someone else. `reached` is every address the payload
 * carries as sent (a message's tokens after its attachments are expanded; a
 * slash command's own target), NOT only names on this client's roster: the
 * server may know an agent the roster has not shown yet. */
export function lockedSend(shown: string, live: boolean, target: string, reached: readonly string[]):
  { kind: 'unreachable' } | { kind: 'beyond'; names: string[] } | null {
  if (!shown) return null;
  if (!live || target !== shown) return { kind: 'unreachable' };
  const names = [...new Set(reached.filter((n) => n && n !== shown))];
  return names.length ? { kind: 'beyond', names } : null;
}

/** Boxes are measured by the browser in textarea-local CSS pixels. A tall
 * touch target can hit the preceding line even when the final line is short. */
export function signatureLayout({
  width, naturalHeight, maxHeight, controlsWidth, controlsHeight, gap, textRects, empty = false, paintInset = 0, inkInset = 0, lift = 0,
}: {
  width: number; naturalHeight: number; maxHeight: number;
  controlsWidth: number; controlsHeight: number; gap: number;
  textRects: readonly AnchorRect[]; empty?: boolean;
  /** How far above the field's bottom edge the controls stand (their CSS
   * `bottom`, board #229): a 32px phone group centred in a 44px line sits 6px
   * up, so its box and the band it needs move up by the same amount. */
  lift?: number;
  /** What collides is INK with PAINT (board #203): a line's rectangle includes
   * its half-leading above and below the glyphs (`inkInset`, (line-height −
   * font-size) / 2), and a command's hit box extends `paintInset`
   * (`--control-paint-inset`) beyond what it paints. A 28px pointer command
   * beside 20.25px lines dips ~4px of hit box into the preceding line's
   * leading while nothing visible touches — that reserved an empty band under
   * every two-line draft. A 44px touch command's paint does reach the
   * preceding line's ink, so the phone still reserves its band. */
  paintInset?: number;
  inkInset?: number;
}): { inputHeight: number; reserved: number; overflow: boolean; collision: boolean } {
  if (empty) return { inputHeight: controlsHeight, reserved: 0, overflow: false, collision: false };
  const natural = Math.max(controlsHeight, naturalHeight);
  const limit = Math.max(controlsHeight, maxHeight);
  const left = width - controlsWidth;
  const up = Math.max(0, lift);
  const top = natural - up - controlsHeight + Math.max(0, paintInset);
  const ink = Math.max(0, inkInset);
  const collision = textRects.some(rect => rect.right > rect.left && rect.bottom > rect.top
    && rect.right + gap > left && rect.left < width && rect.bottom - ink > top && rect.top + ink < natural - up);
  const reserved = collision || natural > limit + 1 ? controlsHeight + up : 0;
  const inputHeight = Math.min(natural, Math.max(controlsHeight, limit - reserved));
  return { inputHeight, reserved, overflow: natural > inputHeight + 1, collision };
}

interface InterruptAgent {
  name: string;
  managed: boolean;
  team?: string | null;
  state?: string;
}

const INTERRUPTIBLE_STATES = new Set(['running', 'working', 'waiting', 'blocked']);

/** A card owns only its busy managed members; callers capture before awaiting. */
export function busyTargetsFor(target: string, agents: readonly InterruptAgent[]): string[] {
  const members = new Set(targetMembers(target, agents));
  return [...new Set(agents
    .filter((a) => a.managed && members.has(a.name) && INTERRUPTIBLE_STATES.has(a.state ?? ''))
    .map((a) => a.name))];
}

interface PaletteAgent {
  name: string;
  managed: boolean;
  team?: string | null;
  agent?: string | null;
}

interface AttachmentToken {
  kind: 'image' | 'file';
  n: number;
}

interface StagedAttachment extends AttachmentToken {
  path: string;
}

/** A leading addressee wins; a room/all choice needs one managed dialect. */
export function paletteBackendFor(
  text: string | null | undefined,
  recipient: string,
  agents: readonly PaletteAgent[],
): string {
  const m = /^\s*@([\w][\w.-]*)\s/u.exec(text ?? '');
  const name = m ? m[1] : (recipient === ALL_TARGET || targetTeam(recipient) ? null : recipient);
  if (name) return agents.find((a) => a.managed && a.name === name)?.agent ?? '';
  const members = targetTeam(recipient) ? new Set(targetMembers(recipient, agents)) : null;
  const backends = [...new Set(agents.filter((a) => a.managed && (!members || members.has(a.name))).map((a) => a.agent ?? ''))];
  return backends.length === 1 ? backends[0]! : 'mixed';
}

export const attachToken = (a: AttachmentToken): string =>
  `[${a.kind === 'image' ? 'img' : 'file'}:${a.n}]`;

/** Replace each attachment's first token in place; append a deleted token's ref. */
export function attachmentBody(raw: string, attachments: readonly StagedAttachment[]): string {
  let body = raw;
  const stragglers = [];
  for (const a of attachments) {
    const ref = a.kind === 'image' ? `![](${a.path})` : a.path;
    const tok = attachToken(a);
    if (body.includes(tok)) body = body.replace(tok, ref);
    else stragglers.push(ref);
  }
  return [body, ...stragglers].filter(Boolean).join('\n');
}
