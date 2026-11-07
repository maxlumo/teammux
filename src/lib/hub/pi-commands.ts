// pi's slash-command table for the Hub palette (board #71), kept out of
// hub.ts, which is over code-quality.md's 2000-line limit. One palette:
// `offeredCommands` in hub.ts reads it like every other backend's table.
import type { SlashCmd } from './hub.ts';

/** pi 1.5.0 — its slash-commands docs (#71). Measured in the live rig
 * (#71 note 9): `/model <provider>/<id>` switches at once and prints
 * `Model: <id>`, `/thinking <level>` switches the level, `/new` starts a new
 * session (a new id, reported by the telemetry). The rest open a picker or
 * a dialog, or leave the pane, so they are kept for the record and filtered. */
export const PI_COMMANDS: readonly SlashCmd[] = [
  { name: 'model', desc: 'Switch model (provider/id)', dynamic: 'models' },
  { name: 'thinking', desc: 'Set the thinking level', args: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { name: 'new', desc: 'Start a new session' },
  { name: 'compact', desc: 'Compact the context, with optional instructions' },
  // ── Pickers, dialogs and exits: kept for the record, filtered.
  { name: 'settings', desc: 'Settings dialog', view: true },
  { name: 'scoped-models', desc: 'Model scope picker', view: true },
  { name: 'resume', desc: 'Session picker', view: true },
  { name: 'tree', desc: 'Session tree navigator', view: true },
  { name: 'fork', desc: 'Fork picker', view: true },
  { name: 'clone', desc: 'Copies the branch into a new session', view: true },
  { name: 'session', desc: 'Session info', view: true },
  { name: 'login', desc: 'Provider login', view: true },
  { name: 'logout', desc: 'Provider logout', view: true },
  { name: 'hotkeys', desc: 'Keyboard shortcuts', view: true },
  { name: 'share', desc: 'Uploads the session — never offered', view: true },
  { name: 'bug', desc: 'Prepares a bug report upload', view: true },
  { name: 'quit', desc: 'Exits pi outside the launch recipe', view: true },
];
