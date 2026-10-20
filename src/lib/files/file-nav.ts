import type { FileViewState } from './file-view-state.ts';

interface FileReference {
  path?: string;
  content?: unknown;
}

export interface FileLocation<F = FileReference, E = unknown> extends FileViewState<F> {
  cwd: string;
  entries: E[];
  fromGit: boolean;
  scroll: number;
  frameScroll: number;
}

interface BackContext<F> {
  cwd: string;
  currentFile: F | null;
  fromGit: boolean;
}

/** One Back step of the directory history: the directory the list was in,
 * or (board #431) the preview a directory LINK was followed from, together
 * with that preview's own linked-file history, which browsing the linked
 * directory would otherwise clear (#431 review P1 residual). */
export type DirectoryStep<L> = string | { location: L; files: L[] };

export type FileBackStep<L> =
  | { kind: 'restore'; location: L }
  | { kind: 'preview' }
  | { kind: 'git' }
  | { kind: 'list'; path: string };

/** Below directory history, tab visits climb; a chat jump returns to chat. */
export function directoryBackFloor(cwd: string, jumped: boolean): string {
  if (!jumped && cwd && cwd !== '/') return cwd.replace(/\/[^/]+\/?$/, '') || '/';
  return '';
}

/** Non-reactive history/request state, one instance per Files component.
 * The host owns RPCs, confirmation, animation and applying DOM scroll offsets. */
export function createFileNavigation<F extends FileReference = FileReference, E = unknown>() {
  let dirHist: DirectoryStep<FileLocation<F, E>>[] = [];
  // The browser model (board #187): Back pushes where you WERE here; Forward
  // pops it; any fresh navigation throws it away.
  let dirFwd: string[] = [];
  let fileHist: FileLocation<F, E>[] = [];
  let fileSeq = 0;

  function backFromPreview({ cwd, currentFile, fromGit }: BackContext<F>): FileBackStep<FileLocation<F, E>> {
    const previous = fileHist.pop();
    if (previous) return { kind: 'restore', location: previous };
    if (fromGit) return { kind: 'git' };
    return { kind: 'list', path: currentFile?.path?.replace(/\/[^/]+$/, '') || cwd };
  }

  return {
    rememberDirectory(cwd: string, path: string): void {
      if (cwd && path !== cwd) { dirHist.push(cwd); dirFwd = []; }
    },
    /** A directory link followed from a preview (board #431) is a Back step
     * of its own, even into the directory already listed: Back returns to
     * that preview. It is a REAL entry, so a chain of preview -> directory ->
     * preview -> directory unwinds in order, and nothing is popped that the
     * link did not push (#431 review P1). It holds the preview's linked-file
     * history too, so opening a file or a directory in the linked listing
     * cannot cut that preview off from where it came from. */
    rememberLink(location: FileLocation<F, E>): void { dirHist.push({ location, files: [...fileHist] }); dirFwd = []; },
    /** Back: the previous directory or link origin, or undefined at the
     * start. `from` (where the user is now) becomes the Forward step. */
    popDirectory(from = ''): DirectoryStep<FileLocation<F, E>> | undefined {
      const prev = dirHist.pop();
      // Forward re-enters a DIRECTORY; returning to a link's preview leaves
      // no Forward step, because the preview is not a directory to re-enter.
      if (typeof prev === 'string' && from) dirFwd.push(from);
      // Back to a link's preview resumes that preview's own Back chain,
      // whatever was browsed in the directory in between.
      if (prev != null && typeof prev !== 'string') fileHist = [...prev.files];
      return prev;
    },
    /** Forward: undoes the last Back; `from` becomes a Back step again. */
    forwardDirectory(from = ''): string | undefined {
      const next = dirFwd.pop();
      if (next != null && from) dirHist.push(from);
      return next;
    },
    canGoBack(): boolean { return dirHist.length > 0; },
    canGoForward(): boolean { return dirFwd.length > 0; },
    resetDirectories(): void { dirHist = []; dirFwd = []; },
    rememberFile(location: FileLocation<F, E>): void { fileHist.push(location); },
    resetFiles(): void { fileHist = []; },
    nextFile(): number { return ++fileSeq; },
    isCurrentFile(request: number): boolean { return request === fileSeq; },
    backFromPreview,
    backFromInfo(context: BackContext<F>): FileBackStep<FileLocation<F, E>> {
      if (context.currentFile?.content != null) return { kind: 'preview' };
      return backFromPreview(context);
    },
  };
}
