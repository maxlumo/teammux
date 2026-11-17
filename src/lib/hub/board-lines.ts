// The Board's two answer lines (board #150: moved out of Board.svelte unchanged, the file-size
// rule of code-quality.md § 2; no logic change).
import { t } from '../core/i18n.svelte.ts';

/** Why a write did not go, in this page's words: the two gate refusals
 * (board #377) have their own copy; anything else is the server's message. */
export const saveError = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  if (code === 'server_too_old') return t('boardAssignOldServer');
  if (code === 'login_pending') return t('boardAssignConnecting');
  return String((e as Error)?.message ?? e);
};
/** The line a save's answer owes the person when the assignee was NOT
 * reached (board #377 review P1-A): `failed` (the telling went wrong) and
 * `offline` (nothing was delivered: stopped, not this project's agent, or
 * tmux could not be asked). The issue is saved either way — that is why
 * this is a line of its own and not a failure of the save. */
export const dispatchLine = (answer: { dispatch?: string; dispatch_error?: string; offline?: { why?: string }[] } | null | undefined, name: string) => {
  if (answer?.dispatch === 'failed') return t('boardDispatchFailed').replace('{name}', name).replace('{error}', answer.dispatch_error ?? '');
  if (answer?.dispatch === 'offline') return t('boardDispatchOffline').replace('{name}', name).replace('{why}', answer.dispatch_error ?? answer.offline?.[0]?.why ?? '');
  return '';
};
