<script lang="ts">
  // A saved server's addresses and token, edited in place (board #402, owner:
  // "connection 里，我可以直接在这个配置页面进行连接的更改，比如为某一个 server
  // 添加一个新的 url"). Opened from that server's row in Settings › Connection;
  // rename stays the row's inline pencil, the one rename mechanism. Every
  // action writes at once through servers.ts (the address list of the current
  // server already removes at once); closing writes nothing more, and a typed
  // address or token that was not added or applied is dropped.
  //
  // The token is a secret: the field starts empty and the saved token is never
  // put in the page. A new one applies from the next connection; the live one
  // is not re-dialled (orchestrator, #402), and a wrong one is refused at the
  // next dial (board #393).
  import Dialog from '../ui/Dialog.svelte';
  import CommandButton from '../ui/CommandButton.svelte';
  import { t } from '../core/i18n.svelte.ts';
  import { normalizeAddress } from '../core/connection-address.ts';
  import { endpointOf, isBulkInsert, parseConnectionLink, type ParsedLink } from '../core/connection-link.ts';
  import type { AddressRefusal } from './servers.ts';

  /** `storage`: the save failed and a re-read shows nothing changed;
   * `uncertain`: it failed and the re-read shows something did (review P2-D
   * round 3: putting the old values back is best effort, not atomic). */
  type Failure = AddressRefusal | 'storage' | 'uncertain';

  let {
    name, addresses, active, machineKnown, max, compact = false,
    onadd, onremove, ontoken, onclose,
  }: {
    name: string;
    /** The server's addresses in dial order (`serverAddresses`). */
    addresses: string[];
    /** The address the last connect proved: never removable. */
    active: string;
    /** The server has connected here, so it has a failover set to add to. */
    machineKnown: boolean;
    max: number;
    compact?: boolean;
    /** null: done. A refusal, or `storage`: nothing was written (board
     * #402 review P2-D: a write that throws changes nothing and is said). */
    onadd: (address: string) => Failure | null;
    onremove: (address: string) => Failure | null;
    ontoken: (token: string) => Failure | null;
    onclose: () => void;
  } = $props();

  let draft = $state('');
  let token = $state('');
  let refusal = $state<Failure | null>(null);
  /** Why a text was refused BEFORE the store was asked: the message key of
   * the shared classification (#401, #405). */
  let linkRefusal = $state('');
  let tokenDone = $state(false);
  let tokenFailure = $state<Failure | null>(null);

  const title = $derived(t('serverDetailsTitle').replace('{name}', name));
  // Why adding is not possible right now, said beside the field (a touch
  // screen has no tooltip, #384 validator F1).
  const blocked = $derived(!machineKnown ? t('serverAddressNoMachine')
    : addresses.length >= max ? t('serverAddressFull').replace('{n}', String(max)) : '');
  const REASON: Record<Failure, string> = {
    missing: 'serverAddressInvalid', 'no-machine': 'serverAddressNoMachine', full: 'serverAddressFull',
    invalid: 'serverAddressInvalid', duplicate: 'serverAddressDuplicate', active: 'serverAddressesNote',
    credential: 'serverAddressCredential', storage: 'serverEditFailed', uncertain: 'serverEditUncertain',
  };
  const said = $derived(linkRefusal ? t(linkRefusal) : refusal ? t(REASON[refusal]).replace('{n}', String(max)) : '');
  /** The unusable reasons, worded as the connect form words them
   * (ConnectFields), so one text reads the same in every address field. */
  const UNUSABLE: Record<Extract<ParsedLink, { kind: 'unusable' }>['reason'], string> = {
    'no-address': 'linkNoAddress', ambiguous: 'linkAmbiguous', 'address-credential': 'linkAddressCredential', hidden: 'linkHidden',
  };

  $effect(() => { if (token) tokenDone = false; });

  /** A typed host with no scheme takes the page's (`host:9899`), as the
   * connect form gives it; a text that names a scheme of its own is passed
   * as typed, so `http://…` is refused, never turned into `ws://http://…`
   * (board #402 review P1-B). The store validates it (`endpointOf`). */
  const withScheme = (text: string) => (/^[a-z][a-z\d+.-]*:\/\//iu.test(text) ? text : normalizeAddress(text, location.protocol));
  /** What the shared classification says about a text in an address-only
   * field, in builder-2's order (#401, #405): the message key when it must
   * be refused and cleared, else ''. (1) `parseConnectionLink`: a usable
   * link carries a token and has no place here; an unusable one says why
   * (no address, ambiguous, a credential in the address such as user info,
   * hidden characters), which covers an old link whose credential sits only
   * inside its encoded `addr`, `address` or `server` (review P1-B residual).
   * (2) `endpointOf` on the text as it would be stored: a `credential`
   * answer (URL user info `user:pass@`, its disguised forms, a credential key
   * anywhere) is cleared the same way. No decoding of its own here; the store
   * gates on `endpointOf` again. */
  function refusalOf(text: string): string {
    const parsed = parseConnectionLink(text);
    if (parsed.kind === 'link') return 'serverAddressCredential';
    if (parsed.kind === 'unusable') return UNUSABLE[parsed.reason];
    return endpointOf(withScheme(text.trim())).kind === 'credential' ? 'linkAddressCredential' : '';
  }
  function refuseLink(key: string) {
    draft = '';
    refusal = null;
    linkRefusal = key;
  }
  function add() {
    if (blocked || !draft.trim()) return;
    const key = refusalOf(draft);
    if (key) { refuseLink(key); return; }
    linkRefusal = '';
    // The store validates again (endpointOf, its own gate). Every link form
    // was refused above with the same classification, so what comes back
    // here is an ordinary refusal of an address, left to be corrected.
    const result = onadd(withScheme(draft.trim()));
    if (!result) draft = '';
    refusal = result;
  }
  /** A pasted link is cleared at once, before anything is pressed: it never
   * sits in plain view (#401's rule for an address field). */
  function addInput(e: Event) {
    const field = e.currentTarget as HTMLInputElement;
    const key = isBulkInsert(e as InputEvent) ? refusalOf(field.value) : '';
    if (key) {
      field.value = '';
      refuseLink(key);
      return;
    }
    refusal = null;  // typing again clears the last refusal
    linkRefusal = '';
  }
  /** The address list has ONE alert, and it belongs to the latest operation
   * (#402 review P2 on ebd198c6): a Remove replaces whatever an earlier Add
   * or paste said, so a refused link's message never hides its outcome. */
  function removeAddress(address: string) {
    linkRefusal = '';
    refusal = onremove(address);
  }
  function addKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    add();
  }
  function applyToken() {
    if (!token) return;
    // Success is said only when the save completed; a failure keeps the
    // typed token in its field (a password field: never shown) for a retry.
    const failed = ontoken(token);
    tokenFailure = failed;
    if (failed) return;
    token = '';
    tokenDone = true;
  }
  function tokenKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    applyToken();
  }
</script>

<Dialog {compact} label={title} oncancel={onclose}>
  <h2>{title}</h2>
  <div class="details-addresses" role="list" aria-label={t('addresses')}>
    {#each addresses as address (address)}
      <div class="details-address" role="listitem">
        <span class="details-address-text">{address}</span>
        {#if address === active}
          <span class="details-in-use">{t('serverAddressInUse')}</span>
        {:else}
          <CommandButton variant="danger" iconOnly bare icon="x" label={`${t('delete')} ${address}`}
            onclick={() => removeAddress(address)} />
        {/if}
      </div>
    {/each}
  </div>
  <p class="dlg-note">{t('serverAddressesNote')}</p>
  <div class="details-line">
    <input class="config-input" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
      placeholder="ws://host:9899" aria-label={t('serverAddressAdd')} disabled={!!blocked}
      bind:value={draft} onkeydown={addKey} oninput={addInput} />
    <CommandButton variant="primary" icon="plus" label={t('serverAddressAdd')} disabled={!!blocked || !draft.trim()} onclick={add} />
  </div>
  {#if blocked}<p class="dlg-note">{blocked}</p>{/if}
  {#if said}<p class="dlg-error config-error appear" role="alert">{said}</p>{/if}
  <strong class="config-field-label details-token-label">{t('serverTokenNew')}</strong>
  <div class="details-line">
    <input class="config-input" type="password" autocomplete="new-password" placeholder={t('serverTokenUnchanged')}
      aria-label={t('serverTokenNew')} bind:value={token} onkeydown={tokenKey} />
    <CommandButton icon="key" label={t('serverTokenChange')} disabled={!token} onclick={applyToken} />
  </div>
  <!-- Each message names only what its action could have changed (#402
       validator P3): an address operation the addresses, the token change
       the token. -->
  {#if tokenFailure}<p class="dlg-error config-error appear" role="alert">{t(tokenFailure === 'uncertain' ? 'serverTokenUncertain' : REASON[tokenFailure])}</p>{/if}
  <p class="dlg-note" role="status">{tokenDone ? t('serverTokenChanged') : t('serverTokenNote')}</p>
  <div class="dlg-actions">
    <CommandButton label={t('close')} onclick={onclose} />
  </div>
</Dialog>

<style>
  .details-addresses { display: flex; flex-direction: column; gap: var(--menu-gap); min-width: 0; }
  .details-address { display: flex; align-items: center; gap: var(--menu-gap); min-width: 0; min-height: var(--control-height); }
  .details-address-text { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-meta); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .details-in-use { flex: none; color: var(--accent-ink); font-size: var(--fs-meta); }
  .details-line { display: flex; align-items: center; gap: var(--menu-gap); min-width: 0; }
  .details-line input { flex: 1; min-width: 0; }
  .details-token-label { margin-top: var(--menu-gap); }
</style>
