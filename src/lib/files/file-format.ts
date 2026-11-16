// How Files names an entry: its size, date, kind, info lines and icon. Moved out of
// Files.svelte unchanged (board #144: the file-size rule, a ticket leaves an oversized file no
// larger than it found it).
import { t } from '../core/i18n.svelte.ts';

type Entry = { name: string; type: string; size: number; modified?: number; is_symlink?: boolean; link_target?: string };

export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

export function formatDate(ts: number | null | undefined): string {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString();
}

// The row's facts for the hover card (motion.md principle 16), through the
// SAME formatters the info view uses — never a second one.
export function entryKind(entry: Entry): string {
  if (entry.type === 'broken') return t('kindBroken');
  const target = entry.type === 'dir' ? t('kindDir') : t('kindFile');
  return entry.is_symlink ? `${t('kindSymlink')} → ${entry.link_target || target}` : target;
}
export function entryInfo(entry: Entry): { title: string; lines: { label: string; value: string }[] } {
  const lines = [{ label: t('type'), value: entryKind(entry) }];
  if (entry.type !== 'dir') lines.push({ label: t('size'), value: formatSize(entry.size) });
  if (entry.modified) lines.push({ label: t('modified'), value: formatDate(entry.modified) });
  return { title: entry.name, lines };
}

export function fileIcon(entry: Pick<Entry, 'type'>): string {
  if (entry.type === 'dir') return 'folder';
  return 'file';
}
