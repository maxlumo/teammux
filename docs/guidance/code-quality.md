# Guidance: Code Quality

> Tenets: 1 (first principles), 9 (one mechanism), 11 (restraint).
> Review questions: **Is this the root cause or a symptom? Does an
> implementation already exist? Can it be shorter? Does an asynchronous
> completion write to the right object?**
> Draft · 2026-09-09.

## 1. Principles

1. **Root cause first:** start the fix commit's body with the cause, then
   the remedy. For a second failure in the same area, start with the
   assumption that the earlier fix addressed a symptom. Identify the layer first:
   browser extension, xterm, tmux, CLI or our code.
2. **One definition:** one function per concept, one location per atom,
   one writer per rule. A second implementation drifts silently.
3. **Restraint:** prefer deletion and shorter code. Remove replaced
   mechanisms completely, without compatibility layers.
4. **Capture identity at the gesture:** before an `await` or callback,
   capture the target project/session/issue/window. Verify it before
   applying a write; stale completions are no-ops.
5. **Empty is a conclusion, not a default:** do not render empty state
   before the first response. A failed read does not erase the last known
   state; emptiness requires a `ready` gate.
6. **Scattered booleans cause bugs:** `kbLocked`, `sent_this_turn`,
   `ctrlArmed` and `noteCopied` have all failed this way. Give an otherwise
   unobservable rule one owner function and one writer.
7. **Replace estimates with measurement:** `perLine=80` underestimated
   usage by a factor of two at 420px; layout transactions should remeasure.

## 2. Required and Forbidden

**Required: TypeScript / Svelte**
- Explicit `.ts` in relative imports, erasable syntax only, and
  `pnpm run check` as the sole type check.
- Import platform decisions only from `core/platform.ts`; check
  `isAndroid` before `isTauri` and `await tauriReady`.
- New modules include `<module>.test.ts` in the same commit.
  Extract testable pure logic; source regexes are a last resort.
- Chunk large base64 operations at 8192; HTML preview iframes use
  only `allow-same-origin`.
- Convert `.js → .ts` one file at a time, without logic changes in that commit.

**Required: Rust**
- Put synchronous I/O in `spawn_blocking`. Do not hold `std::Mutex`
  guards across `await` or perform external observation while holding locks.
- Use a `?`-returning inner function instead of about 40 copies of
  `require_str → match → err`.
- Use one shell quoter, rather than the current three.
- Use a context structure for functions with eight or more parameters.

**Forbidden**
- Parallel implementations of `ui/Select`, `ui/ContextMenu`, `menuPlacement`,
  `.to-tail`, `.live-dot`, `CreateProjectDialog`, `DirPicker` or `core/markdown`.
- Copying styles/logic into a second component, or redeclaring shared
  `app.css` classes in scoped CSS.
- Resolving an asynchronous completion's target from live `selected`/`cur`/`cwd`.
- Treating failed reads as empty data through patterns such as `catch { list = [] }`.
- Hardcoded font sizes, colors, durations, column widths or characters per line.
- Continuing to grow a file beyond roughly 2000 lines. `Hub.svelte` at 4094,
  `store.rs` at 2989, `spawn.rs` at 2364 and `Terminal.svelte` at 2555 are
  extraction debt, not permission to add more.
- Mixing mechanical moves with logic changes in one commit.

## 3. Review Checklist

- [ ] Does the commit explain the root cause and why earlier observations
  were only symptoms?
- [ ] Were related operations checked too? Owner: "你再检查一下其他类似操作逻辑".
- [ ] Was the repository searched for an existing function, component or style?
- [ ] Which file became shorter? Can code be removed rather than added?
- [ ] After each `await`, does the write use captured identity rather than a live value?
- [ ] Is an empty list confirmed empty or still unanswered? Does failure
  clear previously known data?
- [ ] Were booleans added? How many writers does each have?
- [ ] Are numbers or colors hardcoded?
- [ ] Are platform checks ordered correctly, with plugin calls awaiting `tauriReady`?
- [ ] Did type checking, `pnpm test` and `test:rust` pass? Was a negative control run?

## 4. Lessons

- 2026-08-24: right-click Close/Delete targeted the currently selected
  project instead of the pressed row; a broader check found three more
  polling races. Attachment staging leaked across rooms for three fixes
  on 2026-08-31; Board `load()` used live `cur` and clipboard completion
  updated the wrong state on 2026-09-01. All lacked captured identity.
- 2026-08-19: one timeout through `catch { agents = [] }` cleared the roster.
  On 2026-08-25 project switching flashed the add-agent panel; DirPicker
  cleared its content before every new read.
- 2026-05-04: three chip implementations became `AgentChip`. Other duplicates
  included two cursor calculations, five platform checks, 39 mono stacks,
  two DirPickers and two to-tail controls.
- 2026-05-06: six cols/rows update paths became one `ResizeObserver`.
- 2026-09-03: a one-shot Ctrl became a permanent latch; global `noteCopied`
  closed another issue's UI.
- 2026-08-31: the hardcoded `perLine` value of 80 underestimated at 420px by a factor
  of two (board #46).
- Six Escape-focus commits, including an objc2 patch and its revert,
  preceded discovery of the browser extension. Owner: "避免我们过度修复了".
- Keyboard resize reversed four times in a day before the overlay-not-resize
  decision. Keyboard-opening behavior changed three times before double-tap
  handling in touchend.
- Five network-health approaches ended at WS PING/PONG; three toolbar
  paint fixes ended at "structure beats paint".
- The 70-fix review on 2026-09-03 found a 750-line `hub_rpc.rs` match,
  40 boilerplate branches, three shell quoters and a full `ps` for every
  `list_panes`. These were recorded without immediate changes
  ("记录、暂不动"), with reasons in todo.md.
