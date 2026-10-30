// ---------------------------------------------------------------------------
// Structural locators: find a patch site by its role in the parsed program
// instead of by the text around it.
//
// A regex anchor pins token order and adjacency, and those are exactly what
// upstream edits change: a prop joins a destructure, a call gains an argument,
// a statement moves into a new block. Minification meanwhile erases only what
// a syntax tree abstracts away anyway (local names, formatting) and keeps what
// a structural query reads (property keys, string literals, nesting). So a
// locator here finds a cheap invariant token, parses only the unit enclosing
// it, and matches by role and by key SET, ignoring order and extra keys.
//
// Parsing stays local because the whole ~5MB bundle costs ~0.5s and ~200MB of
// tree per pass, while the function or class around a token parses in a few
// ms. Edits stay textual: insertions at node offsets, which the caller wraps
// in its markers, so stripping the markers restores the stock bytes exactly
// and nothing is ever regenerated from the tree.
//
// acorn ships vendored in assets/acorn (the VSIX carries no node_modules), so
// it is loaded relative to this file on first use. Without it every structural
// locator finds nothing, and its point reports missing rather than guessing.
// ---------------------------------------------------------------------------
import * as path from "path";
import type * as acorn from "acorn";

type Acorn = typeof acorn;

// A parsed node plus the parent link a walk records. Typed loosely on purpose:
// queries read child keys by name, which a precise node union only obstructs.
export interface N {
  type: string;
  start: number;
  end: number;
  parent?: N | null;
  [key: string]: any;
}

// One insertion into the source: `text` goes in at offset `pos`.
export interface Edit {
  pos: number;
  text: string;
}

let acornApi: Acorn | null | undefined;

export function loadAcorn(): Acorn | null {
  if (acornApi === undefined) {
    try {
      const a = require(
        path.join(__dirname, "..", "assets", "acorn", "acorn.js"),
      ) as Acorn;
      // acorn's raise() suffixes "(line:column)", counted by scanning the
      // input from its start to the error, which costs ~10ms per failed probe
      // deep in a ~5MB bundle. A failed parse here only ever means "no unit
      // starts here", so the error goes out bare. This copy is private to the
      // extension, so nothing else sees the change.
      const bare = (pos: number, message: string): never => {
        throw Object.assign(new SyntaxError(message), { pos });
      };
      const proto = a.Parser.prototype as unknown as Record<string, unknown>;
      proto.raise = bare;
      proto.raiseRecoverable = bare;
      acornApi = a;
    } catch {
      acornApi = null;
    }
  }
  return acornApi;
}

// The first child on an expression's left edge, which starts where it does.
function leftEdge(n: N): N | null {
  switch (n.type) {
    case "SequenceExpression":
      return n.expressions[0];
    case "CallExpression":
      return n.callee;
    case "MemberExpression":
      return n.object;
    case "TaggedTemplateExpression":
      return n.tag;
    case "BinaryExpression":
    case "LogicalExpression":
    case "AssignmentExpression":
      return n.left;
    case "ConditionalExpression":
      return n.test;
    default:
      return null;
  }
}

// The node of the wanted kind that starts exactly at `pos`, or null. acorn
// reads on past the unit when the source continues the expression
// (`function(){},b` parses as a sequence, a declaration followed by `(` as a
// call), so the unit is dug out of the parse's left edge. It comes back with
// parent links throughout, so bindingSite can climb from any node in it
// however the caller's own walks prune.
export function parseUnitAt(
  c: string,
  pos: number,
  kind: (n: N) => boolean,
): N | null {
  const a = loadAcorn();
  if (!a) return null;
  let root: N;
  try {
    root = a.parseExpressionAt(c, pos, {
      ecmaVersion: "latest",
    }) as unknown as N;
  } catch {
    return null;
  }
  for (let n: N | null = root; n && n.start === pos; n = leftEdge(n)) {
    if (kind(n)) {
      n.parent = null;
      walk(n, () => {});
      return n;
    }
  }
  return null;
}

// Depth-first over every node under `root`, recording each child's parent as
// it descends. `visit` returning false skips that node's children. Walking a
// subtree again rewrites the same links, so nested walks are safe.
export function walk(root: N, visit: (n: N) => boolean | void): void {
  const stack: N[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (visit(n) === false) continue;
    for (const k in n) {
      if (k === "parent") continue;
      const v = n[k];
      if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) {
          const x = v[i];
          if (x && typeof x.type === "string") {
            x.parent = n;
            stack.push(x);
          }
        }
      } else if (v && typeof v === "object" && typeof v.type === "string") {
        v.parent = n;
        stack.push(v);
      }
    }
  }
}

export const isFn = (n: N | null | undefined): boolean =>
  !!n &&
  (n.type === "FunctionDeclaration" ||
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression");

export const isClass = (n: N | null | undefined): boolean =>
  !!n && (n.type === "ClassExpression" || n.type === "ClassDeclaration");

export const idName = (n: N | null | undefined): string | null =>
  n && n.type === "Identifier" ? n.name : null;

// A string literal with exactly this value.
export const isStr = (n: N | null | undefined, s: string): boolean =>
  !!n && n.type === "Literal" && n.value === s;

// A plain member access's property name (`a.b` gives "b").
export function memberProp(n: N | null | undefined): string | null {
  return n && n.type === "MemberExpression" && !n.computed
    ? idName(n.property)
    : null;
}

// `obj.prop` with `obj` an identifier named `obj`.
export function isMember(
  n: N | null | undefined,
  obj: string,
  prop: string,
): boolean {
  return memberProp(n) === prop && idName(n!.object) === obj;
}

// `obj.method()` with no arguments.
export function isCallOf(
  n: N | null | undefined,
  obj: string,
  method: string,
): boolean {
  return (
    !!n &&
    n.type === "CallExpression" &&
    n.arguments.length === 0 &&
    isMember(n.callee, obj, method)
  );
}

// Whether `obj.method()` is called anywhere under `root`, nested functions
// excluded.
export function callsOf(root: N, obj: string, method: string): boolean {
  let hit = false;
  walkOwn(root, (n) => {
    if (hit) return false;
    if (isCallOf(n, obj, method)) hit = true;
  });
  return hit;
}

// The function of the method named `name` in a parsed class that spans
// offset `at`, or null.
export function methodAt(cls: N, name: string, at: number): N | null {
  for (const m of cls.body.body as N[]) {
    if (
      m.type === "MethodDefinition" &&
      !m.computed &&
      idName(m.key) === name &&
      m.value.start <= at &&
      at < m.value.end
    )
      return m.value;
  }
  return null;
}

// walk, without entering the functions nested under `root`.
export function walkOwn(root: N, visit: (n: N) => boolean | void): void {
  walk(root, (n) => (n !== root && isFn(n) ? false : visit(n)));
}

// The key of an object literal or pattern property; null for spreads, rests
// and computed keys.
export function keyName(p: N): string | null {
  if (p.type !== "Property" || p.computed) return null;
  if (p.key.type === "Identifier") return p.key.name;
  return p.key.type === "Literal" ? String(p.key.value) : null;
}

export function propOf(obj: N, key: string): N | null {
  return obj.properties.find((p: N) => keyName(p) === key) ?? null;
}

// An object literal or pattern carrying every key in `keys`, whatever their
// order and whatever else it carries.
export function hasKeys(obj: N | null | undefined, keys: string[]): boolean {
  if (!obj || (obj.type !== "ObjectExpression" && obj.type !== "ObjectPattern"))
    return false;
  const have = new Set(obj.properties.map(keyName));
  return keys.every((k) => have.has(k));
}

// The plain local a destructured key binds, past any default (`{context:J}`
// gives "J", `{language:Z="plaintext"}` gives "Z").
export function boundName(pattern: N, key: string): string | null {
  const p = propOf(pattern, key);
  if (!p) return null;
  return idName(p.value.type === "AssignmentPattern" ? p.value.left : p.value);
}

// The insertion that appends one property to an object literal or pattern:
// after the last property, or ahead of a trailing rest element, which must
// stay last.
export function appendProp(obj: N, prop: string): Edit {
  const ps: N[] = obj.properties;
  const last = ps[ps.length - 1];
  if (!last) return { pos: obj.start + 1, text: prop };
  if (last.type === "RestElement") return { pos: last.start, text: `${prop},` };
  return { pos: last.end, text: `,${prop}` };
}

// The nearest unit around offset `at` that starts with `keyword` and parses as
// `kind`. Backs off over the keyword's earlier occurrences (skipping ones
// inside an identifier, a `function` that is not followed the way the keyword
// is, as in `typeof x==="function"`, and ones where nothing of that kind
// parses) until a parse spans `at`, and never escalates past that first
// enclosing unit, so a token in the wrong place costs one parse rather than a
// climb through ever larger functions. An `async function` is parsed from its
// `async`, where an `await` inside it is legal. `reach` bounds how far back the
// unit may start, and `maxTries` how many of the keyword's occurrences it
// parses (raise it for a token that sits past many nested functions of the
// unit it needs).
export function unitAround(
  c: string,
  at: number,
  keyword: string,
  kind: (n: N) => boolean,
  reach: number,
  maxTries = 8,
): N | null {
  for (let j = at, tries = 0; tries < maxTries;) {
    j = c.lastIndexOf(keyword, j - 1);
    if (j < 0 || at - j > reach) return null;
    if (j > 0 && /[\w$]/.test(c[j - 1])) continue;
    if (keyword === "function" && !/[\s(*]/.test(c[j + 8] ?? "")) continue;
    tries++;
    const start =
      keyword === "function" && c.slice(Math.max(0, j - 6), j) === "async "
        ? j - 6
        : j;
    const n = parseUnitAt(c, start, kind);
    if (n && n.end > at) return n;
  }
  return null;
}

// Every distinct unit enclosing an occurrence of `token` (see unitAround). An
// occurrence inside a unit already found is not parsed again.
export function unitsWith(
  c: string,
  token: string,
  keyword: string,
  kind: (n: N) => boolean,
  reach: number,
  maxTries = 8,
): N[] {
  const found: N[] = [];
  for (let i = c.indexOf(token); i >= 0; i = c.indexOf(token, i + 1)) {
    if (found.some((u) => u.start <= i && i < u.end)) continue;
    const n = unitAround(c, i, keyword, kind, reach, maxTries);
    if (n) found.push(n);
  }
  return found;
}

// Whether a binding pattern introduces `name`.
function patternBinds(p: N | null | undefined, name: string): boolean {
  if (!p) return false;
  switch (p.type) {
    case "Identifier":
      return p.name === name;
    case "ObjectPattern":
      return p.properties.some((q: N) =>
        patternBinds(q.type === "RestElement" ? q.argument : q.value, name),
      );
    case "ArrayPattern":
      return p.elements.some((q: N | null) => patternBinds(q, name));
    case "AssignmentPattern":
      return patternBinds(p.left, name);
    case "RestElement":
      return patternBinds(p.argument, name);
    default:
      return false;
  }
}

// Whether `name` is var-declared, or declared as a function, anywhere in a
// function body outside nested functions (both hoist to the function scope).
function hoistsInto(body: N, name: string): boolean {
  let hit = false;
  walk(body, (n) => {
    if (hit) return false;
    if (n !== body && isFn(n)) {
      if (n.type === "FunctionDeclaration" && n.id?.name === name) hit = true;
      return false;
    }
    if (
      n.type === "VariableDeclaration" &&
      n.kind === "var" &&
      n.declarations.some((d: N) => patternBinds(d.id, name))
    )
      hit = true;
  });
  return hit;
}

// Whether scope node `s` itself binds `name`.
function bindsHere(s: N, name: string): boolean {
  if (isFn(s)) {
    if (s.params.some((p: N) => patternBinds(p, name))) return true;
    if (s.type === "FunctionExpression" && s.id?.name === name) return true;
    return s.body.type === "BlockStatement" && hoistsInto(s.body, name);
  }
  if (s.type === "BlockStatement" || s.type === "StaticBlock") {
    return s.body.some(
      (st: N) =>
        (st.type === "VariableDeclaration" &&
          st.kind !== "var" &&
          st.declarations.some((d: N) => patternBinds(d.id, name))) ||
        (st.type === "ClassDeclaration" && st.id?.name === name),
    );
  }
  if (s.type === "CatchClause") return patternBinds(s.param, name);
  if (
    s.type === "ForStatement" ||
    s.type === "ForInStatement" ||
    s.type === "ForOfStatement"
  ) {
    const d = s.type === "ForStatement" ? s.init : s.left;
    return (
      !!d &&
      d.type === "VariableDeclaration" &&
      d.kind !== "var" &&
      d.declarations.some((x: N) => patternBinds(x.id, name))
    );
  }
  return false;
}

// The scope node that binds `name` as seen from `at`, walking out through
// blocks and functions up to and including `stop`; null when the binding lies
// beyond `stop`. Parent links must come from a walk that covered `stop`.
export function bindingSite(at: N, name: string, stop: N): N | null {
  for (let s = at.parent; s; s = s.parent) {
    if (bindsHere(s, name)) return s;
    if (s === stop) return null;
  }
  return null;
}

// Apply insertions to the source. Edits at one offset land in list order.
export function applyEdits(c: string, edits: Edit[]): string {
  const order = edits
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.pos - a.e.pos || b.i - a.i);
  let out = c;
  for (const { e } of order)
    out = out.slice(0, e.pos) + e.text + out.slice(e.pos);
  return out;
}

// Where offset `pos` of the source lands once `edits` are applied. Text
// inserted at a unit's first offset lands before the unit and text inserted at
// its (exclusive) end lands after it, so pass `inclusive` for a start, which
// those edits push along, and not for an end, which they leave alone.
export function shiftedPos(
  pos: number,
  edits: Edit[],
  inclusive: boolean,
): number {
  let d = 0;
  for (const e of edits) {
    if (e.pos < pos || (inclusive && e.pos === pos)) d += e.text.length;
  }
  return pos + d;
}

// Whether each unit still parses, as the same kind, from its place in the
// edited source to exactly where the edits move its end: the check that no
// insertion broke the syntax around it.
export function unitsReparse(
  out: string,
  edits: Edit[],
  units: [N, (n: N) => boolean][],
): boolean {
  return units.every(([u, kind]) => {
    const n = parseUnitAt(out, shiftedPos(u.start, edits, true), kind);
    return !!n && n.end === shiftedPos(u.end, edits, false);
  });
}
