// Where to reach ONE saved server (board #335 ②b-2-2).
//
// The reconnect machine used to read the live connection keys itself —
// `tmux_address`, `tmux_token`, `tmux_machine_id`, `tmux_machines` — which is
// "whoever is current is who I reconnect", spelled four times inside a module
// that should not know what a server is. This is the one reader instead, and
// it is asked by ENTRY ID, which is what makes one reconnect machine per
// runtime possible later; Single mode still has one, for CURRENT.
//
// ONE SOURCE FOR EVERY ID: the entry (board #335 ②b-4). Until then the
// CURRENT server was read from the active mirror (`tmux_address`, …), which
// four paths wrote AHEAD of the registry. Each of them now records the
// address on the entry when it is proven: the connect form and the deep link
// through `activateConnected`, a failover through `recordServer`, an address
// row or the optimizer when its connect answers. An address that never
// answered is not where the server is.
import { loadServers, machinesMap } from './servers.ts';

type Reader = Pick<Storage, 'getItem'>;

export interface ServerTarget {
  /** The address to try first. */
  address: string;
  token: string;
  /** The machine this server is, '' while unknown. */
  machineId: string;
  /** That machine's other addresses, in failover priority order. */
  alternates: string[];
}

/** Where to reach server `id` (a `ServerEntry.id`), or null when nothing is
 * saved for it. */
export function targetOf(storage: Reader, id: string): ServerTarget | null {
  const alternatesOf = (machineId: string, primary: string): string[] => {
    if (!machineId) return [];
    const set = machinesMap(storage)[machineId];
    return Array.isArray(set) ? set.filter((a) => a !== primary) : [];
  };
  const entry = loadServers(storage).find((s) => s.id === id);
  if (!entry) return null;
  const machineId = entry.machineId ?? '';
  return { address: entry.address, token: entry.token, machineId, alternates: alternatesOf(machineId, entry.address) };
}

/** Every address a switch to server `id` may dial, `first` leading (the one
 * it was asked to dial), then the entry's own and the machine's other
 * addresses in failover order (board #353). A candidate with no saved entry
 * (`id: ''`, the Add-server form before auth) has only the address it named. */
export function addressesOf(storage: Reader, id: string, first: string): string[] {
  const entry = id ? loadServers(storage).find((s) => s.id === id) : undefined;
  const machine = entry?.machineId ? machinesMap(storage)[entry.machineId] : undefined;
  return [...new Set([first, ...(entry ? [entry.address] : []), ...(Array.isArray(machine) ? machine : [])].filter(Boolean))];
}
