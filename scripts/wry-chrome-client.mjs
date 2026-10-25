// Board #454: the Android app wraps wry's RustWebChromeClient
// (gen/android/.../FullscreenChromeClient.kt) to host element fullscreen, and
// forwards every other method wry overrides. A wrapper cannot inherit from
// wry's final class, so a method a LATER wry overrides would be dropped
// silently — onShowFileChooser dropped is a dead attachment picker. This reads
// the wry version Cargo.lock locks, finds that crate's Kotlin in the cargo
// registry, and names every wry override the wrapper does not forward — by
// SIGNATURE (overloads apart), with the call to `inner.<name>(` in that
// method's own body (board #454 review P1-B). It does not prove the two
// Kotlin methods equivalent; it refuses what it cannot read.
// Fail closed: no locked wry, two of them, no source found, a declaration
// that cannot be read, or one declared twice is a problem, never a skip
// (orchestrator rulings, 2026-10-25).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WRAPPER = 'src-tauri/gen/android/app/src/main/java/com/tmuxmobile/dev/FullscreenChromeClient.kt';
/** The two signatures the wrapper implements itself instead of forwarding. */
export const HOSTED = ['onShowCustomView(View,CustomViewCallback)', 'onHideCustomView()'];

/** Kotlin with comments and string literals blanked, so braces count. */
function code(src) {
  return src
    .replace(/"""[\s\S]*?"""/gu, '""')
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/\/\/[^\n]*/gu, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"/gu, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/gu, "''");
}

/** A brace, or the start of a declaration (modifiers included). */
const DECL = /[{}]|\b(?:(?:private|public|internal|protected|open|final|abstract|override|inline|suspend|operator|infix)\s+)*(?:fun|val|var|init|class|object|interface|constructor)\b/gu;

/** The balanced `(…)` opening at `open`: the index of its `)`, or -1. */
function closeParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Split at top-level commas (not inside <>, (), []). */
function topLevel(list) {
  const parts = [];
  let depth = 0, from = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if ('<(['.includes(c)) depth++;
    else if ('>)]'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(list.slice(from, i)); from = i + 1; }
  }
  parts.push(list.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** One parameter's type as the JVM sees it: no annotation, name, default,
 * nullability or qualifier (`GeolocationPermissions.Callback` → `Callback`).
 * Null when it cannot be read; the caller refuses. */
function paramType(param) {
  const bare = param.replace(/@\w+(?:\([^)]*\))?\s*/gu, '').replace(/^vararg\s+/u, '');
  const colon = bare.indexOf(':');
  if (colon < 0) return null;
  const type = (bare.slice(colon + 1).split('=')[0] ?? '').trim();
  if (!type) return null;
  return type.replace(/\s+/gu, '').replace(/\?/gu, '').replace(/\b(?:\w+\.)+(\w+)/gu, '$1');
}

/** The `override fun`s declared directly in `class <name>`'s body (not
 * those of an object or lambda nested in it), each with its SIGNATURE —
 * name and parameter types, so overloads stay apart — and its OWN body:
 * the text from its parameter list to the next class-level declaration.
 * `{ error }` when the class is missing, or a declaration cannot be read or
 * is declared twice: the caller refuses. */
export function overridesOf(src, name) {
  const text = code(src);
  const head = new RegExp(`\\bclass\\s+${name}\\b`, 'u').exec(text);
  if (!head) return { error: `no class ${name}` };
  const open = text.indexOf('{', head.index);
  if (open < 0) return { error: `class ${name} has no body` };
  const starts = [];
  let depth = 0, end = -1;
  DECL.lastIndex = open;
  for (let m; (m = DECL.exec(text));) {
    if (m[0] === '{') depth++;
    else if (m[0] === '}') { if (--depth === 0) { end = m.index; break; } }
    else if (depth === 1) starts.push(m.index);
  }
  if (end < 0) return { error: `class ${name} is not closed` };
  const methods = [];
  for (const [i, at] of starts.entries()) {
    const decl = text.slice(at, starts[i + 1] ?? end);
    if (!/^(?:\w+\s+)*?override\s+(?:\w+\s+)*?fun\b/u.test(decl)) continue;
    const m = /\bfun\s+(\w+)\s*\(/u.exec(decl);
    if (!m) return { error: `${name}: an override fun whose name cannot be read` };
    const paren = m.index + m[0].length - 1;
    const close = closeParen(decl, paren);
    if (close < 0) return { error: `${name}.${m[1]}: an unbalanced parameter list` };
    const types = topLevel(decl.slice(paren + 1, close)).map(paramType);
    if (types.includes(null)) return { error: `${name}.${m[1]}: a parameter whose type cannot be read` };
    methods.push({ name: m[1], sig: `${m[1]}(${types.join(',')})`, body: decl.slice(close + 1) });
  }
  const seen = new Set();
  for (const { sig } of methods) {
    if (seen.has(sig)) return { error: `${name}: ${sig} is declared twice` };
    seen.add(sig);
  }
  return { methods };
}

/** Every `wry` version Cargo.lock locks. */
export function lockedWry(lock) {
  return [...lock.matchAll(/\[\[package\]\]\s*\nname = "wry"\s*\nversion = "([^"]+)"/gu)].map((m) => m[1]);
}

/** The locked wry's RustWebChromeClient.kt in the cargo registry, or null. */
export function wrySource(version, cargoHome) {
  const reg = join(cargoHome, 'registry', 'src');
  let indexes = [];
  try { indexes = readdirSync(reg); } catch { return null; }
  for (const index of indexes) {
    const file = join(reg, index, `wry-${version}`, 'src', 'android', 'kotlin', 'RustWebChromeClient.kt');
    if (existsSync(file)) return file;
  }
  return null;
}

/** Pure: what the wrapper fails to cover, given both sources. */
export function uncovered(wrySrc, wrapperSrc) {
  const wry = overridesOf(wrySrc, 'RustWebChromeClient');
  if (wry.error) return { error: `wry's Kotlin: ${wry.error}` };
  const ours = overridesOf(wrapperSrc, 'FullscreenChromeClient');
  if (ours.error) return { error: `the wrapper: ${ours.error}` };
  const bySig = new Map(ours.methods.map((m) => [m.sig, m]));
  const missing = [], notForwarded = [];
  for (const { name, sig } of wry.methods) {
    const mine = bySig.get(sig);
    if (!mine) missing.push(sig);
    else if (!HOSTED.includes(sig) && !new RegExp(`\\binner\\.${name}\\(`, 'u').test(mine.body)) notForwarded.push(sig);
  }
  return { wry: wry.methods.map((m) => m.sig), missing, notForwarded };
}

/** The whole check for `preflight android-env`: a list of problems. */
export function checkChromeClient(root, env = process.env) {
  const lockFile = join(root, 'src-tauri', 'Cargo.lock');
  let lock = '';
  try { lock = readFileSync(lockFile, 'utf8'); } catch { return [`cannot read ${lockFile}`]; }
  const versions = lockedWry(lock);
  if (versions.length !== 1) return [`Cargo.lock locks ${versions.length ? `${versions.length} wry versions (${versions.join(', ')})` : 'no wry'}; the chrome-client check needs exactly one`];
  const cargoHome = env.CARGO_HOME || join(homedir(), '.cargo');
  const file = wrySource(versions[0], cargoHome);
  if (!file) return [`wry ${versions[0]}'s Kotlin is not in ${join(cargoHome, 'registry', 'src')} (offline or vendored?) — run \`cargo fetch\` in src-tauri; the check does not skip`];
  let wrapper = '';
  try { wrapper = readFileSync(join(root, WRAPPER), 'utf8'); } catch { return [`cannot read ${WRAPPER}`]; }
  const r = uncovered(readFileSync(file, 'utf8'), wrapper);
  if (r.error) return [r.error];
  const problems = [];
  if (r.missing.length) problems.push(`wry ${versions[0]} overrides ${r.missing.join(', ')} in RustWebChromeClient, and ${WRAPPER} does not override that signature — the wrapper would drop it`);
  if (r.notForwarded.length) problems.push(`${WRAPPER} overrides ${r.notForwarded.join(', ')} without calling inner.<name>(…) in that method — wry's behaviour would be lost`);
  return problems;
}
