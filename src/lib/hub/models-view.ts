// The agent editor's view of one backend's `models_list` answer (board #511
// P3). Pure, so the page decides nothing about the answer's shape itself.
//
// `models_list` carries two independent facts (agents-overview.md § Model
// catalogue): a list of ids with its kind, and the baseline default, each with
// a fixed reason when absent. A reason is either a FACT — `not_listed` /
// `not_derivable`: nothing to enumerate or derive, so the field is simply free
// text — or a FAILURE that a Retry may fix. An answer without a `kind` key is
// from an OLDER server, which had only `models`.

/** What one fact of an answer says: `loading` before the first answer; `ok`
 *  it is there; `none` the server says there is nothing (a fact, no Retry);
 *  `failed` it could not be read, the call failed, or the answer is not one
 *  this client can judge (Retry); `unsupported` an older server without it. */
export type ModelFact = 'loading' | 'ok' | 'none' | 'failed' | 'unsupported';

export interface ModelsView {
  /** The list's fact. */
  status: ModelFact;
  ids: string[];
  /** `authoritative` refuses an id outside it at save; `suggestions` never. */
  kind: 'authoritative' | 'suggestions' | null;
  /** False when a suggestions list was cut to the budget. */
  complete: boolean;
  /** The baseline default's fact, independent of the list's (P3 review P1-A). */
  defaultStatus: ModelFact;
  /** The baseline default when `defaultStatus` is `ok`, else null. */
  baseline: string | null;
}

export const NO_MODELS: ModelsView = { status: 'loading', ids: [], kind: null, complete: true, defaultStatus: 'loading', baseline: null };

/** A failed call: neither fact could be read. */
export const FAILED_MODELS: ModelsView = { ...NO_MODELS, status: 'failed', defaultStatus: 'failed' };

const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

type ListPart = Pick<ModelsView, 'status' | 'ids' | 'kind' | 'complete'>;
const FAILED_LIST: ListPart = { status: 'failed', ids: [], kind: null, complete: true };

/** The list: exactly the shapes the server sends, everything else `failed`. */
function readList(r: Record<string, unknown>): ListPart {
  const kind = r.kind === 'authoritative' || r.kind === 'suggestions' ? r.kind : null;
  if (Array.isArray(r.models)) {
    if (!kind || typeof r.complete !== 'boolean') return FAILED_LIST;
    if (r.complete ? r.list_reason !== null : r.list_reason !== 'overflow') return FAILED_LIST;
    return { status: 'ok', ids: ids(r.models), kind, complete: r.complete };
  }
  if (r.models === null && r.kind === null && r.list_reason === 'not_listed') return { status: 'none', ids: [], kind: null, complete: true };
  return FAILED_LIST;
}

/** The baseline default: an id, a fact (`null` with no reason, or
 *  `not_derivable`), else `failed` — never silently "the CLI's default". */
function readDefault(r: Record<string, unknown>): Pick<ModelsView, 'defaultStatus' | 'baseline'> {
  if (typeof r.default === 'string' && r.default && r.default_reason === null) return { defaultStatus: 'ok', baseline: r.default };
  if (r.default === null && (r.default_reason === null || r.default_reason === 'not_derivable')) return { defaultStatus: 'none', baseline: null };
  return { defaultStatus: 'failed', baseline: null };
}

/** Read one answer into its two facts. */
export function readModels(answer: unknown): ModelsView {
  if (!answer || typeof answer !== 'object') return FAILED_MODELS;
  const r = answer as Record<string, unknown>;
  if (!('kind' in r)) {
    // An older server: `models` only, with no kind and no default.
    return { status: 'unsupported', ids: ids(r.models), kind: null, complete: true, defaultStatus: 'unsupported', baseline: null };
  }
  return { ...readList(r), ...readDefault(r) };
}

/** The label the EMPTY model field wears: the baseline default when the
 *  server derived one, "default unknown" when it could not be read, else the
 *  generic "backend default". Only a label — never written into the field. */
export function defaultLabel(view: ModelsView, t: (key: string) => string): string {
  if (view.defaultStatus === 'ok' && view.baseline) return t('agentsModelDefaultIs').replace('{id}', view.baseline);
  return view.defaultStatus === 'failed' ? t('agentsModelDefaultUnknown') : t('agentsModelDefault');
}
