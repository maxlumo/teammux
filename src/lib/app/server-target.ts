// Where to reach ONE saved server (board #335 ②b-2-2).
//
// The reconnect machine used to read the live connection keys itself —
// `tmux_address`, `tmux_token`, `tmux_machine_id`, `tmux_machines` — which is
// "whoever is current is who I reconnect", spelled four times inside a module
// that should not know what a server is. This is the one reader instead, and
// it is asked by ENTRY ID, which is what makes one reconnect machine per
// runtime possible later; Single mode still has one, for CURRENT.
//
// THE CURRENT SERVER IS READ FROM THE ACTIVE MIRROR, and that is not a
// shortcut. Through ②b the mirror is written AHEAD of the registry on four
// paths: the connect form before it dials, the address optimizer before it
// re-dials, the Connection page's address pick, and a failover that moved to
// an alternate. A registry read there would reconnect to the address the user
// just left. For any OTHER id the registry is the only record there is: the
// entry's address and token, and its machine's failover set. b2-4 retires the
// mirror, and then there is one source for every id.
import { currentServerId, loadServers, machinesMap } from './servers.ts';

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
  if (id === currentServerId(storage)) {
    const address = storage.getItem('tmux_address') || '';
    if (!address) return null;
    const machineId = storage.getItem('tmux_machine_id') || '';
    return { address, token: storage.getItem('tmux_token') || '', machineId, alternates: alternatesOf(machineId, address) };
  }
  const entry = loadServers(storage).find((s) => s.id === id);
  if (!entry) return null;
  const machineId = entry.machineId ?? '';
  return { address: entry.address, token: entry.token, machineId, alternates: alternatesOf(machineId, entry.address) };
}
