const ORDER = [
  'lightbox', 'contextMenu', 'turnRail', 'palette',
  'action', 'trash', 'picker', 'create', 'rename', 'search', 'filter', 'files', 'drawer', 'sidebar',
] as const;

export type HubBackLayer = typeof ORDER[number];
type TryBack = () => boolean;

/** Fixed Hub priority, independent of when a layer opens or registers. Owners
 * supply live callbacks; this registry holds no copy of their open state. */
export function createHubBackRegistry() {
  const entries = new Map<HubBackLayer, { tryBack: TryBack }>();
  return {
    register(layer: HubBackLayer, tryBack: TryBack): () => void {
      const entry = { tryBack };
      entries.set(layer, entry);
      return () => {
        if (entries.get(layer) === entry) entries.delete(layer);
      };
    },
    back(): boolean {
      for (const layer of ORDER) {
        if (entries.get(layer)?.tryBack()) return true;
      }
      return false;
    },
  };
}
