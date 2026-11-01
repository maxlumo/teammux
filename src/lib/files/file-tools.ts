export interface FileToolAction {
  key: string;
  label: string;
  icon: string;
  inline?: boolean;
  disabled?: boolean;
  pending?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
  danger?: boolean;
  run: () => unknown;
}

interface Entry { path: string; name: string; type: string }
interface EntryHandlers {
  open(entry: Entry): unknown;
  copy(path: string): unknown;
  download(path: string): unknown;
  rename(entry: Entry): unknown;
  remove(path: string): unknown;
  /** Whether the path is in the bookmarks list, and the one toggle that edits it (#494). */
  bookmarked(path: string): boolean;
  bookmark(path: string): unknown;
}

/** available is the toolbar's content width, in untransformed CSS pixels. */
export function visibleToolCount(total: number, available: number, target: number, gap: number): number {
  if (available <= 0 || target <= 0) return total;
  const slots = Math.max(1, Math.floor((available + gap) / (target + gap)));
  return total <= slots ? total : slots - 1;
}

/** What a thing with a path offers to copy: its NAME or its full PATH
 * (board #191, owner: "我可以复制文件名或者整个完整的路径") — one definition for
 * rows and crumbs alike. */
export function copyActions(target: { name: string; path: string }, t: (key: string) => string, copy: (text: string) => unknown): FileToolAction[] {
  return [
    { key: 'copyName', label: t('filesCopyName'), icon: 'copy', run: () => copy(target.name) },
    { key: 'copy', label: t('filesCopyPath'), icon: 'copy', run: () => copy(target.path) },
  ];
}

/** Inline tools and context menus are views of these same captured actions. */
export function entryToolActions(entry: Entry, t: (key: string) => string, handlers: EntryHandlers): FileToolAction[] {
  const target = { ...entry };
  return [
    { key: 'open', label: t('open'), icon: 'arrow-right', disabled: target.type === 'broken', run: () => handlers.open(target) },
    ...copyActions(target, t, handlers.copy),
    // A file or a folder can be bookmarked from its row's menu (#494, owner
    // 2026-11-01: "单个文件我应该也可以收藏"); a menu action, not a row tool.
    ...(target.type !== 'broken'
      ? [{ key: 'bookmark', label: t('filesBookmarkEntry'), icon: handlers.bookmarked(target.path) ? 'star-filled' : 'star',
        pressed: handlers.bookmarked(target.path), run: () => handlers.bookmark(target.path) }] : []),
    ...(target.type !== 'dir' && target.type !== 'broken'
      ? [{ key: 'download', label: t('filesDownload'), icon: 'download', inline: true, run: () => handlers.download(target.path) }] : []),
    { key: 'rename', label: t('filesRename'), icon: 'edit', inline: true, run: () => handlers.rename(target) },
    { key: 'delete', label: t('delete'), icon: 'trash', inline: true, danger: true, run: () => handlers.remove(target.path) },
  ];
}
