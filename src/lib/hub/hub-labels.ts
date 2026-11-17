// The Hub's state words, tones and two small header helpers (board #147: moved out of
// Hub.svelte unchanged, the file-size rule of code-quality.md § 2; no logic change).
import { t } from '../core/i18n.svelte.ts';
import { detailWords, stateDotColor } from './hub.ts';

/** Four states, one word each. Anything unexpected shows itself rather than
 * being silently relabelled. */
export function stateLabel(state: string): string {
  const label = t('hubState_' + state);
  return label.startsWith('hubState_') ? state : label;
}
/** A status detail in words: the person-needed ones name their remedy
 * (board #362 c), then the provider's error text when there is one (board
 * #39); any other detail reads as the server wrote it. */
export function detailLabel(detail: string, error = ''): string {
  if (!detail) return '';
  const label = t('hubDetail_' + detail);
  return detailWords(label.startsWith('hubDetail_') ? detail : label, error);
}

/** The state's tone in the hover card is the SAME family stateDotColor paints. */
export function stateTone(state: string, detail = ''): 'accent' | 'warn' | 'danger' | undefined {
  switch (stateDotColor(state, detail)) {
    case 'var(--accent)': return 'accent';
    case 'var(--status-warn)': return 'warn';
    case 'var(--status-danger)': return 'danger';
    default: return undefined;
  }
}

/** Why a spawn did not go, in this page's words: the gate's two refusals
 * (#377, #382) have their own copy; anything else is the server's message
 * (`check_join` names the team it refused). */
export function spawnRefusal(e: { code?: string; message?: string } | unknown): string {
  const err = e as { code?: string; message?: string } | null | undefined;
  if (err?.code === 'server_too_old') return t('hubJoinOldServer');
  if (err?.code === 'login_pending') return t('boardAssignConnecting');
  return String(err?.message ?? e);
}

/** Member names of a configured team, for the preset rows. */
export function teamMembers(tm: { members: string }): string[] {
  try { return (JSON.parse(tm.members) ?? []).map((m: { team?: string; name?: string }) => (m.team ? `+${m.team}` : m.name)).filter(Boolean); } catch { return []; }
}

/** Vertical wheel pans the header path horizontally — the path scrolls
 * instead of ellipsizing, and a mouse has no horizontal axis of its own.
 * An action (not `onwheel`) because preventDefault needs a non-passive
 * listener. */
export function wheelX(el: HTMLElement): { destroy: () => void } {
  const onWheel = (e: WheelEvent) => {
    if (!e.deltaY || e.deltaX) return; // trackpads already pan natively
    if (el.scrollWidth <= el.clientWidth) return; // it fits — let the page have the wheel
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  };
  el.addEventListener('wheel', onWheel, { passive: false });
  return { destroy: () => el.removeEventListener('wheel', onWheel) };
}

/** The feed's detail level as three menu rows — chat / + status / + tools —
 * the current one ticked. It lives in the project TITLE's menu (the one
 * menu about "this conversation") rather than as a header switch: the
 * header keeps no spare switches (board #72), and Settings was the only
 * other way to reach it (review, 2026-09-03: dead code in the Hub, a
 * setting three pages away). Radio semantics through the two icons the menu
 * already has — a tick on the chosen level, a hollow circle on the rest.
 * `prefs` is the Hub's own preference store (moved here with its one caller's argument, #147). */
export function feedLevelItems(prefs: { feedLevel: string; setFeedLevel: (level: string) => void }) {
  const levels = [['chat', 'hubFeedChat'], ['status', 'hubFeedStatus'], ['tools', 'hubFeedTools']];
  return levels.map(([level, key]) => ({
    label: `${t('hubFeedLevel')} · ${t(key!)}`,
    icon: prefs.feedLevel === level ? 'check' : 'circle',
    onselect: () => prefs.setFeedLevel(level!),
  }));
}
