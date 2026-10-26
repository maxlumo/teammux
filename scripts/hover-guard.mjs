// Hover is a pointer's paint, press is a finger's (board #392).
//
// A phone has no pointer to leave: Chrome and WebView apply `:hover` on a TAP and keep it until
// the next tap elsewhere, so every control with a hover wash stays washed after the finger lifts —
// a full-width Settings row stayed a grey slab (measured: `:hover` still true 1.5 s after the tap,
// no further input, touch emulation with `hover: none`). The design language already says "hover is
// never the only affordance (phones exist)"; this plugin makes that hold for every rule at once,
// at the one place all CSS passes through, instead of 45 hand-edited rules that a 46th forgets.
//
//   1. GUARD. A rule whose selector has `:hover` is wrapped in `@media (hover: hover), (pointer: none)`: it
//      applies where the primary input can hover (or there is no pointing device), and nowhere else.
//      A selector list is split, so its non-hover members keep applying everywhere; `:is(:hover, .cur)`
//      becomes `.cur` (always) and `:hover` (guarded) — `.cur` is a state, not a pointer.
//   2. PRESS. A guarded rule that only repaints its subject (colour, background, border colour, shadow,
//      filter, a paint variable) also gets its `:active` twin, unguarded, right after it: what a mouse
//      shows on hover a finger shows while it presses, and only then. A selector that already has an
//      `:active` rule of its own keeps it; a rule that REVEALS or MOVES something (opacity, display,
//      transform, a hover-revealed action) is guarded and not twinned — a press must not make controls jump.
//
// SELECTORS ARE READ WITH css-tree's parser, not with regular expressions (the first cut was a first-match
// rewriter and the review found four shapes it let through). The accepted shapes are few and every other
// one THROWS naming the selector, so a new shape is a build error to read, never a sticky hover that
// slipped through: exactly one `:hover` per selector, either in a plain compound or as a member of ONE flat
// `:is()` / `:where()` that is a direct part of the selector, whose alternatives are plain classes and
// argument-less pseudo-classes of the same weight as `:hover` (so splitting cannot change the rule's
// specificity). A media rule counts as an existing guard only when it is EXACTLY a known hover guard;
// any other media condition (a negation, an OR with another query) is not trusted and the rule is
// guarded again inside it, which is always correct.
import postcss from 'postcss';
import { generate, parse, walk } from 'css-tree';

const GUARD = '(hover: hover), (pointer: none)';
const PAINT = /^(background(-color|-image)?|border-(top|right|bottom|left)?-?color|color|box-shadow|filter|outline-color|--[\w-]*(paint|fill|overlay)[\w-]*)$/u;

const parseSelector = (text) => parse(text, { context: 'selector' });
const isPseudo = (node, name) => node.type === 'PseudoClassSelector' && node.name.toLowerCase() === name;
const fnName = (node) => node.name.toLowerCase();

/** Every `:hover` in a selector with the functional pseudo-classes around it (outermost first). css-tree's own
 * walk reaches every node, including an `:nth-child(2n of :hover)` argument that hangs off `Nth.selector`. */
function hoverSites(ast) {
  const sites = [];
  const stack = [];
  walk(ast, {
    enter(node) {
      if (isPseudo(node, 'hover')) sites.push({ node, chain: stack.map(fnName), fn: stack.at(-1) ?? null });
      if (node.type === 'PseudoClassSelector' && node.children) stack.push(node);
    },
    leave(node) {
      if (node.type === 'PseudoClassSelector' && node.children && stack.at(-1) === node) stack.pop();
    },
  });
  return sites;
}

/** A group alternative the split may move: classes and argument-less pseudo-classes only (a type, an id,
 * an attribute, a combinator or a function would change what the alternative weighs). */
const plainAlternative = (selector) => selector.type === 'Selector'
  && selector.children.size > 0
  && selector.children.toArray().every((n) => n.type === 'ClassSelector' || (n.type === 'PseudoClassSelector' && !n.children));

/**
 * One selector -> { hover: [...], rest: [...] }: which parts a pointer owns, which stay everywhere.
 * Anything it cannot move without changing what the rule matches, or how strongly, throws.
 */
export function splitSelector(selector) {
  const ast = parseSelector(selector);
  const sites = hoverSites(ast);
  if (sites.length === 0) return { hover: [], rest: [selector] };
  if (sites.length > 1) throw new Error(`hover-guard: more than one ':hover' in a selector cannot be guarded: ${selector}`);
  const { node, chain, fn } = sites[0];
  if (chain.length === 0) return { hover: [selector], rest: [] };
  const flatGroup = chain.length === 1 && (chain[0] === 'is' || chain[0] === 'where');
  if (!flatGroup) throw new Error(`hover-guard: ':hover' inside ':${chain.join('(:')}()' cannot be guarded: ${selector}`);
  const list = fn.children.first;                                    // the SelectorList of the group
  if (!list || list.type !== 'SelectorList' || fn.children.size !== 1) throw new Error(`hover-guard: ':${chain[0]}()' with an unexpected argument cannot be guarded: ${selector}`);
  const alternatives = list.children.toArray();
  for (const a of alternatives) if (!plainAlternative(a)) throw new Error(`hover-guard: ':${chain[0]}()' alternative '${generate(a)}' is not plain classes and pseudo-classes, so splitting it could change the rule's specificity: ${selector}`);
  const owned = alternatives.filter((a) => a.children.toArray().includes(node));
  const kept = alternatives.filter((a) => !owned.includes(a));
  if (alternatives.some((a) => a.children.size !== owned[0].children.size)) throw new Error(`hover-guard: the alternatives of ':${chain[0]}()' differ in specificity, so splitting would change it: ${selector}`);
  const emit = (members) => { list.children.fromArray(members); return generate(ast); };
  const hover = emit(owned);
  const rest = kept.length ? [emit(kept)] : [];
  list.children.fromArray(alternatives);
  return { hover: [hover], rest };
}

/** The :active twin of a hover selector the split produced, or null when it is not a plain repaint of the subject. */
function pressTwin(hoverSelector) {
  const ast = parseSelector(hoverSelector);
  const [site] = hoverSites(ast);
  const top = ast.children.toArray();
  const lastCombinator = top.map((n) => n.type).lastIndexOf('Combinator');
  const subject = top.slice(lastCombinator + 1);
  const owner = site.fn ?? site.node;                                // the group, or the :hover itself
  if (!subject.includes(owner)) return null;                          // the hover sits on an ancestor, not on the subject
  if (subject.some((n) => n.type === 'PseudoElementSelector')) return null;
  site.node.name = 'active';
  return generate(ast);
}

/** A media rule that IS a hover guard, exactly. Anything else (not (hover: hover), or an OR with another query) is not trusted. */
const KNOWN_GUARDS = new Set(['(hover:hover)', '(any-hover:hover)', generate(parse(GUARD, { context: 'mediaQueryList' }))]);
function isGuardMedia(params) {
  try { return KNOWN_GUARDS.has(generate(parse(params, { context: 'mediaQueryList' }))); } catch { return false; }
}

function insideGuard(node) {
  for (let p = node.parent; p; p = p.parent) if (p.type === 'atrule' && p.name === 'media' && isGuardMedia(p.params)) return true;
  return false;
}

const hasHover = (selector) => hoverSites(parseSelector(selector)).length > 0;
const normal = (selector) => generate(parseSelector(selector));

export function hoverGuard() {
  return {
    postcssPlugin: 'teammux-hover-guard',
    Once(root) {
      // every selector that already has an :active rule of its own
      const pressed = new Set();
      root.walkRules((rule) => { for (const s of rule.selectors) if (/:active(?![\w-])/u.test(s)) pressed.add(normal(s)); });
      const rules = [];
      root.walkRules((rule) => { if (rule.selectors.some(hasHover) && !insideGuard(rule) && !(rule.parent?.type === 'atrule' && /keyframes$/u.test(rule.parent.name))) rules.push(rule); });
      for (const rule of rules) {
        const hover = []; const rest = [];
        for (const s of rule.selectors) { const r = splitSelector(s); hover.push(...r.hover); rest.push(...r.rest); }
        const guarded = rule.clone({ selectors: hover });
        const media = postcss.atRule({ name: 'media', params: GUARD });
        media.append(guarded);
        if (rest.length) { rule.selectors = rest; rule.after(media); } else rule.replaceWith(media);
        // the finger's twin
        const repaintsOnly = guarded.nodes.length > 0 && guarded.nodes.every((d) => d.type === 'decl' && PAINT.test(d.prop));
        if (!repaintsOnly) continue;
        const twins = hover.map(pressTwin);
        if (twins.some((t) => t === null)) continue;
        const wanted = twins.filter((s) => !pressed.has(normal(s)));
        if (!wanted.length) continue;
        media.after(guarded.clone({ selectors: wanted }));
      }
    },
  };
}
hoverGuard.postcss = true;
