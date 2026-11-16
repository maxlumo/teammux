<script>
  // Host for #134's attachment case: one stager over fake upload RPCs, and the app's one transfer limiter,
  // which the test fills so the attachment has to wait.
  import { createStager } from './attachments.svelte.ts';
  import { transferSlots } from '../files/transfers.ts';
  let text = $state('');
  const log = [];
  // `gitignore`: 'present' answers at once; 'held' keeps the stat of the uploads dir's .gitignore
  // pending until `answer()` (it then says missing, so the stager writes it).
  let gitignore = 'present';
  let answer = null;
  const api = {
    fsMkdir: async () => ({}),
    fsStat: async (p) => {
      if (!p.endsWith('.gitignore')) throw new Error('no such file');
      if (gitignore === 'present') return {};
      await new Promise((r) => { answer = r; });
      throw new Error('no such file');
    },
    fsUploadBegin: async (dest, size) => { log.push(`begin ${dest.split('/').pop()}`); return { id: 'u', url: 'http://gw/up/u', chunk: 1 << 20, received: 0 }; },
    fsUploadResume: async () => ({ url: 'http://gw/up/u', received: 0 }),
    fsUploadAbort: async () => ({}),
  };
  const stager = createStager({ api, ws: () => '/ws', getText: () => text, setText: (v) => { text = v; } });
  globalThis.__att = {
    stager, log, slots: transferSlots,
    holdGitignore() { gitignore = 'held'; },
    answer() { answer?.(); },
    get text() { return text; },
  };
</script>

<span class="waiting">{stager.waiting ? 'waiting' : 'not-waiting'}</span>
<span class="attaching">{stager.attaching ? 'attaching' : 'idle'}</span>
