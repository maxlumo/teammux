// The notification mute switch, reactive (board #423, owner 2026-10-19:
// "小铃铛图标那里，可以点开直接有一个mute的按钮…同时小铃铛也加一条竖线").
//
// ONE persisted switch: the `tmux_notify` key notifications.ts reads with
// `notifyEnabled()` — the very value `notifyNews`'s effect gate asks. This
// module is its reactive face, not a second store: `on` changes only after
// the key really changed (review P1: a mirror that flipped first and a write
// that failed silently would show "muted" while the gate still rang), it
// follows a `storage` event from another window, and `set` is the one door
// that writes it — Settings > Notifications and the centre's Mute both go
// through it, so the two can never disagree, and every bell draws `bell-off`
// from `on` alone.
//
// The platform permission's snapshot lives here too (review P2-B), so a
// Settings page left open shows the caption the centre's unmute produced.
import {
  NOTIFY_ENABLED_KEY, notifyEnabled, setNotifyEnabled, previewCue, ensurePermission, notifyPermission,
} from './notifications.ts';

let on = $state(notifyEnabled());
let permission = $state(notifyPermission());

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === NOTIFY_ENABLED_KEY || event.key === null) on = notifyEnabled();
  });
}

export const notifySwitch = {
  /** Sound + system alerts are on: exactly what `notifyNews` gates on. */
  get on(): boolean { return on; },
  /** The platform permission as last read (`notifyPermission()`). */
  get permission(): ReturnType<typeof notifyPermission> { return permission; },
  /** Re-read the platform permission (after any ask). */
  refreshPermission(): void { permission = notifyPermission(); },
  /** Write the switch; `false` when the key could not be written, and then
   * NOTHING changed — not the gate, not the bells, not the controls (their
   * owner shows the failure). Turning it ON is a user gesture, so it also
   * unlocks the audio (`previewCue`) and asks for the system permission
   * (board #72, from Settings or the centre). Both are fail-soft: a denied
   * permission leaves the sound on its own, as it always has. */
  async set(next: boolean): Promise<boolean> {
    if (!setNotifyEnabled(next)) return false;
    on = notifyEnabled();
    if (!next) return true;
    previewCue();
    await ensurePermission();
    permission = notifyPermission();
    return true;
  },
};
