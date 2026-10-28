import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import {
  type Edit,
  type N,
  appendProp,
  applyEdits,
  bindingSite,
  boundName,
  callsOf,
  hasKeys,
  idName,
  isCallOf,
  isClass,
  isFn,
  isMember,
  isStr,
  keyName,
  memberProp,
  methodAt,
  parseUnitAt,
  propOf,
  unitAround,
  unitsReparse,
  unitsWith,
  walk,
  walkOwn,
} from "./derive";

// The installed Claude Code extension is laid down as one directory per
// version/platform, e.g. anthropic.claude-code-2.1.200-darwin-arm64. We patch
// three bundled files inside it: extension.js (the plan-mode preview webview
// template), webview/index.css (the chat code-block font, which no setting
// reaches), and webview/index.js (the chat Edit-diff card: a Monaco diff editor
// with a hardcoded font size, line-numbers off, and a forced dark theme).
const EXT_PREFIX = "anthropic.claude-code-";
const MARKER_FILE = "extension.js"; // must exist for a dir to count as an install

const CONFIG_NS = "claudeCodeUiPatch";

// Stock-value capture: the real native font-size values are read from the
// fresh (unpatched) bundle and persisted in globalState, keyed by Claude Code
// version. Restore uses these captured values instead of the hardcoded
// originalPx/originalValue constants, so it always matches the actual native
// behavior even if a future bundle changes its stock sizes.
const STOCK_VERSION_KEY = "claudeCodeUiPatch.stockVersion";
const STOCK_VALUES_KEY = "claudeCodeUiPatch.stockValues";
export type StockCapture = Record<string, string>;

export const MIN_PX = 6;
export const MAX_PX = 48;
export const STEP = 0.25;

// Trailing debounce for the disk apply pass: long enough to fold a burst of
// config events (rapid panel clicks, a multi-key settings.json save) into one
// pass, short enough to be invisible on a lone change.
const APPLY_DEBOUNCE_MS = 100;
// Settle time for the extension-root watchers: an auto-update extracts a new
// versioned directory over several events, so wait for the burst to end
// before re-running the apply pass against it.
const EXT_WATCH_SETTLE_MS = 2000;

// Bold-weight knob. CSS font-weight moves in hundreds, so the knob steps by 100
// rather than by STEP. The floor is the regular weight (a "bold" lighter than
// the body text is not what this knob is for) and the ceiling is 900, the
// heaviest weight CSS names. NATIVE_BOLD_WEIGHT is what a browser computes for
// <strong> against a 400 parent, so it is both the "off" display value and the
// value that writes no rule.
export const MIN_WEIGHT = 400;
export const MAX_WEIGHT = 900;
export const WEIGHT_STEP = 100;
export const NATIVE_BOLD_WEIGHT = 700;

export type Section =
  "Chat Panel or Tab" | "Plan Mode Markdown Preview" | "Behavior";
export const SECTION_ORDER: Section[] = [
  "Chat Panel or Tab",
  "Plan Mode Markdown Preview",
  "Behavior",
];

// Display order of knobs within a section (panel and popup), by point id. Ids
// not listed keep their natural order after the listed ones.
const KNOB_ORDER: string[] = [
  "chatHistorySize", // agent response
  "chatBoldWeight", // agent bold weight
  "chatText", // user message input (native chat.fontSize)
  "chatInputHistorySize", // user message history
  "chatCodeInline", // inline code
  "chatCode", // code block
  "diffCard",
  "diffLineNumbers",
  "diffThemeSync",
  "chatMath", // math rendering (KaTeX), grouped under the diff card settings
  "text", // plan agent response
  "planCodeInline", // plan inline code
  "code", // plan code block
  "preview", // plan comment quote
  "input", // plan comment composer
  "badge", // plan comment badge
  // Behavior, mirroring the README tree's order (alphabetical by settings key).
  "findBar", // in-chat find bar (Cmd/Ctrl+F)
  "histKeys", // input history recall on Cmd/Ctrl+Up/Down
  "jumpMsg", // jump to previous/next message
  "promptHist", // prompt history list
  "rawMd", // raw markdown of a response
  "scrollDot", // scroll-to-bottom dot
  "permCode",
  "permNoWrap",
  "effortSyncFix",
  "commentCtrlEnter", // plan comment send key
  "ctrlEnterEverywhere",
];
function knobOrder(id: string): number {
  const i = KNOB_ORDER.indexOf(id);
  return i < 0 ? KNOB_ORDER.length : i;
}

// Knobs computed into the snapshot but intentionally not shown in any UI surface
// (the panel and the status-bar tooltip alike). Hiding keeps a knob off both
// surfaces while its setting still applies and still counts toward the apply /
// reload state (that logic reads the toggle states, not this knob list). The
// effort-level indicator sync is a set-and-forget fix, not something to tune by
// hand. The plan comment send key is settings-only: the panel's "Cmd/Ctrl +
// Enter to send everywhere" row already reaches the plan comment box (the
// readToggles fold), so a dedicated row was noise.
export const HIDDEN_KNOBS = new Set<string>([
  "effortSyncFix",
  "commentCtrlEnter",
]);

// ---------------------------------------------------------------------------
// Native chat text size. NOT patched: Claude Code reads chat.fontSize and
// injects it live (it sizes the chat message text, the input box, and the token
// IN/OUT box). The panel exposes it with the same ▼/▲ controls as patch knobs;
// adjusting writes the native setting directly (applied live, no reload needed).
// External changes to chat.fontSize are reflected via onDidChangeConfiguration.
// (chat.editor.fontSize sizes only the chat input editor; the chat's rendered
// code block has no such lever, so it is a patch point below.)
// ---------------------------------------------------------------------------
interface NativeKnob {
  id: "chatText";
  label: string;
  vscodeKey: string;
  fallback: number;
}

const NATIVE_KNOBS: NativeKnob[] = [
  {
    id: "chatText",
    label: "user message input",
    vscodeKey: "chat.fontSize",
    fallback: 13,
  },
];

function nativePx(k: NativeKnob): number {
  const raw = vscode.workspace.getConfiguration().get<number>(k.vscodeKey);
  return typeof raw === "number" && raw > 0 ? raw : k.fallback;
}

// The native chat.fontSize, shown by the chatHistoryFontSize knob while it is
// inheriting (setting at 0), so the knob still reflects the effective size and a
// first ▲/▼ takes control from that value.
function nativeChatFontSizePx(): number {
  const raw = vscode.workspace.getConfiguration().get<number>("chat.fontSize");
  return typeof raw === "number" && raw > 0 ? raw : 13;
}

// The VS Code settings the native sizes of the patch points derive from (see
// PatchPoint.nativeSize), read once per snapshot. The two chat values are read
// the way Claude Code reads them, with its own fallbacks.
interface NativeEnv {
  chat: number; // chat.fontSize
  chatEditor: number; // chat.editor.fontSize
  editor: number; // editor.fontSize, which VS Code hands every webview
  agentText: number; // agent message text: chatHistoryFontSize, else chat.fontSize
}
function nativeEnv(): NativeEnv {
  const num = (section: string, key: string, dflt: number) => {
    const raw = vscode.workspace.getConfiguration(section).get<number>(key);
    return typeof raw === "number" && raw > 0 ? raw : dflt;
  };
  const chat = nativeChatFontSizePx();
  const agent = readInject(
    INJECT_POINTS.find((p) => p.id === "chatHistorySize")!,
  );
  return {
    chat,
    chatEditor: num("chat.editor", "fontSize", 12),
    editor: num("editor", "fontSize", 12),
    agentText: typeof agent === "number" ? agent : chat,
  };
}

// ---------------------------------------------------------------------------
// Patch points (edits inside bundled files).
//   style "number": swap a bare px number in place (pinned value / hardcoded).
//   style "value":  swap a whole value that is either a stock var(...) or an
//     absolute Npx we substituted (decouples from a live var).
//   custom (fn*):   a self-contained transform for a spot the value-slot model
//     can't express (the chat code block, scoped via appended CSS).
// ---------------------------------------------------------------------------
interface PatchPoint {
  id: string;
  section: Section;
  label: string;
  key: string; // settings sub-key under the claudeCodeUiPatch namespace; 0 = native
  maxPx: number; // clamp for ▲/▼ adjust
  file: string; // path relative to the install dir
  // The own slot's stock px: the number-style restore target, its native size,
  // and the setting's default before 1.6.0, when a value equal to it still
  // meant native (see migrateSizeDefaults).
  originalPx: number;
  // What Claude Code renders natively on this bundle, which the panel shows
  // while the setting is 0 (so a first ▲/▼ takes control from it) and the live
  // preview renders. `alt` says the alternate form serves the bundle (see
  // AltForm), and `stock` is the own slot's stock px, captured or originalPx.
  nativeSize: (alt: boolean, env: NativeEnv, stock: number) => number;
  style?: "number" | "value";
  originalValue?: string; // value-style restore target
  res?: RegExp[]; // value-slot regexes, each capturing (prefix)(value)(suffix)
  // Custom transform (used when fnApply is present):
  fnPresent?: (c: string) => boolean;
  // The px in place, undefined at native (a number-style slot reads its stock).
  fnCurrentPx?: (c: string) => string | undefined;
  fnApply?: (c: string, px: string) => string;
  fnRestore?: (c: string) => string;
  // A newer native form the slot model above cannot express (see AltForm).
  alt?: AltForm;
}

// A second native form for a point whose value slot (res or fn*) is gone from a
// newer build. Claude Code 2.1.300 sizes the plan preview off chat.fontSize and
// the diff card off chat.editor.fontSize, so the literal a point used to swap in
// place became an expression the bundle re-reads live. There the knob pins its
// px with a marker-delimited insertion that leaves the native code in place:
// restore is a strip that gives back the native bytes exactly, with no captured
// stock value, and the knob's own default still means native. It serves only
// where the point's own anchors find nothing, so every build they serve patches
// exactly as before.
interface AltForm {
  marked: (c: string) => boolean; // carries this form's fragments
  strip: (c: string) => string; // drop every fragment this form inserted
  present: (c: string) => boolean; // anchor found, in an unmarked bundle
  currentPx: (c: string) => string | undefined; // the pin, undefined = native
  apply: (c: string, px: string) => string; // pin px, into an unmarked bundle
}

// A string's characters as a literal regex source.
function reLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// Chat code block. Scoped to the chat message DOM (hovers/tooltips untouched)
// by appending a CSS rule to webview/index.css that overrides the font ONLY
// inside chat code-block wrappers (.codeBlockWrapper_<hash>) AND inline code
// (.root_<hash> code, the markdown renderer's code spans). The stock wrapper
// rule sets no font-size and inline code is 0.9em of chat.fontSize, so pinning
// both to the same px keeps inline and fenced code matched. The markdown module
// exposes both classes under one CSS-module hash, so `.root_<hash>` reuses the
// hash read from the wrapper rule. A scoped !important rule wins by specificity.
// The hash changes per build, so we read it at patch time; originalPx is
// approximate (em-relative; ~11px at the default chat.fontSize of 13) and unused
// by the css-style logic.
const CHAT_CODE_MARKER = "/*cc-ui-patch:chatCode*/";
const CHAT_CODE_WRAP_RE = /\.codeBlockWrapper_[-\w]+ pre\s*\{/;
const CHAT_CODE_HASH_RE = /\.codeBlockWrapper_([-\w]+) pre\s*\{/;
const CHAT_CODE_LINE_RE = /\n?\/\*cc-ui-patch:chatCode\*\/[^\n]*/;

function applyChatCodeCss(css: string, px: string): string {
  const hash = css.match(CHAT_CODE_HASH_RE)?.[1];
  if (!hash) return css; // wrapper rule gone (version changed): nothing to anchor
  const line = `\n${CHAT_CODE_MARKER}.codeBlockWrapper_${hash} pre,.codeBlockWrapper_${hash} pre code,.root_${hash} code{font-size:${px}px !important}`;
  return css.includes(CHAT_CODE_MARKER)
    ? css.replace(CHAT_CODE_LINE_RE, line)
    : css + line;
}

// Chat Edit-diff card font. The Edit/MultiEdit tool body renders a read-only
// Monaco diff editor whose options hardcode fontSize:12 (no setting reaches it).
// We rewrite the number in both createDiffEditor option blocks (the inline card
// and the expand modal) in webview/index.js. The anchor keys off the stable
// `,lineNumbers:"` that follows the size, so it composes with the line-number
// and theme toggles below (whichever of them is on, this still matches). The /g
// flag patches both sites in one pass; the size is a bare JS number, not px.
const DIFF_FONT_STOCK = 12;
const DIFF_FONT_RE = /(fontSize:)(\d+(?:\.\d+)?)(,lineNumbers:")/g;

function diffFontPresent(c: string): boolean {
  DIFF_FONT_RE.lastIndex = 0;
  return DIFF_FONT_RE.test(c);
}
// The size in the bundle, the stock 12 included: a bare number reads the same
// whether it is native or pinned at that number (the point is number-style).
function diffFontCurrent(c: string): string | undefined {
  DIFF_FONT_RE.lastIndex = 0;
  return DIFF_FONT_RE.exec(c)?.[2];
}
function diffFontSet(c: string, px: string): string {
  return c.replace(DIFF_FONT_RE, (_w, p, _v, s) => `${p}${px}${s}`);
}
function diffFontRestore(c: string): string {
  return c.replace(
    DIFF_FONT_RE,
    (_w, p, _v, s) => `${p}${DIFF_FONT_STOCK}${s}`,
  );
}

// Claude Code 2.1.300 and later create both diff editors with fontSize:<S>(),
// where S reads --app-monospace-font-size (set from chat.editor.fontSize), and a
// subscriber re-applies <E>.subscribe((v)=>editor.updateOptions({fontSize:v}))
// to both on every chat font setting change, fed by E.emit(S()). Pinning only
// the two option blocks would snap back on the first such change, so the pin
// goes in at all three sites as fontSize:<pin>N||<end><native>: the || returns N
// without evaluating the native expression. The sites are required together
// (two option blocks calling one S, one subscriber, its emitter fed S()), so a
// pin can never land on only some of them.
const DIFF_PIN = "/*ccup:diffFont*/";
const DIFF_PIN_END = "/*ccup:diffFontEnd*/";
const DIFF_PIN_FRAG_RE =
  /\/\*ccup:diffFont\*\/[\d.]*\|\|\/\*ccup:diffFontEnd\*\//g;
const DIFF_PIN_PX_RE =
  /\/\*ccup:diffFont\*\/(\d+(?:\.\d+)?)\|\|\/\*ccup:diffFontEnd\*\//g;
const DIFF_SIZE_CALL_RE = /(fontSize:)(([\w$]+)\(\),lineNumbers:")/g;
// Ends right after `fontSize:`, the subscriber's insertion point. It starts at
// its literal, since a leading identifier capture makes the engine try every
// offset of the bundle (about 95ms a scan, against 2ms); the emitter is read
// off the text just before the match instead.
const DIFF_SIZE_SUB_RE =
  /\.subscribe\(\(([\w$]+)\)=>[\w$]+\.updateOptions\(\{fontSize:(?=\1\}\)\))/g;

const DIFF_FONT_ALT: AltForm = {
  marked: (c) => c.includes(DIFF_PIN),
  strip: (c) => (c.includes(DIFF_PIN) ? c.replace(DIFF_PIN_FRAG_RE, "") : c),
  present: (c) => {
    const calls = [...c.matchAll(DIFF_SIZE_CALL_RE)];
    const subs = [...c.matchAll(DIFF_SIZE_SUB_RE)];
    if (calls.length !== 2 || calls[0][3] !== calls[1][3] || subs.length !== 1)
      return false;
    const at = subs[0].index ?? 0;
    const emitter = /[\w$]+$/.exec(c.slice(Math.max(0, at - 64), at))?.[0];
    return !!emitter && c.includes(`${emitter}.emit(${calls[0][3]}())`);
  },
  // A partial or mixed pin reads as neither pinned nor native, so the next
  // apply rebuilds it.
  currentPx: (c) => {
    const px = [...c.matchAll(DIFF_PIN_PX_RE)].map((m) => m[1]);
    if (!px.length) return undefined;
    return px.length === 3 && px.every((v) => v === px[0]) ? px[0] : "mixed";
  },
  apply: (c, px) => {
    const pin = `${DIFF_PIN}${px}||${DIFF_PIN_END}`;
    return c
      .replace(DIFF_SIZE_CALL_RE, (_w, key, rest) => `${key}${pin}${rest}`)
      .replace(DIFF_SIZE_SUB_RE, (w) => `${w}${pin}`);
  },
};

// Claude Code 2.1.300 and later size the plan preview off chat.fontSize: prose
// is var(--plan-font-size) (1px above the chat text), the comment popup's sizes
// are calc(var(--plan-font-size) - Npx), code is
// var(--claude-chat-editor-font-size, 13px), and the host pushes both values
// live. With no px left to swap, a knob pins its element by adding its own
// declaration right after the native one in the same rule (the later one wins).
// The rule is found by its selector and its font-size declaration, whatever
// that declaration's value, and must be unique.
const PLAN_PIN_END = "/*ccup:planSizeEnd*/";

function planPin(mark: string, selector: string): AltForm {
  const decl = `${selector}[^}]*?font-size:[^;}]*;`;
  const ruleRe = new RegExp(decl, "g");
  const frag = (px: string) =>
    `${reLiteral(mark)}font-size:${px}px;${reLiteral(PLAN_PIN_END)}`;
  const fragRe = new RegExp(frag("[\\d.]+"), "g");
  const pxRe = new RegExp(decl + frag("(\\d+(?:\\.\\d+)?)"));
  return {
    marked: (c) => c.includes(mark),
    strip: (c) => (c.includes(mark) ? c.replace(fragRe, "") : c),
    present: (c) => (c.match(ruleRe)?.length ?? 0) === 1,
    // A fragment off its rule reads as neither pinned nor native, so the next
    // apply rebuilds it.
    currentPx: (c) =>
      c.match(pxRe)?.[1] ?? (c.includes(mark) ? "mixed" : undefined),
    apply: (c, px) =>
      c.replace(ruleRe, (w) => `${w}${mark}font-size:${px}px;${PLAN_PIN_END}`),
  };
}

const PATCH_POINTS: PatchPoint[] = [
  {
    id: "chatCode",
    section: "Chat Panel or Tab",
    label: "code block",
    key: "chatCodeBlockFontSize",
    maxPx: 24,
    file: "webview/index.css",
    originalPx: 11,
    // Natively the markdown root sets `code{font-size:.9em}` and the fenced
    // `pre` sets none, so block code is 0.9 of the agent text on every build.
    nativeSize: (_alt, env) => 0.9 * env.agentText,
    fnPresent: (c) => c.includes(CHAT_CODE_MARKER) || CHAT_CODE_WRAP_RE.test(c),
    // A pre-inline-code patch line lacks `.root_`; report it as not-current so the
    // reconcile upgrades it in place to the selector list that also covers inline
    // code (rather than leaving inline code at the stock 0.9em).
    fnCurrentPx: (c) => {
      const line = c.match(CHAT_CODE_LINE_RE)?.[0];
      if (!line || !line.includes(".root_")) return undefined;
      return line.match(/font-size:(\d+(?:\.\d+)?)px/)?.[1];
    },
    fnApply: (c, px) => applyChatCodeCss(c, px),
    fnRestore: (c) => c.replace(CHAT_CODE_LINE_RE, ""),
  },
  {
    id: "diffCard",
    section: "Chat Panel or Tab",
    label: "diff card",
    key: "chatDiffCardFontSize",
    maxPx: 24,
    file: "webview/index.js",
    originalPx: 12,
    nativeSize: (alt, env, stock) => (alt ? env.chatEditor : stock),
    // The own slot is a bare number swapped by the custom fns below.
    style: "number",
    fnPresent: diffFontPresent,
    fnCurrentPx: diffFontCurrent,
    fnApply: diffFontSet,
    fnRestore: diffFontRestore,
    alt: DIFF_FONT_ALT,
  },
  {
    id: "text",
    section: "Plan Mode Markdown Preview",
    label: "Claude's drafted plan",
    key: "planPreviewFontSize",
    maxPx: 24,
    file: "extension.js",
    originalPx: 14,
    // The own slot's var is one VS Code never sets in a webview, so its
    // fallback renders. The alternate form's offsets, here and in the comment
    // popup's points below, mirror the 2.1.300 template and only feed the panel.
    nativeSize: (alt, env, stock) => (alt ? env.chat + 1 : stock),
    style: "value",
    originalValue: "var(--vscode-markdown-font-size, 14px)",
    // Anchor on the plan-preview `body` rule's font-size, tolerating any
    // font-family value before it, so this composes with the planPreviewFontFamily
    // injection (which rewrites that same rule's font-family). extension.js has a
    // single `body {` rule, so this stays unambiguous.
    res: [
      /(body \{\s*font-family:[^;]+;\s*font-size:\s*)(var\(--vscode-markdown-font-size, \d+(?:\.\d+)?px\)|\d+(?:\.\d+)?px)(;)/,
    ],
    alt: planPin("/*ccup:planText*/", "body \\{"),
  },
  {
    id: "code",
    section: "Plan Mode Markdown Preview",
    label: "code block",
    key: "planPreviewCodeBlockFontSize",
    maxPx: 24,
    file: "extension.js",
    originalPx: 13,
    // VS Code hands every webview --vscode-editor-font-size, so the own slot's
    // fallback never renders.
    nativeSize: (alt, env) => (alt ? env.chatEditor : env.editor),
    style: "value",
    originalValue: "var(--vscode-editor-font-size, 13px)",
    res: [
      /(font-family: var\(--vscode-editor-font-family\);\s*font-size:\s*)(var\(--vscode-editor-font-size, \d+(?:\.\d+)?px\)|\d+(?:\.\d+)?px)(;)/,
    ],
    alt: planPin(
      "/*ccup:planCode*/",
      "code \\{\\s*font-family: var\\(--vscode-editor-font-family\\);",
    ),
  },
  {
    id: "preview",
    section: "Plan Mode Markdown Preview",
    label: "comment quote",
    key: "planPreviewCommentQuoteFontSize",
    maxPx: 24,
    file: "extension.js",
    originalPx: 12,
    nativeSize: (alt, env, stock) => (alt ? env.chat - 1 : stock),
    style: "number",
    res: [
      /(\.selected-text-preview\s*\{[^}]*?font-size:\s*)(\d+(?:\.\d+)?)(px)/,
    ],
    alt: planPin("/*ccup:planQuote*/", "\\.selected-text-preview\\s*\\{"),
  },
  {
    id: "input",
    section: "Plan Mode Markdown Preview",
    label: "comment input box",
    key: "planPreviewCommentInputFontSize",
    maxPx: 24,
    file: "extension.js",
    originalPx: 13,
    nativeSize: (alt, env, stock) => (alt ? env.chat : stock),
    style: "number",
    res: [
      /(#comment-input textarea\s*\{[^}]*?font-size:\s*)(\d+(?:\.\d+)?)(px)/,
    ],
    alt: planPin("/*ccup:planInput*/", "#comment-input textarea\\s*\\{"),
  },
  {
    id: "badge",
    section: "Plan Mode Markdown Preview",
    label: "comment badge",
    key: "planPreviewCommentBadgeFontSize",
    maxPx: 12,
    file: "extension.js",
    originalPx: 10,
    nativeSize: (alt, env, stock) => (alt ? env.chat - 3 : stock),
    style: "number",
    res: [/(\.comment-indicator\s*\{[^}]*?font-size:\s*)(\d+(?:\.\d+)?)(px)/],
    alt: planPin("/*ccup:planBadge*/", "\\.comment-indicator\\s*\\{"),
  },
];

// ---------------------------------------------------------------------------
// Toggle points: boolean on/off patches (as opposed to px sizes). They ride the
// same atomic-write / stock-drift / pending-reload machinery, but the value is
// a switch, so they get a small model of their own and a switch control in the
// panel. Both live in the Edit-diff card's createDiffEditor options; each anchor
// is global (patches the inline card and the expand modal) and keys off a stable
// neighbor so it composes with the font knob and the other toggle.
// ---------------------------------------------------------------------------

// Theme sync (ON): replace the hardcoded theme:"vs-dark" with an IIFE that (1)
// returns the Monaco theme matching the webview's current VS Code theme kind, and
// (2) once per window installs a MutationObserver on <body>'s class so a later
// light/dark switch live-updates every diff editor via monaco's global setTheme
// (Cd is monaco.editor at the injection site). Everything is wrapped in try/catch
// so a failure can never break card creation; the /*ccup-theme*/ marker makes the
// ON state detectable and survives minification.
const THEME_SYNC_ON =
  '/*ccup-theme*/(function(){function p(){var l=document.body.classList;return l.contains("vscode-high-contrast")?(l.contains("vscode-high-contrast-light")?"hc-light":"hc-black"):(l.contains("vscode-light")?"vs":"vs-dark")}try{if(!window.__ccupThemeObs){window.__ccupThemeObs=1;new MutationObserver(function(){try{Cd.setTheme(p())}catch(e){}}).observe(document.body,{attributes:true,attributeFilter:["class"]})}}catch(e){}return p()}())';

// Claude Code 2.1.267 absorbed this feature, so there is nothing left to patch:
// it dropped the theme option from both createDiffEditor calls and now wires a
// hook into each diff surface (the card and the expand modal) that maps <body>'s
// class to a Monaco theme, pushes it through monaco.editor.setTheme on mount,
// and re-pushes it from a MutationObserver on <body>'s class. That is the same
// behavior THEME_SYNC_ON injected, plus an observer teardown the patch lacked. On such
// a bundle the point reports "native" rather than "missing": the feature is on,
// no edit is owed, and the setting has nothing to disagree with.
//
// Both halves are required so a chance match cannot silently switch the patch
// off on a build that still needs it. Neither captures a minified identifier
// (those get reshuffled every release), and neither can match THEME_SYNC_ON's
// own injected copy: the patch writes the mapper as a nested ternary and calls
// setTheme with an argument, so a pristine or a patched 2.1.266 scores zero on
// both. Verified against pristine 2.1.266, patched 2.1.266, and 2.1.267.
const THEME_SYNC_NATIVE_RES = [
  // The classList -> Monaco theme mapper, as an if/return chain.
  /contains\("vscode-high-contrast-light"\)\)return"hc-light"/,
  // The hook wired to monaco's global setTheme by reference, e.g. ci(c3.setTheme).
  /[\w$]+\([\w$]+\.setTheme\)/,
];
const themeSyncNative = (c: string): boolean =>
  THEME_SYNC_NATIVE_RES.every((re) => re.test(c));

// Gutter cleanup appended to webview/index.css when line numbers are ON. The diff
// card marks changed lines with codicon glyphs (codicon-diff-insert = the "+"
// icon, codicon-diff-remove = the "-" icon), but this bundle's codicon subset
// can't draw them, so they fall back to empty notdef boxes next to each line. We
// re-point those glyphs at a text font and render literal "+"/"-", turning the
// boxes into the real diff signs; and we flatten line 1's always-bright active
// line number to the normal color. Scoped to every diff container found in the
// stylesheet (the inline card and the expand modal use different CSS-module
// hashes, e.g. _s6OFow and _oXZawA), so both render the signs.
//
// The same line insets each diff editor from its container's left edge. The
// leftmost number column is exactly as wide as its digits (minChars sized to
// fit, and no glyph margin to its left: off natively in the inline view,
// reclaimed by the gm fragment below in side-by-side), so the digits sat flush
// against the card while the line height leaves them room above and below. A
// 4px left border on the editor root gives that room back (ink to edge at the
// default 13px: 4px above the first row, 4.5px left of the digits). It is a
// border rather than padding because Monaco places both editors absolutely
// from the root's padding box and sizes them from its content box, so the
// border shifts and narrows the whole layout in step, in either view. Its
// color is Monaco's own gutter variable, which Monaco's theme rule defines on
// that root, so the strip matches the number column in every theme.
const DIFF_LINES_CSS_MARKER = "/*ccup:diffLines*/";
const DIFF_CONTAINER_HASH_RE = /\.diffEditorContainer_([-\w]+)\{/g;

// ---------------------------------------------------------------------------
// Diff-card line numbers (ON). Two layers, applied together by diffLinesSet:
//
// 1) Base swap, both createDiffEditor option blocks (card + expand modal):
//    lineNumbers:"off" -> lineNumbers:"on",lineNumbersMinChars:1. Monaco sizes
//    the gutter as max(digitCount(model line count), minChars) glyphs, so
//    minChars:1 makes the width purely digit-count-based (1 char for a <10-line
//    snippet, 2 for <100, ...) instead of the fixed 2 an earlier build pinned.
//    OFF restores lineNumbers:"off", whose gutter still shows the native +/-
//    change signs (renderIndicators is a separate Monaco option, always on).
//
// 2) Absolute numbering enhancement: number lines by their real position in the
//    edited file rather than 1..N of the snippet. The Edit card only receives
//    the tool INPUT (old_string/new_string/file_path), which carries no
//    position, but the CLI attaches a top-level `tool_use_result` to every live
//    Edit result message ({originalFile, oldString, structuredPatch, replaceAll,
//    ...}), the extension forwards messages to the webview verbatim, and the
//    webview's store then drops the field while pairing result blocks to their
//    tool_use (setToolResult stores only the content block). Six marked inline
//    insertions carry it through:
//      tur   store loop: derive the 1-based start line right here, as the line
//            of oldString within originalFile (index of the unique match; the
//            text above an edit is untouched, so the SAME number is correct for
//            both panes), and stash only that number on the stored block
//            (block.ccupStart). Deriving at pairing time instead of in the card
//            body keeps a file-sized indexOf plus newline count off every
//            render, and leaves the result payload collectable: stashing the
//            object itself pinned originalFile and structuredPatch for EVERY
//            tool result of the session (a Read's whole file, a Bash's whole
//            output) for as long as the window lived. oldString falls back to
//            the paired tool_use's own input.old_string, the same text the CLI
//            echoes back.
//      prop  Edit-card body: pass the stashed number to the diff component as
//            ccupStart
//      arg   diff component: accept ccupStart in the props destructure
//      fx    diff component: a SEPARATE effect, declared right after the models
//            effect so React still runs it second on mount, pushing the offset
//            into Monaco via updateOptions (diff-level options persist in the
//            option bag and re-derive onto both panes across renderSideBySide
//            flips), also widening lineNumbersMinChars to the digits of the
//            largest rendered number (Monaco's own width formula only counts the
//            model's line count, which would clip e.g. "1403" on a 3-line
//            snippet). It must key on [ccupStart, original, modified] and not
//            join the models effect's own deps: widening those makes the
//            late-arriving result re-run that whole effect (language-probe model
//            created and disposed, setValue on both models, setModel), which
//            re-tokenizes both sides and asks Monaco for a fresh worker diff, so
//            the relabel lands as a full diff re-init.
//      mprop expand modal: forward ccupStart through the openModal call
//      modal modal models effect: same updateOptions from the modal state
//    plus one marked helper line appended at EOF (window.__ccupAbsLn) shared by
//    the two updateOptions call sites, each guarded with && so a missing helper
//    can never throw.
//
// When no offset is derivable the helper resets the base 1-based options, so
// numbering falls back cleanly. That covers: results replayed from history
// (window reload / resume / teleport re-emit user messages WITHOUT
// tool_use_result, verified against the CLI's replay constructors), failed
// edits (tool_use_result is an error string, not an object), replace_all edits
// (several sites, no single true start), and a card rendered before its result
// arrives. Cards from live edits get absolute numbers the moment the result
// lands.
//
// Two further marked insertions polish the gutter's use of space (each applies
// on its own anchor, separate from the six-fragment block, since they fix
// spacing that exists with or without the absolute enhancement):
//      gm    Monaco's diff editor force-enables the ORIGINAL editor's glyph
//            margin whenever the view is side-by-side (glyphMargin =
//            renderSideBySide in its left-hand-side option derive), reserving
//            about a line-height of width for revert-arrow decorations that a
//            read-only card never renders; appending &&!1 to that assignment
//            reclaims the dead strip at the card's left edge
//      gap   in the inline (narrow) view the original editor is sliced off at
//            exactly the end of its number column (width = max(5,
//            decorationsLeft)), so its digits butt against the modified
//            editor's digits with zero gap; widening the slice by +5px opens
//            breathing room at the junction (the revealed pixels are the start
//            of the original's decorations column: blank on unchanged and
//            inserted rows, at most a faint sliver of the "-" sign on deleted
//            rows)
//
// Every insertion is wrapped in /*ccup:absLn:<tag>*/.../*ccup:absLnEnd*/ and
// contains the whole inserted text (commas/semicolons included), so stripping
// the markers restores the stock bytes exactly; diffLinesSet always strips
// first and rebuilds, making it deterministic and idempotent, and letting
// fnCurrentOn detect "fully current" as content === diffLinesSet(content, true)
// (an older patch layout reads as off and upgrades in place on the next apply).
// The six sites are located by their structure (src/derive.ts), from four
// locally parsed units: the diff component (its params destructure
// original/modified/language/filePath), which holds the arg, fx and mprop sites
// and the create effect that names the build's useEffect alias; the class
// around the Edit card (whose body method renders that same component with the
// tool input's strings); the function around the store's result-pairing loop;
// and the expand modal's component. Each site is matched by its role and key
// SET rather than its text, each must be found exactly once, and every
// minified name an insertion reads must resolve there to the binding it was
// read from (the fx effect must also be a top-level statement of the
// component, as hooks are). If ANY of that fails, the enhancement is skipped as
// a block and ON degrades to the base swap alone, so a partial application can
// never reference an identifier another edit failed to introduce. Injected names are ccup-prefixed to dodge minified locals, and
// every injected code path is try/catch-wrapped so it can never break the card.
// ---------------------------------------------------------------------------
// The size ahead of the swap is captured and re-emitted, never parsed: a literal
// through Claude Code 2.1.299, a call since 2.1.300 (pinned or not by the diff
// card knob), and whichever it is, it says nothing about the line numbers.
const DIFF_LN_BASE_RE =
  /(fontSize:[^,]*,)(lineNumbers:"(?:off|on)"(?:,lineNumbersMinChars:\d+)?)(,)/g;
const DIFF_LN_ON = 'lineNumbers:"on",lineNumbersMinChars:1';
const DIFF_LN_OFF = 'lineNumbers:"off"';

const ABS_LN_END = "/*ccup:absLnEnd*/";
const absLnFrag = (tag: string, code: string): string =>
  `/*ccup:absLn:${tag}*/${code}${ABS_LN_END}`;
// Any inline fragment, whatever its tag or body (older layouts strip too).
const ABS_LN_FRAG_RE =
  /\/\*ccup:absLn:[-\w]+\*\/[\s\S]*?\/\*ccup:absLnEnd\*\//g;

const ABS_LN_HELPER_MARKER = "/*ccup:absLnHelper*/";
const ABS_LN_HELPER_LINE_RE = /\n?\/\*ccup:absLnHelper\*\/[^\n]*/g;
// off = the 1-based file line of the snippet's first line (>0), else fall back
// to the base options. a/b = the two model strings, whose longer line count
// bounds the largest rendered number for the minChars width.
//
// The pair in force is remembered on the editor so a call that would change
// nothing returns without touching Monaco, seeded with the pair createDiffEditor
// already set up ("on" at minChars 1) so a card that never receives an offset
// makes no options call at all. That memory is also what keeps the reset to
// plain 1-based numbering working in the expand modal, whose one editor is
// reused across cards.
const ABS_LN_HELPER =
  ABS_LN_HELPER_MARKER +
  "(function(){try{window.__ccupAbsLn=function(ed,off,a,b){try{var o,W=1;" +
  'if(typeof off==="number"&&isFinite(off)&&off>0){' +
  'var L=Math.max(String(a==null?"":a).split("\\n").length,String(b==null?"":b).split("\\n").length);' +
  "W=String(off+L-1).length;if(W<1)W=1}else off=0;" +
  "var P=ed.__ccupLn||{o:0,w:1};if(P.o===off&&P.w===W)return;" +
  "ed.__ccupLn={o:off,w:W};" +
  "o=off?{lineNumbers:function(n){return String(n+off-1)},lineNumbersMinChars:W}" +
  ':{lineNumbers:"on",lineNumbersMinChars:1};' +
  "ed.updateOptions(o)}catch(e){}}}catch(e){}})();";

// The props the diff component destructures (ccupStart joins them). A
// destructured prop sits close after its function keyword, while a token deep
// in a function body or a class may sit far from where that unit starts.
const ABS_LN_DIFF_KEYS = ["original", "modified", "language", "filePath"];
const ABS_LN_PARAMS_REACH = 2000;
const ABS_LN_UNIT_REACH = 200000;

// gm: the diff editor's left-hand-side option derive, which forces the original
// editor's glyph margin on in side-by-side view.
const ABS_LN_GM_RE =
  /(\.glyphMargin=this\._options\.renderSideBySide\.get\(\))/g;

// gap: the inline-view layout's original-editor slice width (cut at the end of
// its line-number column).
const ABS_LN_GAP_RE =
  /(Math\.max\(5,this\._editors\.originalObs\.layoutInfoDecorationsLeft\.read\([\w$]+\)\))/g;

function absLnExec(re: RegExp, c: string): RegExpExecArray | null {
  re.lastIndex = 0;
  return re.exec(c);
}

// Remove every trace of the enhancement (inline fragments + helper line),
// restoring those spots to stock bytes.
function absLnStrip(c: string): string {
  return c.replace(ABS_LN_FRAG_RE, "").replace(ABS_LN_HELPER_LINE_RE, "");
}

// Apply the full ON enhancement to a STRIPPED bundle: the six-fragment
// absolute-numbering thread (all-or-nothing), then the two spacing fragments,
// each independent and skipped silently when its anchor is gone.
function absLnApply(c: string): string {
  let out = absLnThread(c);
  out = out.replace(
    ABS_LN_GM_RE,
    (_w, head) => `${head}${absLnFrag("gm", "&&!1")}`,
  );
  out = out.replace(
    ABS_LN_GAP_RE,
    (_w, head) => `${head}${absLnFrag("gap", "+5")}`,
  );
  return out;
}

// The editor ref's name when `x` is the models push both models effects end
// with, `<ref>.current.setModel({original:<m>.current.original,
// modified:<m>.current.modified})`; else null.
function absLnSetModelRef(x: N): string | null {
  if (x.type !== "CallExpression" || memberProp(x.callee) !== "setModel")
    return null;
  const owner = x.callee.object;
  const arg = x.arguments[0];
  if (
    memberProp(owner) !== "current" ||
    !hasKeys(arg, ["original", "modified"])
  )
    return null;
  const models = ["original", "modified"].map((k) => {
    const v = propOf(arg, k)!.value;
    return memberProp(v) === k && memberProp(v.object) === "current"
      ? idName(v.object.object)
      : null;
  });
  return models[0] && models[0] === models[1] ? idName(owner.object) : null;
}

// `<blk>.type==="tool_result"`, the comparison written either way round.
function absLnIsToolResultTest(t: N, blk: string): boolean {
  if (
    t.type !== "BinaryExpression" ||
    (t.operator !== "===" && t.operator !== "==")
  )
    return false;
  return (
    (isMember(t.left, blk, "type") && isStr(t.right, "tool_result")) ||
    (isMember(t.right, blk, "type") && isStr(t.left, "tool_result"))
  );
}

// The tool_use_result thread, or the input unchanged when any site is missing,
// ambiguous, or would read a name bound elsewhere (all-or-nothing, see the
// block comment above).
function absLnThread(c: string): string {
  // The diff component, and inside it the models effect (a hook call whose
  // callback ends in the models push and whose deps hold both strings), the
  // create effect (whose callee is the build's useEffect alias, the hook the fx
  // fragment declares its own effect with), and the expand click (a call handed
  // the component's own four strings).
  const comps = unitsWith(
    c,
    "filePath:",
    "function",
    isFn,
    ABS_LN_PARAMS_REACH,
  ).filter((f) => hasKeys(f.params[0], ABS_LN_DIFF_KEYS));
  if (comps.length !== 1) return c;
  const comp = comps[0];
  const compName = idName(comp.id);
  const orig = boundName(comp.params[0], "original");
  const mod = boundName(comp.params[0], "modified");
  if (!compName || !orig || !mod || comp.body.type !== "BlockStatement")
    return c;
  const models: { call: N; set: N; ref: string }[] = [];
  const creates: N[] = [];
  const opens: N[] = [];
  walk(comp, (n) => {
    if (n.type !== "CallExpression") return;
    const [cb, deps] = n.arguments as N[];
    if (isFn(cb) && idName(n.callee)) {
      const seen = { create: false, sets: [] as { set: N; ref: string }[] };
      walkOwn(cb, (x) => {
        if (x.type !== "CallExpression") return;
        if (memberProp(x.callee) === "createDiffEditor") seen.create = true;
        const ref = absLnSetModelRef(x);
        if (ref) seen.sets.push({ set: x, ref });
      });
      if (seen.create) creates.push(n);
      const names =
        deps?.type === "ArrayExpression" ? deps.elements.map(idName) : [];
      if (seen.sets.length === 1 && names.includes(orig) && names.includes(mod))
        models.push({ call: n, ...seen.sets[0] });
    }
    for (const a of n.arguments as N[]) {
      if (
        a.type === "ObjectExpression" &&
        hasKeys(a, ABS_LN_DIFF_KEYS) &&
        idName(propOf(a, "original")!.value) === orig &&
        idName(propOf(a, "modified")!.value) === mod
      )
        opens.push(a);
    }
  });
  if (models.length !== 1 || creates.length !== 1 || opens.length !== 1)
    return c;
  const fx = models[0];
  const alias = idName(creates[0].callee)!;
  // The fx effect goes in as a statement of its own right after the models
  // effect, which has to be a top-level statement of the component (as hooks
  // are), and every name it reads must mean there what it meant where it was
  // read.
  const stmt =
    fx.call.parent?.type === "SequenceExpression"
      ? fx.call.parent.parent
      : fx.call.parent;
  if (
    stmt?.type !== "ExpressionStatement" ||
    stmt.parent !== comp.body ||
    bindingSite(fx.call, alias, comp) !==
      bindingSite(creates[0], alias, comp) ||
    bindingSite(fx.call, fx.ref, comp) !== bindingSite(fx.set, fx.ref, comp) ||
    bindingSite(fx.call, orig, comp) !== comp ||
    bindingSite(fx.call, mod, comp) !== comp
  )
    return c;

  // The Edit card: the call rendering that same component from a class's
  // body(ctx,input,result) method, its strings read off the tool input, in the
  // method that tests the result's is_error.
  const cards = new Map<number, { cls: N; obj: N; result: string }>();
  const tok = `(${compName},`;
  for (let i = c.indexOf(tok); i >= 0; i = c.indexOf(tok, i + 1)) {
    const cls = unitAround(c, i, "class ", isClass, ABS_LN_UNIT_REACH);
    const m = cls ? methodAt(cls, "body", i) : null;
    const input = m ? idName(m.params[1]) : null;
    const result = m ? idName(m.params[2]) : null;
    if (!cls || !m || !input || !result) continue;
    const fromInput = (obj: N, key: string, field: string) => {
      const v = propOf(obj, key)!.value;
      return (
        v.type === "LogicalExpression" &&
        v.operator === "||" &&
        isMember(v.left, input, field) &&
        v.right.type === "Literal" &&
        v.right.value === ""
      );
    };
    const seen = { isError: false, objs: [] as N[] };
    walk(m, (n) => {
      if (isMember(n, result, "is_error")) seen.isError = true;
      const obj =
        n.type === "CallExpression" && idName(n.arguments[0]) === compName
          ? n.arguments[1]
          : null;
      if (
        hasKeys(obj, ["original", "modified", "filePath"]) &&
        fromInput(obj, "original", "old_string") &&
        fromInput(obj, "modified", "new_string") &&
        fromInput(obj, "filePath", "file_path") &&
        bindingSite(obj, result, m) === m
      )
        seen.objs.push(obj);
    });
    if (seen.isError)
      for (const obj of seen.objs) cards.set(obj.start, { cls, obj, result });
  }
  if (cards.size !== 1) return c;
  const card = [...cards.values()][0];

  // The store's result-pairing loop, `for(<blk> of <msg>.message.content)
  // if(<blk>.type==="tool_result"){let <wrap>=<find>(...,<blk>.tool_use_id);
  // ... <wrap>.setToolResult(<blk>,...)}`, the stash going in right after
  // that let.
  const loops: { unit: N; first: N; blk: string; msg: string; wrap: string }[] =
    [];
  const pairUnits: N[] = [];
  for (
    let i = c.indexOf("setToolResult(");
    i >= 0;
    i = c.indexOf("setToolResult(", i + 1)
  ) {
    if (pairUnits.some((u) => u.start <= i && i < u.end)) continue;
    const u = unitAround(c, i, "function", isFn, ABS_LN_UNIT_REACH);
    if (!u) continue;
    pairUnits.push(u);
    walk(u, (n) => {
      if (n.type !== "ForOfStatement") return;
      const blk =
        n.left.type === "VariableDeclaration" &&
        n.left.declarations.length === 1
          ? idName(n.left.declarations[0].id)
          : null;
      const msg =
        memberProp(n.right) === "content" &&
        memberProp(n.right.object) === "message"
          ? idName(n.right.object.object)
          : null;
      const s = n.body;
      if (
        !blk ||
        !msg ||
        s.type !== "IfStatement" ||
        !absLnIsToolResultTest(s.test, blk) ||
        s.consequent.type !== "BlockStatement"
      )
        return;
      const first = s.consequent.body[0];
      const d =
        first?.type === "VariableDeclaration" && first.declarations.length === 1
          ? first.declarations[0]
          : null;
      const wrap = d ? idName(d.id) : null;
      if (
        !wrap ||
        d.init?.type !== "CallExpression" ||
        !d.init.arguments.some((a: N) => isMember(a, blk, "tool_use_id"))
      )
        return;
      const seen = { pairs: false };
      walkOwn(s.consequent, (x) => {
        if (
          x.type === "CallExpression" &&
          isMember(x.callee, wrap, "setToolResult") &&
          idName(x.arguments[0]) === blk
        )
          seen.pairs = true;
      });
      if (
        seen.pairs &&
        bindingSite(first, msg, u) === bindingSite(n.right, msg, u)
      )
        loops.push({ unit: u, first, blk, msg, wrap });
    });
  }
  if (loops.length !== 1) return c;
  const loop = loops[0];

  // The expand modal's models effect: a hook call with one dep, the modal state,
  // whose callback reads that state's original and modified and ends in the
  // same models push.
  const modals: { unit: N; set: N; ref: string; state: string }[] = [];
  const modalUnits: N[] = [];
  for (
    let i = c.indexOf(".current.setModel(");
    i >= 0;
    i = c.indexOf(".current.setModel(", i + 1)
  ) {
    if (comp.start <= i && i < comp.end) continue;
    if (modalUnits.some((u) => u.start <= i && i < u.end)) continue;
    const u = unitAround(c, i, "function", isFn, ABS_LN_UNIT_REACH);
    if (!u) continue;
    modalUnits.push(u);
    walk(u, (n) => {
      if (n.type !== "CallExpression" || !idName(n.callee)) return;
      const [cb, deps] = n.arguments as N[];
      const state =
        deps?.type === "ArrayExpression" && deps.elements.length === 1
          ? idName(deps.elements[0])
          : null;
      if (!state || !isFn(cb) || cb.body.type !== "BlockStatement") return;
      const last = cb.body.body[cb.body.body.length - 1];
      const set = last?.type === "ExpressionStatement" ? last.expression : null;
      const ref = set ? absLnSetModelRef(set) : null;
      if (!ref) return;
      const reads = { original: false, modified: false };
      walkOwn(cb, (x) => {
        if (isMember(x, state, "original")) reads.original = true;
        if (isMember(x, state, "modified")) reads.modified = true;
      });
      if (
        reads.original &&
        reads.modified &&
        bindingSite(set, state, u) === bindingSite(n, state, u)
      )
        modals.push({ unit: u, set, ref, state });
    });
  }
  if (modals.length !== 1) return c;
  const modal = modals[0];

  const stash =
    `try{var ccupR=${loop.msg}.tool_use_result;` +
    'if(ccupR&&typeof ccupR==="object"&&!ccupR.replaceAll&&' +
    'typeof ccupR.originalFile==="string"){' +
    'var ccupQ=typeof ccupR.oldString==="string"&&ccupR.oldString?' +
    `ccupR.oldString:(${loop.wrap}&&${loop.wrap}.content&&${loop.wrap}.content.input&&` +
    `${loop.wrap}.content.input.old_string);` +
    "if(ccupQ){var ccupX=ccupR.originalFile.indexOf(ccupQ);" +
    "if(ccupX>=0){var ccupN=1,ccupP=0;" +
    'while((ccupP=ccupR.originalFile.indexOf("\\n",ccupP))>=0&&ccupP<ccupX)' +
    "{ccupN++;ccupP++}" +
    `${loop.blk}.ccupStart=ccupN}}}}catch(ccupE){}`;
  const prop = appendProp(
    card.obj,
    `ccupStart:(${card.result}&&${card.result}.ccupStart)`,
  );
  const arg = appendProp(comp.params[0], "ccupStart:ccupS");
  const mprop = appendProp(opens[0], "ccupStart:ccupS");
  const edits: Edit[] = [
    { pos: loop.first.end, text: absLnFrag("tur", stash) },
    { pos: prop.pos, text: absLnFrag("prop", prop.text) },
    { pos: arg.pos, text: absLnFrag("arg", arg.text) },
    {
      pos: fx.call.end,
      text: absLnFrag(
        "fx",
        `;${alias}(()=>{window.__ccupAbsLn&&` +
          `window.__ccupAbsLn(${fx.ref}.current,ccupS,${orig},${mod})},` +
          `[ccupS,${orig},${mod}])`,
      ),
    },
    { pos: mprop.pos, text: absLnFrag("mprop", mprop.text) },
    {
      pos: modal.set.end,
      text: absLnFrag(
        "modal",
        `;window.__ccupAbsLn&&window.__ccupAbsLn(${modal.ref}.current,${modal.state}.ccupStart,${modal.state}.original,${modal.state}.modified)`,
      ),
    },
  ];
  const out = applyEdits(c, edits);
  const units: [N, (n: N) => boolean][] = [
    [comp, isFn],
    [card.cls, isClass],
    [loop.unit, isFn],
    [modal.unit, isFn],
  ];
  return unitsReparse(out, edits, units) ? `${out}\n${ABS_LN_HELPER}` : c;
}

function diffLinesPresent(c: string): boolean {
  DIFF_LN_BASE_RE.lastIndex = 0;
  return DIFF_LN_BASE_RE.test(c);
}
// Same patch, EOF helper POSITION factored out: the inline fragments match and
// the helper's own bytes match, wherever the helper happens to sit. Other
// toggles (scroll dot, jump buttons, math) also append EOF lines and can land
// after the helper, so whole-file equality would read as drifted forever once
// any of them does, while the fragments and the helper's bytes are what
// actually matter. Shared by the readback and the transform below, which keeps
// the two from disagreeing (and, since the transform cannot call the readback
// without recursing, is the only place the rule can live).
function absLnSameModuloHelper(a: string, b: string): boolean {
  const stripHelper = (s: string) => s.replace(ABS_LN_HELPER_LINE_RE, "");
  return (
    stripHelper(a) === stripHelper(b) &&
    cssMarkedLine(a, ABS_LN_HELPER_MARKER) ===
      cssMarkedLine(b, ABS_LN_HELPER_MARKER)
  );
}
// ON means base swap on AND the enhancement in exactly this build's form: an
// older layout (e.g. the fixed minChars:2 build, or stale fragments) compares
// unequal, reads as off, and the next apply rebuilds it in place.
function diffLinesCurrentOn(c: string): boolean | undefined {
  const m = absLnExec(DIFF_LN_BASE_RE, c);
  if (!m) return undefined;
  if (!m[2].includes('"on"')) return false;
  return absLnSameModuloHelper(c, diffLinesSet(c, true));
}
// One toggle click re-evaluates diffLinesSet(c, true) several times over the
// ~5MB bundle (applyPatch reads current then sets, the pending-reload
// reconcile and the analyze refresh each read again), and diffLinesCurrentOn
// funnels through it too, so the panel's round-trip stalls without a cache.
// The transform is deterministic, so memoize the last ON input->output pair;
// a hit costs one string compare (~2ms). It is also idempotent (strip first,
// then rebuild), so an input equal to the memoized OUTPUT returns itself.
// The OFF polarity is just the strip + base swap (~6ms), not worth retaining
// another ~10MB pair for.
let diffLnMemoOn: { input: string; output: string } | undefined;

function diffLinesSet(c: string, on: boolean): string {
  if (on && diffLnMemoOn) {
    if (diffLnMemoOn.input === c) return diffLnMemoOn.output;
    if (diffLnMemoOn.output === c) return c;
  }
  let out = absLnStrip(c);
  DIFF_LN_BASE_RE.lastIndex = 0;
  out = out.replace(
    DIFF_LN_BASE_RE,
    (_w, p, _v, s) => `${p}${on ? DIFF_LN_ON : DIFF_LN_OFF}${s}`,
  );
  if (!on) return out;
  out = absLnApply(out);
  // Position-stable: a rebuild that differs from the input only in where the
  // EOF helper sits keeps the input, so an already-correct bundle is never
  // rewritten just to migrate the helper back to the end of the file. Without
  // this, every pass rewrote the ~5MB bundle with all points reading current.
  if (out !== c && absLnSameModuloHelper(c, out)) out = c;
  diffLnMemoOn = { input: c, output: out };
  return out;
}

// Effort reload-sync (ON): close the settings.json -> actual-call gap. Claude
// Code persists `effortLevel` to ~/.claude/settings.json and the chat UI seeds
// its effort button from that raw value, but a freshly spawned CLI session does
// NOT re-read `effortLevel` from settings — effort is driven live only via the
// apply_settings / applyFlagSettings RPC, which fires when the button is
// toggled. So after a window reload the button shows "max" while the next
// message silently runs at the CLI default ("high") until you flip the button.
// The patch mirrors the toggle's proven path: in the webview init effect that
// seeds `effortLevel` from settings, also push that value to the running CLI
// via applySettings({effortLevel:r},{flagsOnly:!0}) (flagsOnly = push only, no
// settings.json rewrite, since the value already came from there). The
// /*ccup-effortSync*/ marker makes the ON state detectable; the local seed
// variable is captured so the patch survives re-minification across versions.
// The seed branch's own `!this.effortLevel.value` guard makes the push fire
// once per webview load, and .catch swallows any rejection (e.g. an effort
// level the current model doesn't support) so it can never break the effect.
const EFFORT_SYNC_MARKER = "/*ccup-effortSync*/";
// Native (OFF) form: if(VAR&&!this.effortLevel.value)this.effortLevel.value=VAR;
const EFFORT_SYNC_OFF_RE =
  /if\(([a-zA-Z_$][\w$]*)&&!this\.effortLevel\.value\)this\.effortLevel\.value=\1;/;
// Patched (ON) form: the marker plus the live push to the running CLI session.
const EFFORT_SYNC_ON_RE =
  /if\(([a-zA-Z_$][\w$]*)&&!this\.effortLevel\.value\)\{this\.effortLevel\.value=\1;\/\*ccup-effortSync\*\/this\.queueSettingsApply\(\(\)=>this\.applySettings\(\{effortLevel:\1\},\{flagsOnly:!0\}\)\.catch\(\(\)=>\{\}\)\);\}/;

function effortSyncPresent(c: string): boolean {
  return EFFORT_SYNC_OFF_RE.test(c) || EFFORT_SYNC_ON_RE.test(c);
}
// true = ON (patched), false = OFF (native), undefined = anchor gone.
function effortSyncCurrentOn(c: string): boolean | undefined {
  if (EFFORT_SYNC_ON_RE.test(c)) return true;
  if (EFFORT_SYNC_OFF_RE.test(c)) return false;
  return undefined;
}
function effortSyncSet(c: string, on: boolean): string {
  if (on) {
    return c.replace(
      EFFORT_SYNC_OFF_RE,
      (_w, v: string) =>
        `if(${v}&&!this.effortLevel.value){this.effortLevel.value=${v};${EFFORT_SYNC_MARKER}this.queueSettingsApply(()=>this.applySettings({effortLevel:${v}},{flagsOnly:!0}).catch(()=>{}));}`,
    );
  }
  return c.replace(
    EFFORT_SYNC_ON_RE,
    (_w, v: string) =>
      `if(${v}&&!this.effortLevel.value)this.effortLevel.value=${v};`,
  );
}

// Input-history recall keys (ON): natively, ArrowUp in the chat input recalls
// the previous sent message once the caret sits at the input's very start, and
// ArrowDown the next once it sits at the very end, so holding Up through a
// multi-line draft overshoots the first line straight into history. When ON
// the recall pair moves to Cmd/Ctrl+Up/Down, fired from ANY caret position in
// one press, and plain Up/Down only ever move the caret. Two coupled edits in
// webview/index.js, toggled together:
//   - the composer keydown: both cycleMessage(+-1) branches gain a modifier
//     requirement (marker-tagged), baked at patch time like the find-bar
//     chords: metaKey (Cmd) on macOS, where Ctrl+Up/Down belongs to Mission
//     Control / App Expose, and ctrlKey elsewhere, where the Win/Super key
//     belongs to the OS. The popup gates (!R&&!un: slash/at-mention menus)
//     are kept.
//   - the history hook's caret gates (caret-at-start for -1, caret-at-end for
//     +1) are parked behind &&!1, so the chord recalls directly instead of
//     needing a native caret jump to the edge first. The dead gate bodies stay
//     in place byte-for-byte, keeping the restore a pure condition strip.
// When cycling has nowhere to go (no history, oldest reached, or not in
// history for Down) cycleMessage returns false, no preventDefault fires, and
// the chord falls through to the browser default (caret to start/end).
// On macOS the recall pair takes Cmd+Up/Down, the platform's keys for moving
// the caret to the draft's very start/end, so the macOS ON form adds
// Cmd+Ctrl+A/E for those two moves (Ctrl+A/E move to the paragraph's
// start/end, and the Cmd widens that to the whole draft). They are one
// marker-delimited branch after the ArrowDown one,
// /*ccup:histKeysCaret*/.../*ccup:histKeysCaretEnd*/, behind the same popup
// gates. It collapses the selection onto the editable (the handler's own
// currentTarget) at its first or last child boundary, as the native focus
// handler does for the end, then scrolls the editable to its top or bottom,
// since a script-set selection never reveals itself (the mirror follows
// through its scroll listener). Elsewhere Ctrl+Home/End keep both moves, so
// the branch is not baked. An ON form without the branch this platform bakes,
// as 1.6.2 and earlier wrote it, reads as off, and the next apply rebuilds it.
// All variable names are captured and rebuilt via backreferences, so the
// anchors survive re-minification renames across Claude Code versions; the ON
// anchor accepts either modifier property, so on/off detection does not
// depend on the platform that baked it.
const HIST_KEYS_MARKER = "/*ccup-histKeys*/";
const HIST_KEYS_MOD = process.platform === "darwin" ? "metaKey" : "ctrlKey";
const HIST_KEYS_CARET = process.platform === "darwin";
const HIST_KEYS_CARET_MARKER = "/*ccup:histKeysCaret*/";
const HIST_KEYS_CARET_END = "/*ccup:histKeysCaretEnd*/";
const HIST_KEYS_CARET_RE =
  /\/\*ccup:histKeysCaret\*\/[\s\S]*?\/\*ccup:histKeysCaretEnd\*\//g;
const HK_ID = "[a-zA-Z_$][\\w$]*";
// Composer keydown pair; captures (1)=event, (2)=popup gates, (3)=hook handle,
// and on the ON form (4)=the caret branch after it, empty when absent.
const HIST_KEYS_KEY_OFF_RE = new RegExp(
  `if\\((${HK_ID})\\.key==="ArrowUp"&&(!${HK_ID}&&!${HK_ID})\\)\\{if\\((${HK_ID})\\.cycleMessage\\(-1\\)\\)\\{\\1\\.preventDefault\\(\\);return\\}\\}` +
    `if\\(\\1\\.key==="ArrowDown"&&\\2\\)\\{if\\(\\3\\.cycleMessage\\(1\\)\\)\\{\\1\\.preventDefault\\(\\);return\\}\\}`,
);
const HIST_KEYS_KEY_ON_RE = new RegExp(
  `if\\((${HK_ID})\\.key==="ArrowUp"&&\\/\\*ccup-histKeys\\*\\/\\1\\.(?:metaKey|ctrlKey)&&(!${HK_ID}&&!${HK_ID})\\)\\{if\\((${HK_ID})\\.cycleMessage\\(-1\\)\\)\\{\\1\\.preventDefault\\(\\);return\\}\\}` +
    `if\\(\\1\\.key==="ArrowDown"&&\\1\\.(?:metaKey|ctrlKey)&&\\2\\)\\{if\\(\\3\\.cycleMessage\\(1\\)\\)\\{\\1\\.preventDefault\\(\\);return\\}\\}` +
    `((?:\\/\\*ccup:histKeysCaret\\*\\/[\\s\\S]*?\\/\\*ccup:histKeysCaretEnd\\*\\/)?)`,
);
// Caret gates in the history hook; captures (1)=direction, (2)=offset,
// (3)=range, (4)=input ref, (5)=text.
const HIST_KEYS_GATE_OFF_RE = new RegExp(
  `if\\((${HK_ID})===-1\\)\\{if\\((${HK_ID})!==0\\)return!1;` +
    `if\\((${HK_ID})\\.startContainer!==\\((${HK_ID})\\.current\\.firstChild\\|\\|\\4\\.current\\)\\)return!1\\}` +
    `if\\(\\1===1\\)\\{if\\(!\\(\\3\\.endContainer===\\(\\4\\.current\\.firstChild\\|\\|\\4\\.current\\)&&\\2===(${HK_ID})\\.length\\)\\)return!1\\}`,
);
const HIST_KEYS_GATE_ON_RE = new RegExp(
  `if\\((${HK_ID})===-1&&!1\\/\\*ccup-histKeys\\*\\/\\)\\{if\\((${HK_ID})!==0\\)return!1;` +
    `if\\((${HK_ID})\\.startContainer!==\\((${HK_ID})\\.current\\.firstChild\\|\\|\\4\\.current\\)\\)return!1\\}` +
    `if\\(\\1===1&&!1\\)\\{if\\(!\\(\\3\\.endContainer===\\(\\4\\.current\\.firstChild\\|\\|\\4\\.current\\)&&\\2===(${HK_ID})\\.length\\)\\)return!1\\}`,
);

// The caret branch for event e and popup gates g, or "" off macOS.
function histKeysCaretStr(e: string, g: string): string {
  if (!HIST_KEYS_CARET) return "";
  return (
    `${HIST_KEYS_CARET_MARKER}if(${e}.metaKey&&${e}.ctrlKey&&!${e}.altKey&&!${e}.shiftKey&&${g}&&/^[ae]$/i.test(${e}.key)){` +
    `var ccupT=${e}.currentTarget,ccupA=${e}.key.toLowerCase()==="a";${e}.preventDefault();` +
    `window.getSelection()?.collapse(ccupT,ccupA?0:ccupT.childNodes.length);` +
    `ccupT.scrollTop=ccupA?0:ccupT.scrollHeight;return}${HIST_KEYS_CARET_END}`
  );
}
function histKeysKeyStr(e: string, g: string, h: string, on: boolean): string {
  const up = on ? `${HIST_KEYS_MARKER}${e}.${HIST_KEYS_MOD}&&` : "";
  const down = on ? `${e}.${HIST_KEYS_MOD}&&` : "";
  return (
    `if(${e}.key==="ArrowUp"&&${up}${g}){if(${h}.cycleMessage(-1)){${e}.preventDefault();return}}` +
    `if(${e}.key==="ArrowDown"&&${down}${g}){if(${h}.cycleMessage(1)){${e}.preventDefault();return}}` +
    (on ? histKeysCaretStr(e, g) : "")
  );
}
function histKeysGateStr(
  d: string,
  f: string,
  r: string,
  n: string,
  p: string,
  on: boolean,
): string {
  const up = on ? `&&!1${HIST_KEYS_MARKER}` : "";
  const down = on ? "&&!1" : "";
  return (
    `if(${d}===-1${up}){if(${f}!==0)return!1;if(${r}.startContainer!==(${n}.current.firstChild||${n}.current))return!1}` +
    `if(${d}===1${down}){if(!(${r}.endContainer===(${n}.current.firstChild||${n}.current)&&${f}===${p}.length))return!1}`
  );
}

// Both anchors must be found (in either polarity): a build that reshapes one
// reports missing, and fnSet is never reached to half-apply.
function histKeysPresent(c: string): boolean {
  return (
    (HIST_KEYS_KEY_OFF_RE.test(c) || HIST_KEYS_KEY_ON_RE.test(c)) &&
    (HIST_KEYS_GATE_OFF_RE.test(c) || HIST_KEYS_GATE_ON_RE.test(c))
  );
}
// true only when BOTH edits are ON, the keydown pair with exactly the caret
// branch this platform bakes. fnSet writes the pair in one pass so a mixed
// state is not produced; if one ever appeared it reports false and a want=ON
// reconcile renormalizes it (strip, then re-apply both).
function histKeysCurrentOn(c: string): boolean | undefined {
  const on = HIST_KEYS_KEY_ON_RE.exec(c);
  const key = on
    ? on[4] === histKeysCaretStr(on[1], on[2])
    : HIST_KEYS_KEY_OFF_RE.test(c)
      ? false
      : undefined;
  const gate = HIST_KEYS_GATE_ON_RE.test(c)
    ? true
    : HIST_KEYS_GATE_OFF_RE.test(c)
      ? false
      : undefined;
  if (key === undefined || gate === undefined) return undefined;
  return key && gate;
}
function histKeysSet(c: string, on: boolean): string {
  let out = c
    .replace(HIST_KEYS_CARET_RE, "")
    .replace(HIST_KEYS_KEY_ON_RE, (_w, e, g, h) =>
      histKeysKeyStr(e, g, h, false),
    )
    .replace(HIST_KEYS_GATE_ON_RE, (_w, d, f, r, n, p) =>
      histKeysGateStr(d, f, r, n, p, false),
    );
  if (!on) return out;
  return out
    .replace(HIST_KEYS_KEY_OFF_RE, (_w, e, g, h) =>
      histKeysKeyStr(e, g, h, true),
    )
    .replace(HIST_KEYS_GATE_OFF_RE, (_w, d, f, r, n, p) =>
      histKeysGateStr(d, f, r, n, p, true),
    );
}

// The webview bundle with the recall keys set as asked (the caret branch
// riding along where this platform bakes it), or null when an anchor is gone.
// scripts/repro's hist-keys.mjs serves this, so it runs exactly what an apply
// writes and doubles as the drift canary.
export function histKeysWebview(js: string, on: boolean): string | null {
  const out = histKeysSet(js, on);
  return histKeysCurrentOn(out) === on ? out : null;
}

// Permission-code size match (ON): the permission "Allow this command?" dialog
// renders the command in .bashCommand_<hash> at 0.9em, larger than the tool
// input (IN) block (0.85em). When ON we append a scoped rule pinning the
// permission block to 0.85em so it matches the IN block (both remain em-relative
// to the chat font size). The hash is read from the stylesheet; if the anchor is
// gone we skip (native). The /*cc-ui-patch:permCode*/ marker makes it detectable.
// This is a pure-CSS toggle (no JS anchor): its "file" is the stylesheet and the
// fn* transforms append/remove the marked line, so it rides the toggle machinery
// without a JS side.
const PERM_CODE_MARKER = "/*cc-ui-patch:permCode*/";
const BASH_CMD_HASH_RE = /\.bashCommand_([-\w]+)\{/;

function permCodePresent(c: string): boolean {
  return c.includes(PERM_CODE_MARKER) || BASH_CMD_HASH_RE.test(c);
}
function permCodeCurrentOn(c: string): boolean | undefined {
  if (c.includes(PERM_CODE_MARKER)) return true;
  if (BASH_CMD_HASH_RE.test(c)) return false;
  return undefined; // anchor gone
}
function permCodeSet(c: string, on: boolean): string {
  if (!on) return cssRemoveLine(c, PERM_CODE_MARKER);
  const hash = c.match(BASH_CMD_HASH_RE)?.[1];
  if (!hash) return c; // anchor gone: leave native
  return cssApplyLine(
    c,
    PERM_CODE_MARKER,
    `${PERM_CODE_MARKER}.bashCommand_${hash}{font-size:.85em !important}`,
  );
}

// Permission-code no-wrap (ON): the permission block renders its command with
// white-space:pre-wrap, so a line longer than the box wraps onto the next visual
// row with no marker — a wrapped continuation looks identical to a real newline.
// The command is a single contentEditable text node (children:e.command, no
// per-line elements), so CSS line numbers / per-line striping have nothing to
// anchor to; the one clean lever is to stop wrapping. When ON we append a scoped
// rule switching the block to white-space:pre + overflow-x:auto, so every visual
// row is exactly one logical line and a long command scrolls horizontally
// instead of wrapping ambiguously. Same pure-CSS toggle shape as permCode: it
// shares the .bashCommand_<hash> anchor and rides the toggle machinery with no JS
// side. The two permission rules are separate marked lines and set disjoint
// properties (font-size vs white-space/overflow), so they compose freely.
const PERM_NOWRAP_MARKER = "/*cc-ui-patch:permNoWrap*/";

function permNoWrapPresent(c: string): boolean {
  return c.includes(PERM_NOWRAP_MARKER) || BASH_CMD_HASH_RE.test(c);
}
function permNoWrapCurrentOn(c: string): boolean | undefined {
  if (c.includes(PERM_NOWRAP_MARKER)) return true;
  if (BASH_CMD_HASH_RE.test(c)) return false;
  return undefined; // anchor gone
}
function permNoWrapSet(c: string, on: boolean): string {
  if (!on) return cssRemoveLine(c, PERM_NOWRAP_MARKER);
  const hash = c.match(BASH_CMD_HASH_RE)?.[1];
  if (!hash) return c; // anchor gone: leave native
  return cssApplyLine(
    c,
    PERM_NOWRAP_MARKER,
    `${PERM_NOWRAP_MARKER}.bashCommand_${hash}{white-space:pre !important;overflow-x:auto !important}`,
  );
}

// Editor selection colors (always on, two halves): the chat sets no ::selection
// rule, so selected text paints in Chromium's own highlight (the macOS accent,
// lightened), which leaves the chat's text in lower contrast than the editor's
// selection leaves the editor's, and follows no theme. The CSS half
// (selectionColorsCss) is an appended stylesheet line that paints every
// selection in the editor's theme colors, the variables VS Code hands every
// webview and updates live on a theme switch:
//   editor.selectionBackground          while the chat has focus
//   editor.inactiveSelectionBackground  once focus leaves it, the switch the
//                                       editor makes (natively an unfocused
//                                       frame paints its selection gray)
//   editor.selectionForeground          high-contrast themes only, the one
//                                       place Monaco applies it (HC Black
//                                       selects in white); elsewhere each run
//                                       keeps its own color
// Verified on Chromium 150: an author ::selection paints its background behind
// text exactly as given, and one that sets only the background keeps every
// run's own color (links, inline code). Over a selected <img> Chromium still
// blends an opaque author color toward white, which for a dark theme's color
// leaves an 80% veil, so images take the color at half strength (an inline
// <svg> takes no tint either way). A missing variable falls back to the system
// Highlight rather than to an invisible selection.
//
// The composer is the one place the highlight has to carry the text as well.
// Its editable draws its own text transparent (color and
// -webkit-text-fill-color both #0000) over a mirror sibling that renders the
// visible text with the mentions styled, so the native translucent highlight
// let the mirror show through where the editor's opaque color covers it, and
// a selection there read as a blank block. The line therefore paints the
// editable's selected glyphs itself, in the mirror's own color: the highlight
// pseudo needs both `color` (Blink paints selected text on its own only when
// the highlight's color is set) and `-webkit-text-fill-color` (the element's
// transparent fill would win otherwise). Found by the mirror rule and the
// editable rule sharing one hash, and skipped when that pair is gone; the
// repro's composer check is the canary. In high contrast the selection
// foreground takes over the fill as well, so its rule comes last.
//
// The focus switch is the JS half (selectionColors), since no selector
// follows frame focus (:window-inactive tracks the OS window, so it stays
// active while the editor has focus). On window blur it marks the selection's
// common ancestor with data-ccup-sel-inactive, which swaps --ccup-selection
// to the inactive color for that subtree, marks again when the selection
// moves while unfocused (the native find steps through matches with
// window.find), and unmarks on focus. A selection inside a contenteditable
// is marked on the editable's parent, so the editor never meets a foreign
// attribute in its own DOM, and no observer in the bundle watches the
// attribute (they filter on class and style). The mark goes on that subtree
// rather than on <html> because a ::selection rule reaching every element
// makes Blink compute a highlight style for each: a full recalc costs about
// twice as much (12ms to 23ms on a 34k-element page), which an <html>
// attribute would pay on every focus change.
// An always-on fix rather than a knob: the native highlight is the browser's,
// tied to no theme, so there is no native behavior worth keeping as an option.
// No anchor: both halves read only what VS Code provides, so every build takes
// them, each as one marked line (see ALWAYS_POINTS).
const SELECTION_MARKER = "/*ccup:selectionColors*/";
const SELECTION_CSS_MARKER = "/*ccup:selectionColorsCss*/";
// Set on the selection's subtree while the chat is unfocused.
const SELECTION_INACTIVE_ATTR = "data-ccup-sel-inactive";
// The JS half's once-only guard on window.
const SELECTION_FLAG = "__ccupSelectionColors";

// The composer's mirror pair: the mirror rule's hash and text color, and the
// editable of the same hash drawing its own text transparent.
const SELECTION_MIRROR_RE =
  /\.mentionMirror_([-\w]+)\{(?:[^}]*;)?color:([^;}]+)/;
const selectionEditableRe = (hash: string): RegExp =>
  new RegExp(`\\.messageInput_${hash}\\{(?:[^}]*;)?color:#0000[;}]`);

function selectionCssBuild(css: string): string {
  const v = "--ccup-selection";
  const hc = "var(--vscode-editor-selectionForeground,currentcolor)";
  const mirror = css.match(SELECTION_MIRROR_RE);
  const composer =
    mirror && selectionEditableRe(mirror[1]).test(css)
      ? `.messageInput_${mirror[1]}::selection{color:${mirror[2]};-webkit-text-fill-color:${mirror[2]}}`
      : "";
  return (
    SELECTION_CSS_MARKER +
    `:root{${v}:var(--vscode-editor-selectionBackground,Highlight)}` +
    `[${SELECTION_INACTIVE_ATTR}]{${v}:var(--vscode-editor-inactiveSelectionBackground,Highlight)}` +
    `::selection{background-color:var(${v})}` +
    `img::selection{background-color:color-mix(in srgb,var(${v}) 50%,transparent)}` +
    composer +
    `.vscode-high-contrast ::selection{color:${hc};-webkit-text-fill-color:${hc}}`
  );
}

function selectionWatchBuild(): string {
  const js =
    `(function(){try{` +
    `if(window.${SELECTION_FLAG})return;window.${SELECTION_FLAG}=1;` +
    `var A="${SELECTION_INACTIVE_ATTR}",m=null;` +
    `function off(){if(m){m.removeAttribute(A);m=null}}` +
    // The selection's common ancestor, lifted out of an editable.
    `function mark(){off();var s=getSelection();if(!s||!s.rangeCount||s.isCollapsed)return;` +
    `var n=s.getRangeAt(0).commonAncestorContainer,e=n.nodeType===1?n:n.parentElement,ed=e&&e.closest("[contenteditable]");` +
    `if(ed)e=ed.parentElement;if(e){e.setAttribute(A,"");m=e}}` +
    `addEventListener("blur",mark);addEventListener("focus",off);` +
    `document.addEventListener("selectionchange",function(){if(!document.hasFocus())mark()})` +
    `}catch(e){}})();`;
  return `${SELECTION_MARKER}${js}`;
}

// The webview bundle and stylesheet as an apply writes them, both halves in.
// scripts/repro's selection-colors.mjs serves this, so it runs exactly what
// the patcher writes.
export function selectionColorsWebview(
  js: string,
  css: string,
): { js: string; css: string } {
  return {
    js: cssApplyLine(js, SELECTION_MARKER, selectionWatchBuild()),
    css: cssApplyLine(css, SELECTION_CSS_MARKER, selectionCssBuild(css)),
  };
}

// Permission focus ring (always on): the composer answers focus with a border
// color change AND a soft halo (.inputContainer_<hash>:focus-within{...
// box-shadow:0 0 0 3px color-mix(in srgb,var(--focus-ring-color)12%,transparent),
// 0 1px 2px color-mix(in srgb,var(--focus-ring-color),transparent 80%)}), but
// the permission/question card that replaces it natively sets the border color
// alone, so the box that has the keyboard reads as flatter than the one it
// stood in for. We append the composer's own two-layer shadow to the card,
// driven by --app-input-active-border, the token the card's focused border
// already uses (the composer's ring color is a different, permission-mode-aware
// token, so reusing it would put an orange halo around a blue border). The card
// is overflow:hidden, which clips children rather than its own shadow, and it
// sits 16px inside the chat container, so the 3px ring has room to paint.
// An always-on fix rather than a knob: native applies this treatment to every
// other focused input, so the card's bare border is an oversight with no
// behavior worth keeping as an option (see ALWAYS_POINTS).
const PERM_RING_MARKER = "/*cc-ui-patch:permRing*/";
const PERM_REQ_CSS_HASH_RE = /\.permissionRequestContainer_([-\w]+)\{/;

function permRingBuild(c: string): string | undefined {
  const hash = c.match(PERM_REQ_CSS_HASH_RE)?.[1];
  if (!hash) return undefined; // anchor gone: leave native
  const ring =
    "0 0 0 3px color-mix(in srgb,var(--app-input-active-border) 12%,transparent)," +
    "0 1px 2px color-mix(in srgb,var(--app-input-active-border),transparent 80%)";
  return `${PERM_RING_MARKER}.permissionRequestContainer_${hash}:focus-within{box-shadow:${ring}}`;
}

// AskUserQuestion caret reveal (always on): the questions list
// (.questionsContainer_<hash>, overflow-y:auto capped at 40vh) is the scroll
// container around the growing "Other" answer box (.otherInput_<hash>, a
// bordered wrapper carrying the box's padding, inside an .option_<hash> row).
// Typing at the end of the box makes Chromium's caret reveal scroll that
// container just far enough to put the caret's line box at the fold, so the
// box's bottom padding and border, and the row padding under them, stay below
// the fold, and the container's overflow indicator (a border-bottom on the
// same element) draws a full-width line the text sits flush against: the box
// reads as having lost its padding while its real border is clipped out of
// view. Whether it shows depends only on the popup exceeding 40vh of the
// webview, so short panels hit it constantly and tall windows never do.
// Scroll-padding on the container makes every reveal keep the box chrome in
// view: box vertical padding + box border + option-row padding, plus 2px for
// fractional-height rounding (the reveal already aligns whole line boxes, so
// no glyph-descent term is needed; overshoot past max scroll just clamps).
// The same numbers inset upward reveals, showing the box's top edge when the
// caret surfaces mid-box. The three anchors below must all parse, with the
// container in its scrolling form, or the fix is skipped for that build.
// The permission popup's feedback box cannot hit this: its container is
// overflow:hidden with no scrollable ancestor, and the shared inner scroller
// (max-height-capped, natively 120px; chatPopupInputMaxLines can raise it)
// sits inside the padded wrapper, which therefore always keeps the 6px gap
// visible.
const QUESTION_REVEAL_MARKER = "/*cc-ui-patch:questionReveal*/";
const QUESTIONS_CONTAINER_RULE_RE =
  /\.questionsContainer_([-\w]+)\{[^{}]*?overflow-y:auto[^{}]*?\}/;
const OTHER_INPUT_RULE_RE =
  /\.otherInput_([-\w]+)\{[^{}]*?border:(\d+(?:\.\d+)?)px solid[^{}]*?padding:(\d+(?:\.\d+)?)px \d+(?:\.\d+)?px[^{}]*?\}/;
const OPTION_ROW_RULE_RE =
  /\.option_([-\w]+)\{[^{}]*?padding:(\d+(?:\.\d+)?)px\}/;

function questionRevealBuild(c: string): string | undefined {
  const qHash = c.match(QUESTIONS_CONTAINER_RULE_RE)?.[1];
  const box = c.match(OTHER_INPUT_RULE_RE);
  const row = c.match(OPTION_ROW_RULE_RE);
  if (!qHash || !box || !row) return undefined; // anchor gone: leave native
  const pad = Math.round(Number(box[2]) + Number(box[3]) + Number(row[2]) + 2);
  return `${QUESTION_REVEAL_MARKER}.questionsContainer_${qHash}{scroll-padding:${pad}px 0 ${pad}px}`;
}

// Expanded prompt header (always on, two halves): every user message is the
// sticky header of its turn (.message_<h>.stickyHeader_<h>, position:sticky;
// top:0), its content clamped at 250px behind a "Show more" button. "Show
// more" lifts the clamp and changes nothing about the pinning, so a prompt
// taller than the chat pins over the whole scrollport: the response scrolls by
// hidden underneath it, a wheel over the prompt moves that hidden response
// while the prompt itself stays put, and the only thing that ever surfaces is
// the next turn's header, right under the open one, until "Show less" collapses
// it again.
//
// The header keeps pinning in both states (it is the turn's label for as long
// as any of the turn's response is in view); what changes is that an open
// prompt gets a ceiling and its own scroller. The CSS half (expandedHeader)
// caps the open content at max(250px, 50vh) with overflow-y:auto, so an open
// prompt takes at most half the chat and a wheel over it reads the prompt, and
// puts overscroll-behavior:contain on it while it overflows, so reaching the
// prompt's end never spills into the transcript: the prompt is its own layer,
// and the response is scrolled by pointing at the response. The contain rule is
// keyed to a data-ccup-own attribute rather than unconditional because a scroll
// container with nothing to scroll and contain set swallows the wheel entirely,
// which would make a short open prompt a dead zone. The content's native
// max-height transition never ran (250px to none is not interpolable) but
// would between the clamp and the cap, in both directions; transition:none on
// the content keeps open and close instant, as they were.
//
// From 2.1.307 on the build caps the bubble itself (the header's .userMessage_
// block, overflow-y:auto under max-height:40vh), so an open prompt already has
// a ceiling and a scroller, with "Show less" at the scroller's end, in view
// only once the prompt is read to its end. The content cap above, nested in
// it, put a 50vh scroller inside a 40vh one: the content's last lines and the
// button sat below the bubble's clip, and contain kept the wheel from ever
// scrolling the bubble to them. Where the stylesheet's bubble rule carries that
// cap, the CSS half writes a second form instead: no content cap, the "Show
// less" row sticky at the bubble's bottom edge, and contain keyed to the
// bubble. Stuck, the row floats over the text and stays in reach however far
// the prompt is scrolled; at the end it rests in its own slot below the last
// line, so it never hides the end of the text. Chromium measures bottom:0
// inside the bubble's padding, so the stuck row and the resting one sit on the
// same line and nothing jumps as the end arrives. The row is as wide as the
// prompt, so it passes the pointer through to the text beside its button.
//
// The JS half (expandedView) is a capture-phase click listener on the document:
//   Show more: parks one ResizeObserver on the clicked expandable's content
//     and its bubble that sets or clears data-ccup-own on each by whether it
//     overflows its box, now and on any later resize; the observer is parked
//     on the content it watches, so they fall out of reach together. Each
//     form keys contain to its own scroller, and the other box, uncapped,
//     never overflows (the bubble before 2.1.307, the content after), so one
//     script serves both.
//   Show less: resets both scrollTops to 0 (the offset survives the collapse,
//     and the preview would show the prompt's end) and drops the observer and
//     the attributes, so a collapsed prompt never carries contain.
//
// What the transcript does when a stuck prompt grows is Chromium's own scroll
// anchoring, verified in the repro rather than scripted: the anchor is a
// response paragraph below the header (sticky boxes are skipped), the growth
// moves it down in the document, and the scroller follows by exactly the
// growth, so on screen the response stays where it was and the header simply
// covers more of it; "Show less" reverses that to the pixel. A prompt at its
// natural position opens in place, pushing what follows down, and springs back
// on "Show less". An open prompt starts at its beginning, continuing from
// where the clamp cut.
//
// An always-on fix rather than a knob: a header covering the chat is never the
// wanted behavior, and a collapsed header behaves exactly as before. Anchors:
// the stylesheet's sticky rule and its content/collapsed rule for the CSS half
// (plus, in the second form, the expandable's container and button-row rules),
// and for the JS half the expandable's whole class map (one hash from
// expandableContainer through collapseButton, since another module also names
// an expandButton) plus the stickyHeader and userMessage keys of the header's
// module; either half skips on its own when its anchors are gone.
const EXPANDED_HEADER_MARKER = "/*cc-ui-patch:expandedHeader*/";
const EXPANDED_VIEW_MARKER = "/*cc-ui-patch:expandedView*/";
const STICKY_HEADER_RULE_RE =
  /\.message_([-\w]+)\.stickyHeader_([-\w]+)\{[^{}]*?position:sticky[^{}]*?\}/;
// The expandable's content rule, with the collapsed class on the same hash.
const EXPANDABLE_CONTENT_RULE_RE = /\.content_([-\w]+)\.collapsed_\1\{/;
const EXPANDABLE_MAP_RE =
  /expandableContainer:"expandableContainer_([-\w]+)",content:"content_\1",collapsed:"collapsed_\1",truncationGradient:"truncationGradient_\1",expandButton:"expandButton_\1",buttonContainer:"buttonContainer_\1",collapseButton:"collapseButton_\1"/;
const EXPANDED_STICKY_HASH_RE = /stickyHeader:"stickyHeader_([-\w]+)"/;
// The bubble's rule under the sticky header, on the header's own hashes.
const STICKY_BUBBLE_RULE_RE = (msg: string, sticky: string): RegExp =>
  new RegExp(
    `\\.message_${msg}\\.stickyHeader_${sticky} \\.userMessage_([-\\w]+)\\{([^}]*)\\}`,
  );
// The open content's ceiling: never below the native clamp, at most half the
// chat, so the response under a stuck prompt always keeps a hoverable share.
const EXPANDED_FLOOR = 250;
const EXPANDED_CAP = "50vh";
// Set on an open content box while it overflows: the hook for contain.
const EXPANDED_OWN_ATTR = "data-ccup-own";
// The JS half's once-only guard on window, and its observer expando.
const EXPANDED_VIEW_FLAG = "__ccupExpandedView";
const EXPANDED_RO_PROP = "__ccupExpandedRo";

// The bubble's hash where the build caps the bubble itself (overflow-y:auto or
// scroll under a max-height, 2.1.307 on), else undefined.
function stickyBubbleCap(
  c: string,
  msg: string,
  sticky: string,
): string | undefined {
  const rule = c.match(STICKY_BUBBLE_RULE_RE(msg, sticky));
  if (!rule) return undefined;
  const capped =
    /(?:^|;)max-height:/.test(rule[2]) &&
    /(?:^|;)overflow-y:(?:auto|scroll)(?:;|$)/.test(rule[2]);
  return capped ? rule[1] : undefined;
}

function expandedHeaderBuild(c: string): string | undefined {
  const sticky = c.match(STICKY_HEADER_RULE_RE);
  const box = c.match(EXPANDABLE_CONTENT_RULE_RE)?.[1];
  if (!sticky || !box) return undefined; // anchor gone: leave native
  const head = `.message_${sticky[1]}.stickyHeader_${sticky[2]}`;
  const bubble = stickyBubbleCap(c, sticky[1], sticky[2]);
  if (bubble !== undefined) {
    // The build's bubble is the scroller: pin the "Show less" row to it.
    const row = `.buttonContainer_${box}`;
    const exp = `.expandableContainer_${box}`;
    if (!c.includes(`${row}{`) || !c.includes(`${exp}{`)) return undefined;
    return (
      `${EXPANDED_HEADER_MARKER}${head} ${exp}>${row}{position:sticky;bottom:0;pointer-events:none}` +
      `${head} ${exp}>${row}>*{pointer-events:auto}` +
      `${head} .userMessage_${bubble}[${EXPANDED_OWN_ATTR}]{overscroll-behavior:contain}`
    );
  }
  const content = `${head} .content_${box}`;
  const open = `${content}:not(.collapsed_${box})`;
  return (
    `${EXPANDED_HEADER_MARKER}${content}{transition:none}` +
    `${open}{max-height:max(${EXPANDED_FLOOR}px,${EXPANDED_CAP});overflow-y:auto}` +
    `${open}[${EXPANDED_OWN_ATTR}]{overscroll-behavior:contain}`
  );
}

function expandedViewBuild(c: string): string | undefined {
  const box = c.match(EXPANDABLE_MAP_RE)?.[1];
  const sticky = c.match(EXPANDED_STICKY_HASH_RE)?.[1];
  if (!box || !sticky) return undefined; // anchor gone: leave native
  if (!c.includes(`userMessage:"userMessage_${sticky}"`)) return undefined;
  const js =
    `(function(){try{` +
    `if(window.${EXPANDED_VIEW_FLAG})return;window.${EXPANDED_VIEW_FLAG}=1;` +
    `var RO="${EXPANDED_RO_PROP}";` +
    `function own(c){if(c.scrollHeight>c.clientHeight+1)c.setAttribute("${EXPANDED_OWN_ATTR}","");else c.removeAttribute("${EXPANDED_OWN_ATTR}")}` +
    `document.addEventListener("click",function(e){` +
    `var el=e.target,b=el&&el.closest?el.closest(".expandButton_${box},.collapseButton_${box}"):null;if(!b)return;` +
    // The clicked expandable's own content, and the bubble holding it.
    `var h=b.closest(".stickyHeader_${sticky}"),x=h&&b.closest(".expandableContainer_${box}"),c=x&&x.querySelector(".content_${box}");if(!c)return;` +
    `var u=c.closest(".userMessage_${sticky}"),s=u&&h.contains(u)?[c,u]:[c];` +
    // Show more: follow both boxes as the prompt opens, and mark each while it overflows.
    `if(b.classList.contains("expandButton_${box}")){if(!c[RO]&&window.ResizeObserver){var o=c[RO]=new ResizeObserver(function(){s.forEach(own)});s.forEach(function(t){o.observe(t)})}}` +
    // Show less: the preview shows the start again, and carries no contain.
    `else{s.forEach(function(t){t.scrollTop=0;t.removeAttribute("${EXPANDED_OWN_ATTR}")});if(c[RO]){c[RO].disconnect();delete c[RO]}}` +
    `},!0)` +
    `}catch(e){}})();`;
  return `${EXPANDED_VIEW_MARKER}${js}`;
}

// The webview bundle and stylesheet as an apply writes them, both halves in,
// or null when an anchor of either is gone. scripts/repro's
// expanded-header.mjs serves this, so it runs exactly what the patcher writes.
export function expandedHeaderWebview(
  js: string,
  css: string,
): { js: string; css: string } | null {
  const view = expandedViewBuild(js);
  const header = expandedHeaderBuild(css);
  if (view === undefined || header === undefined) return null;
  return {
    js: cssApplyLine(js, EXPANDED_VIEW_MARKER, view),
    css: cssApplyLine(css, EXPANDED_HEADER_MARKER, header),
  };
}

// Hidden cursor (always on, two halves): macOS hides the mouse cursor while
// you type in a text field, and the page should then act as if no pointer were
// there at all. Whenever layout moves content under a resting pointer,
// Chromium re-runs the hit test there with a synthetic move that updates
// :hover and sends the boundary events (the over/out and enter/leave pairs,
// pointer and mouse) but no move. It skips that synthetic move while it knows
// the cursor is hidden, but only its Aura views report that state to the
// renderer: on macOS the browser process hides the cursor in AppKit alone
// (setHiddenUntilMouseMoves on a keyDown in a text input without Command,
// cleared on the next NSEventTypeMouseMoved), and Blink never hears of it. So
// the input box growing as you type carries the mic button and this patch's
// buttons up under the hidden cursor, which hovers them: their tooltips pop up
// over the text being typed, a question popup arriving under it opens an
// option's preview, and whatever else reacts to hover reacts to a cursor
// nobody can see.
//
// The halves emulate the platform rule in the page, and leave hit testing
// alone, so a click or a wheel at the resting cursor lands exactly as natively:
//   hiddenCursorWatch (JS)  macOS only, capture-phase listeners on window.
//     Hide: a trusted keydown with focus in a text input, no Meta, and not a
//       lone modifier, which is Chromium's own autohide condition. It marks
//       the hovered chain with data-ccup-nohover and sends a synthetic leave
//       from the chain's deepest element (pointerout, pointerleave up the
//       chain, mouseout, mouseleave, relatedTarget null), as if the pointer
//       had left the page.
//     Hidden: every trusted boundary event stops at window, before anything
//       else sees it (React listens on its root, further down). A pointerover
//       or mouseover first marks the chain under its target, which is how
//       elements that layout carries under the cursor join the marked set.
//     Reveal: the first trusted pointermove unmarks them all and sends a
//       synthetic enter at its target (pointerover, pointerenter down the
//       chain, mouseover, mouseenter), as if the pointer had just come into
//       the page, and the move itself then goes on. A click does not reveal,
//       matching Chromium, which clears its flag on a move only.
//   hiddenCursorHover (CSS)  every :hover in the stylesheet's selectors gets
//     :where(:not([data-ccup-nohover])), so a marked element matches no hover
//     rule, whether its :hover sits in the subject compound, an ancestor one,
//     or inside :not() (where a marked element reads as not hovered, as it
//     should). :where() adds no specificity, so the cascade is unchanged. The
//     mark goes on the hovered elements rather than on <html>, because an
//     attribute flip on <html> invalidates every element any hover rule names:
//     73ms against 5.7ms for marking a hovered chain, on a synthetic page of
//     80,000 elements. This patch's own stylesheet lines are skipped, since
//     their builders write the same gate (HOVER).
// An always-on fix rather than a knob: a hidden cursor that still triggers
// things is never the wanted behavior. Neither half has an anchor, and the CSS
// half reports missing only when the stylesheet has no :hover left to gate. Out
// of reach: native title tooltips, which Blink raises from the hit test itself
// (unreliable inside the webview anyway, see HOVER_TIP_CSS).
const HIDDEN_CURSOR_MARKER = "/*ccup:hiddenCursor*/";
// Set on an element while the hidden cursor hovers it: no hover rule matches it.
const NOHOVER_ATTR = "data-ccup-nohover";
// The gate after each :hover of the native stylesheet, behind its strip marker.
const NOHOVER_FRAG = `/*ccup:nohover*/:where(:not([${NOHOVER_ATTR}]))`;
const NOHOVER_FRAG_RE =
  /\/\*ccup:nohover\*\/:where\(:not\(\[data-ccup-nohover\]\)\)/g;
// The same gate for this patch's own hover rules, whose lines strip whole.
const HOVER = `:hover:where(:not([${NOHOVER_ATTR}]))`;
// The JS half's once-only guard on window.
const HIDDEN_CURSOR_FLAG = "__ccupHiddenCursor";
// Grouping at-rules hold rules of their own. Any other at-rule block is copied
// whole: keyframes, font faces, and the like carry no selectors.
const CSS_GROUP_AT_RE =
  /^@(?:media|supports|container|layer|scope|starting-style|document|-moz-document)\b/i;

// The stylesheet with NOHOVER_FRAG after every :hover in its selectors, and how
// many it gated. Comments, strings, escapes, and declaration blocks are copied
// as they are, and so are this patch's own marked lines (each starts a line
// with a ccup or cc-ui-patch comment) and a :hover after a pseudo-element in
// the same compound, where a :where() would void the whole rule.
function gateHovers(css: string): { out: string; count: number } {
  const n = css.length;
  let count = 0;
  // Index just past the comment, string, or escape at j, or j if none starts there.
  const atomEnd = (j: number): number => {
    const ch = css[j];
    if (ch === "/" && css[j + 1] === "*") {
      const e = css.indexOf("*/", j + 2);
      return e < 0 ? n : e + 2;
    }
    if (ch === '"' || ch === "'") {
      let k = j + 1;
      while (k < n && css[k] !== ch && css[k] !== "\n") {
        k += css[k] === "\\" ? 2 : 1;
      }
      return Math.min(n, k + 1);
    }
    return ch === "\\" ? Math.min(n, j + 2) : j;
  };
  // Index just past the "}" that closes the block opened at j.
  const blockEnd = (j: number): number => {
    let depth = 0;
    for (let k = j; k < n;) {
      const a = atomEnd(k);
      if (a !== k) {
        k = a;
        continue;
      }
      if (css[k] === "{") depth++;
      else if (css[k] === "}" && --depth === 0) return k + 1;
      k++;
    }
    return n;
  };
  // The selector text from s to e with the gate after each :hover.
  const gate = (s: number, e: number): string => {
    let r = "";
    for (let k = s; k < e;) {
      const a = atomEnd(k);
      if (a !== k) {
        r += css.slice(k, a);
        k = a;
        continue;
      }
      if (css.startsWith(":hover", k) && !/[-\w]/.test(css[k + 6] ?? "")) {
        const from = Math.max(
          ...[" ", ">", "+", "~", ",", "("].map((c) => r.lastIndexOf(c)),
        );
        r += ":hover";
        if (!r.slice(from + 1).includes("::")) {
          r += NOHOVER_FRAG;
          count++;
        }
        k += 6;
        continue;
      }
      r += css[k++];
    }
    return r;
  };
  const ownLine = (j: number): boolean =>
    (j === 0 || css[j - 1] === "\n") &&
    (css.startsWith("/*ccup:", j) || css.startsWith("/*cc-ui-patch:", j));
  // The rule list from i to the "}" that closes it (to the end at the top).
  const list = (i: number, top: boolean): [string, number] => {
    let out = "";
    while (i < n) {
      let w = i;
      while (w < n && /\s/.test(css[w])) w++;
      out += css.slice(i, w);
      i = w;
      if (i >= n) break;
      if (top && ownLine(i)) {
        const e = css.indexOf("\n", i);
        out += css.slice(i, e < 0 ? n : e);
        i = e < 0 ? n : e;
        continue;
      }
      if (css[i] === "}") {
        if (!top) return [out + "}", i + 1];
        out += css[i++];
        continue;
      }
      // The prelude runs to its "{", or to the ";" of a statement at-rule.
      let k = i;
      while (k < n) {
        const a = atomEnd(k);
        if (a !== k) {
          k = a;
          continue;
        }
        if (css[k] === "{" || css[k] === ";" || css[k] === "}") break;
        k++;
      }
      if (k >= n || css[k] !== "{") {
        const e = k < n && css[k] === ";" ? k + 1 : k;
        out += css.slice(i, e);
        i = e;
        continue;
      }
      if (css[i] === "@") {
        if (CSS_GROUP_AT_RE.test(css.slice(i, k))) {
          const [inner, after] = list(k + 1, false);
          out += css.slice(i, k + 1) + inner;
          i = after;
        } else {
          const e = blockEnd(k);
          out += css.slice(i, e);
          i = e;
        }
        continue;
      }
      const e = blockEnd(k);
      out += gate(i, k) + css.slice(k, e);
      i = e;
    }
    return [out, i];
  };
  return { out: list(0, true)[0], count };
}

// The native stylesheet with the gate in, or null when it has no :hover to gate.
function hiddenCursorHoverPatch(native: string): string | null {
  const { out, count } = gateHovers(native);
  return count ? out : null;
}

function hiddenCursorWatchBuild(): string {
  const js =
    `(function(){try{` +
    `if(window.${HIDDEN_CURSOR_FLAG})return;window.${HIDDEN_CURSOR_FLAG}=1;` +
    // The one platform known to hide the cursor behind Blink's back.
    `if(!/^Mac/.test(navigator.platform||""))return;` +
    `var A="${NOHOVER_ATTR}",hid=0,marked=[],x=0,y=0,sx=0,sy=0,` +
    `MOD={Shift:1,Control:1,Alt:1,AltGraph:1,Meta:1,CapsLock:1,Fn:1,FnLock:1,Hyper:1,Super:1,Symbol:1,SymbolLock:1,OS:1},` +
    `TXT=/^(?:text|search|url|email|tel|password|number)$/;` +
    // Focus in a text input: where Chromium's autohide applies.
    `function typing(el){return!!el&&!el.disabled&&!el.readOnly&&(el.isContentEditable||el.tagName==="TEXTAREA"||el.tagName==="INPUT"&&TXT.test(el.type))}` +
    `function mark(el){for(var n=el;n&&n.nodeType===1;n=n.parentElement)if(!n.hasAttribute(A)){n.setAttribute(A,"");marked.push(n)}}` +
    `function fire(t,el,b){var o={bubbles:b,cancelable:b,composed:!0,view:window,clientX:x,clientY:y,screenX:sx,screenY:sy,relatedTarget:null};` +
    `if(t.charAt(0)==="p"){o.pointerId=1;o.pointerType="mouse";o.isPrimary=!0;el.dispatchEvent(new PointerEvent(t,o))}else el.dispatchEvent(new MouseEvent(t,o))}` +
    // The boundary events of the pointer leaving the page from el, or entering it at el.
    `function cross(el,inn){var c=[],n,i,p=inn?["pointerover","pointerenter","mouseover","mouseenter"]:["pointerout","pointerleave","mouseout","mouseleave"];` +
    `for(n=el;n&&n.nodeType===1;n=n.parentElement)c.push(n);if(inn)c.reverse();` +
    `fire(p[0],el,!0);for(i=0;i<c.length;i++)fire(p[1],c[i],!1);fire(p[2],el,!0);for(i=0;i<c.length;i++)fire(p[3],c[i],!1)}` +
    `addEventListener("keydown",function(e){if(hid||!e.isTrusted||e.metaKey||MOD[e.key]||!typing(document.activeElement))return;` +
    `var h=document.querySelectorAll(":hover"),el=h[h.length-1];hid=1;if(el){mark(el);cross(el,!1)}},!0);` +
    // Hidden: layout re-hovers in silence, and whatever it lands on is marked.
    `["pointerover","pointerout","pointerenter","pointerleave","mouseover","mouseout","mouseenter","mouseleave"].forEach(function(t){` +
    `var over=t.slice(-4)==="over";addEventListener(t,function(e){if(!hid||!e.isTrusted)return;if(over)mark(e.target);e.stopImmediatePropagation()},!0)});` +
    `addEventListener("pointermove",function(e){if(!e.isTrusted)return;x=e.clientX;y=e.clientY;sx=e.screenX;sy=e.screenY;` +
    `if(!hid)return;hid=0;for(var i=0;i<marked.length;i++)marked[i].removeAttribute(A);marked=[];` +
    `if(e.target&&e.target.nodeType===1)cross(e.target,!0)},!0)` +
    `}catch(e){}})();`;
  return `${HIDDEN_CURSOR_MARKER}${js}`;
}

// The webview bundle and stylesheet, patched or not, as an apply writes them
// with both hidden-cursor halves in and the toggles whose buttons carry a tip
// on (scroll-to-bottom, jump, find bar), or null when an anchor of any of them
// is gone. scripts/repro's hidden-cursor.mjs serves this, so it runs exactly
// what the patcher writes and doubles as the canary for both halves.
export function hiddenCursorWebview(
  js: string,
  css: string,
): { js: string; css: string } | null {
  const bar = findBarCssBuild(css);
  const out = findBarSet(jumpMsgSet(scrollDotSet(js, true), true), true);
  const on =
    scrollDotCurrentOn(out) === true &&
    jumpMsgCurrentOn(out) === true &&
    findBarCurrentOn(out) === true;
  if (!bar || !on) return null;
  const gated = hiddenCursorHoverPatch(
    cssApplyLine(css.replace(NOHOVER_FRAG_RE, ""), FINDBAR_CSS_MARKER, bar),
  );
  if (gated === null) return null;
  return {
    js: cssApplyLine(out, HIDDEN_CURSOR_MARKER, hiddenCursorWatchBuild()),
    css: gated,
  };
}

// ---------------------------------------------------------------------------
// Session delete (always on, two halves): the session list (the chat header's
// history dropdown and the sidebar's session list render the same rows) offers
// rename, archive and unarchive on hover, and nothing anywhere deletes a
// conversation: the host knows archive_session, unarchive_session(s) and
// rename_session, and no delete request at all. Every local row with a
// transcript, archived or not, gets a third button that moves the
// conversation to the OS trash, except the row of the session its view shows.
//
// The webview half (sessionDelete) is one fragment in the row component: a
// sibling element right after the unarchive button in the actions span, built
// from that button's own jsx factory and class-map members, with Heroicons'
// trash beside the set's archive and unarchive icons. It renders where the
// list hands the row an archive or an unarchive handler (a local row; the Web
// tab passes neither) and the session has an id. A first click arms it: the
// row's other buttons hide, and the icon gives way to a bold red "sure?" (as
// on last turn delete's button) flush with the right edge of the row's button
// group, and leaving the button or its focus disarms it. A second click sends
// {type:"delete_session",sessionId,title,confirmed:true} through the
// session's connectionProvider, the shared transport, without the per-session
// listener wiring getConnection would add to a row that is about to go, and
// dims the row until the list drops it. A host still running its pre-patch
// code answers "Unknown request type.", which the click turns into a native
// notification asking for the reload that loads the handler.
//
// The host half (sessionDeleteHost) is three fragments in extension.js:
//   wire    at the head of the webview provider's wireLiveRegistry(comms),
//           which runs for every chat panel, the sidebar and the session list
//           alike: ccupOpenHere(id), the provider's own sessionOpenHere test
//           (a panel holds the session, or the sidebar shows it) plus the
//           remembered tabs a reload has not revived yet, and ccupPeers(),
//           every live comms
//   route   at the head of the comms subclass's processRequest: delete_session
//           goes to the method below, everything else falls through untouched
//   method  ccupDeleteSession, ahead of processRequest in the same class,
//           running the compiled ccupSessionDeleteHost with the session store
// The handler refuses while anything could still write the transcript, moves
// the transcript and the session's folder beside it to the trash (asking in a
// modal before a permanent delete where the file system has none), and sends
// session_store_changed to every comms: the one notice after which a list's
// re-read drops sessions missing from disk (an archive_sync re-read keeps
// them). A request without `confirmed` comes from a webview loaded before the
// button confirmed in place, whose single click confirmed nothing, so it gets
// a reload notice and deletes nothing. Builds without the live-session
// registry (2.1.270 has no sessionHeldElsewhere hook) cannot tell whether
// another window or a terminal holds a session, so the provider anchors
// require it.
//
// The halves are all or nothing across the two files: each builds only when
// the other file's sites are found too, so a drifted build never shows a
// button with no handler behind it. Every site is found by structure
// (src/derive.ts) and required exactly once, the minified names an insertion
// reads are taken from the site and checked to resolve there, and the touched
// units are parsed again after the edits. Each insertion is wrapped in
// /*ccup:sdel:<site>*/.../*ccup:sdelEnd*/, so stripping the fragments restores
// the stock bytes.
// ---------------------------------------------------------------------------
const SDEL_END = "/*ccup:sdelEnd*/";
const SDEL_ROW = "/*ccup:sdel:row*/";
const SDEL_WIRE = "/*ccup:sdel:wire*/";
const SDEL_ROUTE = "/*ccup:sdel:route*/";
const SDEL_METHOD = "/*ccup:sdel:method*/";
const SDEL_FRAG_RE = /\/\*ccup:sdel:[-\w]+\*\/[\s\S]*?\/\*ccup:sdelEnd\*\//g;
const SDEL_WEBVIEW_FILE = "webview/index.js";
const SDEL_HOST_FILE = "extension.js";
const sdelEdit = (marker: string, e: Edit): Edit => ({
  pos: e.pos,
  text: `${marker}${e.text}${SDEL_END}`,
});
const sdelStrip = (c: string): string => c.replace(SDEL_FRAG_RE, "");

// The props the session row destructures, and how far ahead of one its
// function keyword may sit.
const SDEL_ROW_KEYS = ["session", "isActive", "onArchive", "onUnarchive"];
const SDEL_PARAMS_REACH = 2000;
// How far ahead of a member token its class may start (the comms base class
// alone spans about 145KB).
const SDEL_CLASS_REACH = 400000;
// Heroicons' outline trash, the set the row's archive and unarchive icons
// come from (the bundle ships the same path for its own trash icon).
const SDEL_TRASH_D =
  "m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0";
// The button's click and disarm, kept on window so every row shares one copy
// (see ccupSessionDeleteWeb).
const SDEL_HELPER_PROP = "__ccupSessionDelete";
const SDEL_RESTART_NOTE = "Reload the window to start using session delete.";
// How far in from the list's right edge every row's button group (the actions
// span holding rename, archive or unarchive, and delete) ends. The list's
// overlay scrollbar, once hovered, covers the last 16px (VS Code 1.143 on
// macOS, as for PROMPT_HIST_DEL_INSET), and the list has no padding of its
// own, so past the row's 8px of padding the group keeps a margin for the rest
// plus a few pixels of air. The time label sharing the group's slot stays
// where it is.
const SDEL_GROUP_INSET = 20;
const SDEL_ROW_PAD = 8;

// The sheet the helper adds: the inset, when the group's class is known, and
// the button's states. While a button is armed, its group hides the other
// buttons, keeping their room so the row does not reflow, and the button
// trades its icon for a bold red "sure?" chip (the look of last turn delete's
// chip), as tall as the group and flush with its right edge. A row whose
// delete is out dims and takes no pointer.
function sdelCss(group: string | null): string {
  return (
    (group
      ? `.${group}{margin-right:${SDEL_GROUP_INSET - SDEL_ROW_PAD}px}`
      : "") +
    "[data-ccup-sdel-bar]{position:relative}" +
    "[data-ccup-sdel-bar]>:not([data-ccup-sdel-arm]){visibility:hidden}" +
    "[data-ccup-sdel-arm]>svg{visibility:hidden}" +
    '[data-ccup-sdel-arm]::after{content:"sure?";position:absolute;top:0;right:0;bottom:0;display:flex;align-items:center;padding:0 6px;border-radius:4px;background:var(--app-menu-background);box-shadow:0 0 0 1px var(--app-input-border);color:var(--vscode-errorForeground,#f14c4c);font-weight:700;white-space:nowrap}' +
    "[data-ccup-sdel-going]{opacity:.5;pointer-events:none}"
  );
}

// The delete button's helper, compiled into the webview bundle by toString,
// so it may use only its parameters and the page's globals (the DOM through
// the any-typed globalThis, since the project compiles without the DOM lib).
// click(session, button) arms a button, or sends one delete_session from an
// armed one, and the host deletes and refreshes every list without asking
// again; off(button) disarms. A session whose request is still out takes no
// further click.
function ccupSessionDeleteWeb(
  css: string,
  reloadNote: string,
): { click(s: any, el: any): void; off(el: any): void } {
  const g = globalThis as Record<string, any>;
  try {
    const sheet = g.document.createElement("style");
    sheet.textContent = css;
    g.document.head.appendChild(sheet);
  } catch {
    // no sheet: an armed button looks unchanged but still takes two clicks
  }
  const busy = new Set<string>();
  const off = (el: any): void => {
    if (!el?.hasAttribute?.("data-ccup-sdel-arm")) return;
    el.removeAttribute("data-ccup-sdel-arm");
    el.removeAttribute("aria-label");
    el.parentElement?.removeAttribute("data-ccup-sdel-bar");
  };
  const click = (s: any, el: any): void => {
    try {
      const id = s.sessionId.value;
      if (!id || busy.has(id)) return;
      if (!el.hasAttribute("data-ccup-sdel-arm")) {
        el.setAttribute("data-ccup-sdel-arm", "");
        el.setAttribute("aria-label", "Confirm: delete session");
        el.parentElement?.setAttribute("data-ccup-sdel-bar", "");
        return;
      }
      off(el);
      busy.add(id);
      const row = el.closest("button");
      row?.setAttribute("data-ccup-sdel-going", "");
      let deleted = false;
      Promise.resolve()
        .then(() => s.connectionProvider())
        .then((c: any) =>
          c
            .sendRequest({
              type: "delete_session",
              sessionId: id,
              title: s.summary?.value || "Untitled",
              confirmed: true,
            })
            .then(
              (r: any) => {
                deleted = r?.deleted === true;
              },
              (e: any) => {
                const m = e?.message || String(e);
                return c.showNotification(
                  m === "Unknown request type."
                    ? reloadNote
                    : `Could not delete the session: ${m}`,
                  "warning",
                );
              },
            ),
        )
        .catch(() => {})
        .finally(() => {
          busy.delete(id);
          // A deleted row leaves with the list's next read, which the host
          // asks for before it answers; one still listed by then wakes up.
          g.setTimeout(
            () => row?.removeAttribute("data-ccup-sdel-going"),
            deleted ? 5000 : 0,
          );
        });
    } catch {
      // a click never breaks the list
    }
  };
  return { click, off };
}

// Whether `fn`'s own body calls `name(arg)`.
function sdelCallsWith(fn: N, name: string, arg: string): boolean {
  let hit = false;
  walkOwn(fn, (n) => {
    if (hit) return false;
    if (
      n.type === "CallExpression" &&
      idName(n.callee) === name &&
      n.arguments.length === 1 &&
      idName(n.arguments[0]) === arg
    )
      hit = true;
  });
  return hit;
}

// The row component and the insertion that adds its delete button, or null.
function sdelRowFind(c: string): { unit: N; edit: Edit } | null {
  const rows = unitsWith(
    c,
    "onUnarchive:",
    "function",
    isFn,
    SDEL_PARAMS_REACH,
  ).filter((f) => hasKeys(f.params[0], SDEL_ROW_KEYS));
  if (rows.length !== 1) return null;
  const row = rows[0];
  const ps = row.params[0];
  const sess = boundName(ps, "session");
  const active = boundName(ps, "isActive");
  const archive = boundName(ps, "onArchive");
  const unarchive = boundName(ps, "onUnarchive");
  if (!sess || !active || !archive || !unarchive) return null;

  // The archive and unarchive buttons, `cb&&jsx("span",{...})` with a click
  // that calls cb(session), siblings in the actions span's children array.
  const buttons: { el: N; call: N; props: N; cb: string }[] = [];
  let readsId = false;
  walk(row, (n) => {
    if (memberProp(n) === "value" && isMember(n.object, sess, "sessionId"))
      readsId = true;
    if (n.type !== "LogicalExpression" || n.operator !== "&&") return;
    const cb = idName(n.left);
    const call = n.right;
    if ((cb !== archive && cb !== unarchive) || call.type !== "CallExpression")
      return;
    const props = call.arguments[1];
    if (
      call.arguments.length !== 2 ||
      !isStr(call.arguments[0], "span") ||
      !hasKeys(props, ["className", "onClick", "title", "children"])
    )
      return;
    const click = propOf(props, "onClick")!.value;
    if (isFn(click) && sdelCallsWith(click, cb, sess))
      buttons.push({ el: n, call, props, cb });
  });
  const un = buttons.filter((b) => b.cb === unarchive);
  const ar = buttons.filter((b) => b.cb === archive);
  if (!readsId || un.length !== 1 || ar.length !== 1) return null;
  const { el, call, props } = un[0];
  if (el.parent?.type !== "ArrayExpression" || ar[0].el.parent !== el.parent)
    return null;

  // The button's factory and class-map member, and its icon's: the new
  // button repeats them, so it renders and styles exactly like its siblings.
  const jsx = idName(call.callee);
  const btnCls = propOf(props, "className")!.value;
  const icon = propOf(props, "children")!.value;
  const iconProps = icon.type === "CallExpression" ? icon.arguments[1] : null;
  const iconCls = hasKeys(iconProps, ["className"])
    ? propOf(iconProps, "className")!.value
    : null;
  const isSheetMember = (m: N | null) => !!memberProp(m) && !!idName(m!.object);
  if (!jsx || !isSheetMember(btnCls) || !isSheetMember(iconCls)) return null;
  for (const name of [sess, active, archive, unarchive]) {
    if (bindingSite(el, name, row) !== row) return null;
  }
  // The button group, the element whose children array holds the buttons,
  // and its class from the bundle's class map, for the inset rule. A group
  // whose class cannot be told apart keeps the native inset.
  const kids = el.parent.parent;
  const groupProps: N | null =
    kids?.type === "Property" && keyName(kids) === "children"
      ? (kids.parent ?? null)
      : null;
  const groupCls =
    groupProps && hasKeys(groupProps, ["className", "children"])
      ? propOf(groupProps, "className")!.value
      : null;
  const groupKey = isSheetMember(groupCls) ? memberProp(groupCls) : null;
  const groups =
    groupKey && /^\w+$/.test(groupKey)
      ? new Set(
          [
            ...c.matchAll(
              new RegExp(`[{,]${groupKey}:"(${groupKey}_[-\\w]+)"`, "g"),
            ),
          ].map((m) => m[1]),
        )
      : new Set<string>();
  const group = groups.size === 1 ? [...groups][0] : null;

  const del = "ccupDel";
  const ev = "ccupEv";
  const fire = `${del}.click(${sess},${ev}.currentTarget)`;
  const disarm = `(${ev})=>${del}.off(${ev}.currentTarget)`;
  const svg =
    `${jsx}("svg",{xmlns:"http://www.w3.org/2000/svg",fill:"none",viewBox:"0 0 24 24",` +
    `strokeWidth:1.5,stroke:"currentColor","aria-hidden":"true",` +
    `className:${c.slice(iconCls!.start, iconCls!.end)},` +
    `children:${jsx}("path",{strokeLinecap:"round",strokeLinejoin:"round",` +
    `d:${JSON.stringify(SDEL_TRASH_D)}})})`;
  // A held Enter repeats, and must not confirm what its first press armed.
  const button =
    `${jsx}("span",{role:"button",tabIndex:0,` +
    `className:${c.slice(btnCls.start, btnCls.end)},` +
    `onClick:(${ev})=>{${ev}.stopPropagation(),${fire}},` +
    `onKeyDown:(${ev})=>{if(${ev}.key==="Enter"||${ev}.key===" "){${ev}.preventDefault(),${ev}.stopPropagation();` +
    `if(!${ev}.repeat)${fire}}},` +
    `onMouseLeave:${disarm},onBlur:${disarm},` +
    `title:"Delete session",children:${svg}})`;
  const helper =
    `(${ccupSessionDeleteWeb.toString()})` +
    `(${JSON.stringify(sdelCss(group))},${JSON.stringify(SDEL_RESTART_NOTE)})`;
  const text =
    `,(${archive}||${unarchive})&&!${active}&&${sess}.sessionId.value&&` +
    `((${del})=>${button})(window.${SDEL_HELPER_PROP}||` +
    `(window.${SDEL_HELPER_PROP}=${helper}))`;
  return { unit: row, edit: sdelEdit(SDEL_ROW, { pos: el.end, text }) };
}

// The delete_session handler. It is compiled into Claude Code's extension
// host by toString, as the body of a method on its per-webview comms class,
// so it runs there and may use only its parameters, `this` (that comms), and
// Node's globals.
async function ccupSessionDeleteHost(
  this: any,
  req: any,
  store: any,
): Promise<{ type: string; deleted: boolean }> {
  const vscode = require("vscode");
  const path = require("path");
  const fs = require("fs");
  const done = (deleted: boolean) => ({
    type: "delete_session_response",
    deleted,
  });
  const id = typeof req?.sessionId === "string" ? req.sessionId : "";
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
    return done(false);
  let title =
    typeof req.title === "string" ? req.title.replace(/\s+/g, " ").trim() : "";
  if (!title) title = "Untitled";
  if (title.length > 100) title = `${title.slice(0, 97)}...`;
  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const warn = (message: string) => {
    void vscode.window.showWarningMessage(message);
    return done(false);
  };
  // The button confirms in place, on a second click. A webview loaded before
  // it did sends one click as the whole request.
  if (req.confirmed !== true)
    return warn("Reload the window to finish updating session delete.");

  // Anything that could still write the transcript: a tab of this window
  // (including one a reload has not revived yet) or its sidebar; a Claude
  // process of this window, live or still closing after its view moved on;
  // or another window or a terminal, per the live-session registry, which
  // answers undefined when it cannot tell and then does not block.
  const heldWhere = async (): Promise<"here" | "elsewhere" | undefined> => {
    if (this.ccupOpenHere(id)) return "here";
    for (const peer of this.ccupPeers()) {
      if (await peer.sessionMayStillRun(id)) return "here";
    }
    if ((await this.closedSurfaceMayHold?.(id)) === true) return "here";
    if ((await this.sessionHeldElsewhere?.(id)) === true) return "elsewhere";
    return undefined;
  };
  const busy = async (): Promise<boolean> => {
    const where = await heldWhere();
    if (where === "here")
      warn(
        `'${title}' is still open in this window. Close it first, then delete it.`,
      );
    else if (where === "elsewhere")
      warn(
        `'${title}' is open elsewhere (another window or a terminal). Close it there, then delete it.`,
      );
    return where !== undefined;
  };
  if (await busy()) return done(false);

  let file: unknown;
  try {
    const sessions = await store.load(this.cwd, this.logger);
    file = (await sessions.resolveSessionFile(id))?.filePath;
  } catch (e) {
    return warn(`Could not read the transcript of '${title}': ${reason(e)}`);
  }
  if (typeof file !== "string")
    return warn(`Could not find the transcript of '${title}'.`);

  // The transcript goes first, since it is what lists the session, then the
  // folder beside it with the session's subagent transcripts and tool output.
  const targets = [file];
  const folder = path.join(path.dirname(file), id);
  try {
    if (fs.lstatSync(folder).isDirectory()) targets.push(folder);
  } catch {
    // no folder: the session never kept anything beside its transcript
  }
  const bin = process.platform === "win32" ? "Recycle Bin" : "Trash";
  let useTrash = true;
  let removed = 0;
  try {
    for (const target of targets) {
      const uri = vscode.Uri.file(target);
      try {
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash });
      } catch (e) {
        if (!useTrash) throw e;
        // "sure?" agreed to a move to the trash, not to a delete that cannot
        // be undone, so where the file system has no trash that still asks,
        // and the session must still be free once the dialog closes.
        const forever = "Delete Permanently";
        const pick = await vscode.window.showWarningMessage(
          `Could not move '${title}' to the ${bin}.`,
          {
            modal: true,
            detail: `${reason(e)}\n\nDelete it permanently instead? This cannot be undone.`,
          },
          forever,
        );
        if (pick !== forever || (await busy())) break;
        useTrash = false;
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash });
      }
      removed++;
    }
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Could not delete '${title}': ${reason(e)}`,
    );
  }
  if (removed > 0) {
    for (const peer of this.ccupPeers()) peer.sendSessionStoreChanged();
  }
  return done(removed > 0);
}

// A class's own method (static or not) or field of this name.
function sdelMethod(cls: N, name: string, isStatic = false): N | null {
  for (const m of cls.body.body as N[]) {
    if (
      m.type === "MethodDefinition" &&
      m.kind === "method" &&
      !m.computed &&
      !!m.static === isStatic &&
      idName(m.key) === name
    )
      return m;
  }
  return null;
}
function sdelField(cls: N, name: string): boolean {
  return (cls.body.body as N[]).some(
    (m) =>
      m.type === "PropertyDefinition" && !m.computed && idName(m.key) === name,
  );
}

// `this.prop`.
const sdelIsThisMember = (n: N | null | undefined, prop: string): boolean =>
  memberProp(n) === prop && n!.object.type === "ThisExpression";

// The host's sites and their three insertions, or null.
function sdelHostFind(
  c: string,
): { units: [N, (n: N) => boolean][]; edits: Edit[] } | null {
  const classesWith = (token: string) =>
    unitsWith(c, token, "class ", isClass, SDEL_CLASS_REACH);

  // The per-webview comms subclass, which carries the hooks the provider sets.
  const subs = classesWith("isSessionLiveInOtherSurface(").filter(
    (k) =>
      idName(k.superClass) &&
      sdelMethod(k, "processRequest") &&
      sdelField(k, "sessionHeldElsewhere") &&
      sdelField(k, "closedSurfaceMayHold"),
  );
  if (subs.length !== 1) return null;
  const sub = subs[0];
  // Its base, with the per-session run check and the store-change notice.
  const bases = classesWith("sessionMayStillRun(").filter(
    (k) =>
      idName(k.id) === idName(sub.superClass) &&
      sdelMethod(k, "sessionMayStillRun") &&
      sdelMethod(k, "sendSessionStoreChanged"),
  );
  if (bases.length !== 1) return null;

  // The session store, as the base opens it (see commsStore).
  const store = commsStore(c, bases[0]);
  if (!store || idName(sub.id) === store) return null;
  // The subclass reads that same binding itself, unshadowed, so the method
  // inserted into it reaches the store too.
  let reaches = false;
  walk(sub, (n) => {
    if (reaches) return false;
    if (
      n.type === "MemberExpression" &&
      idName(n.object) === store &&
      bindingSite(n, store, sub) === null
    )
      reaches = true;
  });
  if (!reaches) return null;

  // The webview provider: wireLiveRegistry(comms), which must be where the
  // registry hooks are set, and the state ccupOpenHere reads.
  const provs = classesWith("wireLiveRegistry(").filter(
    (k) =>
      sdelMethod(k, "wireLiveRegistry") &&
      sdelMethod(k, "sidebarHoldsSession") &&
      ["sessionPanels", "rememberedTabSessions", "allComms"].every((f) =>
        sdelField(k, f),
      ),
  );
  if (provs.length !== 1) return null;
  const prov = provs[0];
  const wire = sdelMethod(prov, "wireLiveRegistry")!.value;
  const comms = wire.params.length === 1 ? idName(wire.params[0]) : null;
  if (!comms || wire.body.type !== "BlockStatement") return null;
  const hooks = new Set<string>();
  walkOwn(wire, (n) => {
    if (
      n.type === "AssignmentExpression" &&
      n.operator === "=" &&
      idName(n.left.object) === comms
    ) {
      const k = memberProp(n.left);
      if (k) hooks.add(k);
    }
  });
  if (!hooks.has("sessionHeldElsewhere") || !hooks.has("closedSurfaceMayHold"))
    return null;

  // The route's method, whose first param is the request envelope.
  const pr = sdelMethod(sub, "processRequest")!;
  const env = idName(pr.value.params[0]);
  if (!env || pr.value.body.type !== "BlockStatement") return null;
  let readsType = false;
  walkOwn(pr.value, (n) => {
    if (readsType) return false;
    if (memberProp(n) === "type" && isMember(n.object, env, "request"))
      readsType = true;
  });
  if (!readsType) return null;

  const edits: Edit[] = [
    sdelEdit(SDEL_WIRE, {
      pos: wire.body.start + 1,
      text:
        `${comms}.ccupOpenHere=(ccupId)=>this.sessionPanels.has(ccupId)||` +
        `this.rememberedTabSessions.some((ccupT)=>ccupT.sessionId===ccupId)||` +
        `this.sidebarHoldsSession(ccupId);` +
        `${comms}.ccupPeers=()=>[...this.allComms];`,
    }),
    sdelEdit(SDEL_METHOD, {
      pos: pr.start,
      text:
        `ccupDeleteSession(ccupReq){return(${ccupSessionDeleteHost.toString()})` +
        `.call(this,ccupReq,${store})}`,
    }),
    sdelEdit(SDEL_ROUTE, {
      pos: pr.value.body.start + 1,
      text: `if(${env}.request.type==="delete_session")return this.ccupDeleteSession(${env}.request);`,
    }),
  ];
  return {
    units: [
      [sub, isClass],
      [prov, isClass],
    ],
    edits,
  };
}

// A one-argument string function remembering its last two answers: an apply
// pass asks each half about both its own file and, through the other half's
// gate, the same text again.
function sdelMemo(
  fn: (native: string) => string | null,
): (native: string) => string | null {
  let slots: { input: string; output: string | null }[] = [];
  return (native) => {
    const hit = slots.find((s) => s.input === native);
    if (hit) return hit.output;
    const output = fn(native);
    slots = [{ input: native, output }, ...slots].slice(0, 2);
    return output;
  };
}

// Each half's native file with its fragments in, or null when a site is
// missing or an edit would not parse.
const sdelRowBuild = sdelMemo((native) => {
  const site = sdelRowFind(native);
  if (!site) return null;
  const out = applyEdits(native, [site.edit]);
  return unitsReparse(out, [site.edit], [[site.unit, isFn]]) ? out : null;
});
const sdelHostBuild = sdelMemo((native) => {
  const sites = sdelHostFind(native);
  if (!sites) return null;
  const out = applyEdits(native, sites.edits);
  return unitsReparse(out, sites.edits, sites.units) ? out : null;
});

// The two ALWAYS_POINTS patches, each gated on the other file's sites.
function sessionDeleteRowPatch(
  native: string,
  read: BundleReader,
): string | null {
  const host = read(SDEL_HOST_FILE);
  if (host === undefined || sdelHostBuild(sdelStrip(host)) === null)
    return null;
  return sdelRowBuild(native);
}
function sessionDeleteHostPatch(
  native: string,
  read: BundleReader,
): string | null {
  const web = read(SDEL_WEBVIEW_FILE);
  if (web === undefined || sdelRowBuild(sdelStrip(web)) === null) return null;
  return sdelHostBuild(native);
}

// The webview bundle, patched or not, as an apply writes it given this host
// bundle, or null when either half's sites are gone. scripts/repro's
// session-delete.mjs serves this, so it runs exactly what the patcher writes
// and doubles as the drift canary for both halves.
export function sessionDeleteWebview(web: string, host: string): string | null {
  return sessionDeleteRowPatch(sdelStrip(web), (rel) =>
    rel === SDEL_HOST_FILE ? host : undefined,
  );
}

// ---------------------------------------------------------------------------
// Untitled session stays (always on): a chat view mirrors the session it shows
// into its own URL as `?session=<id>` (history.replaceState), and when it moves
// to a session that has no id yet it leaves the last id there. Every re-read
// of the session list ends in a restore meant for a reload, which makes the
// session that URL names active again unless the active session is a blank the
// user made (the New session button) or one holding a prompt or reply. The
// blank a view opens with is neither (createSession gets isExplicit false), so
// picking it again from the history dropdown and then opening the dropdown
// once more, which re-reads the list, jumps to whichever session was on screen
// before it, a running one included.
//
// The restore is meant for an id-less session only while it is a placeholder
// waiting for the URL's session: createSession marks a non-explicit session
// isLoading when the URL already names one, and otherwise only a session with
// an id loading its transcript is ever isLoading. So the guard gains one more
// alternative, `||!<active>.isLoading.value`: a blank that is not waiting
// stays, a placeholder still resolves to the URL's session, and the URL, the
// list's id adoption and the restore itself stay native.
//
// One fragment, /*ccup:untitledStays*/.../*ccup:untitledStaysEnd*/, at the end
// of the guard's alternatives in the session manager's doListSessions, found
// by structure (src/derive.ts). The guard is the declarator
// `<M>=<D>!==void 0&&!<D>.sessionId.value&&(this.createdByUser.has(<D>)||
// <D>.hasPromptOrReply.peek())`, with D the method's own
// `this.activeSession.value`. M must be read only by the restore's test and
// its else branch, the restore must make a session active, its other condition
// must call the URL reader (a function returning
// `new URLSearchParams(...).get("session")`), and the method must read
// `.isLoading.value` off a session. Builds through 2.1.284 guard the restore
// with createdByUser alone (2.1.280) or not at all (2.1.270), so the point
// reads missing there.
// ---------------------------------------------------------------------------
const STAY_MARKER = "/*ccup:untitledStays*/";
const STAY_END = "/*ccup:untitledStaysEnd*/";
const STAY_FRAG_RE =
  /\/\*ccup:untitledStays\*\/[\s\S]*?\/\*ccup:untitledStaysEnd\*\//g;
const STAY_FILE = "webview/index.js";
// How far ahead of doListSessions its class may start (the session manager
// spans about 28KB).
const STAY_CLASS_REACH = 200000;

// The operands of a chain of one logical operator, left to right (the node
// alone when it is no such chain).
function chainOf(n: N, op: string): N[] {
  return n.type === "LogicalExpression" && n.operator === op
    ? [...chainOf(n.left, op), ...chainOf(n.right, op)]
    : [n];
}

// `obj.prop.value` or `obj.prop.peek()`: a read of a signal field.
function readsSignal(n: N, obj: string, prop: string): boolean {
  if (memberProp(n) === "value") return isMember(n.object, obj, prop);
  return (
    n.type === "CallExpression" &&
    n.arguments.length === 0 &&
    memberProp(n.callee) === "peek" &&
    isMember(n.callee.object, obj, prop)
  );
}

// Whether the function declared as `name`, once in the bundle, reads the URL's
// session parameter: `new URLSearchParams(...).get("session")`.
function stayIsUrlReader(c: string, name: string): boolean {
  const decl = `function ${name}(`;
  const at = c.indexOf(decl);
  if (at < 0 || c.indexOf(decl, at + 1) >= 0) return false;
  const fn = parseUnitAt(c, at, isFn);
  if (!fn) return false;
  let hit = false;
  walkOwn(fn, (n) => {
    if (hit) return false;
    if (
      n.type === "CallExpression" &&
      memberProp(n.callee) === "get" &&
      n.arguments.length === 1 &&
      isStr(n.arguments[0], "session") &&
      n.callee.object.type === "NewExpression" &&
      idName(n.callee.object.callee) === "URLSearchParams"
    )
      hit = true;
  });
  return hit;
}

// The session manager and the insertion that lets a blank stay, or null.
function untitledStaysFind(c: string): { unit: N; edit: Edit } | null {
  const mgrs = unitsWith(
    c,
    "doListSessions(",
    "class ",
    isClass,
    STAY_CLASS_REACH,
  ).filter(
    (k) => sdelMethod(k, "doListSessions") && sdelField(k, "createdByUser"),
  );
  if (mgrs.length !== 1) return null;
  const mgr = mgrs[0];
  const fn: N = sdelMethod(mgr, "doListSessions")!.value;
  const decls = (name: string): N[] => {
    const found: N[] = [];
    walkOwn(fn, (n) => {
      if (n.type === "VariableDeclarator" && idName(n.id) === name)
        found.push(n);
    });
    return found;
  };

  // The guard: a declarator whose `&&` chain dereferences the active session
  // (`!<D>.sessionId.value`) ahead of the blanks it keeps,
  // `(this.createdByUser.has(<D>)||<D>.hasPromptOrReply.peek())`.
  const guards: { decl: N; d: string; group: N }[] = [];
  walkOwn(fn, (n) => {
    if (n.type !== "VariableDeclarator" || !n.init || !idName(n.id)) return;
    const ands = chainOf(n.init, "&&");
    for (let i = 0; i < ands.length; i++) {
      const o = ands[i];
      if (
        o.type !== "UnaryExpression" ||
        o.operator !== "!" ||
        memberProp(o.argument) !== "value" ||
        memberProp(o.argument.object) !== "sessionId"
      )
        continue;
      const d = idName(o.argument.object.object);
      if (!d) continue;
      for (const group of ands.slice(i + 1)) {
        if (group.type !== "LogicalExpression" || group.operator !== "||")
          continue;
        const alts = chainOf(group, "||");
        const userMade = alts.some(
          (x) =>
            x.type === "CallExpression" &&
            x.arguments.length === 1 &&
            idName(x.arguments[0]) === d &&
            memberProp(x.callee) === "has" &&
            sdelIsThisMember(x.callee.object, "createdByUser"),
        );
        if (userMade && alts.some((x) => readsSignal(x, d, "hasPromptOrReply")))
          guards.push({ decl: n, d, group });
      }
    }
  });
  if (guards.length !== 1) return null;
  const { decl, d, group } = guards[0];
  const m = idName(decl.id)!;

  // D is the method's own `this.activeSession.value`, as the guard sees it.
  const ds = decls(d).filter(
    (n) =>
      memberProp(n.init) === "value" &&
      sdelIsThisMember(n.init.object, "activeSession"),
  );
  if (ds.length !== 1) return null;
  const dScope = bindingSite(ds[0], d, fn);
  if (!dScope || bindingSite(group, d, fn) !== dScope) return null;

  // The restore: an if whose `&&` test reads `!<M>` and whose body makes a
  // session active.
  const restores: N[] = [];
  walkOwn(fn, (n) => {
    if (
      n.type === "IfStatement" &&
      chainOf(n.test, "&&").some(
        (o) =>
          o.type === "UnaryExpression" &&
          o.operator === "!" &&
          idName(o.argument) === m,
      )
    )
      restores.push(n);
  });
  if (restores.length !== 1) return null;
  const restore = restores[0];
  let activates = false;
  walkOwn(restore.consequent, (n) => {
    if (activates) return false;
    if (
      n.type === "AssignmentExpression" &&
      memberProp(n.left) === "value" &&
      sdelIsThisMember(n.left.object, "activeSession")
    )
      activates = true;
  });
  if (!activates) return null;

  // Nothing else reads M: the restore's test and the test of its else branch
  // are the only places the wider guard reaches.
  const mScope = bindingSite(decl, m, fn);
  if (!mScope) return null;
  const alt =
    restore.alternate?.type === "IfStatement" ? restore.alternate : null;
  const within = (n: N, root: N | null | undefined): boolean =>
    !!root && root.start <= n.start && n.end <= root.end;
  let strayRead = false;
  walk(fn, (n) => {
    if (strayRead) return false;
    if (n.type !== "Identifier" || n.name !== m || n === decl.id) return;
    const p = n.parent;
    if (p?.type === "MemberExpression" && p.property === n && !p.computed)
      return;
    if (p?.type === "Property" && p.key === n && !p.computed) return;
    if (bindingSite(n, m, fn) !== mScope) return;
    if (!within(n, restore.test) && !within(n, alt?.test)) strayRead = true;
  });
  if (strayRead) return null;

  // The restore's other condition holds the URL's session: `<H>` with
  // `<H>=<reader>()`, the reader bound outside the method.
  const readsUrl = chainOf(restore.test, "&&").some((o) => {
    const h = idName(o);
    if (!h) return false;
    const hs = decls(h);
    if (hs.length !== 1 || bindingSite(o, h, fn) !== bindingSite(hs[0], h, fn))
      return false;
    const init = hs[0].init;
    const reader = init?.type === "CallExpression" ? idName(init.callee) : null;
    return (
      !!reader &&
      init.arguments.length === 0 &&
      bindingSite(init.callee, reader, fn) === null &&
      stayIsUrlReader(c, reader)
    );
  });
  if (!readsUrl) return null;

  // Sessions carry the signal the new alternative reads.
  let readsLoading = false;
  walkOwn(fn, (n) => {
    if (readsLoading) return false;
    if (memberProp(n) === "value" && memberProp(n.object) === "isLoading")
      readsLoading = true;
  });
  if (!readsLoading) return null;

  return {
    unit: mgr,
    edit: {
      pos: group.end,
      text: `${STAY_MARKER}||!${d}.isLoading.value${STAY_END}`,
    },
  };
}

// The native webview bundle with the fragment in, or null when a site is
// missing or the edit would not parse.
const untitledStaysBuild = sdelMemo((native) => {
  const site = untitledStaysFind(native);
  if (!site) return null;
  const out = applyEdits(native, [site.edit]);
  return unitsReparse(out, [site.edit], [[site.unit, isClass]]) ? out : null;
});
function untitledStaysPatch(native: string): string | null {
  return untitledStaysBuild(native);
}

// The webview bundle, patched or not, as an apply writes this point into it,
// or null when its sites are gone. scripts/repro's untitled-stays.mjs serves
// this, so it runs exactly what the patcher writes and doubles as the drift
// canary.
export function untitledStaysWebview(web: string): string | null {
  return untitledStaysBuild(web.replace(STAY_FRAG_RE, ""));
}

// ---------------------------------------------------------------------------
// Last turn delete (always on, two halves): the prompt history list
// (promptHist) gives its last entry a delete button, and a confirmed click
// takes that turn out of the conversation as if it had never been sent. Only
// the last turn has one: every later turn builds on the ones before it, so
// cutting one from the middle would strand whatever came after, while
// deleting backward one turn at a time reaches any point.
//
// Nothing native deletes a turn in place. Fork and rewind start a new session
// from the turn before, and the CLI's own rewind_conversation control request
// (2.1.200 on), which cuts its live conversation and leaves the process
// running, is a request only other clients send. It refuses on its own when
// the turn cannot go cleanly (a queued prompt, a later turn it has not
// shown, a target compacted away), interrupts a turn still running, stops
// the background agents and MCP tasks that turn spawned, forgets the files
// read in it, and records the cut as an explicit last-prompt checkpoint
// ({leafUuid, explicit, rewound}) that its resume honors. Disk keeps the dead
// branch, though, and the extension host's reader ignores that checkpoint:
// it shows the branch whose leaf comes last in the file, so a reload would
// bring the deleted turn back until the next prompt grows a newer one. The
// checkpoint also repeats the deleted prompt as the session's lastPrompt.
//
// The webview half (turnRewind) is two fragments in webview/index.js:
//   mgr  at the head of the session manager's constructor: window's
//        __ccupTurnRewind bridge, built around the manager, whose run(uuid)
//        stops the active session's turn, waits for it to wind down, asks the
//        host to rewind, and then drops the turn from the view (its messages,
//        the todo list a TodoWrite in it set, the reply suggestion)
//   row  in the user message component's container props: data-ccup-uuid,
//        the message's own uuid, which the sticky header that the history
//        list reads therefore carries
// The host half (turnRewindHost) is two fragments in extension.js:
//   case    at the head of the comms base's request switch: ccup_rewind_turn
//           goes to the method below
//   method  ccupRewindTurn, at the end of that class, running the compiled
//           ccupTurnRewindHost with the session store and ccupTurnScrub
// The handler sends rewind_conversation down the request's channel, with the
// turn's prompt as both target and last seen message and interrupt on, and
// then scrubs the transcript: the prompt, every entry descending from it,
// the plain queue records sending it, the snapshots keyed to its messages and
// the turn's own last-prompt and ai-title stamps go, the checkpoint names the
// kept conversation's last prompt again, and everything else (session
// metadata, request logs the CLI deduplicates against, lines appended
// meanwhile) stays byte for byte. Subagent transcripts and saved tool output
// that only the dropped lines mention go too. Then every list re-reads.
//
// The halves are all or nothing across the two files, as for session delete,
// and every site is found by structure (src/derive.ts). Each insertion is
// wrapped in /*ccup:trw:<site>*/.../*ccup:trwEnd*/, so stripping the
// fragments restores the stock bytes.
// ---------------------------------------------------------------------------
const TRW_END = "/*ccup:trwEnd*/";
const TRW_MGR = "/*ccup:trw:mgr*/";
const TRW_ROW = "/*ccup:trw:row*/";
const TRW_CASE = "/*ccup:trw:case*/";
const TRW_METHOD = "/*ccup:trw:method*/";
const TRW_FRAG_RE = /\/\*ccup:trw:[-\w]+\*\/[\s\S]*?\/\*ccup:trwEnd\*\//g;
const TRW_WEBVIEW_FILE = "webview/index.js";
const TRW_HOST_FILE = "extension.js";
const trwEdit = (marker: string, e: Edit): Edit => ({
  pos: e.pos,
  text: `${marker}${e.text}${TRW_END}`,
});
const trwStrip = (c: string): string => c.replace(TRW_FRAG_RE, "");
// How far ahead of a token its class may start (the comms base spans about
// 150KB, with the rewind_code case some 100KB in), and its function.
const TRW_CLASS_REACH = 400000;
const TRW_ROW_REACH = 30000;
// The members of a session the bridge touches.
const TRW_SESSION_METHODS = [
  "interrupt",
  "launchClaude",
  "getConnection",
  "showNotification",
  "reloadSessionDiff",
];
const TRW_SESSION_FIELDS = [
  "messages",
  "heldPrompts",
  "todos",
  "promptSuggestion",
  "busy",
  "connection",
  "sessionId",
  "replayInsertIndex",
  "turnStarting",
];

// The dead branch a rewind_conversation leaves in a transcript, taken out.
// `file` is the session's transcript, `target` the deleted turn's prompt and
// `sid` the session. Compiled into Claude Code's extension host by toString
// (see turnRewindHostFind), so it may use only its parameters and Node's
// globals. The CLI keeps appending (O_APPEND) while this runs, so the file is
// read whole, the cut planned, and the write done in one synchronous run that
// carries over whatever landed past the bytes read. Returns how many lines and
// side files went, null when it left the transcript alone, or "wait" when
// `needMark` asks for the rewind's checkpoint and the file has none past the
// prompt yet.
//
// The rewind answers before that checkpoint is written: the CLI queues every
// transcript line and flushes the queue every 100ms, first in first out, so
// lines of the deleted turn can still be in flight. Once the checkpoint is
// on disk, all of them are, and nothing the CLI writes after it descends from
// the turn any more.
function ccupTurnScrub(
  file: string,
  target: string,
  sid: string,
  needMark: boolean,
): { lines: number; files: number } | "wait" | null {
  const fs = require("fs");
  const path = require("path");
  const chain = new Set([
    "user",
    "assistant",
    "attachment",
    "system",
    "progress",
  ]);
  const parse = (b: Buffer, s: number, e: number): any => {
    try {
      return JSON.parse(b.toString("utf8", s, e));
    } catch {
      return null;
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const fd = fs.openSync(file, "r+");
    try {
      const size: number = fs.fstatSync(fd).size;
      const buf: Buffer = Buffer.alloc(size);
      for (let o = 0; o < size;) {
        const n = fs.readSync(fd, buf, o, size - o, o);
        if (n <= 0) return null;
        o += n;
      }
      // Line i spans [st[i], en[i]), its newline (if any) at en[i].
      const st: number[] = [];
      const en: number[] = [];
      for (let s = 0; s < size;) {
        let e = buf.indexOf(10, s);
        if (e < 0) e = size;
        st.push(s);
        en.push(e);
        s = e + 1;
      }
      const lineAt = (pos: number): number => {
        let lo = 0;
        let hi = st.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (st[mid] <= pos) lo = mid;
          else hi = mid - 1;
        }
        return lo;
      };

      // The prompt: the last line that is the user entry with that uuid.
      const needle = Buffer.from(`"uuid":"${target}"`);
      let ti = -1;
      for (let p = buf.lastIndexOf(needle); p >= 0;) {
        const i = lineAt(p);
        const r = parse(buf, st[i], en[i]);
        if (r && r.type === "user" && r.uuid === target) {
          ti = i;
          break;
        }
        p = st[i] > 0 ? buf.lastIndexOf(needle, st[i] - 1) : -1;
      }
      if (ti < 0) return null;
      const rec: any[] = [];
      for (let i = ti; i < st.length; i++) rec[i] = parse(buf, st[i], en[i]);

      // The prompt's subtree: every chain entry descending from it, through a
      // compaction boundary's logical parent too.
      const gone = new Set<string>([target]);
      for (let grew = true; grew;) {
        grew = false;
        for (let i = ti + 1; i < st.length; i++) {
          const r = rec[i];
          if (!r || !chain.has(r.type) || typeof r.uuid !== "string") continue;
          if (gone.has(r.uuid)) continue;
          if (gone.has(r.parentUuid) || gone.has(r.logicalParentUuid)) {
            gone.add(r.uuid);
            grew = true;
          }
        }
      }
      // The rewind's checkpoint closes the turn's own records. One naming an
      // entry of the subtree is not this rewind's.
      let mk = -1;
      for (let i = st.length - 1; i > ti; i--) {
        const r = rec[i];
        if (
          r?.type === "last-prompt" &&
          r.explicit === true &&
          r.rewound === true
        ) {
          mk = i;
          break;
        }
      }
      if (mk < 0 && needMark) return "wait";
      if (mk >= 0 && gone.has(rec[mk].leafUuid)) return null;
      const end = mk >= 0 ? mk : st.length;
      // The plain send's queue records, right above the prompt.
      let from = ti;
      while (from > 0) {
        const r = parse(buf, st[from - 1], en[from - 1]);
        if (r?.type !== "queue-operation" || r.content !== undefined) break;
        from--;
      }
      // The kept conversation's last prompt, for the checkpoint.
      let last: unknown;
      for (let i = from - 1; i >= 0 && last === undefined; i--) {
        if (!buf.subarray(st[i], en[i]).includes('"type":"last-prompt"'))
          continue;
        const r = parse(buf, st[i], en[i]);
        if (r?.type === "last-prompt" && typeof r.lastPrompt === "string")
          last = r.lastPrompt;
      }
      const drops = (i: number): boolean => {
        if (i < ti) return true;
        const r = rec[i];
        if (!r) return false;
        if (chain.has(r.type) && typeof r.uuid === "string")
          return gone.has(r.uuid);
        if (
          r.type === "file-history-snapshot" ||
          r.type === "file-history-delta" ||
          r.type === "attribution-snapshot"
        )
          return gone.has(r.messageId);
        if (r.type === "summary") return gone.has(r.leafUuid);
        return i < end && (r.type === "last-prompt" || r.type === "ai-title");
      };
      const parts: Buffer[] = [];
      const dropped: string[] = [];
      for (let i = from; i < st.length; i++) {
        const stop = en[i] < size ? en[i] + 1 : en[i];
        if (drops(i)) {
          dropped.push(buf.toString("utf8", st[i], en[i]));
          continue;
        }
        if (i !== mk) {
          parts.push(buf.subarray(st[i], stop));
          continue;
        }
        const r = { ...rec[mk] };
        if (typeof last === "string") r.lastPrompt = last;
        else delete r.lastPrompt;
        parts.push(Buffer.from(JSON.stringify(r) + (stop > en[i] ? "\n" : "")));
      }
      if (dropped.length === 0) return null;
      const out = Buffer.concat(parts);

      // The write, unbroken: a file that shrank or changed under the bytes
      // read is someone else's rewrite, so plan again from a fresh read.
      const tail = Math.min(size, 4096);
      const check = Buffer.alloc(tail);
      if (fs.fstatSync(fd).size < size) continue;
      fs.readSync(fd, check, 0, tail, size - tail);
      if (!check.equals(buf.subarray(size - tail))) continue;
      fs.writeSync(fd, out, 0, out.length, st[from]);
      let len = st[from] + out.length;
      const now: number = fs.fstatSync(fd).size;
      if (now > size) {
        const extra = Buffer.alloc(now - size);
        fs.readSync(fd, extra, 0, extra.length, size);
        fs.writeSync(fd, extra, 0, extra.length, len);
        len += extra.length;
      }
      fs.ftruncateSync(fd, len);

      // Subagent transcripts and saved tool output only the dropped lines
      // name: random ids, so a mention is a reference.
      let files = 0;
      const folder = path.join(path.dirname(file), sid);
      const goneText = dropped.join("\n");
      let keptText: string | undefined;
      for (const sub of ["subagents", "tool-results"]) {
        let names: string[] = [];
        try {
          names = fs.readdirSync(path.join(folder, sub));
        } catch {
          continue;
        }
        for (const name of names) {
          const key =
            sub === "subagents"
              ? name
                  .replace(/^agent-/, "")
                  .replace(/\.(?:jsonl|meta\.json)$/, "")
              : name;
          if (!/^[\w.-]{8,}$/.test(key) || !goneText.includes(key)) continue;
          keptText ??= buf.toString("utf8", 0, st[from]) + out.toString("utf8");
          if (keptText.includes(key)) continue;
          try {
            const p = path.join(folder, sub, name);
            if (fs.lstatSync(p).isFile()) {
              fs.unlinkSync(p);
              files++;
            }
          } catch {
            // gone already, or not ours to remove
          }
        }
      }
      return { lines: dropped.length, files };
    } finally {
      fs.closeSync(fd);
    }
  }
  return null;
}

// The ccup_rewind_turn handler. It is compiled into Claude Code's extension
// host by toString, as the body of a method on its comms base class, so it
// runs there and may use only its parameters, `this` (that comms), and Node's
// globals. `ch` is the request's channel, whose Claude process holds the
// conversation, and `scrub` is ccupTurnScrub.
async function ccupTurnRewindHost(
  this: any,
  req: any,
  ch: unknown,
  store: any,
  scrub: (
    file: string,
    target: string,
    sid: string,
    needMark: boolean,
  ) => unknown,
): Promise<object> {
  const done = (o: object) => ({ type: "ccup_rewind_turn_response", ...o });
  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const id = typeof req?.sessionId === "string" ? req.sessionId : "";
  const target = typeof req?.targetUuid === "string" ? req.targetUuid : "";
  if (typeof ch !== "string" || !ch || !uuid.test(id) || !uuid.test(target))
    return done({ rewound: false, error: "no turn was named" });

  let res: any;
  try {
    res = await this.withChannel(ch, async (c: any) => {
      if (c.sessionId !== undefined && c.sessionId !== id)
        throw new Error(
          "this view's Claude process holds another conversation",
        );
      const r = await c.query.request({
        subtype: "rewind_conversation",
        target_message_uuid: target,
        last_seen_user_message_uuid: target,
        interrupt_if_running: true,
      });
      return r?.response;
    });
  } catch (e) {
    return done({ rewound: false, error: reason(e) });
  }
  if (res?.rewound !== true)
    return done({
      rewound: false,
      error: typeof res?.error === "string" ? res.error : "Claude Code kept it",
    });

  // The scrub waits up to three seconds for the rewind's checkpoint to land
  // (see ccupTurnScrub), and then goes ahead without it.
  let cleaned = false;
  try {
    const sessions = await store.load(this.cwd, this.logger);
    const file = (await sessions.resolveSessionFile(id))?.filePath;
    if (typeof file === "string") {
      let got: unknown = "wait";
      for (let i = 0; got === "wait"; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 100));
        got = scrub(file, target, id, i < 30);
      }
      cleaned = got !== null;
    }
  } catch (e) {
    this.logger?.warn?.(
      `ccup_rewind_turn: transcript left as it is: ${reason(e)}`,
    );
  }
  // Session delete's wire, when it is in, reaches every list; else this one.
  const peers =
    typeof this.ccupPeers === "function" ? this.ccupPeers() : [this];
  for (const peer of peers) {
    try {
      peer.sendSessionStoreChanged();
    } catch {
      // a view on its way out
    }
  }
  return done({ rewound: true, cleaned });
}

// The bridge the history list's delete button calls, window.__ccupTurnRewind,
// built around the session manager by its constructor. Compiled into the
// webview bundle by toString, so it may use only its parameter and the page's
// globals. run(uuid) answers whether the turn went, and says why not in a
// notification otherwise.
function ccupTurnRewindWeb(mgr: any): { run(uuid: string): Promise<boolean> } {
  const busy = new Set<unknown>();
  const say = (s: any, m: string): void => {
    try {
      void s.showNotification(m, "warning");
    } catch {
      // no host to tell
    }
  };
  const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const run = async (uuid: string): Promise<boolean> => {
    const s = mgr.activeSession?.value;
    if (!s || typeof uuid !== "string" || busy.has(s)) return false;
    busy.add(s);
    try {
      const id = s.sessionId.value;
      const at = (): number =>
        s.messages.value.findIndex((x: any) => x?.uuid === uuid);
      if (!id || at() < 0) {
        say(
          s,
          "Could not delete the turn: it is no longer in this conversation.",
        );
        return false;
      }
      if (s.heldPrompts.value.length > 0) {
        say(
          s,
          "Could not delete the turn while a queued message waits to be sent.",
        );
        return false;
      }
      // The stop, sent whether or not the turn still runs, and then up to
      // ten seconds for it to wind down; the rewind interrupts what is left.
      const settle = async (tries: number) => {
        for (let i = 0; i < tries && (s.busy.value || s.turnStarting); i++)
          await nap(100);
      };
      try {
        await s.interrupt();
      } catch {
        // the rewind's own interrupt still stands
      }
      await settle(100);
      const ch = s.claudeChannelId ?? (await s.launchClaude());
      const conn = s.connection.value ?? (await s.getConnection());
      let res: any;
      try {
        res = await conn.sendRequest(
          { type: "ccup_rewind_turn", sessionId: id, targetUuid: uuid },
          ch,
        );
      } catch (e: any) {
        const m = e?.message ?? String(e);
        say(
          s,
          m === "Unknown request type."
            ? "Reload the window to start using turn delete."
            : `Could not delete the turn: ${m}`,
        );
        return false;
      }
      if (res?.rewound !== true) {
        say(
          s,
          `Could not delete the turn: ${res?.error ?? "Claude Code kept it"}.`,
        );
        return false;
      }
      // The view drops the turn as the CLI did, once a turn the rewind had to
      // interrupt has sent its last rows. The todo list is the kept
      // conversation's last TodoWrite, the one processMessage would have left.
      await settle(50);
      const j = at();
      const kept = j >= 0 ? s.messages.value.slice(0, j) : s.messages.value;
      s.messages.value = kept;
      let todos: unknown[] = [];
      for (const x of kept) {
        if (x?.type !== "assistant" || !Array.isArray(x.content)) continue;
        for (const w of x.content) {
          const b = w?.content;
          if (
            b?.type === "tool_use" &&
            b.name === "TodoWrite" &&
            Array.isArray(b.input?.todos)
          )
            todos = b.input.todos;
        }
      }
      s.todos.value = todos;
      s.promptSuggestion.value = null;
      if (s.replayInsertIndex > kept.length) s.replayInsertIndex = kept.length;
      if (res.cleaned)
        void Promise.resolve(s.reloadSessionDiff()).catch(() => {});
      return true;
    } catch (e: any) {
      say(s, `Could not delete the turn: ${e?.message ?? String(e)}`);
      return false;
    } finally {
      busy.delete(s);
    }
  };
  return { run };
}

// The session store as the comms base opens it, `S.load(this.cwd,this.logger)`,
// when its class has resolveSessionFile and a static load; else null. Shared
// by session delete and last turn delete. A name bound inside the class does
// not count: ccupRewindTurn, which last turn delete adds to this very class,
// opens the store it is handed the same way.
function commsStore(c: string, base: N): string | null {
  const loads = new Set<string>();
  walk(base, (n) => {
    if (
      n.type === "CallExpression" &&
      memberProp(n.callee) === "load" &&
      n.arguments.length === 2 &&
      sdelIsThisMember(n.arguments[0], "cwd") &&
      sdelIsThisMember(n.arguments[1], "logger")
    ) {
      const s = idName(n.callee.object);
      if (s && bindingSite(n, s, base) === null) loads.add(s);
    }
  });
  if (loads.size !== 1) return null;
  const store = [...loads][0];
  const stores = unitsWith(
    c,
    "resolveSessionFile(",
    "class ",
    isClass,
    TRW_CLASS_REACH,
  ).filter(
    (k) =>
      idName(k.id) === store &&
      sdelMethod(k, "resolveSessionFile") &&
      sdelMethod(k, "load", true),
  );
  return stores.length === 1 && idName(base.id) !== store ? store : null;
}

// The host's sites and their two insertions, or null.
function turnRewindHostFind(
  c: string,
): { units: [N, (n: N) => boolean][]; edits: Edit[] } | null {
  // The comms base: the class around the native rewind_code case that also
  // routes requests, resolves channels, and tells lists the store changed.
  const bases = unitsWith(
    c,
    'case"rewind_code":',
    "class ",
    isClass,
    TRW_CLASS_REACH,
  ).filter(
    (k) =>
      sdelMethod(k, "processRequest") &&
      sdelMethod(k, "withChannel") &&
      sdelMethod(k, "sendSessionStoreChanged"),
  );
  if (bases.length !== 1) return null;
  const base = bases[0];
  const pr = sdelMethod(base, "processRequest")!.value;
  const env = idName(pr.params[0]);
  if (!env) return null;

  // Its switch on `<env>.request.type`, whose rewind_code case answers
  // through `this.withChannel(<env>.channelId, ...)` and rewindFiles.
  const switches: N[] = [];
  walkOwn(pr, (n) => {
    if (
      n.type === "SwitchStatement" &&
      memberProp(n.discriminant) === "type" &&
      isMember(n.discriminant.object, env, "request") &&
      n.cases.some((k: N) => isStr(k.test, "rewind_code"))
    )
      switches.push(n);
  });
  if (switches.length !== 1) return null;
  const sw = switches[0];
  const rc = sw.cases.find((k: N) => isStr(k.test, "rewind_code"))!;
  let viaChannel = false;
  let rewinds = false;
  walk(rc, (n) => {
    if (
      n.type === "CallExpression" &&
      sdelIsThisMember(n.callee, "withChannel") &&
      n.arguments.length === 2 &&
      isMember(n.arguments[0], env, "channelId")
    )
      viaChannel = true;
    if (memberProp(n) === "rewindFiles") rewinds = true;
  });
  if (!viaChannel || !rewinds || bindingSite(sw, env, pr) !== pr) return null;
  const store = commsStore(c, base);
  if (!store) return null;

  // The case goes first in the switch, so no case falls through into it,
  // and the method last in the class, after a `;` that ends a trailing field.
  return {
    units: [[base, isClass]],
    edits: [
      trwEdit(TRW_CASE, {
        pos: sw.cases[0].start,
        text: `case"ccup_rewind_turn":return this.ccupRewindTurn(${env}.request,${env}.channelId);`,
      }),
      trwEdit(TRW_METHOD, {
        pos: base.body.end - 1,
        text:
          `;ccupRewindTurn(ccupReq,ccupCh){return(${ccupTurnRewindHost.toString()})` +
          `.call(this,ccupReq,ccupCh,${store},${ccupTurnScrub.toString()})}`,
      }),
    ],
  };
}

// The webview's sites and their two insertions, or null.
function turnRewindWebFind(
  c: string,
): { units: [N, (n: N) => boolean][]; edits: Edit[] } | null {
  // The session manager, one per webview, which owns the active session.
  const mgrs = unitsWith(
    c,
    "doListSessions(",
    "class ",
    isClass,
    STAY_CLASS_REACH,
  ).filter(
    (k) =>
      sdelMethod(k, "doListSessions") &&
      sdelField(k, "activeSession") &&
      sdelField(k, "createdByUser"),
  );
  if (mgrs.length !== 1 || mgrs[0].superClass) return null;
  const mgr = mgrs[0];
  const ctor = (mgr.body.body as N[]).find(
    (m) => m.type === "MethodDefinition" && m.kind === "constructor",
  );
  if (!ctor || ctor.value.body.type !== "BlockStatement") return null;

  // The session class carries every member the bridge touches.
  const sessions = unitsWith(
    c,
    "loadFromServer(",
    "class ",
    isClass,
    TRW_CLASS_REACH,
  ).filter(
    (k) =>
      TRW_SESSION_METHODS.every((m) => sdelMethod(k, m)) &&
      TRW_SESSION_FIELDS.every((f) => sdelField(k, f)) &&
      (k.body.body as N[]).some(
        (m) =>
          m.type === "MethodDefinition" &&
          m.kind === "get" &&
          idName(m.key) === "claudeChannelId",
      ),
  );
  if (sessions.length !== 1) return null;

  // The user message component, `{session,message,held,...}` (the assistant
  // one takes no held), and its container's props: the object with
  // data-transcript-message whose className reads the sticky header class.
  // Since 2.1.300 it also takes sentMessage, the session's own message behind
  // a row a plugin engine redraws, which then carries the uuid.
  const rows = unitsWith(
    c,
    '"data-transcript-message"',
    "function",
    isFn,
    TRW_ROW_REACH,
  ).filter((f) => hasKeys(f.params[0], ["session", "message", "held"]));
  if (rows.length !== 1) return null;
  const row = rows[0];
  const sent =
    boundName(row.params[0], "sentMessage") ??
    boundName(row.params[0], "message");
  const props: N[] = [];
  walk(row, (n) => {
    if (
      n.type === "ObjectExpression" &&
      propOf(n, "data-transcript-message") &&
      propOf(n, "className")
    )
      props.push(n);
  });
  if (!sent || props.length !== 1) return null;
  let sticky = false;
  walk(propOf(props[0], "className")!.value, (n) => {
    if (memberProp(n) === "stickyHeader") sticky = true;
  });
  if (!sticky || bindingSite(props[0], sent, row) !== row) return null;

  return {
    units: [
      [mgr, isClass],
      [row, isFn],
    ],
    edits: [
      trwEdit(TRW_MGR, {
        pos: ctor.value.body.start + 1,
        text: `window.__ccupTurnRewind=(${ccupTurnRewindWeb.toString()})(this);`,
      }),
      trwEdit(TRW_ROW, {
        pos: propOf(props[0], "data-transcript-message")!.end,
        text: `,"data-ccup-uuid":${sent}.uuid`,
      }),
    ],
  };
}

// Each half's native file with its fragments in, or null when a site is
// missing or an edit would not parse.
const turnRewindHostBuild = sdelMemo((native) => {
  const sites = turnRewindHostFind(native);
  if (!sites) return null;
  const out = applyEdits(native, sites.edits);
  return unitsReparse(out, sites.edits, sites.units) ? out : null;
});
const turnRewindWebBuild = sdelMemo((native) => {
  const sites = turnRewindWebFind(native);
  if (!sites) return null;
  const out = applyEdits(native, sites.edits);
  return unitsReparse(out, sites.edits, sites.units) ? out : null;
});

// The two ALWAYS_POINTS patches, each gated on the other file's sites.
function turnRewindWebPatch(native: string, read: BundleReader): string | null {
  const host = read(TRW_HOST_FILE);
  if (host === undefined || turnRewindHostBuild(trwStrip(host)) === null)
    return null;
  return turnRewindWebBuild(native);
}
function turnRewindHostPatch(
  native: string,
  read: BundleReader,
): string | null {
  const web = read(TRW_WEBVIEW_FILE);
  if (web === undefined || turnRewindWebBuild(trwStrip(web)) === null)
    return null;
  return turnRewindHostBuild(native);
}

// Either file as an apply writes this point into it given the other, or null
// when either half's sites are gone. scripts/repro's turn-delete.mjs serves
// the webview one and drives the host one, so both run exactly what the
// patcher writes and double as the drift canary.
export function turnRewindWebview(web: string, host: string): string | null {
  return turnRewindWebPatch(trwStrip(web), (rel) =>
    rel === TRW_HOST_FILE ? host : undefined,
  );
}
export function turnRewindHost(host: string, web: string): string | null {
  return turnRewindHostPatch(trwStrip(host), (rel) =>
    rel === TRW_WEBVIEW_FILE ? web : undefined,
  );
}
export const turnRewindScrub = ccupTurnScrub;

// ---------------------------------------------------------------------------
// Bookmark notes (always on, two halves): every row of the Bookmarks pane
// (Claude Code 2.1.286 on) gets a notepad button after its time, and a click
// on it opens a one-line box over the row for a note of the user's own. A
// saved note stands in for the response's opening line in that row, whose
// button then stays shown, and emptying the box drops the note. Enter or
// leaving the box saves, and Escape keeps the note as it was.
//
// A bookmark is a record {uuid, addedAt, writtenAt?} in its session's file
// under the extension's global storage (session-bookmarks/<id>.json), read
// and written through get_session_bookmarks and update_session_bookmark, so
// it follows the session into every panel and window. Both bundles parse each
// record with one zod object schema, which drops any key it does not name, so
// a note rides in the record itself once both schemas name it: ccupNote, an
// optional string. Only the box caps its length, so no note can make its
// bookmark invalid (a record that fails the schema is dropped, and the next
// write deletes it). A note then travels with the native requests and leaves
// with its bookmark, and a restored bundle ignores it until that session's
// next bookmark write drops it.
//
// The webview half (bookmarkNote) is three fragments in webview/index.js:
//   schema  the record schema's ccupNote field
//   text    the row's text, which reads the note first
//   btn     the button after the row's last child, on the bundle's own jsx
//           factory, with the helper on window.__ccupBookmarkNote that styles
//           it, opens the box, and saves
// The save repeats the native update's steps (the list shows the record at
// once, the host's answer replaces it unless the store's revision has moved
// on, a failure rereads the host's list) through the bundle's own session id,
// store and list functions, read off that native update, but sends none of
// its analytics, which would count each note as a bookmark added. A host that
// answers without the note (its bundle not patched yet) gets the user a
// reload notice.
// The host half (bookmarkNoteHost) is one fragment in extension.js:
//   schema  the record schema's ccupNote field
//
// The halves are all or nothing across the two files, as for session delete,
// and every site is found by structure (src/derive.ts). Each insertion is
// wrapped in /*ccup:bnote:<site>*/.../*ccup:bnoteEnd*/, so stripping the
// fragments restores the stock bytes.
// ---------------------------------------------------------------------------
const BNOTE_END = "/*ccup:bnoteEnd*/";
const BNOTE_SCHEMA = "/*ccup:bnote:schema*/";
const BNOTE_TEXT = "/*ccup:bnote:text*/";
const BNOTE_BTN = "/*ccup:bnote:btn*/";
const BNOTE_FRAG_RE = /\/\*ccup:bnote:[-\w]+\*\/[\s\S]*?\/\*ccup:bnoteEnd\*\//g;
const BNOTE_WEBVIEW_FILE = "webview/index.js";
const BNOTE_HOST_FILE = "extension.js";
const bnoteEdit = (marker: string, e: Edit): Edit => ({
  pos: e.pos,
  text: `${marker}${e.text}${BNOTE_END}`,
});
const bnoteStrip = (c: string): string => c.replace(BNOTE_FRAG_RE, "");
// The record's note field, and the box's length limit.
const BNOTE_FIELD = "ccupNote";
const BNOTE_MAX = 200;
// How far ahead of its token the pane's function and the native update may
// start, and how far ahead of its addedAt key the record schema's call.
const BNOTE_FN_REACH = 8000;
const BNOTE_SCHEMA_REACH = 400;
const BNOTE_HELPER_PROP = "__ccupBookmarkNote";
const BNOTE_RELOAD_NOTE = "Reload the window to start using bookmark notes.";
// A notepad bound by three rings, in the 24-unit outline style of the pane's
// own bookmark icons.
const BNOTE_PAD_D =
  "M7.5 4.5h9a2.25 2.25 0 0 1 2.25 2.25v12a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-12A2.25 2.25 0 0 1 7.5 4.5ZM9 3v3m3-3v3m3-3v3M8.25 10.5h7.5m-7.5 3h7.5m-7.5 3h4.5";

// The helper's sheet. The button hides until its row is hovered or holds
// keyboard focus, and stays shown on a row with a note. Its hover square is
// the pane's icon buttons' own, with the class doubled to outrank the
// selected row's rule, which paints every span in that row. The box covers
// the whole row and starts its text where the row's does (12px in, at the
// row text's 13px), its border the focus outline the list's own module
// draws, or VS Code's focus border where a theme leaves that unset.
function bnoteCss(): string {
  return (
    ".ccup-bnote-btn{display:flex;flex:none;align-self:center;align-items:center;justify-content:center;width:20px;height:20px;margin:-2px -4px -2px -6px;border-radius:4px;color:var(--app-secondary-foreground);cursor:pointer;opacity:0}" +
    `${HOVER}>.ccup-bnote-btn,:focus-visible>.ccup-bnote-btn,.ccup-bnote-btn:focus-visible,.ccup-bnote-btn[data-ccup-bnote-on]{opacity:1}` +
    `.ccup-bnote-btn.ccup-bnote-btn${HOVER},.ccup-bnote-btn.ccup-bnote-btn:focus-visible{background-color:var(--app-ghost-button-hover-background);color:var(--app-primary-foreground);outline:none}` +
    ".ccup-bnote-btn>svg{display:block;width:14px;height:14px}" +
    "li:has(>.ccup-bnote-input){position:relative}" +
    ".ccup-bnote-input{position:absolute;inset:0;z-index:1;box-sizing:border-box;width:100%;height:100%;margin:0;padding:0 11px;border:1px solid var(--app-input-active-border,var(--vscode-focusBorder));border-radius:0;outline:none;background:var(--app-input-background);color:var(--app-input-foreground);font:inherit;font-size:13px}" +
    ".ccup-bnote-input::placeholder{color:var(--app-input-placeholder-foreground)}"
  );
}

// The notes' helper, compiled into the webview bundle by toString, so it may
// use only its parameters and the page's globals (the DOM through the
// any-typed globalThis). sidOf, storeOf and norm are the bundle's own session
// id, per-session store and record list functions (see bnoteSaveFind).
// edit(el, session, bookmark) opens the box over the row holding `el`, or
// focuses the one already open there.
function ccupBookmarkNoteWeb(
  css: string,
  sidOf: (s: any) => unknown,
  storeOf: (id: unknown) => any,
  norm: (list: unknown) => any[],
  field: string,
  max: number,
  reloadNote: string,
): { edit(el: any, s: any, bm: any): void } {
  const g = globalThis as Record<string, any>;
  try {
    const sheet = g.document.createElement("style");
    sheet.textContent = css;
    g.document.head.appendChild(sheet);
  } catch {
    // no sheet: the button shows unstyled and the box opens below the row
  }
  const say = (s: any, m: string): void => {
    try {
      void s.showNotification(m, "warning");
    } catch {
      // no host to tell
    }
  };
  // One record through the native update's steps, without its analytics.
  const save = (s: any, bm: any, note: string): void => {
    const id = sidOf(s);
    const host = s.bookmarkHost?.();
    if (id === undefined || host === undefined) return;
    const rec = { ...bm };
    delete rec[field];
    if (note) rec[field] = note;
    const st = storeOf(id);
    const before = st.list.value.bookmarks;
    st.list.value = {
      ...st.list.value,
      bookmarks: norm([...before.filter((b: any) => b.uuid !== bm.uuid), rec]),
    };
    const rev = ++st.revision;
    const settle = (list: unknown): void => {
      if (st.revision === rev)
        st.list.value = { bookmarks: norm(list), loaded: true };
    };
    Promise.resolve()
      .then(() => host.updateSessionBookmark(id, bm.uuid, rec))
      .then(
        (list: unknown) => {
          settle(list);
          // A host bundle without the field keeps the bookmark, not the note.
          const kept = norm(list).find((b: any) => b.uuid === bm.uuid);
          if (note && kept && kept[field] !== note) say(s, reloadNote);
        },
        (e: any) => {
          say(s, `Could not save the note: ${e?.message ?? String(e)}`);
          return Promise.resolve()
            .then(() => host.getSessionBookmarks(id))
            .then(settle, () => settle(before));
        },
      )
      .catch(() => {});
  };
  const edit = (el: any, s: any, bm: any): void => {
    try {
      const row = el?.closest?.("button");
      const li = row?.parentElement;
      if (!li || typeof bm?.uuid !== "string") return;
      const open = li.querySelector(":scope>.ccup-bnote-input");
      if (open) {
        open.focus();
        return;
      }
      const old = typeof bm[field] === "string" ? bm[field] : "";
      const box = g.document.createElement("input");
      box.type = "text";
      box.className = "ccup-bnote-input";
      box.maxLength = max;
      box.value = old;
      box.placeholder = "Add a note";
      box.setAttribute("aria-label", "Bookmark note");
      let done = false;
      const finish = (keep: boolean, back: boolean): void => {
        if (done) return;
        done = true;
        const note = String(box.value).replace(/\s+/g, " ").trim();
        box.remove();
        if (keep && note !== old) save(s, bm, note);
        if (back) (el.isConnected ? el : row).focus?.();
      };
      // The box is no React element, but its keys still reach the pane's own
      // handler, whose Escape closes the pane. The two keys the box answers
      // stop here, and the rest go on to VS Code, which handles copy, paste
      // and undo.
      box.addEventListener("keydown", (e: any) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key !== "Enter" && e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        finish(e.key === "Enter", true);
      });
      box.addEventListener("blur", () => finish(true, false));
      li.appendChild(box);
      box.focus();
      box.select();
    } catch {
      // an edit never breaks the pane
    }
  };
  return { edit };
}

// `<f>()` with `<f>` a plain identifier: its name, else null.
function bnoteBareCall(n: N | null | undefined): string | null {
  return n?.type === "CallExpression" && n.arguments.length === 0
    ? idName(n.callee)
    : null;
}
const bnoteIsCall = (n: N): boolean => n.type === "CallExpression";
const bnoteEscape = (name: string): string => name.replace(/\$/g, "\\$");

// The bookmark record schema, the one call
// `<obj>({uuid:<U>,writtenAt:<num>().optional(),addedAt:<num>()})` assigned to
// a name whose `.safeParse(` the bundle calls, and the insertion naming
// ccupNote in it, built on the string constructor of U's own
// `<U>=<str>().min(1).max(<n>)`. Null when anything differs, or when the
// schema names ccupNote already.
function bnoteSchemaFind(c: string): { unit: N; edit: Edit } | null {
  const found: { call: N; obj: N; uuid: string }[] = [];
  for (
    let i = c.indexOf("addedAt:");
    i >= 0;
    i = c.indexOf("addedAt:", i + 1)
  ) {
    const open = c.lastIndexOf("({", i);
    if (open < 0 || i - open > BNOTE_SCHEMA_REACH) continue;
    let s = open;
    while (s > 0 && /[\w$]/.test(c[s - 1])) s--;
    if (s === open || c[s - 1] === ".") continue;
    const call = parseUnitAt(c, s, bnoteIsCall);
    const obj = call?.arguments[0];
    if (
      !call ||
      !idName(call.callee) ||
      call.arguments.length !== 1 ||
      obj.type !== "ObjectExpression" ||
      obj.start !== open + 1 ||
      !hasKeys(obj, ["uuid", "writtenAt", "addedAt"]) ||
      propOf(obj, BNOTE_FIELD)
    )
      continue;
    const uuid = idName(propOf(obj, "uuid")!.value);
    const num = bnoteBareCall(propOf(obj, "addedAt")!.value);
    const w = propOf(obj, "writtenAt")!.value;
    if (
      !uuid ||
      !num ||
      w.type !== "CallExpression" ||
      w.arguments.length !== 0 ||
      memberProp(w.callee) !== "optional" ||
      bnoteBareCall(w.callee.object) !== num
    )
      continue;
    if (!found.some((f) => f.call.start === call.start))
      found.push({ call, obj, uuid });
  }
  if (found.length !== 1) return null;
  const { call, obj, uuid } = found[0];
  const name = /([\w$]+)=$/.exec(
    c.slice(Math.max(0, call.start - 80), call.start),
  )?.[1];
  if (!name || !c.includes(`${name}.safeParse(`)) return null;
  const strs = new Set<string>();
  const decl = new RegExp(`(?<![\\w$.])${bnoteEscape(uuid)}=(?![=>])`, "g");
  for (const m of c.matchAll(decl)) {
    const v = parseUnitAt(c, m.index! + m[0].length, bnoteIsCall);
    const min = v?.callee.object;
    if (
      !v ||
      memberProp(v.callee) !== "max" ||
      v.arguments.length !== 1 ||
      min?.type !== "CallExpression" ||
      memberProp(min.callee) !== "min" ||
      min.arguments.length !== 1 ||
      min.arguments[0].type !== "Literal" ||
      min.arguments[0].value !== 1
    )
      continue;
    const str = bnoteBareCall(min.callee.object);
    if (str) strs.add(str);
  }
  if (strs.size !== 1) return null;
  const prop = `${BNOTE_FIELD}:${[...strs][0]}().optional()`;
  return { unit: call, edit: bnoteEdit(BNOTE_SCHEMA, appendProp(obj, prop)) };
}

// The native update, the one `function(<s>,<uuid>,<rec>)` calling
// `<host>.updateSessionBookmark(<id>,<uuid>,<rec>)`, read for the functions
// its steps go through: <id>=<sidOf>(<s>) beside <host>=<s>.bookmarkHost(),
// the store <st>=<storeOf>(<id>) whose revision it bumps and whose list.value
// it writes, and <norm>([...,<rec>]). It must also reread with
// `<host>.getSessionBookmarks(<id>)`. Null unless all of that holds and each
// of the three is a function declared once.
function bnoteSaveFind(
  c: string,
): { sidOf: string; storeOf: string; norm: string } | null {
  const fns = unitsWith(
    c,
    ".updateSessionBookmark(",
    "function",
    isFn,
    BNOTE_FN_REACH,
  ).filter(
    // a declaration parses as an expression here, so it reads as a named one
    (f) =>
      f.type !== "ArrowFunctionExpression" &&
      !!f.id &&
      f.params.length === 3 &&
      f.params.every((p: N) => idName(p)),
  );
  if (fns.length !== 1) return null;
  const fn = fns[0];
  const [s, uuid, rec] = fn.params.map((p: N) => idName(p)!);
  const inits = new Map<string, N>();
  const calls: N[] = [];
  const bumped = new Set<string>();
  const written = new Set<string>();
  walk(fn, (n) => {
    if (n.type === "VariableDeclarator" && idName(n.id) && n.init)
      inits.set(idName(n.id)!, n.init);
    if (n.type === "CallExpression") calls.push(n);
    if (
      n.type === "UpdateExpression" &&
      n.operator === "++" &&
      memberProp(n.argument) === "revision" &&
      idName(n.argument.object)
    )
      bumped.add(idName(n.argument.object)!);
    if (
      n.type === "AssignmentExpression" &&
      memberProp(n.left) === "value" &&
      memberProp(n.left.object) === "list" &&
      idName(n.left.object.object)
    )
      written.add(idName(n.left.object.object)!);
  });
  // `<f>(<arg>)`: f's name, else null.
  const callOn = (n: N | undefined, arg: string): string | null =>
    n?.type === "CallExpression" &&
    n.arguments.length === 1 &&
    idName(n.arguments[0]) === arg
      ? idName(n.callee)
      : null;
  const upd = calls.filter(
    (n) =>
      memberProp(n.callee) === "updateSessionBookmark" &&
      n.arguments.length === 3 &&
      idName(n.arguments[1]) === uuid &&
      idName(n.arguments[2]) === rec,
  );
  if (upd.length !== 1) return null;
  const host = idName(upd[0].callee.object);
  const id = idName(upd[0].arguments[0]);
  if (!host || !id || !isCallOf(inits.get(host), s, "bookmarkHost"))
    return null;
  const sidOf = callOn(inits.get(id), s);
  const stores = [...bumped].filter((x) => written.has(x));
  const storeOf = stores.length === 1 ? callOn(inits.get(stores[0]), id) : null;
  const norms = new Set(
    calls
      .filter((n) => {
        const a = n.arguments.length === 1 ? n.arguments[0] : null;
        return (
          a?.type === "ArrayExpression" &&
          idName(a.elements[a.elements.length - 1]) === rec
        );
      })
      .map((n) => idName(n.callee)),
  );
  const rereads = calls.some(
    (n) =>
      isMember(n.callee, host, "getSessionBookmarks") &&
      n.arguments.length === 1 &&
      idName(n.arguments[0]) === id,
  );
  const norm = norms.size === 1 ? [...norms][0] : null;
  if (!sidOf || !storeOf || !norm || !rereads) return null;
  if (new Set([sidOf, storeOf, norm]).size !== 3) return null;
  for (const name of [sidOf, storeOf, norm]) {
    const re = new RegExp(`function ${bnoteEscape(name)}\\(`, "g");
    if ((c.match(re) ?? []).length !== 1) return null;
  }
  return { sidOf, storeOf, norm };
}

// The webview's sites and their three insertions, or null. The pane is the
// one `function({session,bookmarks,selected,...})` around the "Show in
// conversation" link, and its row the one
// `<jsx>("li",{children:<jsxs>("button",{className,onClick,children:[
// <jsx>("span",{className,children:<text>}),...]})},...)` that a map callback
// taking `{bookmark,...}` returns.
function bnoteWebFind(
  c: string,
): { units: [N, (n: N) => boolean][]; edits: Edit[] } | null {
  const schema = bnoteSchemaFind(c);
  const save = schema ? bnoteSaveFind(c) : null;
  if (!schema || !save) return null;
  const panes = unitsWith(
    c,
    '"Show in conversation"',
    "function",
    isFn,
    BNOTE_FN_REACH,
  ).filter((f) => hasKeys(f.params[0], ["session", "bookmarks", "selected"]));
  if (panes.length !== 1) return null;
  const pane = panes[0];
  const sess = boundName(pane.params[0], "session");
  if (!sess) return null;
  const rows: { li: N; row: N; bm: string }[] = [];
  walk(pane, (n) => {
    if (n.type !== "CallExpression" || !isStr(n.arguments[0], "li")) return;
    const lp = n.arguments[1];
    const row = hasKeys(lp, ["children"])
      ? propOf(lp, "children")!.value
      : null;
    const cb = n.parent;
    if (
      row?.type !== "CallExpression" ||
      !isStr(row.arguments[0], "button") ||
      !hasKeys(row.arguments[1], ["className", "onClick", "children"]) ||
      !isFn(cb) ||
      cb!.body !== n ||
      !hasKeys(cb!.params[0], ["bookmark"])
    )
      return;
    const bm = boundName(cb!.params[0], "bookmark");
    if (bm) rows.push({ li: n, row, bm });
  });
  if (rows.length !== 1) return null;
  const { li, row, bm } = rows[0];
  const kids = propOf(row.arguments[1], "children")!.value;
  const els: N[] = kids.type === "ArrayExpression" ? kids.elements : [];
  const first = els[0];
  if (
    first?.type !== "CallExpression" ||
    !isStr(first.arguments[0], "span") ||
    !hasKeys(first.arguments[1], ["className", "children"]) ||
    els.some((e) => !e)
  )
    return null;
  const jsx = idName(first.callee);
  if (!jsx) return null;
  // The session and the bookmark are the pane's and the callback's own, and
  // everything the fragments call comes from outside the pane.
  if (
    bindingSite(li, sess, pane) !== pane ||
    bindingSite(li, bm, pane) !== li.parent
  )
    return null;
  for (const name of [jsx, save.sidOf, save.storeOf, save.norm]) {
    if (bindingSite(li, name, pane) !== null) return null;
  }

  const text = propOf(first.arguments[1], "children")!.value;
  const on = `${bm}.${BNOTE_FIELD}`;
  const ev = "ccupEv";
  const fire = `ccupBn.edit(${ev}.currentTarget,${sess},${bm})`;
  const svg =
    `${jsx}("svg",{xmlns:"http://www.w3.org/2000/svg",fill:"none",viewBox:"0 0 24 24",` +
    `strokeWidth:1.5,stroke:"currentColor","aria-hidden":"true",` +
    `children:${jsx}("path",{strokeLinecap:"round",strokeLinejoin:"round",` +
    `d:${JSON.stringify(BNOTE_PAD_D)}})})`;
  // A held Enter repeats, and must not open the box again behind itself.
  const button =
    `${jsx}("span",{role:"button",tabIndex:0,className:"ccup-bnote-btn",` +
    `"data-ccup-bnote-on":${on}?"":void 0,` +
    `title:${on}?"Edit note":"Add note",` +
    `onClick:(${ev})=>{${ev}.stopPropagation(),${fire}},` +
    `onKeyDown:(${ev})=>{if(${ev}.key==="Enter"||${ev}.key===" "){${ev}.preventDefault(),${ev}.stopPropagation();` +
    `if(!${ev}.repeat)${fire}}},` +
    `children:${svg}})`;
  const helper =
    `(${ccupBookmarkNoteWeb.toString()})(${JSON.stringify(bnoteCss())},` +
    `${save.sidOf},${save.storeOf},${save.norm},${JSON.stringify(BNOTE_FIELD)},` +
    `${BNOTE_MAX},${JSON.stringify(BNOTE_RELOAD_NOTE)})`;
  return {
    units: [
      [pane, isFn],
      [schema.unit, bnoteIsCall],
    ],
    edits: [
      schema.edit,
      bnoteEdit(BNOTE_TEXT, { pos: text.start, text: `${on}?${on}:` }),
      bnoteEdit(BNOTE_BTN, {
        pos: els[els.length - 1].end,
        text:
          `,((ccupBn)=>${button})(window.${BNOTE_HELPER_PROP}||` +
          `(window.${BNOTE_HELPER_PROP}=${helper}))`,
      }),
    ],
  };
}

// The host's site, the record schema, in a bundle that answers
// update_session_bookmark.
function bnoteHostFind(
  c: string,
): { units: [N, (n: N) => boolean][]; edits: Edit[] } | null {
  if (!c.includes('"update_session_bookmark"')) return null;
  const schema = bnoteSchemaFind(c);
  return schema
    ? { units: [[schema.unit, bnoteIsCall]], edits: [schema.edit] }
    : null;
}

// Each half's native file with its fragments in, or null when a site is
// missing or an edit would not parse.
const bnoteWebBuild = sdelMemo((native) => {
  const sites = bnoteWebFind(native);
  if (!sites) return null;
  const out = applyEdits(native, sites.edits);
  return unitsReparse(out, sites.edits, sites.units) ? out : null;
});
const bnoteHostBuild = sdelMemo((native) => {
  const sites = bnoteHostFind(native);
  if (!sites) return null;
  const out = applyEdits(native, sites.edits);
  return unitsReparse(out, sites.edits, sites.units) ? out : null;
});

// The two ALWAYS_POINTS patches, each gated on the other file's sites.
function bookmarkNoteWebPatch(
  native: string,
  read: BundleReader,
): string | null {
  const host = read(BNOTE_HOST_FILE);
  if (host === undefined || bnoteHostBuild(bnoteStrip(host)) === null)
    return null;
  return bnoteWebBuild(native);
}
function bookmarkNoteHostPatch(
  native: string,
  read: BundleReader,
): string | null {
  const web = read(BNOTE_WEBVIEW_FILE);
  if (web === undefined || bnoteWebBuild(bnoteStrip(web)) === null) return null;
  return bnoteHostBuild(native);
}

// Either file as an apply writes this point into it given the other, or null
// when either half's sites are gone. scripts/repro's bookmark-notes.mjs serves
// the webview one, which builds only when the host's site is found too, so it
// runs exactly what the patcher writes and doubles as the drift canary for
// both halves.
export function bookmarkNoteWebview(web: string, host: string): string | null {
  return bookmarkNoteWebPatch(bnoteStrip(web), (rel) =>
    rel === BNOTE_HOST_FILE ? host : undefined,
  );
}
export function bookmarkNoteHost(host: string, web: string): string | null {
  return bookmarkNoteHostPatch(bnoteStrip(host), (rel) =>
    rel === BNOTE_WEBVIEW_FILE ? web : undefined,
  );
}

// ---------------------------------------------------------------------------
// Input box selection redraw (always on): the input box's mention and
// slash-command detector (the hook yielding `{atMention,slashCommand,...}`)
// subscribes to `selectionchange` on the whole document and answers every one
// by bumping a state counter, `()=>{<set>(n=>n+1)}`, which re-renders the
// whole input area. A drag across the transcript fires one per mouse move, so
// the input area re-rendered at the pointer's rate while nothing in it could
// change: the hook's own memo leaves the counter out of its deps, and every
// read of the selection in that component sits in an event callback, never
// in render. On a 150-turn transcript that was about half of a drag's script
// time, roughly 0.4ms a move.
//
// One fragment, /*ccup:mentionRedraw*/.../*ccup:mentionRedrawEnd*/, at the
// head of the listener's body lets the bump through only when the selection
// touches the editable (an end inside it, or the editable inside the range)
// or touched it at the previous change. A caret move, a selection inside the
// box, and the change that leaves it all re-render exactly as natively, and a
// selection that never comes near the box stays out of React. The previous
// answer rides on the editable as an expando, and any error lets the bump
// through.
//
// Found by structure (src/derive.ts): in a function that builds an object
// carrying both atMention and slashCommand, an effect `<eff>(()=>{...},[J])`
// whose callback returns early on `!J`, calls
// `document.addEventListener("selectionchange",U)` and
// `J.addEventListener("keydown",H)`, and declares U itself as exactly that
// one-statement counter bump, with J the function's own parameter wherever the
// fragment reads it.
// ---------------------------------------------------------------------------
const MREDRAW_MARKER = "/*ccup:mentionRedraw*/";
const MREDRAW_END = "/*ccup:mentionRedrawEnd*/";
const MREDRAW_FRAG_RE =
  /\/\*ccup:mentionRedraw\*\/[\s\S]*?\/\*ccup:mentionRedrawEnd\*\//g;
const MREDRAW_FILE = "webview/index.js";
// Set on the editable: whether the previous selection change touched it.
const MREDRAW_IN_PROP = "__ccupMentionIn";
// How far ahead of a "selectionchange" token its function may start (the
// detector spans about 900 chars on 2.1.304).
const MREDRAW_REACH = 20000;

// `<obj>.addEventListener("<type>",<fn>)` with both identifiers, as their
// names, or null.
function mredrawListener(n: N, type: string): [string, string] | null {
  if (
    n.type !== "CallExpression" ||
    n.arguments.length !== 2 ||
    memberProp(n.callee) !== "addEventListener" ||
    !isStr(n.arguments[0], type)
  )
    return null;
  const obj = idName(n.callee.object);
  const fn = idName(n.arguments[1]);
  return obj && fn ? [obj, fn] : null;
}

// `<set>(n=>n+1)`: one call of an identifier on an arrow adding 1 to its only
// parameter.
function mredrawIsBump(st: N | undefined): boolean {
  if (!st || st.type !== "ExpressionStatement") return false;
  const call = st.expression;
  if (
    call.type !== "CallExpression" ||
    !idName(call.callee) ||
    call.arguments.length !== 1
  )
    return false;
  const f = call.arguments[0];
  if (f.type !== "ArrowFunctionExpression" || f.params.length !== 1)
    return false;
  const p = idName(f.params[0]);
  const b = f.body;
  return (
    !!p &&
    b.type === "BinaryExpression" &&
    b.operator === "+" &&
    idName(b.left) === p &&
    b.right.type === "Literal" &&
    b.right.value === 1
  );
}

// The gate the fragment puts ahead of the bump, reading the editable as J.
function mredrawGate(j: string): string {
  const p = MREDRAW_IN_PROP;
  return (
    `if(!function(e){try{var s=document.getSelection(),` +
    `t=!!s&&s.rangeCount>0&&(e.contains(s.anchorNode)||e.contains(s.focusNode)||s.containsNode(e,!0)),` +
    `w=!!e.${p};e.${p}=t;return t||w}catch(x){return!0}}(${j}))return;`
  );
}

function mentionRedrawFind(c: string): { unit: N; edit: Edit } | null {
  const detectors = unitsWith(
    c,
    '"selectionchange"',
    "function",
    isFn,
    MREDRAW_REACH,
  ).filter((f) => {
    let found = false;
    walk(f, (n) => {
      if (found) return false;
      if (hasKeys(n, ["atMention", "slashCommand"])) found = true;
    });
    return found;
  });
  const sites: { unit: N; edit: Edit }[] = [];
  for (const hook of detectors) {
    walk(hook, (n) => {
      const sel = mredrawListener(n, "selectionchange");
      if (!sel || sel[0] !== "document") return;
      // The effect callback making the call, and the effect keyed on [J].
      let eff = n.parent;
      while (eff && !isFn(eff)) eff = eff.parent;
      if (!eff || eff === hook || eff.body.type !== "BlockStatement") return;
      const call = eff.parent;
      const deps = call?.arguments?.[1];
      if (
        call?.type !== "CallExpression" ||
        call.arguments[0] !== eff ||
        deps?.type !== "ArrayExpression" ||
        deps.elements.length !== 1
      )
        return;
      const j = idName(deps.elements[0]);
      if (!j || !hook.params.some((p: N) => idName(p) === j)) return;
      const first = eff.body.body[0];
      if (
        first?.type !== "IfStatement" ||
        first.test.type !== "UnaryExpression" ||
        first.test.operator !== "!" ||
        idName(first.test.argument) !== j ||
        first.consequent.type !== "ReturnStatement"
      )
        return;
      let keys = false;
      walkOwn(eff, (m) => {
        if (keys) return false;
        if (mredrawListener(m, "keydown")?.[0] === j) keys = true;
      });
      if (!keys) return;
      // U, declared in the callback as the bump, is what the call passes.
      const u = sel[1];
      const decls: N[] = [];
      walkOwn(eff, (m) => {
        if (m.type === "VariableDeclarator" && idName(m.id) === u)
          decls.push(m);
      });
      if (decls.length !== 1) return;
      const fn = decls[0].init;
      if (
        fn?.type !== "ArrowFunctionExpression" ||
        fn.params.length !== 0 ||
        fn.body.type !== "BlockStatement" ||
        fn.body.body.length !== 1 ||
        !mredrawIsBump(fn.body.body[0])
      )
        return;
      const uScope = bindingSite(n.arguments[1], u, hook);
      if (!uScope || decls[0].parent?.parent !== uScope) return;
      if (bindingSite(fn.body.body[0], j, hook) !== hook) return;
      sites.push({
        unit: hook,
        edit: {
          pos: fn.body.start + 1,
          text: `${MREDRAW_MARKER}${mredrawGate(j)}${MREDRAW_END}`,
        },
      });
    });
  }
  return sites.length === 1 ? sites[0] : null;
}

// The native webview bundle with the fragment in, or null when the site is
// missing or the edit would not parse.
const mentionRedrawBuild = sdelMemo((native) => {
  const site = mentionRedrawFind(native);
  if (!site) return null;
  const out = applyEdits(native, [site.edit]);
  return unitsReparse(out, [site.edit], [[site.unit, isFn]]) ? out : null;
});

function mentionRedrawPatch(native: string): string | null {
  return mentionRedrawBuild(native);
}

// The webview bundle, patched or not, as an apply writes this point into it,
// or null when its site is gone. scripts/repro's mention-redraw.mjs serves
// this, so it runs exactly what the patcher writes and doubles as the drift
// canary.
export function mentionRedrawWebview(web: string): string | null {
  return mentionRedrawBuild(web.replace(MREDRAW_FRAG_RE, ""));
}

// ---------------------------------------------------------------------------
// Chat math rendering (ON): the chat webview renders agent markdown through
// react-markdown with no math support, so TeX like $\mathcal{G}$ shows as raw
// source. When ON we render it with a bundled KaTeX (vendored under this
// extension's assets/katex, refreshed via `npm run update-katex`). Detection
// happens BEFORE the markdown parser runs, which is what makes it robust: a
// marked wrapper around the markdown component's content initializer rewrites
// each math span in the RAW markdown string into an inline code span carrying
// a base64 payload (so `_`/`*`/`|` inside math can never turn into emphasis or
// break tables), and a marked hook at the head of the component map's `code`
// renderer turns that payload back into a React element whose innerHTML is
// KaTeX's output. React owns the produced DOM, so streaming re-renders
// reconcile cleanly (no post-hoc DOM mutation, which React can crash on).
//
// Delimiters: $$…$$ (display when it sits alone on its line(s), inline
// otherwise), $…$ (single line; the opener must not be followed by whitespace
// or another $, the closer must not be preceded by whitespace nor followed by
// a digit, so "$5 and $10" stays currency), \(…\) inline, and \[…\] display.
// A span containing a blank line never matches. Fenced code blocks and inline
// code spans are skipped; after a stray unclosed backtick run the rest of that
// paragraph is left untouched, since an added marker backtick there could
// re-pair with the stray one and leak the payload as literal text.
//
// Pieces written into the bundle (each marked, all stripped on OFF/restore):
//   wrapA/wrapB  two inline fragments around the content initializer in the
//                markdown component (`let n=i?trim(e):e` keeps its stock bytes
//                between them), routing the string through the preprocessor
//   code         one inline fragment at the head of the `code` component
//                override, rendering marker payloads via the hook (the code
//                component is reached by both inline code and fenced blocks,
//                and the marker regex is anchored so real code never matches)
//   katex block  katex.min.js appended at EOF between block markers, wrapped
//                in (function(define,module,exports){…})() so the UMD header
//                sees none of them and lands on its self.katex branch (the
//                bundle is an ES module: no CommonJS globals, but shadowing
//                also guards against a future AMD loader in the bundle)
//   helper block the webview-side preprocessor + renderer (the compiled
//                ccupMathHelperWebview below, injected via toString), between
//                block markers since it is multi-line
//   css line     katex.min.css plus the font-size override, appended to
//                webview/index.css via the toggle's cssBuild side-effect; the
//                stylesheet is loaded with <link>, so its relative
//                url(fonts/…) sources resolve next to index.css
//   fonts        the woff2 files copied into <install>/webview/fonts/ (the
//                webview CSP allows font-src from the extension directory;
//                data: URIs are not in font-src, so inlining is not an
//                option); removed again on OFF/restore
//
// The math size rides chatMathFontSizeEm (em, relative to the chat text):
// KaTeX's own default is 1.21em, sized for documents; 1.0 matches the chat
// text. The em value is baked into the css line, so a change re-applies via
// the same stale-line reconcile as any other knob (the key belongs to the
// chatMathSize point, so the config listener picks it up). At 0, the native
// setting, this renderer draws the text size, as the old default of 1 did.
//
// The two inline anchors are all-or-nothing: if either regex fails to match
// this build, nothing is inserted (a wrapper without the code hook would leak
// marker text into the chat). The current-state check compares each piece
// separately (inline fragments by re-deriving them onto the stripped bundle,
// helper/katex/css lines by marker extraction), NOT whole-file equality, so
// it stays true however other EOF-appended toggle lines are ordered around
// ours. mathSet returns the input unchanged when already current, so a
// re-apply never shuffles EOF lines for nothing.
// ---------------------------------------------------------------------------

// KaTeX assets, loaded once at activation from this extension's own install
// dir (initMathAssets). undefined => feature reports missing and stays inert.
interface MathAssets {
  js: string; // katex.min.js (single line, verbatim)
  css: string; // katex.min.css (single line)
  fontsDir: string; // absolute path to the vendored woff2 files
  fontNames: string[]; // KaTeX_*.woff2 names shipped by this build
}
let mathAssets: MathAssets | undefined;

export function initMathAssets(extensionDir: string): void {
  try {
    const base = path.join(extensionDir, "assets", "katex");
    const js = fs
      .readFileSync(path.join(base, "katex.min.js"), "utf8")
      .replace(/\/\/# sourceMappingURL=[^\n]*/g, "")
      .trim();
    const css = fs
      .readFileSync(path.join(base, "katex.min.css"), "utf8")
      .trim();
    const fontsDir = path.join(base, "fonts");
    const fontNames = fs
      .readdirSync(fontsDir)
      .filter((f) => /^KaTeX_[\w-]+\.woff2$/.test(f));
    // The payload strips/anchors are line- and marker-based: a multi-line or
    // marker-colliding asset can't be embedded safely, so refuse it (the
    // toggle then reports missing rather than corrupting the bundle).
    if (
      !js ||
      !css ||
      js.includes("\n") ||
      css.includes("\n") ||
      js.includes("ccup") ||
      css.includes("ccup") ||
      !fontNames.length
    ) {
      mathAssets = undefined;
      return;
    }
    mathAssets = { js, css, fontsDir, fontNames };
  } catch {
    mathAssets = undefined;
  }
}

// The markdown component every agent text block renders through, found by
// its params destructure: content, context, and the streaming flag, plus
// whatever props a build adds (2.1.286 added `links`). The flag was the
// boolean `isPartialText` through 2.1.300. 2.1.301 renamed it `streaming`,
// where it names how the text splits into chunks and is unset once settled.
// chatMath and rawMd both read their sites off it, so the parse is kept per
// bundle text.
const MD_FLAGS = ["isPartialText", "streaming"];
const MD_PARAMS_REACH = 2000;
let mdMemo: { input: string; unit: N | null } | undefined;

function mdComponent(c: string): N | null {
  if (mdMemo?.input !== c) {
    // Either flag will do, but only one component may match across both.
    const found = new Map<number, N>();
    for (const flag of MD_FLAGS) {
      const keys = ["content", "context", flag];
      for (const f of unitsWith(
        c,
        `${flag}:`,
        "function",
        isFn,
        MD_PARAMS_REACH,
      )) {
        if (hasKeys(f.params[0], keys)) found.set(f.start, f);
      }
    }
    const u = found.size === 1 ? [...found.values()][0] : null;
    mdMemo = {
      input: c,
      unit: u?.body.type === "BlockStatement" ? u : null,
    };
  }
  return mdMemo.unit;
}

const MATH_FRAG_END = "/*ccup:mathEnd*/";
const mathFrag = (tag: string, code: string): string =>
  `/*ccup:math:${tag}*/${code}${MATH_FRAG_END}`;
const MATH_FRAG_RE = /\/\*ccup:math:[-\w]+\*\/[\s\S]*?\/\*ccup:mathEnd\*\//g;

const MATH_KATEX_START = "/*ccup:mathKatexStart*/";
const MATH_KATEX_END = "/*ccup:mathKatexEnd*/";
const MATH_KATEX_BLOCK_RE =
  /\n?\/\*ccup:mathKatexStart\*\/[\s\S]*?\/\*ccup:mathKatexEnd\*\//g;

const MATH_HELPER_START = "/*ccup:mathHelperStart*/";
const MATH_HELPER_BLOCK_RE =
  /\n?\/\*ccup:mathHelperStart\*\/[\s\S]*?\/\*ccup:mathHelperEnd\*\//g;

const MATH_CSS_MARKER = "/*ccup:mathCss*/";
// The math size, the chatMathSize point's key: 0 = native, any other value an
// em of the chat text. The math css line bakes it in too.
const MATH_EM_KEY = "chatMathFontSizeEm";

// Settings that feed a point's build output without being a point of their own
// (the find-bar chord settings bake into its cfg line), so a change must run
// autoApply and a factory reset must clear them like any point key.
export const EXTRA_PATCH_KEYS: [string, number | string][] = [
  ["chatFindBarNextMatchKeys", ""],
  ["chatFindBarPreviousMatchKeys", ""],
  ["chatFindBarNextMatchBlockKeys", ""],
  ["chatFindBarPreviousMatchBlockKeys", ""],
];

// A pinned math size in em, clamped to [0.5, 3], or undefined at native (0,
// unset, or not a number).
function mathEmPin(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
    return undefined;
  return Math.round(Math.min(3, Math.max(0.5, raw)) * 100) / 100;
}

// The bundled renderer's size, baked into the math css line. At native it is
// the text size: how math read before Claude Code rendered it (raw TeX in the
// text), and what the old default of 1 drew.
function readMathEm(): string {
  const raw = vscode.workspace
    .getConfiguration(CONFIG_NS)
    .get<number>(MATH_EM_KEY, 0);
  return String(mathEmPin(raw) ?? 1);
}

// Runs inside the chat webview, injected verbatim via toString(): it must stay
// fully self-contained (no references to module scope, no TS-only runtime
// constructs) and must never contain the literal comment-closer of the block
// markers. Everything is try/catch-wrapped so it can never break the chat.
function ccupMathHelperWebview(): void {
  const g = globalThis as Record<string, any>;
  try {
    if (g.__ccupMathW) return;
    const S = "\uE000"; // private-use sentinel, never in real chat text
    const MRE = new RegExp("^" + S + "([DI]):([A-Za-z0-9+/=]*)" + S + "$");
    const enc = (t: string): string => {
      try {
        return g.btoa(unescape(encodeURIComponent(t)));
      } catch {
        return "";
      }
    };
    const dec = (t: string): string => {
      try {
        return decodeURIComponent(escape(g.atob(t)));
      } catch {
        return "";
      }
    };
    const mark = (kind: string, tex: string): string | null => {
      const b = enc(tex);
      return b ? "`" + S + kind + ":" + b + S + "`" : null;
    };
    const ink = (t: string): boolean => /\S/.test(t);
    const isSp = (c: string): boolean => c === " " || c === "\t";
    // Next unescaped `tok` at or after `from`; rejected when a blank line
    // (paragraph break, which TeX math cannot contain) sits before it.
    const findTok = (s: string, from: number, tok: string): number => {
      let j = s.indexOf(tok, from);
      while (j >= 0) {
        let b = 0;
        let k = j - 1;
        while (k >= from && s.charAt(k) === "\\") {
          b++;
          k--;
        }
        if (b % 2 === 0) {
          const bl = s.indexOf("\n\n", from);
          return bl >= 0 && bl < j ? -1 : j;
        }
        j = s.indexOf(tok, j + 1);
      }
      return -1;
    };

    // Preprocessor: raw markdown in, markdown with math spans replaced by
    // `<sentinel-tagged base64>` inline code spans out.
    g.__ccupMathW = function (s: unknown): unknown {
      try {
        if (typeof s !== "string") return s;
        if (
          s.indexOf("$") < 0 &&
          s.indexOf("\\(") < 0 &&
          s.indexOf("\\[") < 0
        ) {
          return s;
        }
        const n = s.length;
        let out = "";
        let i = 0;
        let lineStart = true;
        let poison = -1; // after a stray backtick: no conversion before this index
        while (i < n) {
          const c = s.charAt(i);
          if (c === "\n") {
            out += c;
            i++;
            lineStart = true;
            continue;
          }
          if (lineStart) {
            lineStart = false;
            // Fenced code block (0-3 spaces, then 3+ backticks or tildes):
            // copy through the closing fence untouched.
            let j = i;
            let spn = 0;
            while (j < n && s.charAt(j) === " " && spn < 3) {
              j++;
              spn++;
            }
            const f = s.charAt(j);
            if (f === "`" || f === "~") {
              let k = j;
              while (k < n && s.charAt(k) === f) k++;
              const flen = k - j;
              if (flen >= 3) {
                let close = -1;
                let p = k;
                for (;;) {
                  const nl = s.indexOf("\n", p);
                  if (nl < 0) break;
                  let q = nl + 1;
                  let sp2 = 0;
                  while (q < n && s.charAt(q) === " " && sp2 < 3) {
                    q++;
                    sp2++;
                  }
                  let r = q;
                  while (r < n && s.charAt(r) === f) r++;
                  if (r - q >= flen) {
                    let t = r;
                    while (t < n && isSp(s.charAt(t))) t++;
                    if (t >= n || s.charAt(t) === "\n") {
                      close = t;
                      break;
                    }
                  }
                  p = nl + 1;
                }
                if (close < 0) {
                  out += s.slice(i); // unclosed fence: rest is code
                  i = n;
                  break;
                }
                out += s.slice(i, close);
                i = close;
                continue;
              }
            }
          }
          if (c === "`") {
            // Inline code span: a run of L backticks closes at the next run of
            // exactly L within the paragraph. Unpaired runs poison the rest of
            // the paragraph (a marker's backticks could re-pair with them).
            let k = i;
            while (k < n && s.charAt(k) === "`") k++;
            const L = k - i;
            let lim = s.indexOf("\n\n", k);
            if (lim < 0) lim = n;
            let p = k;
            let close = -1;
            while (p < lim) {
              const b1 = s.indexOf("`", p);
              if (b1 < 0 || b1 >= lim) break;
              let b2 = b1;
              while (b2 < n && s.charAt(b2) === "`") b2++;
              if (b2 - b1 === L) {
                close = b2;
                break;
              }
              p = b2;
            }
            if (close >= 0) {
              out += s.slice(i, close);
              i = close;
              continue;
            }
            out += s.slice(i, k);
            i = k;
            poison = lim;
            continue;
          }
          if (poison >= 0) {
            if (i < poison) {
              let nl = s.indexOf("\n", i);
              if (nl < 0) nl = n;
              let stop = Math.min(poison, nl);
              if (stop <= i) stop = i + 1;
              out += s.slice(i, stop);
              i = stop;
              continue;
            }
            poison = -1;
          }
          if (c === "\\") {
            const d = s.charAt(i + 1);
            if (d === "(" || d === "[") {
              const e = findTok(s, i + 2, d === "(" ? "\\)" : "\\]");
              if (e >= 0) {
                const tex = s.slice(i + 2, e);
                if (ink(tex) && tex.length <= 5000) {
                  const mk = mark(d === "[" ? "D" : "I", tex);
                  if (mk) {
                    out += mk;
                    i = e + 2;
                    continue;
                  }
                }
              }
            }
            out += s.slice(i, i + 2); // escape pair (covers \$) stays verbatim
            i += 2;
            continue;
          }
          if (c === "$") {
            if (s.charAt(i + 1) === "$") {
              const e = findTok(s, i + 2, "$$");
              if (e >= 0) {
                const tex = s.slice(i + 2, e);
                if (ink(tex) && tex.length <= 5000) {
                  // Display only when the $$…$$ sits alone on its line(s)
                  // (blockquote `>` prefixes allowed); inline otherwise.
                  const ls = s.lastIndexOf("\n", i - 1) + 1;
                  const head = s.slice(ls, i);
                  const after = e + 2;
                  let nl = s.indexOf("\n", after);
                  if (nl < 0) nl = n;
                  const tail = s.slice(after, nl);
                  const disp = /^[ \t>]*$/.test(head) && /^[ \t]*$/.test(tail);
                  // Inside a blockquote the continuation lines carry "> "
                  // prefixes that are markdown syntax, not TeX: strip them.
                  const tex2 =
                    disp && head.indexOf(">") >= 0
                      ? tex.replace(/\n[ \t]*(?:>[ \t]?)+/g, "\n")
                      : tex;
                  const mk = mark(disp ? "D" : "I", tex2);
                  if (mk) {
                    out += mk;
                    i = after;
                    continue;
                  }
                }
              }
              out += "$$";
              i += 2;
              continue;
            }
            // Single $: same line only; opener not followed by whitespace or
            // $, closer not preceded by whitespace nor followed by a digit
            // (Pandoc's heuristic, so currency stays literal).
            const prev = i > 0 ? s.charAt(i - 1) : "";
            const next = s.charAt(i + 1);
            if (next !== "" && next !== "$" && !isSp(next) && prev !== "$") {
              let j2 = i + 1;
              let close = -1;
              while (j2 < n) {
                const ch = s.charAt(j2);
                if (ch === "\n") break;
                if (ch === "\\") {
                  j2 += 2;
                  continue;
                }
                if (ch === "$") {
                  const pb = s.charAt(j2 - 1);
                  const pa = s.charAt(j2 + 1);
                  if (!isSp(pb) && !(pa >= "0" && pa <= "9")) close = j2;
                  break;
                }
                j2++;
              }
              if (close > i + 1) {
                const tex = s.slice(i + 1, close);
                if (ink(tex) && tex.length <= 2000) {
                  const mk = mark("I", tex);
                  if (mk) {
                    out += mk;
                    i = close + 1;
                    continue;
                  }
                }
              }
            }
            out += c;
            i++;
            continue;
          }
          // Bulk copy to the next character of interest (\n $ \ `).
          let stop = n;
          for (let t = i + 1; t < n; t++) {
            const cc = s.charCodeAt(t);
            if (cc === 10 || cc === 36 || cc === 92 || cc === 96) {
              stop = t;
              break;
            }
          }
          out += s.slice(i, stop);
          i = stop;
        }
        return out;
      } catch {
        return s;
      }
    };

    // Renderer hook: called at the head of the `code` component with the
    // build's jsx factory and the code span's children. Returns a React
    // element for marker payloads, null for everything else (real code).
    const cache = new Map<string, string | null>();
    g.__ccupMathR = function (jsx: any, children: unknown): any {
      try {
        if (typeof children !== "string") return null;
        const m = MRE.exec(children);
        if (!m) return null;
        const disp = m[1] === "D";
        const tex = dec(m[2]);
        const raw = disp ? "$$" + tex + "$$" : "$" + tex + "$";
        const K = g.katex;
        if (!K || !K.renderToString) return jsx("span", { children: raw });
        const key = m[1] + m[2];
        let html = cache.get(key);
        if (html === undefined) {
          try {
            html = K.renderToString(tex, {
              displayMode: disp,
              throwOnError: false,
              strict: "ignore",
            }) as string;
          } catch {
            html = null; // wrong-type ParseError etc.: fall back to raw TeX
          }
          if (cache.size > 800) cache.clear();
          cache.set(key, html);
        }
        if (!html) return jsx("span", { children: raw });
        return jsx("span", {
          className: disp ? "ccup-math ccup-math-d" : "ccup-math",
          dangerouslySetInnerHTML: { __html: html },
        });
      } catch {
        return null;
      }
    };
  } catch {
    // never break the webview
  }
}

function mathHelperBlock(): string {
  return `${MATH_HELPER_START};(${ccupMathHelperWebview.toString()})();/*ccup:mathHelperEnd*/`;
}

function mathKatexBlock(): string | undefined {
  if (!mathAssets) return undefined;
  return `${MATH_KATEX_START};(function(define,module,exports){${mathAssets.js}})();${MATH_KATEX_END}`;
}

// Claude Code 2.1.301 renders chat math itself: it bundles its own KaTeX
// into the webview, renders each formula through a memoized component, and
// styles the result under the markdown root, behind a server-side gate that is
// on unless switched off. KaTeX's own `katex-mathml` class name outside this
// patch's KaTeX block is what says a build ships that copy. The point then
// reads native and writes nothing: no bundle edit, no css line, no fonts.
// Scanned in place, since copying the bundle without the block costs about
// 5ms a call.
const KATEX_OWN_TOKEN = '"katex-mathml"';
function mathNative(c: string): boolean {
  const s = c.indexOf(MATH_KATEX_START);
  const e = s < 0 ? -1 : c.indexOf(MATH_KATEX_END, s);
  for (
    let i = c.indexOf(KATEX_OWN_TOKEN);
    i >= 0;
    i = c.indexOf(KATEX_OWN_TOKEN, i + 1)
  ) {
    if (s < 0 || i < s || (e >= 0 && i > e)) return true;
  }
  return false;
}

// The math sites on 2.1.300 and earlier, found by structure. wrap: the
// markdown component's content initializer, the declarator
// `isPartialText ? <split>(content) : content`, which the two wrap fragments
// route through the KaTeX preprocessor. code: the component map's `code`
// renderer, whose body opens `if(className)return
// <jsx>("code",{className,children})`; the code fragment goes in ahead of that
// `if`. Since 2.1.282 the map sits in a memoized chunk component rather than in
// the markdown component, so the renderer is found from its own `code:(` token
// and must be the only one of its shape.
const MATH_UNIT_REACH = 200000;
let mathMemo: { input: string; output: string | null } | undefined;

// The bundle with the inline fragments in, or null when a site is missing,
// ambiguous, or the edit would not parse.
function mathBuild(c: string): string | null {
  if (mathMemo?.input !== c) {
    mathMemo = { input: c, output: mathBuildUncached(c) };
  }
  return mathMemo.output;
}

function mathBuildUncached(c: string): string | null {
  if (mathNative(c)) return null;
  const m = mdComponent(c);
  const content = m ? boundName(m.params[0], "content") : null;
  const partial = m ? boundName(m.params[0], "isPartialText") : null;
  if (!m || !content || !partial) return null;
  const inits: N[] = [];
  walkOwn(m, (n) => {
    const v = n.type === "VariableDeclarator" ? n.init : null;
    if (
      v?.type === "ConditionalExpression" &&
      idName(v.test) === partial &&
      idName(v.alternate) === content &&
      v.consequent.type === "CallExpression" &&
      idName(v.consequent.arguments[0]) === content
    )
      inits.push(v);
  });
  if (inits.length !== 1) return null;
  const renderers: { unit: N; first: N; jsx: string; children: string }[] = [];
  const units: N[] = [];
  for (let i = c.indexOf("code:("); i >= 0; i = c.indexOf("code:(", i + 1)) {
    if (units.some((u) => u.start <= i && i < u.end)) continue;
    const u =
      m.start <= i && i < m.end
        ? m
        : unitAround(c, i, "function", isFn, MATH_UNIT_REACH);
    if (!u) continue;
    units.push(u);
    walk(u, (n) => {
      if (n.type !== "Property" || keyName(n) !== "code" || !isFn(n.value))
        return;
      const f = n.value;
      const p = f.params[0];
      const children = hasKeys(p, ["children", "className"])
        ? boundName(p, "children")
        : null;
      const cls = children ? boundName(p, "className") : null;
      const first = f.body.type === "BlockStatement" ? f.body.body[0] : null;
      const call =
        cls &&
        first?.type === "IfStatement" &&
        idName(first.test) === cls &&
        first.consequent.type === "ReturnStatement"
          ? first.consequent.argument
          : null;
      const props =
        call?.type === "CallExpression" && isStr(call.arguments[0], "code")
          ? call.arguments[1]
          : null;
      const jsx = props ? idName(call.callee) : null;
      if (
        jsx &&
        hasKeys(props, ["className", "children"]) &&
        idName(propOf(props, "className")!.value) === cls &&
        idName(propOf(props, "children")!.value) === children
      )
        renderers.push({ unit: u, first, jsx, children: children! });
    });
  }
  if (renderers.length !== 1) return null;
  const r = renderers[0];
  const edits: Edit[] = [
    {
      pos: inits[0].start,
      text: mathFrag(
        "wrapA",
        "(window.__ccupMathW||function(ccupX){return ccupX})(",
      ),
    },
    { pos: inits[0].end, text: mathFrag("wrapB", ")") },
    {
      pos: r.first.start,
      text: mathFrag(
        "code",
        `var ccupM=window.__ccupMathR&&window.__ccupMathR(${r.jsx},${r.children});if(ccupM)return ccupM;`,
      ),
    },
  ];
  const out = applyEdits(c, edits);
  const check: [N, (n: N) => boolean][] = [[m, isFn]];
  if (r.unit !== m) check.push([r.unit, isFn]);
  return unitsReparse(out, edits, check) ? out : null;
}

function mathAnchorsPresent(c: string): boolean {
  return mathBuild(c) !== null;
}
function mathMarksPresent(c: string): boolean {
  return (
    c.includes("/*ccup:math:") ||
    c.includes(MATH_HELPER_START) ||
    c.includes(MATH_KATEX_START)
  );
}
// Remove every trace (inline fragments + both EOF blocks), restoring those
// spots to stock bytes.
function mathStrip(c: string): string {
  return c
    .replace(MATH_KATEX_BLOCK_RE, "")
    .replace(MATH_HELPER_BLOCK_RE, "")
    .replace(MATH_FRAG_RE, "");
}
// Remove only the EOF blocks, keeping the inline fragments in place (for the
// order-insensitive current check).
function mathStripEof(c: string): string {
  return c.replace(MATH_KATEX_BLOCK_RE, "").replace(MATH_HELPER_BLOCK_RE, "");
}
// Insert the inline fragments into a STRIPPED bundle (the caller has checked
// mathAnchorsPresent; an unbuildable bundle comes back unchanged).
function mathApplyInline(c: string): string {
  return mathBuild(c) ?? c;
}

function mathPresent(c: string): boolean {
  return (
    mathMarksPresent(c) || (mathAssets !== undefined && mathAnchorsPresent(c))
  );
}
// true = ON in exactly this build's form (also when marked but unrebuildable,
// so an orphaned patch still reads as ON and stays removable), false = OFF or
// stale, undefined = no marks and no anchors. Each piece is compared on its
// own (never whole-file equality), so other toggles' EOF lines can sit in any
// order around ours without reading as drift.
function mathCurrentOn(c: string): boolean | undefined {
  if (!mathMarksPresent(c)) {
    return mathAssets && mathAnchorsPresent(c) ? false : undefined;
  }
  const stripped = mathStrip(c);
  const katex = mathKatexBlock();
  if (!katex || !mathAnchorsPresent(stripped)) return true;
  if (mathStripEof(c) !== mathApplyInline(stripped)) return false;
  MATH_HELPER_BLOCK_RE.lastIndex = 0;
  const h = MATH_HELPER_BLOCK_RE.exec(c)?.[0]?.replace(/^\n/, "");
  if (h !== mathHelperBlock()) return false;
  MATH_KATEX_BLOCK_RE.lastIndex = 0;
  const k = MATH_KATEX_BLOCK_RE.exec(c)?.[0]?.replace(/^\n/, "");
  return k === katex;
}
function mathSet(c: string, on: boolean): string {
  if (!on) return mathStrip(c);
  if (mathCurrentOn(c) === true) return c; // stable: no EOF reshuffle on re-apply
  const stripped = mathStrip(c);
  const katex = mathKatexBlock();
  if (!katex || !mathAnchorsPresent(stripped)) return c; // can't build here
  return `${mathApplyInline(stripped)}\n${katex}\n${mathHelperBlock()}`;
}

// The css side-effect: katex.min.css plus the em-size override, one marked
// line. Baking the em in means an em change reads as a stale line and
// re-applies through the ordinary reconcile.
function mathCssBuild(_css: string): string | undefined {
  if (!mathAssets) return undefined;
  return (
    `${MATH_CSS_MARKER}${mathAssets.css}` +
    `.ccup-math .katex{font-size:${readMathEm()}em}` +
    `.ccup-math .katex-display{overflow-x:auto;overflow-y:hidden;padding:3px 0}`
  );
}

// chatMathSize: the math size where Claude Code renders math itself (2.1.301
// and later). One marked line sizes every formula under the markdown root, the
// box KaTeX's own stylesheet sets at its stock 1.21em, so native (0) writes
// nothing. A build without native math gives the point nothing to write: the
// math css line carries the size for the bundled renderer there, and the point
// reads inert.
const MATH_SIZE_MARKER = "/*ccup:mathSize*/";
const MATH_SIZE_EM_RE =
  /\/\*ccup:mathSize\*\/\.root_[-\w]+ \.katex\{font-size:([\d.]+)em\}/;
// A native math rule hung off the markdown root, which names the root's hash.
const NATIVE_MATH_ROOT_RE = /\.root_([-\w]+) \.katex\{/;

// Whether the install's own stylesheet carries KaTeX, both math lines of this
// patch set aside.
function nativeMathCss(css: string): boolean {
  return /\.katex\{/.test(
    cssRemoveLine(cssRemoveLine(css, MATH_CSS_MARKER), MATH_SIZE_MARKER),
  );
}
// The markdown root's hash, read off a native math rule.
function mathSizeRoot(css: string): string | undefined {
  return cssRemoveLine(css, MATH_SIZE_MARKER).match(NATIVE_MATH_ROOT_RE)?.[1];
}

// The KaTeX fonts the install's own stylesheet loads, the math css line set
// aside. Claude Code 2.1.301 and later ship them in this same webview/fonts
// folder for their own math rendering, under the same 20 names and byte for
// byte the bundled 0.19.0 set.
const MATH_FONT_URL_RE = /url\(["']?fonts\/(KaTeX_[\w-]+\.woff2)["']?\)/g;
function nativeMathFonts(css: string | undefined): Set<string> {
  if (css === undefined) return new Set();
  const own = cssRemoveLine(css, MATH_CSS_MARKER);
  return new Set(Array.from(own.matchAll(MATH_FONT_URL_RE), (m) => m[1]));
}

// Copy the KaTeX woff2 fonts into <install>/webview/fonts when ON (skipping
// up-to-date files); remove exactly those files (and the dir if it emptied)
// when OFF. Same atomic stage-and-rename as the bundle writes. Fonts the
// build's own stylesheet loads belong to the build whatever the toggle says:
// never overwritten or removed, and put back from the bundled set when
// missing, since 1.6.0 removed them on 2.1.301 with the toggle off.
function syncMathFonts(ext: ClaudeExt, on: boolean, changed: string[]): void {
  const dir = path.join(ext.dir, "webview", "fonts");
  const native = nativeMathFonts(readFileSafe(ext, "webview/index.css"));
  if (native.size) {
    let restored = 0;
    for (const name of mathAssets?.fontNames ?? []) {
      const dst = path.join(dir, name);
      if (!native.has(name) || fs.existsSync(dst)) continue;
      fs.mkdirSync(dir, { recursive: true });
      copyFileAtomic(path.join(mathAssets!.fontsDir, name), dst);
      restored++;
    }
    if (restored) changed.push(`math fonts restored x${restored}`);
    return;
  }
  if (on && mathAssets) {
    fs.mkdirSync(dir, { recursive: true });
    let copied = 0;
    for (const name of mathAssets.fontNames) {
      const src = path.join(mathAssets.fontsDir, name);
      const dst = path.join(dir, name);
      try {
        if (fs.statSync(dst).size === fs.statSync(src).size) continue;
      } catch {
        // missing: copy below
      }
      copyFileAtomic(src, dst);
      copied++;
    }
    if (copied) changed.push(`math fonts x${copied}`);
    return;
  }
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^KaTeX_[\w-]+\.woff2$/.test(f)) continue; // never touch other files
      try {
        fs.unlinkSync(path.join(dir, f));
        removed++;
      } catch {
        // best effort: a locked file just lingers
      }
    }
    if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
  } catch {
    // dir absent: nothing to remove
  }
  if (removed) changed.push("math fonts removed");
}

// ---------------------------------------------------------------------------
// Inline math spans (always on). Claude Code 2.1.301 picks the $...$ spans of a
// response it typesets with a guard written against currency, shell and
// template text, and several of its rules also refuse plain math: $0$ and
// $1/2$, the uppercase subscript of $J_O$, $(d,e)$ and $(0, 1]$, a span in
// quotes ("$\prec$", $G$'s) or beside a slash ($50$/$49$), names such as $TC$
// and $A[r]$, A$\to$B and H$_2$O, and any formula past 60 characters all keep
// their dollar signs. The span finder rejects a space inside either delimiter
// and a digit right after the closer, runs a currency check on a digit-led
// body (nothing alphanumeric before the opener, no Latin or Greek letter,
// digit, `$` or backslash after the closer, no "5 apples" shape, no trailing
// operator, and a body its arithmetic grammar reads or one holding TeX
// syntax), and then the TeX test, which caps the body at 60 characters, wants
// the opener after a line start, whitespace, `(`, `[` or a non-ASCII
// character, and the closer before a line end, whitespace, a non-ASCII
// character, one of `.,;:!?)]*_~|-`, a backtick, `[` or `<`, refuses a
// `{`-led body, and a `(`-led one unless its arithmetic grammar reads it or it
// holds a letter command or `^`, and takes only a body that grammar reads
// (never a digit-led one) or one holding one of \ ^ { } = < > | ! + or a
// one-letter subscript (an uppercase base taking only a lowercase or digit
// index), with no word of four letters or more.
//
// Seven fragments, each /*ccup:mathSpans:<site>*/.../*ccup:mathSpansEnd*/,
// six in the TeX test and one in the precheck, each widening one rule:
//   long      a body up to 200 characters that holds a command of two or more
//             letters
//   before    the opener may follow `"`, `'` or `-`, a `/` unless a `/` also
//             follows the closer (a path segment), or a letter or digit when
//             the body holds strong TeX evidence: a command of two or more
//             letters, or a leading `^` or `_` (A$\to$B, H$_2$O, 10$^6$)
//   after     the closer may precede `"` or `'`, a `/` unless one also
//             precedes the opener, or a letter given strong TeX evidence
//   shape     the arithmetic verdict also takes a digit-led body with none of
//             \ { } ^ _ = < > (given the currency check it already passed, a
//             body its arithmetic grammar read), a comma list of groups (an
//             optional one-letter name, a parenthesized or bracketed list of
//             numbers and subscripted letters, an optional subscript), an
//             indexed letter such as A[rr], or a two-letter name
//   paren     a `(`-led body may also hold an escaped brace, \{ or \}
//   evidence  an uppercase letter with an uppercase index (J_O), or a body
//             that is a subscript alone (_2, _{min}), counts as TeX syntax
//   pre       the precheck that decides whether a message enters the math
//             pipeline at all (the `{display,inline}` read off its text) also
//             passes any message holding a span with no space inside either
//             delimiter, since the native one (a letter, or two or more
//             characters around an operator) cannot see $0$, $[n]$, $TC$ or
//             H$_2$O, which would then render only beside another formula
// Everything else stays native: the delimiter rules, so "$5 and $10",
// "$5-$10" and "$1.50/$2.00" stay text, the currency check, so US$5 does too,
// letter runs of four or more (templates such as $END$ have three, kept out by
// stopping at two), bodies ending in an operator such as $PATH:$, `"` or `@`
// inside a body, and `{`-led bodies such as ${HOME}.
//
// The sites are found by structure (src/derive.ts). The span finder holds the
// closer search `<s>.indexOf("$",...)` and an `if(...)return null` whose `||`
// chain runs `<digit>(<first>)&&!<currency>(<s>,<J>,<X>)` ahead of
// `!<tex>(<s>,<J>,<J>+1,<X>)`, with <first> its `<s>[<J>+1]`, <digit> a "0"
// to "9" test, and the currency check ending in that grammar-or-syntax `||`.
// <tex> has no other caller, and its own statements are found by role: the
// `<X>-<Z>><n>` cap, the before-character declarator `<Y>=<f>(<s>,<J>)` and
// the rejection opening `<Y>!==void 0&&`, the rejection `!<g>(<s>,<X>+1)`,
// the body `<Q>=<s>.slice(<Z>,<X>)`, the verdict `<q>=<arith>(<Q>)` its final
// `return <q>||...` opens with (<arith> must refuse a digit-led body,
// `return!/^\d/.test(...)&&...`), the rejection `<Q>[0]==="{"||<Q>[0]==="("&&`
// and the `||` of `.test(<Q>)` calls that return's `&&` chain opens with. The
// precheck is the function returning `{display,inline}` whose `inline` reads
// its text's `.includes("\\(")`. A build without native math has no guard to
// relax, so the point reads inert there. 1.6.1 development builds wrote two of
// these as /*ccup:mathDigits:<site>*/.../*ccup:mathDigitsEnd*/, which the
// fragment pattern also matches, so an apply replaces them.
// ---------------------------------------------------------------------------
const MSPAN_END = "/*ccup:mathSpansEnd*/";
const MSPAN_LONG = "/*ccup:mathSpans:long*/";
const MSPAN_BEFORE = "/*ccup:mathSpans:before*/";
const MSPAN_AFTER = "/*ccup:mathSpans:after*/";
const MSPAN_SHAPE = "/*ccup:mathSpans:shape*/";
const MSPAN_PAREN = "/*ccup:mathSpans:paren*/";
const MSPAN_EVIDENCE = "/*ccup:mathSpans:evidence*/";
const MSPAN_PRE = "/*ccup:mathSpans:pre*/";
const MSPAN_FRAG_RE =
  /\/\*ccup:math(?:Spans|Digits):[-\w]+\*\/[\s\S]*?\/\*ccup:math(?:Spans|Digits)End\*\//g;
const MSPAN_FILE = "webview/index.js";
// How far ahead of its token a function may start (the span finder and the
// precheck each run under 1KB).
const MSPAN_REACH = 4000;
// The shapes the verdict gains: a subscript index, a term (a number, or a
// letter with an index and primes), a group, and the whole-body alternatives.
const MSPAN_SUB = String.raw`(?:[A-Za-z0-9]|\{[A-Za-z0-9]{1,4}\})`;
const MSPAN_TERM = String.raw`-?(?:\d+(?:\.\d+)?|[A-Za-z](?:_${MSPAN_SUB})?'*)`;
const MSPAN_GROUP = String.raw`(?:[A-Za-z](?:_${MSPAN_SUB})?)?[(\[]${MSPAN_TERM}(?: ?, ?${MSPAN_TERM})*[)\]](?:_${MSPAN_SUB})?`;
const MSPAN_SHAPES = String.raw`^(?:${MSPAN_GROUP}(?:, ?${MSPAN_GROUP})*|[A-Za-z](?:_[A-Za-z0-9])?\[[A-Za-z0-9]{1,3}\]|[A-Z]{2}|[a-z]{2})$`;

// The function declared as `name`, once in the bundle, or null.
function mspanDeclared(c: string, name: string): N | null {
  const decl = `function ${name}(`;
  const at = c.indexOf(decl);
  if (at < 0 || c.indexOf(decl, at + 1) >= 0) return null;
  return parseUnitAt(c, at, isFn);
}

// How often `name` occurs in the bundle as a whole identifier.
function mspanRefs(c: string, name: string): number {
  let n = 0;
  for (let i = c.indexOf(name); i >= 0; i = c.indexOf(name, i + 1)) {
    const before = c[i - 1] ?? "";
    const after = c[i + name.length] ?? "";
    if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) n++;
  }
  return n;
}

// The one declarator of `name` among a function's own statements, or null.
function mspanDecl(fn: N, name: string): N | null {
  const found: N[] = [];
  walkOwn(fn, (n) => {
    if (n.type === "VariableDeclarator" && idName(n.id) === name) found.push(n);
  });
  return found.length === 1 ? found[0] : null;
}

// `!<f>(...)`: the name called and its arguments, or null.
function mspanNotCall(n: N): { f: string; args: N[] } | null {
  if (n.type !== "UnaryExpression" || n.operator !== "!") return null;
  const call = n.argument;
  const f = call.type === "CallExpression" ? idName(call.callee) : null;
  return f ? { f, args: call.arguments } : null;
}

// `<J>+1`, with J an identifier.
const mspanPlusOne = (n: N | undefined, j: string): boolean =>
  n?.type === "BinaryExpression" &&
  n.operator === "+" &&
  idName(n.left) === j &&
  n.right.type === "Literal" &&
  n.right.value === 1;

// `<re>.test(<arg>)` with `<re>` a regex literal: its pattern and flags, and
// the argument's name.
function mspanRegexTest(
  n: N | undefined,
): { pattern: string; flags: string; arg: string | null } | null {
  if (n?.type !== "CallExpression" || n.arguments.length !== 1) return null;
  if (memberProp(n.callee) !== "test") return null;
  const re = n.callee.object;
  if (re.type !== "Literal" || !re.regex) return null;
  return { ...re.regex, arg: idName(n.arguments[0]) };
}

// `return false` in either spelling, `return!1` once minified.
const mspanRejects = (n: N | undefined): boolean =>
  n?.type === "ReturnStatement" &&
  ((n.argument?.type === "UnaryExpression" &&
    n.argument.operator === "!" &&
    n.argument.argument.value === 1) ||
    (n.argument?.type === "Literal" && n.argument.value === false));

// `<Q>[0]===<ch>`.
const mspanFirstIs = (n: N | undefined, q: string, ch: string): boolean =>
  n?.type === "BinaryExpression" &&
  n.operator === "===" &&
  n.left.type === "MemberExpression" &&
  n.left.computed &&
  idName(n.left.object) === q &&
  n.left.property.value === 0 &&
  isStr(n.right, ch);

// The span finder's reject chain: the TeX test, the currency check and the
// digit test it calls, or null.
function mspanFinder(
  fn: N,
): { tex: string; currency: string; digit: string } | null {
  const s = idName(fn.params[0]);
  const j = idName(fn.params[1]);
  if (!s || !j) return null;
  const hits: { tex: string; currency: string; digit: string }[] = [];
  walkOwn(fn, (n) => {
    if (
      n.type !== "IfStatement" ||
      n.consequent.type !== "ReturnStatement" ||
      n.consequent.argument?.raw !== "null"
    )
      return;
    const alts = chainOf(n.test, "||");
    for (let t = 0; t < alts.length; t++) {
      const tex = mspanNotCall(alts[t]);
      if (
        !tex ||
        tex.args.length !== 4 ||
        idName(tex.args[0]) !== s ||
        idName(tex.args[1]) !== j ||
        !mspanPlusOne(tex.args[2], j)
      )
        continue;
      const x = idName(tex.args[3]);
      if (!x) continue;
      for (const o of alts.slice(0, t)) {
        if (o.type !== "LogicalExpression" || o.operator !== "&&") continue;
        const cur = mspanNotCall(o.right);
        const call = o.left.type === "CallExpression" ? o.left : null;
        const digit = call ? idName(call.callee) : null;
        const arg: N | null =
          call?.arguments.length === 1 ? call.arguments[0] : null;
        const first = idName(arg);
        if (
          !cur ||
          !digit ||
          !arg ||
          !first ||
          cur.args.length !== 3 ||
          idName(cur.args[0]) !== s ||
          idName(cur.args[1]) !== j ||
          idName(cur.args[2]) !== x
        )
          continue;
        // The digit test reads the body's first character: `<s>[<J>+1]`.
        const fd = mspanDecl(fn, first);
        const at = fd?.init;
        if (
          !fd ||
          bindingSite(arg, first, fn) !== bindingSite(fd, first, fn) ||
          at?.type !== "MemberExpression" ||
          !at.computed ||
          idName(at.object) !== s ||
          !mspanPlusOne(at.property, j)
        )
          continue;
        hits.push({ tex: tex.f, currency: cur.f, digit });
      }
    }
  });
  return hits.length === 1 ? hits[0] : null;
}

// Whether the function tests its one argument for "0" through "9".
function mspanIsDigitTest(fn: N): boolean {
  const p = idName(fn.params[0]);
  if (!p || fn.params.length !== 1) return false;
  let lo = false;
  let hi = false;
  walkOwn(fn, (n) => {
    if (n.type !== "BinaryExpression" || idName(n.left) !== p) return;
    if (n.operator === ">=" && n.right.value === "0") lo = true;
    if (n.operator === "<=" && n.right.value === "9") hi = true;
  });
  return lo && hi;
}

// Whether the currency check ends in `<a>.test(<body>)||<b>.test(<body>)`,
// its body being its text's `.slice(...)`.
function mspanIsCurrency(fn: N): boolean {
  const s = idName(fn.params[0]);
  const last = fn.body.body?.[fn.body.body.length - 1];
  if (!s || last?.type !== "ReturnStatement" || !last.argument) return false;
  const ands = chainOf(last.argument, "&&");
  const ors = chainOf(ands[ands.length - 1], "||");
  if (ands.length < 2 || ors.length !== 2) return false;
  const tested = ors.map((o) =>
    o.type === "CallExpression" &&
    memberProp(o.callee) === "test" &&
    o.arguments.length === 1
      ? idName(o.arguments[0])
      : null,
  );
  if (!tested[0] || tested[0] !== tested[1]) return false;
  const bd = mspanDecl(fn, tested[0]);
  return (
    !!bd &&
    bd.init?.type === "CallExpression" &&
    memberProp(bd.init.callee) === "slice" &&
    idName(bd.init.callee.object) === s
  );
}

// The six insertions in the TeX test, or null when any statement is missing
// or found more than once.
function mspanTex(c: string, tex: N): Edit[] | null {
  if (tex.params.length !== 4) return null;
  const [s, j, z, x] = tex.params.map(idName);
  const body: N[] = tex.body.body ?? [];
  if (!s || !j || !z || !x || !body.length) return null;
  const one = (pred: (st: N) => boolean): N | null => {
    const found = body.filter(pred);
    return found.length === 1 ? found[0] : null;
  };
  const rejects = (st: N) =>
    st.type === "IfStatement" && !st.alternate && mspanRejects(st.consequent);
  // A top-level declaration's one declarator, by its init.
  const declOf = (pred: (init: N) => boolean): N | null => {
    const st = one(
      (st) =>
        st.type === "VariableDeclaration" &&
        st.declarations.length === 1 &&
        !!st.declarations[0].init &&
        pred(st.declarations[0].init),
    );
    return st ? st.declarations[0] : null;
  };

  // The body cap: `<X>-<Z>><n>`.
  const cap = one(
    (st) =>
      rejects(st) &&
      st.test.type === "BinaryExpression" &&
      st.test.operator === ">" &&
      st.test.left.type === "BinaryExpression" &&
      st.test.left.operator === "-" &&
      idName(st.test.left.left) === x &&
      idName(st.test.left.right) === z &&
      typeof st.test.right.value === "number",
  );
  // The character before the opener: `<Y>=<f>(<s>,<J>)`, then the rejection
  // opening `<Y>!==void 0&&`.
  const yd = declOf(
    (init) =>
      init.type === "CallExpression" &&
      init.arguments.length === 2 &&
      idName(init.arguments[0]) === s &&
      idName(init.arguments[1]) === j,
  );
  const y = yd ? idName(yd.id) : null;
  const before = one((st) => {
    if (!rejects(st) || !y) return false;
    const ands = chainOf(st.test, "&&");
    const head = ands[0];
    return (
      ands.length > 1 &&
      head.type === "BinaryExpression" &&
      head.operator === "!==" &&
      idName(head.left) === y &&
      head.right.type === "UnaryExpression" &&
      head.right.operator === "void"
    );
  });
  // The character after the closer: the rejection `!<g>(<s>,<X>+1)`.
  const after = one((st) => {
    if (!rejects(st)) return false;
    const call = mspanNotCall(st.test);
    return (
      !!call &&
      call.args.length === 2 &&
      idName(call.args[0]) === s &&
      mspanPlusOne(call.args[1], x)
    );
  });
  // The body: `<Q>=<s>.slice(<Z>,<X>)`.
  const qd = declOf(
    (init) =>
      init.type === "CallExpression" &&
      memberProp(init.callee) === "slice" &&
      idName(init.callee.object) === s &&
      init.arguments.length === 2 &&
      idName(init.arguments[0]) === z &&
      idName(init.arguments[1]) === x,
  );
  const q = qd ? idName(qd.id) : null;
  if (!cap || !yd || !y || !before || !after || !qd || !q) return null;
  // The insertions read <Y> after its declarator and <Q> after its own.
  if (!(yd.start < before.start && yd.start < after.start)) return null;

  // The verdict its final `return <v>||...` opens with: `<v>=<arith>(<Q>)`.
  const last = body[body.length - 1];
  if (last?.type !== "ReturnStatement" || !last.argument) return null;
  const alts = chainOf(last.argument, "||");
  const v = idName(alts[0]);
  const vd = v ? mspanDecl(tex, v) : null;
  const call = vd?.init;
  const arith = call?.type === "CallExpression" ? idName(call.callee) : null;
  if (
    !vd ||
    !arith ||
    call.arguments.length !== 1 ||
    idName(call.arguments[0]) !== q ||
    bindingSite(call.arguments[0], q, tex) !== bindingSite(qd, q, tex) ||
    !(qd.start < vd.start)
  )
    return null;
  // The verdict refuses a digit-led body: `return!/^\d/.test(<p>)&&...`.
  const vf = mspanDeclared(c, arith);
  const p = vf ? idName(vf.params[0]) : null;
  const ret = vf?.body.body?.[0];
  if (!p || ret?.type !== "ReturnStatement" || !ret.argument) return null;
  const head = chainOf(ret.argument, "&&");
  const not = head.length > 1 ? head[0] : null;
  const digitLed =
    not?.type === "UnaryExpression" && not.operator === "!"
      ? mspanRegexTest(not.argument)
      : null;
  if (
    digitLed?.pattern !== "^\\d" ||
    digitLed.flags !== "" ||
    digitLed.arg !== p
  )
    return null;
  // The `(`-led rejection: `<Q>[0]==="{"||<Q>[0]==="("&&...!<v>...`.
  const paren = one((st) => {
    if (
      !rejects(st) ||
      st.test.type !== "LogicalExpression" ||
      st.test.operator !== "||" ||
      !mspanFirstIs(st.test.left, q, "{")
    )
      return false;
    const ands = chainOf(st.test.right, "&&");
    return (
      mspanFirstIs(ands[0], q, "(") &&
      ands.some(
        (o) =>
          o.type === "UnaryExpression" &&
          o.operator === "!" &&
          idName(o.argument) === v,
      )
    );
  });
  // The evidence `||` the return's `&&` chain opens with, every operand a
  // `.test(<Q>)` call.
  const ands = alts.length === 2 ? chainOf(alts[1], "&&") : [];
  const evidence = ands.length > 1 ? ands[0] : null;
  const tests =
    evidence?.type === "LogicalExpression" && evidence.operator === "||"
      ? chainOf(evidence, "||")
      : [];
  if (
    !paren ||
    !evidence ||
    !tests.length ||
    !tests.every(
      (o) =>
        o.type === "CallExpression" &&
        memberProp(o.callee) === "test" &&
        o.arguments.length === 1 &&
        idName(o.arguments[0]) === q,
    )
  )
    return null;

  const span = `${s}.slice(${z},${x})`;
  const next = `${s}[${x}+1]`;
  const strong = String.raw`(/\\[A-Za-z]{2}/.test(${span})||/^[_^]/.test(${span}))`;
  const at = (pos: number, marker: string, text: string): Edit => ({
    pos,
    text: marker + text + MSPAN_END,
  });
  return [
    at(
      cap.test.end,
      MSPAN_LONG,
      String.raw`&&!(${x}-${z}<=200&&/\\[A-Za-z]{2}/.test(${span}))`,
    ),
    at(
      before.test.end,
      MSPAN_BEFORE,
      String.raw`&&!(/["'-]/.test(${y})||${y}==="/"&&${next}!=="/"||/[A-Za-z0-9]/.test(${y})&&${strong})`,
    ),
    at(
      after.test.end,
      MSPAN_AFTER,
      String.raw`&&!(/["']/.test(${next}??"")||${next}==="/"&&${y}!=="/"||/[A-Za-z]/.test(${next}??"")&&${strong})`,
    ),
    at(
      call.end,
      MSPAN_SHAPE,
      String.raw`||/^\d/.test(${q})&&!/[\\{}^_=<>]/.test(${q})||/${MSPAN_SHAPES}/.test(${q})`,
    ),
    at(paren.test.end, MSPAN_PAREN, String.raw`&&!/\\[{}]/.test(${q})`),
    at(
      evidence.end,
      MSPAN_EVIDENCE,
      String.raw`||/(?<![A-Za-z0-9_])[A-Z]_[A-Z](?![A-Za-z0-9_])|^_(?:[A-Za-z0-9]|\{[^{}]{1,8}\})$/.test(${q})`,
    ),
  ];
}

// The precheck and its insertion, or null: the function returning
// `{display,inline}` whose `inline` reads `<text>.includes("\\(")`.
function mspanPre(c: string): { unit: N; edit: Edit } | null {
  const hits: { unit: N; edit: Edit }[] = [];
  for (const fn of unitsWith(
    c,
    '.includes("\\\\(")',
    "function",
    isFn,
    MSPAN_REACH,
  )) {
    const p = idName(fn.params[0]);
    const ret: N | undefined = fn.body.body?.find(
      (st: N) => st.type === "ReturnStatement",
    );
    const obj = ret?.argument;
    if (!p || fn.params.length !== 1 || !hasKeys(obj, ["display", "inline"]))
      continue;
    const inline = propOf(obj, "inline")!.value;
    if (inline.type !== "LogicalExpression" || inline.operator !== "||")
      continue;
    const reads: N[] = [];
    walk(inline, (n) => {
      if (
        n.type === "CallExpression" &&
        memberProp(n.callee) === "includes" &&
        idName(n.callee.object) === p &&
        isStr(n.arguments[0], "\\(")
      )
        reads.push(n.callee.object);
    });
    if (!reads.some((r) => bindingSite(r, p, fn) === fn)) continue;
    hits.push({
      unit: fn,
      edit: {
        pos: inline.end,
        text:
          MSPAN_PRE +
          String.raw`||/\$[^\s$](?:[^$\r\n]{0,198}[^\s$])?\$/.test(${p})` +
          MSPAN_END,
      },
    });
  }
  return hits.length === 1 ? hits[0] : null;
}

// Every site, or null when any is missing or ambiguous.
function mathSpansFind(c: string): { units: N[]; edits: Edit[] } | null {
  const finders = unitsWith(c, '.indexOf("$",', "function", isFn, MSPAN_REACH)
    .map((fn) => ({ fn, chain: mspanFinder(fn) }))
    .filter((f) => f.chain);
  if (finders.length !== 1) return null;
  const { tex, currency, digit } = finders[0].chain!;
  const texFn = mspanDeclared(c, tex);
  const curFn = mspanDeclared(c, currency);
  const digitFn = mspanDeclared(c, digit);
  if (
    !texFn ||
    !curFn ||
    !digitFn ||
    mspanRefs(c, tex) !== 2 ||
    !mspanIsCurrency(curFn) ||
    !mspanIsDigitTest(digitFn)
  )
    return null;
  const texEdits = mspanTex(c, texFn);
  const pre = mspanPre(c);
  if (!texEdits || !pre) return null;
  return { units: [texFn, pre.unit], edits: [...texEdits, pre.edit] };
}

// The native webview bundle with every fragment in, or null when a site is
// missing or an edit would not parse.
const mathSpansBuild = sdelMemo((native) => {
  const sites = mathSpansFind(native);
  if (!sites) return null;
  const out = applyEdits(native, sites.edits);
  return unitsReparse(
    out,
    sites.edits,
    sites.units.map((u): [N, (n: N) => boolean] => [u, isFn]),
  )
    ? out
    : null;
});
function mathSpansPatch(native: string): string | null {
  return mathSpansBuild(native);
}

// The webview bundle, patched or not, as an apply writes this point into it,
// or null when its sites are gone. scripts/repro's math-spans.mjs serves
// this, so it runs exactly what the patcher writes and doubles as the drift
// canary.
export function mathSpansWebview(web: string): string | null {
  return mathSpansBuild(web.replace(MSPAN_FRAG_RE, ""));
}

// Scroll-to-bottom button (ON): the chat auto-sticks to the newest message only
// while the view is within 50px of the bottom; once the user scrolls up to read,
// nothing signals that the conversation has run ahead, and the only way back is
// manual scrolling. When ON we append a marked, self-contained IIFE at the end
// of webview/index.js that mounts a small button just OUTSIDE the input box's
// contour, above its top-right corner (anchored to the composer wrapper
// .inputWrapper_<hash> at top:-34px/right:5px, so it clears the box border,
// shares the send button's 5px right inset (the footer padding) and therefore
// its vertical column, and never shares a row with the send button, the source
// of the earlier dot's shifting; the wrapper rather than the box itself so a
// notice banner cannot end up underneath it, see btnHostSel below). It
// mirrors the send button's footprint (a
// 26px rounded square, box-sizing so the 1px border does not inflate it) and
// its 20px icon size, but stays neutral, using the input's own surface,
// border, and text color so it reads as a secondary control; hover stacks the
// native ghost-button hover token twice over that surface and lifts the border
// (theme-adaptive, unlike a brightness filter, which clips to nothing on light
// surfaces), and it carries a downward arrow plus the shared custom hover tip
// ("Scroll to Bottom"). Clicking runs a fixed-duration scroll to the container's end: a
// 100ms ease-out rAF animation, so the jump takes the same time however long
// the history is (native behavior:"smooth" animates by distance and can crawl
// on a long conversation). The bottom target is re-read every frame so a
// streaming reply cannot outrun it, a final snap lands exactly on
// scrollHeight, a per-click generation token cancels a superseded animation,
// and prefers-reduced-motion collapses the glide to an instant jump. The app's
// stick-to-bottom flag re-arms by itself, being recomputed from the live
// scroll position on every render. The button is always visible; while the view
// sits within 8px of the bottom (nothing to scroll to) it dims inert (data-off:
// faded, clicks ignored, hover tip still shows) instead of hiding, re-checked through one
// rAF-coalesced updater fed by capture-phase scroll
// events, window resizes, and a body-wide MutationObserver (which also re-mounts
// the button if a re-render drops it). data-show/data-off are toggled only on an
// actual change and sit outside the observer's attribute filter, so the updater
// never re-triggers itself. The updater mounts one button per host from the
// shared hosts() collector, so while a permission/question popup replaces the
// input box the button sits on that popup's wrapper instead (same offsets; see
// btnHostsJs above). The button swallows mousedown (preventDefault +
// stopPropagation) and stops click propagation, as the jump buttons always
// have: on the popup this keeps focus (and the popup's number/Esc keyboard
// handling) where it is instead of letting the click blur the popup, and on the
// input box it stops the composer's click handler from stealing focus and
// re-scrolling under the glide. The two required DOM surfaces are addressed via
// CSS-module hashes read from the bundle's class maps at patch time (the input
// module via its messageInput entry, whose module also owns
// .inputContainer_<hash> and .inputWrapper_<hash>; the chat module via
// messagesContainer); if either map is gone the point reports missing and the
// bundle stays native. While ON, the permission-popup auto-scroll guard (see PERM_YANK_MARKER above) also rewrites
// the chat's "popup pending → scroll to bottom" effect to respect the
// stick-to-bottom zone. The whole body is wrapped in try/catch so a
// failure can never break the chat, and the /*ccup:scrollDot*/ marker makes the
// ON state detectable; a marked line that no longer matches the current build
// (an older patch version) reads as OFF, so the next apply rebuilds it in place
// or strips it.
// Custom hover tip shared by the scroll-to-bottom and jump buttons (the find
// bar carries its own below-the-button variant): the native title tooltip is
// unreliable inside the webview (long OS delay, often absent), so a small
// fixed-delay tip shows ABOVE the button (they sit at the viewport's bottom
// edge). One copy is embedded per toggle line so each stays self-contained;
// the duplicate CSS rule is byte-identical and harmless. A cursor hidden by
// typing never arms it, since no mouseenter gets past window while the cursor
// is hidden (see hiddenCursorWatchBuild).
const HOVER_TIP_CSS =
  ".ccup-hover-tip{position:fixed;display:none;padding:2px 8px;border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-widget-border,#454545));border-radius:4px;background:var(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background,#252526));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-editorWidget-foreground,#cccccc));font-size:11px;white-space:nowrap;z-index:1300;pointer-events:none;box-shadow:0 2px 8px var(--vscode-widget-shadow,rgba(0,0,0,.36))}";
const HOVER_TIP_JS =
  `var tip=null,tipT=0;` +
  `function showTip(b,t){if(!tip){tip=document.createElement("div");tip.className="ccup-hover-tip";document.body.appendChild(tip)}` +
  `tip.textContent=t;tip.style.display="block";` +
  `var r=b.getBoundingClientRect(),w=tip.offsetWidth,h=tip.offsetHeight,vw=document.documentElement.clientWidth||0;` +
  `tip.style.left=Math.max(4,Math.min(r.left+r.width/2-w/2,vw-w-4))+"px";tip.style.top=(r.top-h-6)+"px"}` +
  `function hideTip(){if(tipT){clearTimeout(tipT);tipT=0}if(tip)tip.style.display="none"}` +
  `function att(b,t){b.addEventListener("mouseenter",function(){if(tipT)clearTimeout(tipT);` +
  `tipT=setTimeout(function(){tipT=0;try{showTip(b,t)}catch(e){}},250)});` +
  `b.addEventListener("mouseleave",hideTip)}`;

// Shared button-host collector for the scroll-to-bottom and jump buttons. The
// buttons normally anchor to the composer wrapper (btnHostSel above), but while
// a permission request or AskUserQuestion popup is up the app hides the whole
// composer (display:none on the wrapper's own parent) and shows the request UI
// inside a sibling wrapper (.permissionsContainer_<hash>, a plain centered block
// shared with the auth/refusal dialogs), so the buttons vanish exactly when
// reading history is most likely. hosts() therefore returns the composer
// wrappers plus, for each mounted request card
// (.permissionRequestContainer_<hash>, the popup module's root,
// which identifies the tool-permission/question wrapper among the dialogs
// sharing the wrapper class), its closest() wrapper. The card itself cannot
// host (overflow:hidden clips anything above its border), so the wrapper gets a
// ccup-btn-host marker class making it position:relative, and the buttons'
// top:-34px/right offsets land in exactly the same spots as on the composer
// wrapper, both being unbordered, unpadded, centered blocks. The class add is
// guarded by a contains() check so the body observers (class/style in
// their filter) see at most one mutation per mount and settle; React never
// rewrites the wrapper's static className, so the marker survives re-renders
// and dies with the popup. Both permission hashes are read from the bundle's
// class maps at patch time; if either is gone hosts() degrades to the composer
// wrappers alone (the popups just lose the buttons) instead of failing the
// toggle.
// The same pass syncs the ccup-dim marker onto the messages container, since the
// card query that drives it is already in hand here (see dimCss for what the
// marker replaced and why). Unlike ccup-btn-host it has to come off again, the
// container outliving the popup, so it is toggled both ways, each direction
// guarded by a contains() check so the observers see one mutation per
// transition. It reads the container through sc(), which every caller declares.
// The prompt history line passes dim=false: it borrows the hosts and leaves
// the popup dim to the two buttons that own it.
const PERM_WRAP_HASH_RE =
  /permissionsContainer:"permissionsContainer_([-\w]+)"/;
const PERM_REQ_HASH_RE =
  /permissionRequestContainer:"permissionRequestContainer_([-\w]+)"/;
const BTN_WRAP_HASH_RE = /inputWrapper:"inputWrapper_([-\w]+)"/;

// Composer-side host selector. The buttons sit at top:-34px, so the host has to
// be the element whose top edge is the top of the whole composer STACK, not the
// input box alone: the app drops notice banners (Remote Control, rate limit,
// browser/debugger/Jupyter MCP, a settings-parse error, the review upsell) into
// .inputWrapper_<hash>, the box's parent, each one tucked onto the box's top
// edge by a margin-bottom:-8px. Anchored to the box, the buttons land squarely
// inside a banner's box and cover its text and close button; anchored to the
// wrapper they ride 8px above whatever is topmost, banner or box. The wrapper is
// natively unpositioned, so the rule below makes it the containing block. It is
// also unbordered and unpadded, unlike the box (a 1px border, and the box's
// containing block is its PADDING box), so the move settles the buttons 1px
// further out in both axes, exactly matching where they already sit on the
// permission popup's wrapper. The wrapper class comes from the same class map as
// messageInput; if a future bundle drops the entry the host falls back to the
// box and the banner overlap comes back, which is the old behavior rather than a
// broken toggle.
function btnHostSel(input: string, wrap: string | undefined): string {
  return wrap ? `.inputWrapper_${wrap}` : `.inputContainer_${input}`;
}
function btnHostCss(
  wrap: string | undefined,
  perm: string | undefined,
  preq: string | undefined,
): string {
  return (
    (wrap ? `.inputWrapper_${wrap}{position:relative}` : "") +
    (perm && preq ? ".ccup-btn-host{position:relative}" : "")
  );
}
// Shared hide rule for the scroll-to-bottom and jump buttons: whatever native
// element opens INSIDE the strip the buttons occupy (26px at top:-34px, so the
// 8px band above the box) takes that strip back for as long as it is mounted.
// Two kinds do, both children of the composer fieldset rather than of the
// wrapper the buttons host on, and neither carrying a z-index of its own:
//   menuPopup_  the composer's own dropdowns (mention, mode, model, slash,
//               add), bottom:100%, z-index <= 10.
//   banner_     the fieldset's two overlay banners, the session feedback survey
//               ("How is Claude doing this session?", Bad/Fine/Good) and the
//               marketplace review upsell, both position:absolute;bottom:100%
//               with margin-bottom:8px, which is exactly the gap the buttons
//               leave above the box: each banner's box IS the buttons' strip,
//               so the buttons land on its rightmost choice button and its
//               dismiss control.
// Wrapper, popups, banners, and buttons all flatten into the composer's z:20
// stacking context, where the buttons' z:21 paints THROUGH whatever opened, so
// hiding is the remedy rather than a z-index below every overlay (one popup is
// z:auto, which would mean negative), and hiding is also what lets the pointer
// reach the thing underneath. Both tests are stable class-name substrings with
// no per-build hash, and the whole rule is scoped to this composer so an
// overlay in one chat view never blanks another view's buttons.
// The banner test is scoped to the fieldset because the wrapper's OTHER banners
// are the in-flow notice ones (Remote Control, rate limit, browser/debugger/
// Jupyter MCP, settings-parse error, refusal fallback), siblings of the form
// that the wrapper host already lifts the buttons clear of (see btnHostSel):
// hiding for those would drop the buttons for as long as a notice stays up,
// which for Remote Control is the whole session. When the wrap anchor is gone
// and the host IS the fieldset, that scope is already implied, so the test
// drops the prefix rather than nesting a selector that could never match.
function btnHideCss(
  input: string,
  wrap: string | undefined,
  cls: string,
): string {
  const banner = wrap
    ? `.inputContainer_${input} [class*=banner_]`
    : "[class*=banner_]";
  return (
    `${btnHostSel(input, wrap)}:has([class*=menuPopup_],${banner}) ` +
    `${cls}[data-show]{opacity:0;pointer-events:none}`
  );
}
function btnHostsJs(
  host: string,
  perm: string | undefined,
  preq: string | undefined,
  dim = true,
): string {
  const base = `var a=[].slice.call(document.querySelectorAll("${host}"))`;
  if (!perm || !preq) return `function hosts(){${base};return a}`;
  return (
    `function hosts(){${base},p=document.querySelectorAll(".permissionRequestContainer_${preq}");` +
    `for(var i=0;i<p.length;i++){var w=p[i].closest(".permissionsContainer_${perm}");` +
    `if(w){if(!w.classList.contains("ccup-btn-host"))w.classList.add("ccup-btn-host");` +
    `if(a.indexOf(w)<0)a.push(w)}}` +
    (dim
      ? `var m=sc();if(m){var dm=m.classList.contains("${DIM_CLASS}");` +
        `if(p.length&&!dm)m.classList.add("${DIM_CLASS}");` +
        `else if(!p.length&&dm)m.classList.remove("${DIM_CLASS}")}`
      : "") +
    `return a}`
  );
}

// Popup dim control shared by the scroll-to-bottom and jump buttons. While a
// non-question permission request is pending, the chat view natively dims the
// whole transcript to 0.4 (.dimmed_<chat> > :not(.highlightedMessage_<chat>){
// opacity:.4}) to draw the eye to the dialog, leaving the pending turn bright.
// Whenever either button is ON we keep that dim and add two things, keyed on the
// find bar, which marks the one state where the dim is actively in the way
// (reading and navigating history under a pending box is exactly what the bar is
// for):
//   cover  dim for AskUserQuestion too. Native applies .dimmed only when
//          toolName !== "AskUserQuestion", so a question box leaves the
//          transcript at full brightness; this reinstates the same 0.4 /
//          bright-pending-turn treatment for it. A pending popup is marked by
//          the ccup-dim class, which hosts() syncs onto the messages container
//          in the rAF pass both buttons already run (see btnHostsJs).
//   lift   while the bar is open, restore full opacity, over both the native dim
//          and the rule above. Each lift is the dim selector it answers under a
//          body.ccup-find-open prefix, which the bar's open/close paths set and
//          clear, and it carries !important so it beats the native dim whatever
//          the specificity works out to; with no popup up neither matches, so
//          both are inert in normal chat.
//
// Both markers must stay classes rather than the :has() tests they replaced.
// When the :has() subject is an ancestor of everything the rule paints, Blink
// re-runs the whole subject subtree's style on any node added or removed inside
// the scope the test watches, and for the popup marker that scope was the
// composer, so every menu row, mention chip and box clear re-styled the entire
// transcript. A class invalidates only when it changes.
//
// dimmed, highlightedMessage, and inputContainer co-locate with
// messagesContainer in the one chat CSS module, so they share its hash; the
// popup card carries its own. If a future build splits either the rules stop
// matching and the native dim returns unchanged; a missing card hash drops the
// question half alone (questions go back to native, permissions still dim).
const FIND_BAR_OPEN = "body.ccup-find-open";
const DIM_CLASS = "ccup-dim";
function dimCss(chat: string, preq: string | undefined): string {
  const rest = `>:not(.highlightedMessage_${chat})`;
  const dimmed = `.messagesContainer_${chat}.dimmed_${chat}${rest}`;
  const asked = preq
    ? `.messagesContainer_${chat}.${DIM_CLASS}${rest}`
    : undefined;
  const cover = asked ? `${asked}{opacity:.4}` : "";
  const lifts = [dimmed, ...(asked ? [asked] : [])]
    .map((s) => `${FIND_BAR_OPEN} ${s}`)
    .join(",");
  return `${cover}${lifts}{opacity:1 !important}`;
}

// Permission-popup auto-scroll guard (rides the scroll-to-bottom toggle): the
// chat view's render effect has one branch that scrolls the history to the
// bottom whenever a permission request or AskUserQuestion popup is pending,
// yanking the view down while reading history. It is the one branch of that
// effect that does not defer to the stick-to-bottom flag (recomputed each
// render as "within 50px of the bottom").
// With the button ON the yank is pointless (the button is one click away), so
// the branch gets the same stickiness condition inline: an arrow IIFE reads the
// live scroll position off the container ref (introducing no bindings into the
// minified scope) and lets the scroll through only when the view is already
// within the native 50px stick zone (or the ref is unmounted, where the call is
// a no-op anyway), keeping the at-bottom reveal native.
// When it does let the scroll through, the native helper is the wrong tool: it
// smooth-scrolls to the scrollHeight measured RIGHT NOW, but the popup's arrival
// has not finished changing that height. The composer/popup wrapper is
// absolutely positioned and its height is mirrored into a spacer at the end of
// the transcript by a ResizeObserver, so the taller popup only grows the spacer
// a frame or two later, after this layout effect has run: the scroll lands on
// the old bottom and the view is left short by the height delta, reading as "it
// just stayed where it was". The call therefore prefers window.__ccupPermGlide,
// the button's own glide with a settle pass (see scrollDotBuild), and keeps the
// native helper as the fallback for a bundle whose injected line failed. The
// site is a one-token widening of the callee: the argument list is re-emitted
// as it stood, which the glide reads as (ref) and ignores the rest of, so the
// smooth flag only ever reaches the native fallback.
// The branch itself is matched structurally rather than by what it tests,
// because what it tests keeps changing: 2.1.245 appended an `&&!<teleport flag>`
// conjunct, and 2.1.261 dropped the pending-count read entirely for
// `if((<req>&&<untouched>.current||<answered>)&&!<teleport>)`, where
// <untouched> is a native ref cleared by wheel/touch/pointer/nav-key input
// (a coarser cousin of this guard: it suppresses the yank once you interact
// AFTER the popup arrives, but a fresh popup re-arms it, so scrolling up while
// Claude works still gets yanked and answering one still jumps). The whole
// condition is therefore one capture (1) and the smooth flag another (4, `!0`
// until 2.1.261 made it `!<answered>`), both re-emitted verbatim, and what
// pins the site is the shape of the body plus a lookahead for the
// "first messages arrived" branch that follows and reuses the same helper and
// ref. So restore is byte-identical, the guard rides whatever the branch tests
// without reading it, and the marker makes the guarded state detectable. The
// edit is best-effort: on a drifted bundle where the branch is gone the toggle
// still applies (buttons only), and permYankGuardOk treats "no native site" as
// satisfied so the state machinery never loops on it.
//
// 2.1.275 rebuilt the effect around a settle-glide of its own, and split the
// one branch in two: an answered popup jumps to the bottom
// (`if(<answered>){<away>.current=!1,<settle>.current=null,<helper>(<ref>);
// return}`), and a pending, untouched one clears the scrolled-away flag and,
// when the view sits 50px or more above the bottom, starts a smooth glide there
// that a scrollend listener keeps re-aiming for 2s as the spacer grows. That
// glide is the yank itself, and it now closes the spacer gap natively, so this
// form needs neither the stickiness IIFE nor __ccupPermGlide. Instead each of
// the two conditions gains `&&<atBottom>.current`, the effect's own ref that
// render sets to "within 50px of the bottom" before the commit, which is the
// same stick zone measured before the popup changed anything. At the bottom
// both branches then run exactly as native (glide and settle included). Away
// from it neither does, and the effect falls through to its general
// follow-the-bottom decision, which leaves a scrolled-away view where it is.
// The atBottom ref is read off the "first messages arrived" branch that
// follows, which sets it to true and reuses the same away and settle refs,
// helper and container ref (in a lookahead, as before). Each insertion is
// self-delimiting (marker, identifier, `.current`, then the condition's own
// closing paren), so stripping them restores the stock bytes.
//
// 2.1.302 moved the settle-glide into a hook of its own, a scrollend listener
// that re-aims while the settle ref holds a start time, and the fall-through
// into a decision over {atBottom, scrolledAway, settlingSince, now}, which
// scrolls nowhere for a view scrolled away, nor for one away from the bottom
// with no glide under way. The two branches kept their shape, so the same
// conjuncts guard them, and a guarded view away from the bottom stays put.
// The same release put a call into the "first messages arrived" branch,
// between its helper call and its atBottom write (a refresh of the math
// typesetting near the view), so the lookahead reads that branch with any
// calls there.
const PERM_YANK_MARKER = "/*ccup:permYankGuard*/";
// Condition and smooth flag: brace- and semicolon-free spans, which bounds the
// greedy run to the one statement and lets the condition carry its own parens.
const PERM_YANK_COND = String.raw`if\(([^{};]*)\)\{`;
const PERM_YANK_SMOOTH = String.raw`([^;{}]*)`;
// The `if(<first messages>){<helper>(<ref>),<stick>.current=!0;return}` branch
// sitting just past this one, as a lookahead so it stays outside the match.
// Native-only: \2 and \3 are the helper and ref captured by the native regex
// below, so this must stay appended to exactly that prefix.
const PERM_YANK_NEXT = String.raw`(?=[^{}]*if\([^{}]*\)\{\2\(\3\),[\w$]+\.current=!0;return\})`;
const PERM_YANK_NATIVE_RE = new RegExp(
  PERM_YANK_COND +
    String.raw`([\w$]+)\(([\w$]+),` +
    PERM_YANK_SMOOTH +
    String.raw`\);return\}` +
    PERM_YANK_NEXT,
);
const PERM_YANK_GUARD_HEAD = String.raw`\/\*ccup:permYankGuard\*\/if\(\(\(n\)=>!n\|\|n\.scrollHeight-n\.scrollTop-n\.clientHeight<50\)\(([\w$]+)\.current\)\)`;
const PERM_YANK_GUARDED_RE = new RegExp(
  PERM_YANK_COND +
    PERM_YANK_GUARD_HEAD +
    String.raw`\(window\.__ccupPermGlide\|\|([\w$]+)\)\(\2,` +
    PERM_YANK_SMOOTH +
    String.raw`\);return\}`,
);
// The 1.3.2-1.3.6 guard, which called the native helper directly. Stripping it
// is what lets an in-place upgrade rebuild the branch instead of stranding the
// old form (the native regex no longer matches an already-guarded branch).
const PERM_YANK_LEGACY_RE = new RegExp(
  PERM_YANK_COND +
    PERM_YANK_GUARD_HEAD +
    String.raw`([\w$]+)\(\2,` +
    PERM_YANK_SMOOTH +
    String.raw`\);return\}`,
);
// The calls the "first messages arrived" branch may make between its helper
// call and its atBottom write (2.1.302 added one).
const PERM_YANK_SETTLE_MORE = String.raw`(?:[^;{}]*?,)?`;
// The 2.1.275 form: the answered branch (captures: 1=its head through the
// condition, 3=away ref, 4=settle ref, 5=helper, 6=container ref), running on
// into the pending branch's head (2 ends at its condition), then that branch's
// body (7) and the atBottom ref (8) off the branch after them. The conditions
// are opaque spans, so this also matches the guarded form: it must only ever
// run on a stripped bundle.
const PERM_YANK_SETTLE_NATIVE_RE = new RegExp(
  String.raw`(if\([^{};]*)` +
    String.raw`(\)\{([\w$]+)\.current=!1,([\w$]+)\.current=null,([\w$]+)\(([\w$]+)\);return\}if\([^{};]*)` +
    String.raw`(\)\{if\(\3\.current=!1,[^{}]*\)\{\4\.current=Date\.now\(\),\5\(\6,!0\);return\}\})` +
    String.raw`(?=if\([^{}]*\)\{\3\.current=!1,\4\.current=null,\5\(\6\),` +
    PERM_YANK_SETTLE_MORE +
    String.raw`([\w$]+)\.current=!0;return\})`,
);
const PERM_YANK_SETTLE_GUARD = String.raw`&&\/\*ccup:permYankGuard\*\/`;
// Both conditions guarded by the same atBottom ref (captures: 1=atBottom,
// 2=away ref, 3=settle ref, 4=helper, 5=container ref).
const PERM_YANK_SETTLE_GUARDED_RE = new RegExp(
  String.raw`if\([^{};]*` +
    PERM_YANK_SETTLE_GUARD +
    String.raw`([\w$]+)\.current\)\{([\w$]+)\.current=!1,([\w$]+)\.current=null,([\w$]+)\(([\w$]+)\);return\}if\([^{};]*` +
    PERM_YANK_SETTLE_GUARD +
    String.raw`\1\.current\)\{if\(\2\.current=!1,[^{}]*\)\{\3\.current=Date\.now\(\),\4\(\5,!0\);return\}\}` +
    String.raw`(?=if\([^{}]*\)\{\2\.current=!1,\3\.current=null,\4\(\5\),` +
    PERM_YANK_SETTLE_MORE +
    String.raw`\1\.current=!0;return\})`,
);
// One inserted conjunct, whichever condition it sits in.
const PERM_YANK_SETTLE_FRAG_RE = new RegExp(
  PERM_YANK_SETTLE_GUARD + String.raw`[\w$]+\.current(?=\)\{)`,
  "g",
);
function permYankGuardedText(
  cond: string,
  fn: string,
  ref: string,
  smooth: string,
): string {
  return (
    `if(${cond}){${PERM_YANK_MARKER}` +
    `if(((n)=>!n||n.scrollHeight-n.scrollTop-n.clientHeight<50)(${ref}.current))` +
    `(window.__ccupPermGlide||${fn})(${ref},${smooth});return}`
  );
}
// Strip any guard (current, legacy, or the 2.1.275 form) back to the native
// branch, then re-apply when on. Both guarded one-branch forms spell the ref
// before the helper (the stickiness check reads it first), so the strip
// callback takes them in that order.
function permYankGuardSet(c: string, on: boolean): string {
  const native = (
    _m: string,
    cond: string,
    ref: string,
    fn: string,
    smooth: string,
  ): string => `if(${cond}){${fn}(${ref},${smooth});return}`;
  const off = c
    .replace(PERM_YANK_GUARDED_RE, native)
    .replace(PERM_YANK_LEGACY_RE, native)
    .replace(PERM_YANK_SETTLE_FRAG_RE, "");
  if (!on) return off;
  return off
    .replace(PERM_YANK_NATIVE_RE, (_m, cond, fn, ref, smooth) =>
      permYankGuardedText(cond, fn, ref, smooth),
    )
    .replace(
      PERM_YANK_SETTLE_NATIVE_RE,
      (_m, head, mid, _away, _settle, _fn, _ref, body, bottom) => {
        const guard = `&&${PERM_YANK_MARKER}${bottom}.current`;
        return `${head}${guard}${mid}${guard}${body}`;
      },
    );
}
// The guard's ON-state health: guarded in a current form, or nothing left to
// guard (drift). A legacy guard reads as unhealthy so the next apply rebuilds
// it, and so does a 2.1.275 site with only one of its two conjuncts, which the
// opaque conditions let the native form match.
function permYankGuardOk(c: string): boolean {
  if (PERM_YANK_GUARDED_RE.test(c) || PERM_YANK_SETTLE_GUARDED_RE.test(c)) {
    return true;
  }
  return (
    !PERM_YANK_NATIVE_RE.test(c) &&
    !PERM_YANK_LEGACY_RE.test(c) &&
    !PERM_YANK_SETTLE_NATIVE_RE.test(c)
  );
}

const SCROLL_DOT_MARKER = "/*ccup:scrollDot*/";
const SCROLL_DOT_LINE_RE = /\n?\/\*ccup:scrollDot\*\/[^\n]*/g;
const SCROLL_DOT_INPUT_HASH_RE = /messageInput:"messageInput_([-\w]+)"/;
const SCROLL_DOT_CHAT_HASH_RE =
  /messagesContainer:"messagesContainer_([-\w]+)"/;

// The full marked line for this bundle, or undefined when a class-map anchor is
// gone. Deterministic given the bundle content, so equality against the on-disk
// line doubles as the staleness check.
function scrollDotBuild(c: string): string | undefined {
  const input = c.match(SCROLL_DOT_INPUT_HASH_RE)?.[1];
  const chat = c.match(SCROLL_DOT_CHAT_HASH_RE)?.[1];
  if (!input || !chat) return undefined;
  const perm = c.match(PERM_WRAP_HASH_RE)?.[1];
  const preq = c.match(PERM_REQ_HASH_RE)?.[1];
  const wrap = c.match(BTN_WRAP_HASH_RE)?.[1];
  const host = btnHostSel(input, wrap);
  // The button floats just above the composer stack's top-right corner.
  // box-sizing:border-box keeps the 26px footprint matching the send button's
  // despite the 1px border; it stays hidden (opacity 0, no pointer events, nudged
  // down) until data-show is set. currentColor drives the arrow's stroke.
  const ghost2 =
    "linear-gradient(var(--app-ghost-button-hover-background),var(--app-ghost-button-hover-background)),linear-gradient(var(--app-ghost-button-hover-background),var(--app-ghost-button-hover-background))";
  const css =
    ".ccup-scroll-btn{box-sizing:border-box;position:absolute;top:-34px;right:5px;display:flex;align-items:center;justify-content:center;width:26px;height:26px;margin:0;padding:0;border:1px solid var(--app-input-border);border-radius:5px;background:var(--app-input-secondary-background);color:var(--app-primary-foreground);box-shadow:0 1px 3px #00000033;cursor:pointer;opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .15s ease,transform .15s ease,filter .15s ease;z-index:21}" +
    ".ccup-scroll-btn[data-show]{opacity:1;transform:none;pointer-events:auto}" +
    ".ccup-scroll-btn[data-show][data-off]{opacity:.35;cursor:default}" +
    `.ccup-scroll-btn${HOVER}{background:${ghost2},var(--app-input-secondary-background);border-color:var(--app-secondary-foreground)}` +
    `.ccup-scroll-btn[data-off]${HOVER}{background:var(--app-input-secondary-background);border-color:var(--app-input-border)}` +
    ".ccup-scroll-btn:not([data-off]):active{filter:brightness(.85)}" +
    ".ccup-scroll-btn svg{display:block;width:20px;height:20px}" +
    // While one of the composer's own dropdowns or the fieldset's overlay
    // banners holds the button's strip, the button hides so it neither paints
    // through nor blocks what opened there (see btnHideCss).
    btnHideCss(input, wrap, ".ccup-scroll-btn") +
    btnHostCss(wrap, perm, preq) +
    dimCss(chat, preq) +
    HOVER_TIP_CSS;
  // Down arrow, drawn with currentColor strokes; single-quoted attributes so the
  // whole markup embeds in a double-quoted JS string below without escaping.
  const arrow =
    "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 5v14'/><path d='M19 12l-7 7-7-7'/></svg>";
  const js =
    `(function(){try{` +
    `if(window.__ccupScrollDot)return;window.__ccupScrollDot=1;` +
    `var st=document.createElement("style");st.textContent='${css}';document.head.appendChild(st);` +
    `var ARROW="${arrow}",raf=0,gen=0;` +
    HOVER_TIP_JS +
    `function rm(){return matchMedia("(prefers-reduced-motion:reduce)").matches}` +
    `function sc(){return document.querySelector(".messagesContainer_${chat}")}` +
    btnHostsJs(host, perm, preq) +
    // Settle pass (permission/question arrival only): the glide above lands on
    // the bottom as it stands now, but the popup's spacer grows a frame or two
    // later, so for 600ms afterwards any newly opened gap is closed too. Each
    // frame eases 35% of what is left, which reads as one continuous motion with
    // the glide rather than a snap; a gap of a pixel or less is finished off
    // outright, as is every step under reduced motion. It rides the same
    // generation token as the glide, so a click or a user scroll ends it.
    `function pin(t,g,r){var e=0;function stp(now){if(g!==gen)return;` +
    `if(!e)e=now+600;if(now>e)return;` +
    `var d=t.scrollHeight-t.scrollTop-t.clientHeight;` +
    `if(d>0)t.scrollTop=d>1&&!r?t.scrollTop+d*.35:t.scrollHeight;` +
    `requestAnimationFrame(stp)}requestAnimationFrame(stp)}` +
    // Fixed 100ms ease-out glide to the bottom; target re-read per frame. t
    // defaults to the sole messages container (button clicks); p adds the settle
    // pass. Bumping gen first makes the token the single cancel channel.
    `function go(t,p){if(!t)t=sc();if(!t)return;var g=++gen,r=rm();` +
    `if(r){t.scrollTop=t.scrollHeight;if(p)pin(t,g,r);return}` +
    `var f=t.scrollTop,t0;` +
    `function stp(now){if(g!==gen)return;if(t0===void 0)t0=now;` +
    `var k=Math.min(1,(now-t0)/100),e=1-(1-k)*(1-k);` +
    `if(k<1){t.scrollTop=f+(t.scrollHeight-t.clientHeight-f)*e;requestAnimationFrame(stp)}` +
    `else{t.scrollTop=t.scrollHeight;if(p)pin(t,g,r)}}` +
    `requestAnimationFrame(stp)}` +
    // A wheel or touch is the user taking over: void the generation token so an
    // in-flight glide or settle pass stops instead of fighting them. Passive, so
    // the listeners never delay the scroll they are watching for.
    `function cxl(){gen++}` +
    `document.addEventListener("wheel",cxl,{capture:!0,passive:!0});` +
    `document.addEventListener("touchstart",cxl,{capture:!0,passive:!0});` +
    // The permission/question arrival path, called from the guarded branch in
    // the chat's scroll effect (see PERM_YANK_MARKER) with that effect's own
    // container ref, which is authoritative when several chat views are mounted.
    // Through 2.1.274 only: the guard from 2.1.275 on leaves native's own
    // settle-glide in charge, so nothing calls it there.
    `window.__ccupPermGlide=function(r){try{go(r&&r.current,1)}catch(e){}};` +
    // can = something below to scroll to; shown always, dimmed inert otherwise.
    `function upd(){raf=0;var s=sc(),can=!!s&&s.scrollHeight-s.scrollTop-s.clientHeight>8,boxes=hosts();` +
    `for(var i=0;i<boxes.length;i++){var box=boxes[i],d=box.querySelector(".ccup-scroll-btn");` +
    `if(!d){d=document.createElement("button");d.type="button";d.className="ccup-scroll-btn";` +
    `d.setAttribute("aria-label","Scroll to Bottom");d.innerHTML=ARROW;` +
    `d.addEventListener("mousedown",function(e){e.preventDefault();e.stopPropagation();hideTip()});` +
    `d.addEventListener("click",function(e){e.stopPropagation();hideTip();if(!this.hasAttribute("data-off"))go()});att(d,"Scroll to Bottom");box.appendChild(d)}` +
    `if(!d.hasAttribute("data-show"))d.setAttribute("data-show","");` +
    `var off=d.hasAttribute("data-off");if(can&&off)d.removeAttribute("data-off");else if(!can&&!off)d.setAttribute("data-off","")}}` +
    `function que(){if(!raf)raf=requestAnimationFrame(upd)}` +
    `document.addEventListener("scroll",que,!0);window.addEventListener("resize",que);` +
    `new MutationObserver(que).observe(document.body,{childList:!0,subtree:!0,characterData:!0,attributes:!0,attributeFilter:["class","style"]});` +
    `que()` +
    `}catch(e){}})();`;
  return `${SCROLL_DOT_MARKER}${js}`;
}

function scrollDotPresent(c: string): boolean {
  return c.includes(SCROLL_DOT_MARKER) || scrollDotBuild(c) !== undefined;
}
// true = ON (marked line present and matching this build AND the popup
// auto-scroll guard healthy; also when present but unrebuildable, so an
// orphaned line still reads as ON and stays removable), false = OFF or stale
// (including a missing guard, so upgrades re-apply it), undefined = anchors
// gone and nothing to remove.
function scrollDotCurrentOn(c: string): boolean | undefined {
  const cur = cssMarkedLine(c, SCROLL_DOT_MARKER);
  const want = scrollDotBuild(c);
  if (cur !== undefined)
    return (want === undefined || cur === want) && permYankGuardOk(c);
  return want === undefined ? undefined : false;
}
function scrollDotSet(c: string, on: boolean): string {
  if (on && scrollDotCurrentOn(c) === true) return c; // stable: no EOF reshuffle
  const stripped = permYankGuardSet(c.replace(SCROLL_DOT_LINE_RE, ""), false);
  if (!on) return stripped;
  const line = scrollDotBuild(stripped);
  if (line === undefined) return c; // anchors gone: leave the file as it is
  return `${permYankGuardSet(stripped, true)}\n${line}`;
}

// Jump-to-previous/next-message buttons (ON): a companion to the
// scroll-to-bottom button for moving through the conversation a turn at a time.
// Each user message is a sticky header (.stickyHeader_<hash>,
// position:sticky;top:0) that pins to the top of the messages area while its
// responses scroll underneath, so the natural navigation stops are those
// headers. When ON we append a marked, self-contained IIFE at the end of
// webview/index.js that mounts two neutral 26px squares above the input box's
// top-right corner (anchored to .inputWrapper_<hash>, see btnHostSel), in the
// same row (top:-34px) as the scroll-to-bottom button and to its left: with that button
// ON the trio reads up/down/bottom at right:65/35/5px (a 30px pitch off the
// send button's 5px inset); with it OFF the pair slides into right:35/5px. The
// slot choice is baked at patch time by checking the bundle for the scrollDot
// marker, which is sound because toggles apply in TOGGLE_POINTS order
// (scrollDot precedes jumpMsg), so this build always sees the other's final
// state, and a later scrollDot flip re-applies this line through the staleness
// check. Each square matches the send button's rounded-square look via the
// input's own surface, border, and text color, with the same doubled
// ghost-button hover, and carries the shared custom hover tip
// ("Previous Message" / "Next Message").
//
// The stops are the headers' natural (unstuck) positions in the scroll range,
// and offsetTop alone cannot supply them: the sticky shift is part of layout, so
// a pinned header reports the shifted position (~scrollTop), not its flow slot.
// With top:0 against the whole container every header scrolled past pins at the
// scrollport top in one pile (painted in document order, so the latest pinned
// header is the visible one) and all of them read ~scrollTop. A click therefore
// measures natural positions by neutralizing the pile for one synchronous pass:
// set inline position:static on every header, read its offset, restore. Each
// read sums offsetTop up the offsetParent chain to the container instead of
// trusting one hop: normally the chain IS one hop (.messagesContainer_<hash> is
// the position:relative offsetParent, and the turn wrappers between it and the
// headers are borderless and unpadded, so the sum equals the plain offsetTop),
// but while a permission/question popup is pending the pending turn's wrapper
// carries .highlightedMessage_<chat> (position:relative z-index:10, the native
// dim's opt-out), hijacking the newest header's offsetParent, and a bare
// offsetTop would read that header's slot within its own turn (~0): "next"
// would lose the newest stop (its bottom fallback then fires from anywhere in
// the tail) and "previous" would gain a phantom ~0 stop below the first
// header's real slot (a 20px stickyMode spacer precedes it) and creep past the
// first message. The walk keeps every read container-relative in every state.
// No paint happens between the writes and the restore (a forced layout at most),
// so nothing flickers, and static occupies the same flow slot, so scrollHeight
// and the scroll position are unchanged. "Previous" glides to the greatest
// natural position more than 4px above scrollTop (the epsilon absorbs sub-pixel
// drift): from the bottom that pins the newest turn's header, and further clicks
// step a turn up. "Next" glides to the least natural position more than 4px
// below; with no header below it falls back to the very bottom, the
// conversation's live edge (the input box, or the permission/question popup
// while one is pending). Inside the newest turn's response every user header
// sits at/above the scrollport top, and under a pending popup that is the
// common reading state (the pending turn is the assistant's, so no user turn
// can be below) — without the fallback "next" would strand there dimmed with
// content plainly below. The glide is the scroll-to-bottom button's fixed 100ms ease-out rAF
// animation (instant under prefers-reduced-motion), clamped to the scrollable
// range, with a per-click generation token cancelling a superseded animation.
// Both buttons swallow mousedown (preventDefault + stopPropagation) and click
// (stopPropagation): they sit inside the composer container, whose own handlers
// otherwise steal focus and scroll the chat to the bottom, overriding the glide.
//
// The pair is always visible (unlike the scroll-to-bottom button), so from the
// bottom it doubles as "jump back to the newest user message"; only an exhausted
// direction dims and goes inert (data-off) rather than being removed, keeping
// the shape stable. The dimming census mostly needs no natural positions: raw
// (sticky-shifted) offsetTops, summed through the same offsetParent walk so a
// highlighted turn cannot fold its header into the pile, classify headers as
// below the scrollport top (> scrollTop+4px; never pinned, so trustworthy) or
// in the pile at/above it. "Next" lights on any
// header below, and otherwise on a view above the bottom zone (more than 8px of
// scroll left, the scroll button's own threshold), matching its bottom
// fallback; it dims only at the bottom. "Previous" lights on a pile of two or more (the pile's newest
// turn plus at least one earlier, whose start sits at least a header height
// higher, clearing the epsilon), and on a lone pile header exactly when the view
// sits more than 4px below its start, so jumping to the top of the current turn
// stays available inside the first turn's body, single-turn conversations
// included. That start is the one natural position the raw census cannot give,
// but a lone pile member is necessarily the FIRST header, and nothing precedes
// turn one, so its natural position is fixed for the element's lifetime: it is
// measured once (same neutralize-and-restore) and cached by element identity,
// costing no per-frame reflow. Mounting, re-mount on re-render, and the
// rAF-coalesced updater (capture-phase scroll, resize, body MutationObserver)
// mirror the scroll-to-bottom button, including the shared hosts() collector,
// so while a permission/question popup replaces the input box the pair sits on
// that popup's wrapper at the same offsets (see btnHostsJs above), where the
// mousedown swallow also keeps focus, and with it the popup's keyboard
// handling, on the popup; data-show/data-off sit outside the
// observer's class/style attribute filter, and the observer callback drops the
// records our own measurements produce (style writes on sticky headers, from
// the click-time pass and the census probe alike), so the updater never
// re-triggers itself. The three class-map hashes (messageInput's inputWrapper,
// messagesContainer, and stickyHeader) are read at patch time; if any is gone
// the point reports missing and the bundle stays native. try/catch wraps the
// whole body, and the /*ccup:jumpMsg*/ marker makes the ON state detectable; a
// marked line that no longer matches the current build reads as OFF, so the next
// apply rebuilds it in place or strips it.
const JUMP_MSG_MARKER = "/*ccup:jumpMsg*/";
const JUMP_MSG_LINE_RE = /\n?\/\*ccup:jumpMsg\*\/[^\n]*/g;
const JUMP_MSG_INPUT_HASH_RE = /messageInput:"messageInput_([-\w]+)"/;
const JUMP_MSG_CHAT_HASH_RE = /messagesContainer:"messagesContainer_([-\w]+)"/;
const JUMP_MSG_STICKY_HASH_RE = /stickyHeader:"stickyHeader_([-\w]+)"/;

// The full marked line for this bundle, or undefined when a class-map anchor is
// gone. Deterministic given the bundle content, so equality against the on-disk
// line doubles as the staleness check.
function jumpMsgBuild(c: string): string | undefined {
  const input = c.match(JUMP_MSG_INPUT_HASH_RE)?.[1];
  const chat = c.match(JUMP_MSG_CHAT_HASH_RE)?.[1];
  const sticky = c.match(JUMP_MSG_STICKY_HASH_RE)?.[1];
  if (!input || !chat || !sticky) return undefined;
  const perm = c.match(PERM_WRAP_HASH_RE)?.[1];
  const preq = c.match(PERM_REQ_HASH_RE)?.[1];
  const wrap = c.match(BTN_WRAP_HASH_RE)?.[1];
  const host = btnHostSel(input, wrap);
  // Two 26px squares matching the scroll-to-bottom button, above the composer
  // stack's top-right corner: left of the scroll button's right:5px slot when
  // its marker is in the bundle, slid into its place otherwise (30px pitch
  // either way);
  // box-sizing keeps the 1px border from inflating them. data-show fades a button
  // in; data-show+data-off dims an exhausted direction.
  const withDot = c.includes(SCROLL_DOT_MARKER);
  const ghost2 =
    "linear-gradient(var(--app-ghost-button-hover-background),var(--app-ghost-button-hover-background)),linear-gradient(var(--app-ghost-button-hover-background),var(--app-ghost-button-hover-background))";
  const css =
    ".ccup-nav-btn{box-sizing:border-box;position:absolute;top:-34px;display:flex;align-items:center;justify-content:center;width:26px;height:26px;margin:0;padding:0;border:1px solid var(--app-input-border);border-radius:5px;background:var(--app-input-secondary-background);color:var(--app-primary-foreground);box-shadow:0 1px 3px #00000033;cursor:pointer;opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .15s ease,transform .15s ease,filter .15s ease;z-index:21}" +
    `.ccup-nav-prev{right:${withDot ? 65 : 35}px}.ccup-nav-next{right:${withDot ? 35 : 5}px}` +
    ".ccup-nav-btn[data-show]{opacity:1;transform:none;pointer-events:auto}" +
    ".ccup-nav-btn[data-show][data-off]{opacity:.35;cursor:default}" +
    `.ccup-nav-btn${HOVER}{background:${ghost2},var(--app-input-secondary-background);border-color:var(--app-secondary-foreground)}` +
    `.ccup-nav-btn[data-off]${HOVER}{background:var(--app-input-secondary-background);border-color:var(--app-input-border)}` +
    ".ccup-nav-btn:not([data-off]):active{filter:brightness(.85)}" +
    ".ccup-nav-btn svg{display:block;width:20px;height:20px}" +
    // Hide both nav buttons while a composer dropdown or one of the fieldset's
    // overlay banners holds their strip; they mount in the composer wrapper (no
    // stacking context of its own), so their z:21 would otherwise paint through
    // whatever opened above the box, and block it (see btnHideCss).
    btnHideCss(input, wrap, ".ccup-nav-btn") +
    btnHostCss(wrap, perm, preq) +
    dimCss(chat, preq) +
    HOVER_TIP_CSS;
  // Chevron up / down (no stem), distinct from the scroll button's stemmed arrow;
  // single-quoted attributes embed in the double-quoted JS strings below unescaped.
  const up =
    "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M18 15l-6-6-6 6'/></svg>";
  const dn =
    "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9l6 6 6-6'/></svg>";
  const js =
    `(function(){try{` +
    `if(window.__ccupJumpMsg)return;window.__ccupJumpMsg=1;` +
    `var st=document.createElement("style");st.textContent='${css}';document.head.appendChild(st);` +
    `var UP="${up}",DN="${dn}",raf=0,gen=0,n0el=null,n0=0;` +
    HOVER_TIP_JS +
    `function sc(){return document.querySelector(".messagesContainer_${chat}")}` +
    btnHostsJs(host, perm, preq) +
    `function hh(t){return t.querySelectorAll(".stickyHeader_${sticky}")}` +
    // Header offset within container t: offsetTop summed up the offsetParent
    // chain (one hop normally; two while .highlightedMessage wraps its turn).
    `function ot(e,t){var y=0,n=e;while(n&&n!==t){y+=n.offsetTop;n=n.offsetParent}return y}` +
    // Natural (unstuck) header positions: neutralize sticky, read all, restore.
    `function nat(t){var h=hh(t),a=[],i;` +
    `for(i=0;i<h.length;i++)h[i].style.position="static";` +
    `for(i=0;i<h.length;i++)a.push(ot(h[i],t));` +
    `for(i=0;i<h.length;i++)h[i].style.position="";` +
    `return a}` +
    // Fixed 100ms ease-out glide to a clamped scrollTop; instant under reduced motion.
    `function go(to){var t=sc();if(!t)return;var top=Math.max(0,Math.min(to,t.scrollHeight-t.clientHeight));` +
    `if(matchMedia("(prefers-reduced-motion:reduce)").matches){t.scrollTop=top;return}` +
    `var g=++gen,f=t.scrollTop,t0;function stp(now){if(g!==gen)return;if(t0===void 0)t0=now;` +
    `var k=Math.min(1,(now-t0)/100),e=1-(1-k)*(1-k);t.scrollTop=f+(top-f)*e;if(k<1)requestAnimationFrame(stp)}` +
    `requestAnimationFrame(stp)}` +
    // Nearest natural position >4px above (dir<0) or below (dir>0) the current
    // top; with none below, next falls back to the bottom (see the census note).
    `function jump(dir){var t=sc();if(!t)return;var a=nat(t),cur=t.scrollTop,best=null,i,o;` +
    `for(i=0;i<a.length;i++){o=a[i];if(dir<0){if(o<cur-4&&(best===null||o>best))best=o}` +
    `else if(o>cur+4&&(best===null||o<best))best=o}` +
    `if(best!==null)go(best);` +
    `else if(dir>0&&t.scrollHeight-t.scrollTop-t.clientHeight>8)go(t.scrollHeight-t.clientHeight)}` +
    // Buttons swallow mousedown/click so the composer never steals focus or scrolls.
    `function mk(cls,svg,t,dir){var b=document.createElement("button");b.type="button";b.className="ccup-nav-btn "+cls;` +
    `b.setAttribute("aria-label",t);b.innerHTML=svg;att(b,t);` +
    `b.addEventListener("mousedown",function(e){e.preventDefault();e.stopPropagation();hideTip()});` +
    `b.addEventListener("click",function(e){e.stopPropagation();if(!b.hasAttribute("data-off"))jump(dir)});return b}` +
    // Toggle data-show/data-off only on an actual change (outside the observer filter).
    `function ss(el,show,off){var s=el.hasAttribute("data-show");if(show&&!s)el.setAttribute("data-show","");else if(!show&&s)el.removeAttribute("data-show");var o=el.hasAttribute("data-off");if(off&&!o)el.setAttribute("data-off","");else if(!off&&o)el.removeAttribute("data-off")}` +
    // Census on raw (sticky-shifted) offsets through the same offsetParent
    // walk: pile = pinned at/above the top, below = trustworthy.
    `function upd(){raf=0;var t=sc(),below=0,pile=0,m=null,dist=0;` +
    `if(t){var h=hh(t),cur=t.scrollTop;dist=t.scrollHeight-cur-t.clientHeight;` +
    `for(var i=0;i<h.length;i++){if(ot(h[i],t)>cur+4)below++;else{pile++;m=h[i]}}}` +
    `var canP=pile>1,canN=below>0||dist>8;` +
    // A lone pile header is turn 1's; prev is valid while the view sits below its
    // start. That natural position is fixed per element, so measure once and cache.
    `if(!canP&&pile===1){if(n0el!==m){n0el=m;m.style.position="static";n0=ot(m,t);m.style.position=""}canP=n0<cur-4}` +
    `var boxes=hosts();` +
    `for(var j=0;j<boxes.length;j++){var box=boxes[j],p=box.querySelector(".ccup-nav-prev"),n=box.querySelector(".ccup-nav-next");` +
    `if(!p){p=mk("ccup-nav-prev",UP,"Previous Message",-1);box.appendChild(p)}` +
    `if(!n){n=mk("ccup-nav-next",DN,"Next Message",1);box.appendChild(n)}` +
    `ss(p,!0,!canP);ss(n,!0,!canN)}}` +
    `function que(){if(!raf)raf=requestAnimationFrame(upd)}` +
    `document.addEventListener("scroll",que,!0);window.addEventListener("resize",que);` +
    // Drop records from our own sticky measurements; anything else refreshes.
    `new MutationObserver(function(rs){for(var i=0;i<rs.length;i++){var r=rs[i],tg=r.target;` +
    `if(r.type!=="attributes"||r.attributeName!=="style"||!tg.classList||!tg.classList.contains("stickyHeader_${sticky}")){que();return}}})` +
    `.observe(document.body,{childList:!0,subtree:!0,characterData:!0,attributes:!0,attributeFilter:["class","style"]});` +
    `que()` +
    `}catch(e){}})();`;
  return `${JUMP_MSG_MARKER}${js}`;
}

function jumpMsgPresent(c: string): boolean {
  return c.includes(JUMP_MSG_MARKER) || jumpMsgBuild(c) !== undefined;
}
// true = ON (marked line present and matching this build, or present but
// unrebuildable so an orphaned line stays removable), false = OFF or stale,
// undefined = anchors gone and nothing to remove.
function jumpMsgCurrentOn(c: string): boolean | undefined {
  const cur = cssMarkedLine(c, JUMP_MSG_MARKER);
  const want = jumpMsgBuild(c);
  if (cur !== undefined) return want === undefined || cur === want;
  return want === undefined ? undefined : false;
}
function jumpMsgSet(c: string, on: boolean): string {
  if (on && jumpMsgCurrentOn(c) === true) return c; // stable: no EOF reshuffle
  const stripped = c.replace(JUMP_MSG_LINE_RE, "");
  if (!on) return stripped;
  const line = jumpMsgBuild(stripped);
  if (line === undefined) return c; // anchors gone: leave the file as it is
  return `${stripped}\n${line}`;
}

// Prompt history button (ON): a fourth 26px square in the composer's button
// row that opens a list of the conversation's user messages, one entry per
// sticky header, numbered from 1 in transcript order, so any turn is one click
// away instead of a run of jump clicks. When ON we append a marked,
// self-contained IIFE at the end of webview/index.js, the jumpMsg pattern.
//
// The button sits left of every other button in the row, on the same 30px
// pitch: right:95px with both the jump pair and the scroll-to-bottom button
// on, 65px with the pair alone, 35px with the scroll button alone, 5px with
// neither. The slot is baked at patch time from the jumpMsg and scrollDot
// markers in the bundle, which is sound because toggles apply in TOGGLE_POINTS
// order (both precede this point), and a later flip of either re-applies this
// line through the staleness check, exactly as jumpMsg follows scrollDot. The
// square copies the nav buttons' look and adds a pressed state (the doubled
// ghost hover) while the list is open, with the shared hover tip ("Prompt
// History") suppressed for as long as that lasts, since the list sits over the
// strip the tip would take. Mounting, the data-show/data-off fades, the hide
// rule for the composer's own dropdowns and overlay banners (btnHideCss), and
// the hosts() collector (so the button rides the permission/question popup's
// wrapper while one replaces the composer) all mirror the jump pair. The
// collector is called with dim=false, so this point never touches the popup
// dim the other two buttons own. The button dims inert while the transcript
// has no user message.
//
// The list (.ccup-hist-pane) is one element per document, mounted into the
// host whose button opened it:
//   place   position:absolute;right:0 on the host, which is the composer
//           wrapper, unbordered and unpadded, so its right edge is the input
//           box's right edge. Its bottom sits 6px above the button row
//           (bottom:calc(100% + 40px), the row being top:-34px and 26px tall).
//   width   shrink-to-fit between min-width:min(260px,100%) and
//           max-width:100%, the host's own width: a list of short messages
//           stays a compact right-aligned popover, long ones widen it up to
//           the input box, and an input box squeezed below 260px caps the
//           floor too. The native composer menus anchored to one side size
//           the same way.
//   height  JS-set max-height so the list, the 6px gap, the button row and
//           the composer stack together stay within two thirds of the
//           viewport (2/3 innerHeight - 40px - host height), floored at 120px
//           for a composer grown tall, and never past 8px below the viewport
//           top. Re-fit on every pass, so a growing composer or a resize
//           shrinks it. overflow-y:auto with overscroll-behavior:contain, so
//           a wheel over the list never scrolls the transcript.
//   entry   the number in Claude's clay (--app-claude-orange, the native
//           link color), right-aligned in a column as wide as the largest
//           number's digits, then the message text clamped to two lines
//           (-webkit-line-clamp), at line-height 2 for readability. On the
//           current entry the number takes the selection's foreground
//           instead, since clay on a blue selection loses its contrast (about
//           3.8:1 in the default dark theme, under 2:1 on light ones). Every
//           entry is exactly two lines tall (height:2lh), a one-line message
//           leaving its second line blank, so the rows keep one rhythm. Each
//           run of line breaks becomes one muted monospace "\n" per break, so
//           the text flows on instead of breaking lines, and other whitespace
//           collapses. Past 1000 characters the source is cut, far more than
//           two lines can show.
//   divider a 1px line between rows in the native menu divider's color
//           (--app-input-border), inset to the text edges. It is a ::before
//           on every row but the first, entries and folds alike (the shared
//           ccup-hist-row class), so it takes no layout height, and it hides
//           on both sides of the current, hovered, or focused row, where it
//           would cut across that row's rounded highlight.
//
// The text is the message as rendered, read off the header's DOM rather than
// any React state: each .userMessage_<chat> block of the header contributes
// either its expandable's content element (.content_<box>, the plain-text
// span the prompt renders into, @file mentions spelled as typed, the "Show
// more" button outside it) or, for a slash-command echo, the block itself.
// Attachment chips render outside both and are skipped. A header with neither
// falls back to its visually hidden turn heading (whitespace-collapsed and
// truncated by the app, so line breaks are lost there), with the "You: "
// prefix dropped. The class hashes come from the bundle's class maps: the
// expandable's whole map (one hash from expandableContainer through
// collapseButton, see EXPANDABLE_MAP_RE) and the userMessage key on the
// stickyHeader's hash are required, the slash-command and heading keys are
// optional (each fallback drops out alone).
//
// A click on an entry is a jump-button jump to that message: the header's
// natural (unstuck) position, read with its sticky shift neutralized for one
// synchronous pass and summed up the offsetParent chain (see jumpMsg for both),
// reached with the same 100ms ease-out glide, clamped to the scroll range and
// instant under prefers-reduced-motion. The list stays open, so successive
// clicks hop between messages while each lands pinned at the top of the chat,
// in the third of the viewport the height rule keeps clear. The current entry
// carries data-cur and aria-current, re-marked on every pass, and opening the
// list centers it. The first rule that applies picks it: (1) a clicked entry,
// while its glide runs and for as long as the view stays where the glide put
// it, since the last few turns can share the final screen, where a natural
// position clamps to the bottom and rule (3) would name a neighbor, (2) the
// last entry, with the view within 8px of the bottom (the scroll button's
// threshold), where a short last turn sits under the previous turn's stuck
// header, (3) the turn whose header is stuck at the top (the last header at or
// above the scroll top, the census jumpMsg runs), or entry 1 above the first
// header.
//
// Entries can be hidden, for the "yes please" kind of message that only
// clutters the outline. Each entry carries an eye-off button under its number,
// on the number column's otherwise empty second line, shown on hover or
// keyboard focus (Delete or Backspace does the same from the keyboard). The
// right end, where it first sat, is where the list's own scrollbar draws. The
// button leaves as little air to the row's left edge and to the text as below
// it (the row's 2px padding), reaching into the gap the number keeps to the
// text, since it shows only on hover. A run of consecutive hidden entries
// renders as one slim fold row in their place ("2 hidden" and the range, e.g.
// 23-24, behind a chevron in the number column). A click on the fold, or Enter
// on it, brings the run back. Visible entries keep their transcript numbers,
// and when the current entry is hidden its fold carries the highlight. Headers
// carry no message id, so an entry is named by its position and an FNV-1a
// hash of its text: a rewound or edited transcript, where a position now holds
// another message, never hides the wrong one. The marks persist per
// conversation in the webview's localStorage (where Claude Code keeps its own
// UI flags), keyed by the ?session= id the webview mirrors into its URL, the
// 200 most recently touched conversations kept. A brand-new conversation has
// no id until its first reply arrives, so marks made in that moment land
// under the URL's previous id (or none) and fail to match once the id comes
// in.
//
// The last entry, and only the last, carries a delete button at its right end
// once the last turn delete point is in (window.__ccupTurnRewind, see
// turnRewindWebFind): one line tall, ending far enough in from the list's
// right edge that the list's overlay scrollbar, even hovered and wide, never
// covers it, and shown on hover or keyboard focus like the hide button. A first click arms it, the trash icon giving
// way to "sure?" in bold red, right-aligned to the button's right edge, and
// leaving the button disarms it. A second click hands the header's
// data-ccup-uuid to the bridge, which stops the turn and deletes it, and dims
// the row meanwhile. The list then rebuilds from the shorter header set, and
// hidden marks from that position on are dropped, since the next prompts take
// those positions.
//
// Focus follows the menu-button pattern without disturbing the composer: the
// button and the list swallow mousedown (preventDefault + stopPropagation, as
// the jump buttons do), so a click never moves focus or the composer's caret,
// and opening focuses the list itself (no ring). Up/Down/Home/End then move a
// focused row, Enter or Space jumps to an entry or opens a fold, Escape or Tab
// closes and hands focus back to whatever held it before (the composer, with
// its caret where it was, or the popup card), and the handled keys stop at the
// list, ahead of the app's root listeners and VS Code's key forwarder. A pointerdown outside
// the list and the button row closes it and goes on to whatever it pressed,
// with no focus hand-back. Clicks on the jump and scroll buttons keep it open,
// so stepping a turn at a time stays available while it is up. The list
// closes on its own when the transcript empties or its host leaves the page or
// stops rendering (a popup hiding the composer), and while open it rebuilds
// whenever the header set changes.
//
// The rAF-coalesced updater (capture-phase scroll, resize, body
// MutationObserver) mounts the buttons and, while the list is open, refits,
// re-marks, and rebuilds. Every write happens only on change, and the
// observer drops records from inside the list and from the sticky-header
// measurements (this line's and jumpMsg's), so it settles. The required
// anchors are messageInput, messagesContainer, stickyHeader with its
// userMessage key, and the expandable's map. If any is gone the point reports
// missing and the bundle stays native. try/catch wraps the whole body, and the
// /*ccup:promptHist*/ marker makes the ON state detectable. A marked line that
// no longer matches the current build reads as OFF, so the next apply rebuilds
// it in place or strips it.
const PROMPT_HIST_MARKER = "/*ccup:promptHist*/";
const PROMPT_HIST_LINE_RE = /\n?\/\*ccup:promptHist\*\/[^\n]*/g;
// Width floor of the list, and the pane's gap above the button row.
const PROMPT_HIST_MIN_W = 260;
const PROMPT_HIST_GAP = 40; // the row's 34px offset plus 6px of air
// The localStorage item holding hidden entries, and how many conversations
// it keeps (most recently touched first).
const PROMPT_HIST_STORE = "ccup-prompt-history-hidden";
const PROMPT_HIST_STORE_CAP = 200;
// How far in from the list's right edge the delete button ends. The list's
// overlay scrollbar, once hovered, covers the last 16px (VS Code 1.143 on
// macOS), and the list's border and padding and the row's padding come to
// 13px, so the button keeps a margin for the rest plus a few pixels of air.
const PROMPT_HIST_DEL_INSET = 20;

// The full marked line for this bundle, or undefined when a required anchor is
// gone. Deterministic given the bundle content, so equality against the on-disk
// line doubles as the staleness check.
function promptHistBuild(c: string): string | undefined {
  const input = c.match(JUMP_MSG_INPUT_HASH_RE)?.[1];
  const chat = c.match(JUMP_MSG_CHAT_HASH_RE)?.[1];
  const sticky = c.match(JUMP_MSG_STICKY_HASH_RE)?.[1];
  const box = c.match(EXPANDABLE_MAP_RE)?.[1];
  if (!input || !chat || !sticky || !box) return undefined;
  // The header's own module names its message blocks, and the two fallbacks
  // are read off the same map as optional.
  if (!c.includes(`userMessage:"userMessage_${sticky}"`)) return undefined;
  const slash = c.includes(
    `slashCommandMessage:"slashCommandMessage_${sticky}"`,
  );
  const heading = c.includes(
    `screenReaderTurnHeading:"screenReaderTurnHeading_${sticky}"`,
  );
  const perm = c.match(PERM_WRAP_HASH_RE)?.[1];
  const preq = c.match(PERM_REQ_HASH_RE)?.[1];
  const wrap = c.match(BTN_WRAP_HASH_RE)?.[1];
  const host = btnHostSel(input, wrap);
  // One 30px slot per button already in the row to its right.
  const right =
    5 +
    30 *
      ((c.includes(JUMP_MSG_MARKER) ? 2 : 0) +
        (c.includes(SCROLL_DOT_MARKER) ? 1 : 0));
  const ghost2 =
    "linear-gradient(var(--app-ghost-button-hover-background),var(--app-ghost-button-hover-background)),linear-gradient(var(--app-ghost-button-hover-background),var(--app-ghost-button-hover-background))";
  const css =
    `.ccup-hist-btn{box-sizing:border-box;position:absolute;top:-34px;right:${right}px;display:flex;align-items:center;justify-content:center;width:26px;height:26px;margin:0;padding:0;border:1px solid var(--app-input-border);border-radius:5px;background:var(--app-input-secondary-background);color:var(--app-primary-foreground);box-shadow:0 1px 3px #00000033;cursor:pointer;opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .15s ease,transform .15s ease,filter .15s ease;z-index:21}` +
    ".ccup-hist-btn[data-show]{opacity:1;transform:none;pointer-events:auto}" +
    ".ccup-hist-btn[data-show][data-off]{opacity:.35;cursor:default}" +
    `.ccup-hist-btn${HOVER},.ccup-hist-btn[aria-expanded=true]{background:${ghost2},var(--app-input-secondary-background);border-color:var(--app-secondary-foreground)}` +
    `.ccup-hist-btn[data-off]${HOVER}{background:var(--app-input-secondary-background);border-color:var(--app-input-border)}` +
    ".ccup-hist-btn:not([data-off]):active{filter:brightness(.85)}" +
    ".ccup-hist-btn svg{display:block;width:20px;height:20px}" +
    `.ccup-hist-pane{box-sizing:border-box;position:absolute;right:0;bottom:calc(100% + ${PROMPT_HIST_GAP}px);z-index:22;width:max-content;min-width:min(${PROMPT_HIST_MIN_W}px,100%);max-width:100%;max-height:50vh;overflow-y:auto;overscroll-behavior:contain;margin:0;padding:4px;border:1px solid var(--app-input-border);border-radius:var(--corner-radius-large,8px);background:var(--app-menu-background);color:var(--app-primary-foreground);box-shadow:0 4px 12px var(--vscode-widget-shadow,#0000005c);font-family:var(--vscode-chat-font-family);font-size:var(--vscode-chat-font-size,13px);text-align:left;outline:none;animation:fadeIn .15s ease-out}` +
    // Entries and folds alike: the row box, its shape, and the dividers.
    ".ccup-hist-row{position:relative;border-radius:var(--app-list-border-radius,4px);cursor:pointer;outline:none}" +
    ".ccup-hist-item{display:flex;align-items:baseline;gap:8px;padding:2px 8px 2px 2px;line-height:2}" +
    `.ccup-hist-row+.ccup-hist-row::before{content:"";position:absolute;top:0;left:8px;right:8px;height:1px;background:var(--app-input-border);pointer-events:none}` +
    `.ccup-hist-row[data-cur]::before,.ccup-hist-row[data-cur]+.ccup-hist-row::before,` +
    `.ccup-hist-row:focus-visible::before,.ccup-hist-row:focus-visible+.ccup-hist-row::before,` +
    `.ccup-hist-row${HOVER}::before,.ccup-hist-row${HOVER}+.ccup-hist-row::before{visibility:hidden}` +
    `.ccup-hist-item${HOVER}{background:var(--app-list-hover-background)}` +
    ".ccup-hist-item[data-cur]{background:var(--app-list-active-background);color:var(--app-list-active-foreground)}" +
    ".ccup-hist-item:focus-visible,.ccup-hist-fold:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}" +
    // At least as wide as the hide button, an entry's line (2em at its
    // line-height 2), less the 6px it reaches into the gap, in folds too,
    // whose shorter line keeps the same column.
    `.ccup-hist-num{flex:none;min-width:max(var(--ccup-hist-w,1ch),2em - 6px);text-align:right;font-variant-numeric:tabular-nums;color:var(--app-claude-orange,#d97757)}` +
    ".ccup-hist-item[data-cur] .ccup-hist-num{color:inherit;opacity:.75}" +
    ".ccup-hist-txt{flex:1 1 auto;min-width:0;height:2lh;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;white-space:normal;overflow-wrap:anywhere}" +
    ".ccup-hist-nl{margin:0 .3em;color:var(--app-secondary-foreground);opacity:.7;font-family:var(--app-monospace-font-family,monospace);font-size:.85em}" +
    // The number over the hide button in one column, the button one line
    // square on the second line, as the delete button is (font:inherit, or
    // the button's own UA font would size 1lh), shown with its entry's hover
    // or focus. It reaches 6px past the column into the 8px gap, so with the
    // row's 2px left padding it keeps the same 2px to the row's left edge and
    // to the text as to the row's bottom, while the number keeps the full gap.
    // Its icon is 1.25em of the list's text (about 16px at the default 13px),
    // so it grows with chat.fontSize as the square does.
    ".ccup-hist-lead{flex:none;display:flex;flex-direction:column}" +
    `.ccup-hist-hide{flex:none;align-self:flex-end;display:flex;align-items:center;justify-content:center;width:1lh;height:1lh;margin:0 -6px 0 0;padding:0;border:none;border-radius:5px;background:none;color:var(--app-secondary-foreground);font:inherit;cursor:pointer;visibility:hidden}` +
    ".ccup-hist-hide svg{display:block;width:1.25em;height:1.25em}" +
    `.ccup-hist-item${HOVER} .ccup-hist-hide,.ccup-hist-item:focus-visible .ccup-hist-hide{visibility:visible}` +
    `.ccup-hist-hide${HOVER}{color:var(--app-primary-foreground);background:var(--app-ghost-button-hover-background)}` +
    ".ccup-hist-item[data-cur] .ccup-hist-hide{color:inherit}" +
    // The last entry's delete button, one line square on the second line's
    // axis (the entry is two lines tall), its icon sized as the hide
    // button's, and the "sure?" chip an armed one shows over its own box.
    `.ccup-hist-del{flex:none;align-self:flex-end;position:relative;display:flex;align-items:center;justify-content:center;width:1lh;height:1lh;margin:0 ${PROMPT_HIST_DEL_INSET - 13}px 0 0;padding:0;border:none;border-radius:5px;background:none;color:var(--app-secondary-foreground);font:inherit;cursor:pointer;visibility:hidden}` +
    ".ccup-hist-del svg{display:block;width:1.25em;height:1.25em}" +
    `.ccup-hist-item${HOVER} .ccup-hist-del,.ccup-hist-item:focus-visible .ccup-hist-del,.ccup-hist-del[data-arm]{visibility:visible}` +
    `.ccup-hist-del${HOVER}{color:var(--app-primary-foreground);background:var(--app-ghost-button-hover-background)}` +
    ".ccup-hist-item[data-cur] .ccup-hist-del{color:inherit}" +
    ".ccup-hist-sure{display:none;position:absolute;top:0;right:0;height:1lh;padding:0 6px;border-radius:5px;background:var(--app-menu-background);box-shadow:0 0 0 1px var(--app-input-border);color:var(--vscode-errorForeground,#f14c4c);font-weight:700;white-space:nowrap}" +
    ".ccup-hist-del[data-arm] svg{visibility:hidden}" +
    ".ccup-hist-del[data-arm] .ccup-hist-sure{display:block}" +
    ".ccup-hist-row[data-going]{opacity:.5;pointer-events:none}" +
    // The fold standing in for a run of hidden entries: one slim muted row,
    // its chevron (about 12px at the default 13px) scaling with the text too.
    ".ccup-hist-fold{display:flex;align-items:center;gap:8px;padding:1px 8px 1px 2px;line-height:1.6;color:var(--app-secondary-foreground)}" +
    ".ccup-hist-fold .ccup-hist-num{color:inherit}" +
    ".ccup-hist-fold .ccup-hist-num svg{display:inline-block;width:.9em;height:.9em;vertical-align:-.08em}" +
    ".ccup-hist-fold-n,.ccup-hist-fold-r{font-size:.85em}" +
    ".ccup-hist-fold-r{color:var(--app-claude-orange,#d97757);font-variant-numeric:tabular-nums}" +
    `.ccup-hist-fold${HOVER}{background:var(--app-list-hover-background);color:var(--app-primary-foreground)}` +
    ".ccup-hist-fold[data-cur]{background:var(--app-list-active-background);color:var(--app-list-active-foreground)}" +
    ".ccup-hist-fold[data-cur] .ccup-hist-fold-r{color:inherit}" +
    btnHideCss(input, wrap, ".ccup-hist-btn") +
    btnHostCss(wrap, perm, preq) +
    HOVER_TIP_CSS;
  // Three bars in currentColor, stroked like the chevrons. Single-quoted
  // attributes embed in the double-quoted JS string below unescaped.
  const bars =
    "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round'><path d='M5 7h14'/><path d='M5 12h14'/><path d='M5 17h14'/></svg>";
  // An eye struck through for the hide button, and the fold's chevron.
  const eyeOff =
    "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M2 12Q12 2 22 12Q12 22 2 12Z'/><circle cx='12' cy='12' r='3'/><path d='M4 4l16 16'/></svg>";
  const chevron =
    "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M9 6l6 6-6 6'/></svg>";
  // The last entry's delete button wears the session list delete's trash.
  const trash = `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='${SDEL_TRASH_D}'/></svg>`;
  // A message block's text: the expandable's content, or a slash-command echo.
  const blockText = slash
    ? `c?c.textContent:a[i].classList.contains("slashCommandMessage_${sticky}")?a[i].textContent:""`
    : `c?c.textContent:""`;
  const js =
    `(function(){try{` +
    `if(window.__ccupPromptHist)return;window.__ccupPromptHist=1;` +
    `var st=document.createElement("style");st.textContent='${css}';document.head.appendChild(st);` +
    `var BARS="${bars}",EYE="${eyeOff}",CHEV="${chevron}",TRASH="${trash}",T="Prompt History",NL=String.fromCharCode(92)+"n",` +
    `SK="${PROMPT_HIST_STORE}",raf=0,gen=0,gl=0,P=null,on=0,pBox=null,pBtn=null,pFoc=null,pHs=[],pCur=-1,` +
    `pin=-1,pinTop=0,rowOf=[],keyOf=[],curEl=null;` +
    HOVER_TIP_JS +
    `function sc(){return document.querySelector(".messagesContainer_${chat}")}` +
    btnHostsJs(host, perm, preq, false) +
    `function hh(t){return t?[].slice.call(t.querySelectorAll(".stickyHeader_${sticky}")):[]}` +
    `function same(a,b){if(a.length!==b.length)return!1;for(var i=0;i<a.length;i++)if(a[i]!==b[i])return!1;return!0}` +
    // Offset within container t, summed up the offsetParent chain (see jumpMsg).
    `function ot(e,t){var y=0,n=e;while(n&&n!==t){y+=n.offsetTop;n=n.offsetParent}return y}` +
    // The jump buttons' glide: fixed 100ms ease-out to a clamped scrollTop,
    // which it returns, and gl names the glide in flight.
    `function go(to){var t=sc();if(!t)return;var top=Math.max(0,Math.min(to,t.scrollHeight-t.clientHeight));` +
    `if(matchMedia("(prefers-reduced-motion:reduce)").matches){t.scrollTop=top;return top}` +
    `var g=++gen,f=t.scrollTop,t0;gl=g;function stp(now){if(g!==gen)return;if(t0===void 0)t0=now;` +
    `var k=Math.min(1,(now-t0)/100),e=1-(1-k)*(1-k);t.scrollTop=f+(top-f)*e;if(k<1)requestAnimationFrame(stp);else if(gl===g)gl=0}` +
    `requestAnimationFrame(stp);return top}` +
    // A header's message text, its blocks joined by line breaks.
    `function txt(h){var a=h.querySelectorAll(".userMessage_${sticky}"),p=[],i,c,s;` +
    `for(i=0;i<a.length;i++){c=a[i].querySelector(".content_${box}");s=${blockText};` +
    `s=s.replace(/\\r/g,"").trim();if(s)p.push(s)}` +
    (heading
      ? `if(!p.length){c=h.querySelector(".screenReaderTurnHeading_${sticky}");` +
        `if(c)p.push(c.textContent.replace(/^You: /,""))}`
      : "") +
    `return p.join("\\n")}` +
    // Text runs as text nodes, and each run of breaks as one muted \n per break.
    `function fill(el,s){if(s.length>1000)s=s.slice(0,1000);var a=s.split(/(\\n+)/),i,m;` +
    `for(i=0;i<a.length;i++){if(!a[i])continue;` +
    `if(i%2){m=document.createElement("span");m.className="ccup-hist-nl";m.textContent=Array(a[i].length+1).join(NL);el.appendChild(m)}` +
    `else el.appendChild(document.createTextNode(a[i]))}}` +
    // Hidden marks, per conversation (the URL's session id), each entry named
    // by its position and a hash of its text. Storage failures are no-ops.
    `function sid(){try{return new URLSearchParams(location.search).get("session")||""}catch(e){return""}}` +
    `function hsh(s){for(var h=2166136261,i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return(h>>>0).toString(36)}` +
    `function store(){try{var o=JSON.parse(localStorage.getItem(SK)||"{}");return o&&typeof o==="object"&&!Array.isArray(o)?o:{}}catch(e){return{}}}` +
    `function hidden(){var e=store()[sid()];return new Set(e&&Array.isArray(e.k)?e.k:[])}` +
    `function keep(set){try{var o=store(),s=sid(),k=Array.from(set);if(k.length)o[s]={t:Date.now(),k:k};else delete o[s];` +
    `var ids=Object.keys(o);if(ids.length>${PROMPT_HIST_STORE_CAP}){ids.sort(function(a,b){return((o[b]&&o[b].t)||0)-((o[a]&&o[a].t)||0)});` +
    `for(var i=${PROMPT_HIST_STORE_CAP};i<ids.length;i++)delete o[ids[i]]}localStorage.setItem(SK,JSON.stringify(o))}catch(e){}}` +
    `function entry(i,s){var it=document.createElement("div"),ld=document.createElement("span"),` +
    `nu=document.createElement("span"),tx=document.createElement("span"),hb=document.createElement("button");` +
    `it.className="ccup-hist-row ccup-hist-item";it.setAttribute("role","option");it.setAttribute("data-i",i);it.tabIndex=-1;` +
    `ld.className="ccup-hist-lead";nu.className="ccup-hist-num";nu.textContent=i+1;tx.className="ccup-hist-txt";fill(tx,s);` +
    `hb.type="button";hb.className="ccup-hist-hide";hb.tabIndex=-1;hb.setAttribute("aria-label","Hide "+(i+1));hb.innerHTML=EYE;` +
    `ld.appendChild(nu);ld.appendChild(hb);it.appendChild(ld);it.appendChild(tx);return it}` +
    `function fold(a,b){var g=document.createElement("div"),c=document.createElement("span"),` +
    `l=document.createElement("span"),r=document.createElement("span");` +
    `g.className="ccup-hist-row ccup-hist-fold";g.setAttribute("role","option");g.setAttribute("data-a",a);g.setAttribute("data-b",b);g.tabIndex=-1;` +
    `c.className="ccup-hist-num";c.innerHTML=CHEV;l.className="ccup-hist-fold-n";l.textContent=(b-a+1)+" hidden";` +
    `r.className="ccup-hist-fold-r";r.textContent=a===b?String(a+1):(a+1)+"\\u2013"+(b+1);` +
    `g.setAttribute("aria-label","Show "+l.textContent+", "+r.textContent);` +
    `g.appendChild(c);g.appendChild(l);g.appendChild(r);return g}` +
    // The first header a row stands for.
    `function anchor(r){var a=r.getAttribute("data-i");return a!==null?+a:+r.getAttribute("data-a")}` +
    // Rows in transcript order, a run of hidden entries folded into one, and
    // rowOf mapping every header to its row. A focused row's header, the
    // highlight, and the list's scroll position all survive the rebuild.
    `function build(hs){var ae=document.activeElement,fi=ae&&ae.parentNode===P?anchor(ae):-1,st=P.scrollTop,` +
    `hid=hidden(),f=document.createDocumentFragment(),n=hs.length,tx=hs.map(txt),i,j,q,g;` +
    `pHs=hs;rowOf=[];keyOf=[];curEl=null;for(i=0;i<n;i++)keyOf[i]=i+":"+hsh(tx[i]);` +
    `for(i=0;i<n;i=j+1){j=i;if(hid.has(keyOf[i])){while(j+1<n&&hid.has(keyOf[j+1]))j++;g=fold(i,j)}else g=entry(i,tx[i]);` +
    `for(q=i;q<=j;q++)rowOf[q]=g;f.appendChild(g)}` +
    `if(n&&window.__ccupTurnRewind&&rowOf[n-1].hasAttribute("data-i"))rowOf[n-1].appendChild(dbtn(n-1));` +
    `P.textContent="";P.appendChild(f);P.scrollTop=st;P.style.setProperty("--ccup-hist-w",String(n).length+"ch");` +
    `if(pCur>=0)mark(pCur);if(fi>=0&&n)focRow(rowOf[Math.min(fi,n-1)])}` +
    // The current entry: a clicked one while the view stays where its glide
    // put it, the last at the bottom, else the last header at or above the
    // scroll top (the jump census, headers sitting in document order), else
    // the first.
    `function cur(t,hs){var c=t.scrollTop,n=hs.length,k=-1,i;` +
    `if(pin>=0&&pin<n){if(gl||Math.abs(c-pinTop)<=1)return pin;pin=-1}` +
    `if(n&&t.scrollHeight-c-t.clientHeight<=8)return n-1;` +
    `for(i=0;i<n;i++){if(ot(hs[i],t)>c+4)break;k=i}return k<0&&n?0:k}` +
    // The current header's row carries the highlight (a fold, when hidden).
    `function mark(k){pCur=k;var el=k>=0&&rowOf[k]||null;if(el===curEl)return;` +
    `if(curEl){curEl.removeAttribute("data-cur");curEl.removeAttribute("aria-current")}` +
    `if(el){el.setAttribute("data-cur","");el.setAttribute("aria-current","true")}curEl=el}` +
    // Two thirds of the viewport for list, gap, row and composer together.
    `function fit(){var r=pBox.getBoundingClientRect(),H=window.innerHeight||0,` +
    `m=Math.max(0,Math.min(r.top-${PROMPT_HIST_GAP + 8},Math.max(120,Math.floor(H*2/3-${PROMPT_HIST_GAP}-r.height))))+"px";` +
    `if(P.style.maxHeight!==m)P.style.maxHeight=m}` +
    `function focRow(r){if(!r)return;r.focus({preventScroll:!0});` +
    `var y=r.offsetTop,b=y+r.offsetHeight;if(y<P.scrollTop)P.scrollTop=y-4;else if(b>P.scrollTop+P.clientHeight)P.scrollTop=b-P.clientHeight+4}` +
    `function hide(i){var s=hidden();s.add(keyOf[i]);keep(s);build(pHs)}` +
    `function unhide(a,b){var s=hidden();for(var i=a;i<=b;i++)s.delete(keyOf[i]);keep(s);build(pHs)}` +
    // The last entry's delete button: a click arms it, a second deletes the
    // turn through the bridge, and leaving the button disarms it.
    `function dbtn(i){var b=document.createElement("button");b.type="button";b.className="ccup-hist-del";b.tabIndex=-1;` +
    `b.setAttribute("aria-label","Delete turn "+(i+1));b.innerHTML=TRASH+"<span class='ccup-hist-sure'>sure?</span>";` +
    `b.addEventListener("mouseleave",function(){disarm(b)});return b}` +
    `function disarm(b){if(b.hasAttribute("data-arm")){b.removeAttribute("data-arm");` +
    `b.setAttribute("aria-label",b.getAttribute("aria-label").replace(/^Confirm: d/,"D"))}}` +
    `function del(r,b){if(r.hasAttribute("data-going"))return;` +
    `if(!b.hasAttribute("data-arm")){b.setAttribute("data-arm","");` +
    `b.setAttribute("aria-label","Confirm: d"+b.getAttribute("aria-label").slice(1));return}` +
    `disarm(b);var i=+r.getAttribute("data-i"),h=pHs[i],u=h&&h.getAttribute("data-ccup-uuid"),api=window.__ccupTurnRewind;` +
    `if(!u||!api||i!==pHs.length-1)return;r.setAttribute("data-going","");` +
    `Promise.resolve().then(function(){return api.run(u)}).then(function(ok){if(ok)forget(i)},function(){})` +
    `.then(function(){r.removeAttribute("data-going")})}` +
    // Marks from a deleted position on: the next prompts take those positions.
    `function forget(i){var s=hidden(),c=0;s.forEach(function(k){if(parseInt(k,10)>=i){s.delete(k);c++}});if(c)keep(s)}` +
    // An entry jumps, a fold brings its run back.
    `function act(r){if(r.hasAttribute("data-i"))jumpTo(+r.getAttribute("data-i"));` +
    `else unhide(+r.getAttribute("data-a"),+r.getAttribute("data-b"))}` +
    // A header's natural position, its sticky shift neutralized for one read.
    `function jumpTo(i){var t=sc(),h=pHs[i];if(!t||!h||!h.isConnected)return;` +
    `h.style.position="static";var y=ot(h,t);h.style.position="";y=go(y);` +
    `if(y!==void 0){pin=i;pinTop=y;mark(i)}}` +
    // Keys move between rows, and the first arrow from the list itself lands
    // on the current row.
    `function keys(e){if(e.isComposing||e.metaKey||e.ctrlKey||e.altKey)return;` +
    `var k=e.key,rs=P.children,n=rs.length,ae=document.activeElement,r=ae&&ae.parentNode===P?[].indexOf.call(rs,ae):-1;` +
    `if(k==="Escape"||k==="Tab")close(1);` +
    `else if(k==="ArrowDown"||k==="ArrowUp")focRow(rs[r<0?Math.max(0,[].indexOf.call(rs,rowOf[Math.max(0,pCur)])):` +
    `Math.max(0,Math.min(n-1,r+(k==="ArrowDown"?1:-1)))]);` +
    `else if(k==="Home"||k==="End")focRow(rs[k==="Home"?0:n-1]);` +
    `else if(k==="Enter"||k===" "){if(r>=0)act(rs[r])}` +
    `else if(k==="Delete"||k==="Backspace"){if(r>=0&&rs[r].hasAttribute("data-i"))hide(+rs[r].getAttribute("data-i"))}` +
    `else return;e.preventDefault();e.stopPropagation()}` +
    `function stop(e){e.stopPropagation()}` +
    `function open(b){var t=sc(),hs=hh(t),box=b.parentNode;if(!t||!hs.length||!box)return;` +
    `if(!P){P=document.createElement("div");P.className="ccup-hist-pane";P.setAttribute("role","listbox");` +
    `P.setAttribute("aria-label",T);P.tabIndex=-1;` +
    `P.addEventListener("mousedown",function(e){e.preventDefault();e.stopPropagation()});` +
    `["pointerdown","pointerup","mouseup","dblclick"].forEach(function(n){P.addEventListener(n,stop)});` +
    `P.addEventListener("click",function(e){e.stopPropagation();var t=e.target;if(!t||!t.closest)return;` +
    `var r=t.closest(".ccup-hist-item,.ccup-hist-fold");if(!r||r.parentNode!==P)return;` +
    `var d=t.closest(".ccup-hist-del");if(d)del(r,d);` +
    `else if(t.closest(".ccup-hist-hide"))hide(+r.getAttribute("data-i"));else act(r)});` +
    `P.addEventListener("keydown",keys)}` +
    `pFoc=document.activeElement;pBox=box;pBtn=b;on=1;hideTip();box.appendChild(P);build(hs);fit();mark(cur(t,hs));` +
    `var it=rowOf[pCur];P.scrollTop=it?it.offsetTop-(P.clientHeight-it.offsetHeight)/2:P.scrollHeight;` +
    `b.setAttribute("aria-expanded","true");P.focus({preventScroll:!0})}` +
    // back: hand focus back to what held it at opening, if the list still has it.
    `function close(back){if(!on)return;on=0;var f=P.contains(document.activeElement);P.remove();` +
    `if(pBtn)pBtn.setAttribute("aria-expanded","false");` +
    `if(back&&f&&pFoc&&pFoc.isConnected&&pFoc.focus)try{pFoc.focus({preventScroll:!0})}catch(e){}` +
    `pBox=pBtn=pFoc=curEl=null;pHs=[];rowOf=[];keyOf=[];pCur=-1;pin=-1}` +
    `function mk(){var b=document.createElement("button");b.type="button";b.className="ccup-hist-btn";` +
    `b.setAttribute("aria-label",T);b.setAttribute("aria-haspopup","listbox");b.setAttribute("aria-expanded","false");b.innerHTML=BARS;` +
    `b.addEventListener("mouseenter",function(){if(tipT)clearTimeout(tipT);` +
    `tipT=setTimeout(function(){tipT=0;if(!(on&&pBtn===b))try{showTip(b,T)}catch(e){}},250)});` +
    `b.addEventListener("mouseleave",hideTip);` +
    `b.addEventListener("mousedown",function(e){e.preventDefault();e.stopPropagation();hideTip()});` +
    `b.addEventListener("click",function(e){e.stopPropagation();hideTip();if(on&&pBtn===b){close(1);return}` +
    `if(on)close(0);if(!b.hasAttribute("data-off"))open(b)});return b}` +
    // Toggle data-show/data-off only on an actual change (outside the observer filter).
    `function ss(el,show,off){var s=el.hasAttribute("data-show");if(show&&!s)el.setAttribute("data-show","");else if(!show&&s)el.removeAttribute("data-show");var o=el.hasAttribute("data-off");if(off&&!o)el.setAttribute("data-off","");else if(!off&&o)el.removeAttribute("data-off")}` +
    `function upd(){raf=0;var t=sc(),hs=hh(t),n=hs.length,boxes=hosts(),i,b;` +
    `for(i=0;i<boxes.length;i++){b=boxes[i].querySelector(".ccup-hist-btn");if(!b){b=mk();boxes[i].appendChild(b)}ss(b,!0,!n)}` +
    `if(!on)return;` +
    `if(!n||!P.isConnected||!pBox.isConnected||!pBox.getClientRects().length||!pBtn.isConnected){close(0);return}` +
    `if(!same(hs,pHs)){pin=-1;build(hs)}fit();mark(cur(t,hs))}` +
    `function que(){if(!raf)raf=requestAnimationFrame(upd)}` +
    `document.addEventListener("scroll",que,!0);window.addEventListener("resize",que);` +
    // Outside the list and the button row: close, and let the press go on.
    `document.addEventListener("pointerdown",function(e){if(!on)return;var el=e.target;` +
    `if(el&&el.nodeType===1&&(P.contains(el)||el.closest(".ccup-hist-btn,.ccup-nav-btn,.ccup-scroll-btn")))return;close(0)},!0);` +
    // Drop records from inside the list and from sticky measurements.
    `new MutationObserver(function(rs){for(var i=0;i<rs.length;i++){var r=rs[i],tg=r.target;` +
    `if(P&&(tg===P||P.contains(tg)))continue;` +
    `if(r.type==="attributes"&&r.attributeName==="style"&&tg.classList&&tg.classList.contains("stickyHeader_${sticky}"))continue;` +
    `que();return}})` +
    `.observe(document.body,{childList:!0,subtree:!0,characterData:!0,attributes:!0,attributeFilter:["class","style"]});` +
    `que()` +
    `}catch(e){}})();`;
  return `${PROMPT_HIST_MARKER}${js}`;
}

function promptHistPresent(c: string): boolean {
  return c.includes(PROMPT_HIST_MARKER) || promptHistBuild(c) !== undefined;
}
// true = ON (marked line present and matching this build, or present but
// unrebuildable so an orphaned line stays removable), false = OFF or stale,
// undefined = anchors gone and nothing to remove.
function promptHistCurrentOn(c: string): boolean | undefined {
  const cur = cssMarkedLine(c, PROMPT_HIST_MARKER);
  const want = promptHistBuild(c);
  if (cur !== undefined) return want === undefined || cur === want;
  return want === undefined ? undefined : false;
}
function promptHistSet(c: string, on: boolean): string {
  if (on && promptHistCurrentOn(c) === true) return c; // stable: no EOF reshuffle
  const stripped = c.replace(PROMPT_HIST_LINE_RE, "");
  if (!on) return stripped;
  const line = promptHistBuild(stripped);
  if (line === undefined) return c; // anchors gone: leave the file as it is
  return `${stripped}\n${line}`;
}

// The webview bundle with the prompt history line in and the scroll-to-bottom
// and jump lines set as asked (the history button's slot follows them), or
// null when an anchor is gone. scripts/repro's prompt-history.mjs serves this,
// so it runs exactly what an apply writes and doubles as the drift canary.
export function promptHistWebview(
  js: string,
  dot: boolean,
  jump: boolean,
): string | null {
  const out = promptHistSet(jumpMsgSet(scrollDotSet(js, dot), jump), true);
  return promptHistCurrentOn(out) === true ? out : null;
}

// ---------------------------------------------------------------------------
// In-chat find bar (ON): a working Cmd/Ctrl+F for the chat webview. The native
// webview find widget (the chat editor tab sets enableFindWidget) can only
// HIGHLIGHT: typing starts a fresh Chromium find-in-page session each
// keystroke, but the navigation calls (Enter / Shift+Enter / the widget's
// arrows, all funneling into one findInFrame "continue session" request)
// restart instead of advancing, so "next" re-lands on the first match and
// "previous" lands on the last and sticks (upstream: claude-code#72005 and
// #37182 report exactly this; electron#34490/#45875 document the follow-up
// findInPage class, closed unfixed). That machinery lives in VS Code core and
// the browser process, with no extension-reachable surface, so instead of
// repairing it we intercept the find chord INSIDE the chat document (a
// capture-phase keydown on the content window fires before VS Code's
// bubble-phase key forwarder, so stopImmediatePropagation keeps the native
// widget from ever opening) and run find in the page, where navigation is just
// state we own. The sidebar chat view, which has no native find at all
// (vscode#173643, open), gets the same bar for free: both surfaces load this
// bundle.
//
// The engine (ccupFindBarWebview, injected via toString like the math helper):
//   bar     a fixed widget (the input with the search options inside it, a
//           "k of n" counter, prev/next/close buttons) styled from the
//           editorWidget/input theme variables, so it reads native in either
//           theme, and created lazily on first open. It sits over the right
//           end of the chat header, centered on the header's button row and
//           overhanging the row's end by as much as above and below, so the
//           New session button there stays wholly behind it. Where no header
//           shows (the editor tab hides it), it keeps the top-right corner
//   options Match Case, Match Whole Word, and Use Regular Expression, toggles
//           inside the input as in the editor's find widget: its codicon
//           glyphs (read out of the font the bundle ships, see
//           codiconGlyphSvgs), a hover tip each, and no chords. A flip
//           searches again from the active match, and the state persists in
//           the webview's localStorage, as the editor keeps its own per
//           workspace. Whole word is the editor's rule: each end of a match
//           meets the haystack's edge, a non-word neighbor, or a non-word
//           character of the match itself, word characters being Unicode
//           letters, marks, digits, and connector punctuation. A regular
//           expression runs with the u flag, one haystack line at a time
//           unless the pattern names a line break itself (\n, \r, or \W, the
//           editor's test), and skips empty matches, which paint nothing. An
//           invalid one finds nothing and shows its error under the input
//   scan    a TreeWalker over the transcript container (.messagesContainer_
//           <hash>, baked at patch time like the scroll-dot button) collects
//           visible text nodes into one haystack with per-node offsets;
//           consecutive nodes under one nearest non-inline ancestor
//           concatenate seamlessly, so a match may span inline markup
//           (bold/code/links), while block boundaries insert "\n", which a
//           single-line query can never match across; hidden text is skipped
//           via checkVisibility (collapsed "Show more" content stays
//           unsearchable, matching native find's visible-only semantics).
//           Rendered math reads as its TeX, the way the raw markdown does:
//           each formula is one unit, fenced by "\n" so no match crosses its
//           edge, holding its TeX body in either native render state (KaTeX
//           keeps it only in a hidden annotation, and a response far from
//           view shows the raw source instead), so the match count does not
//           change as responses typeset and revert while scrolling. The
//           haystack is cached until the transcript changes, so typing a
//           query costs one pass over a string per keystroke, and a match is
//           kept as haystack positions rather than a live Range
//   paint   two CSS Custom Highlights (the matches near the view, and the
//           active one at higher priority), colored by the editor findMatch
//           theme tokens in the appended CSS line; no DOM mutation, so React
//           re-renders never fight the highlights. Only the matches within a
//           margin of the view are registered, re-measured as the view
//           scrolls: Blink rebuilds every highlight marker on each frame
//           with a DOM or style change, so registering all of a frequent
//           word's matches slowed every frame while the bar was open. A
//           match in a formula selects the whole formula element, whose
//           boundary points sit in its parent and so outlive the renderer
//           swapping raw source for KaTeX inside it
//   nav     next/previous wrap around, move the active highlight, and scroll
//           the active match into the band between the pinned sticky header
//           (whose height varies with the pinned message) and the composer
//           box, with a bounded re-measure pass because sticky pinning and
//           Monaco's virtualization re-layout mid-scroll
//   blocks  a second button pair skips between the BLOCKS that hold matches,
//           because a match can be legible only after manual action the bar
//           deliberately never takes (no auto-expand, no focus steal): inside
//           a folded IN/OUT row or an unexpanded diff card the orange
//           highlight is clipped or tiny. A match's block is its nearest
//           ancestor among the baked block classes (diff card containers,
//           IN/OUT row, tool card body, the tool card wrapper, one markdown
//           chunk of an agent response, a user message, a turn's sticky
//           header), falling back to the transcript row; previous lands on a
//           block's first match. A
//           fixed ruler bar (the active-match highlight color, pinned to the
//           user-message column's left gutter, tracked on scroll/resize/
//           mutation) marks the block of the active match, so the eye finds
//           the right block even when the highlight itself is not visible in
//           place; it spans only the block's visible slice of the scrollport,
//           clamped under the pinned sticky header rather than painting over
//           it while the block scrolls beneath
//   rescan  a body MutationObserver (debounced, observing only while the bar
//           is open) recomputes matches when the chat re-renders or streams,
//           without scrolling. Records outside the transcript are dropped
//           (the bar's own counter writes, the composer), attribute changes
//           inside it only mark the cached haystack stale, and the active
//           match re-anchors via its LIVE Range, whose boundaries track
//           surrounding mutations, so content mounting above (sticky pinning,
//           Monaco's virtualized diff lines during scroll) cannot walk the
//           active match forward; the haystack offset is only the fallback
//           for a re-rendered active node
//
// Keys are resolved on the HOST at patch time and baked into a small cfg line
// (window.__ccupFindCfg) separate from the engine block, so a keybinding edit
// re-bakes one line: the open chord follows editor.action.webvieweditor
// .showFind (default Cmd/Ctrl+F), and next/previous follow the user's
// editor.action.nextMatchFindAction / previousMatchFindAction, i.e. the
// platform defaults (Enter / Shift+Enter, F3 / Shift+F3, plus Cmd+G /
// Cmd+Shift+G on macOS) minus their `-command` removals in keybindings.json
// plus their own bindings there. The keybindings.json path is derived from
// globalStorageUri at activation (initFindKeys), so VS Code forks and portable
// installs resolve without a per-product path table; an fs watcher re-applies
// on edits. when-clauses are ignored deliberately (the bar emulates the
// user's keystroke preference, not the native contexts), only single chords
// are honored (a "cmd+k cmd+g" sequence cannot be captured in one keydown),
// and Escape-to-close is fixed. Chord matching compares KeyboardEvent.key
// case-insensitively with exact modifier equality, so e.g. plain Enter and
// Shift+Enter never shadow each other.
//
// Current-state checks are per marker (the cfg line by line equality, the
// engine block by block equality), never whole-file, so other EOF-appended
// toggle lines can sit in any order around ours; set() strips both pieces and
// re-appends cfg-then-engine, keeping the cfg assignment ahead of the engine
// that reads it. Everything injected is try/catch-wrapped and guarded on the
// Highlight API so it can never break the chat.
// ---------------------------------------------------------------------------
const FINDBAR_CFG_MARKER = "/*ccup:findBarCfg*/";
const FINDBAR_CFG_LINE_RE = /\n?\/\*ccup:findBarCfg\*\/[^\n]*/g;
const FINDBAR_START = "/*ccup:findBarStart*/";
const FINDBAR_BLOCK_RE =
  /\n?\/\*ccup:findBarStart\*\/[\s\S]*?\/\*ccup:findBarEnd\*\//g;
const FINDBAR_CSS_MARKER = "/*ccup:findBarCss*/";
const FINDBAR_CHAT_HASH_RE = /messagesContainer:"messagesContainer_([-\w]+)"/;
const FINDBAR_INPUT_HASH_RE = /messageInput:"messageInput_([-\w]+)"/;
const FINDBAR_CSS_ANCHOR_RE = /\.messagesContainer_[-\w]+/;
// Set by native math's formula component alone (its scroll helpers only read
// it), on a span it keeps while swapping raw source and KaTeX inside.
const FINDBAR_MATH_ATTR = "data-redrawn";
// The option toggles' codicons, by toggle: case-sensitive, whole-word, regex.
const FINDBAR_GLYPHS: [string, number][] = [
  ["c", 0xeab1],
  ["w", 0xeb7e],
  ["r", 0xeb38],
];

// The option toggles' glyphs as SVG documents, read out of the codicon font
// that Monaco's stylesheet declares in the bundle's index.css, or null when
// the face, a table, or a glyph is missing, or a glyph is composite. The face
// is a data: URI, which the webview never loads, since its content security
// policy allows fonts from the webview's own source alone, while data: images
// are allowed. So each glyph's outline becomes an SVG path in the font's em
// box (y flipped, the baseline where the font puts it, as its own rendering
// would place the glyph), which the stylesheet paints as a mask. The patch
// ships no glyphs of its own: each is derived from Claude Code's font on the
// user's machine.
function codiconGlyphSvgs(css: string): string[] | null {
  let b64 = "";
  for (const m of css.matchAll(/@font-face\{([^}]*)\}/g)) {
    if (!/font-family:\s*["']?codicon["']?\s*(?:;|$)/.test(m[1])) continue;
    b64 =
      /url\(\s*["']?data:[^;,)]*;base64,([A-Za-z0-9+/=]+)/.exec(m[1])?.[1] ??
      "";
    break;
  }
  if (!b64) return null;
  try {
    const f = Buffer.from(b64, "base64");
    const u16 = (o: number): number => f.readUInt16BE(o);
    const i16 = (o: number): number => f.readInt16BE(o);
    const u32 = (o: number): number => f.readUInt32BE(o);
    const tab: Record<string, number> = {};
    for (let i = 0, n = u16(4); i < n; i++) {
      tab[f.toString("latin1", 12 + 16 * i, 16 + 16 * i)] = u32(20 + 16 * i);
    }
    const need = ["head", "hhea", "hmtx", "maxp", "cmap", "loca", "glyf"];
    if (need.some((t) => tab[t] === undefined)) return null;
    const longLoca = i16(tab.head + 50) === 1;
    const asc = i16(tab.hhea + 4);
    const desc = i16(tab.hhea + 6);
    const nhm = u16(tab.hhea + 34);
    const nglyphs = u16(tab.maxp + 4);
    // The first format 4 subtable maps the BMP, the codicons' private use
    // area included.
    let cm = -1;
    for (let i = 0, n = u16(tab.cmap + 2); i < n && cm < 0; i++) {
      const st = tab.cmap + u32(tab.cmap + 8 + 8 * i);
      if (u16(st) === 4) cm = st;
    }
    if (cm < 0) return null;
    const segs = u16(cm + 6) / 2;
    const glyphOf = (c: number): number => {
      for (let s = 0; s < segs; s++) {
        if (c > u16(cm + 14 + 2 * s)) continue;
        const start = u16(cm + 16 + 2 * segs + 2 * s);
        if (c < start) return 0;
        const delta = i16(cm + 16 + 4 * segs + 2 * s);
        const ro = cm + 16 + 6 * segs + 2 * s;
        if (!u16(ro)) return (c + delta) & 0xffff;
        const g = u16(ro + u16(ro) + 2 * (c - start));
        return g ? (g + delta) & 0xffff : 0;
      }
      return 0;
    };
    const loca = (g: number): number =>
      longLoca ? u32(tab.loca + 4 * g) : 2 * u16(tab.loca + 2 * g);
    const num = (v: number): string => String(Math.round(v * 10) / 10);
    const out: string[] = [];
    for (const [, cp] of FINDBAR_GLYPHS) {
      const g = glyphOf(cp);
      if (!g || g >= nglyphs || loca(g + 1) <= loca(g)) return null;
      let p = tab.glyf + loca(g);
      const nc = i16(p);
      if (nc <= 0) return null;
      const ends: number[] = [];
      for (let i = 0; i < nc; i++) ends.push(u16(p + 10 + 2 * i));
      const np = ends[nc - 1] + 1;
      p += 10 + 2 * nc;
      p += 2 + u16(p); // the hinting instructions
      const flags: number[] = [];
      while (flags.length < np) {
        const fl = f[p++];
        flags.push(fl);
        if (fl & 8) for (let r = f[p++]; r > 0; r--) flags.push(fl);
      }
      // x then y, each a byte (its sign in the flag) or a word, or repeated.
      const coords = (short: number, same: number): number[] => {
        const v: number[] = [];
        let c = 0;
        for (const fl of flags) {
          if (fl & short) c += fl & same ? f[p++] : -f[p++];
          else if (!(fl & same)) {
            c += i16(p);
            p += 2;
          }
          v.push(c);
        }
        return v;
      };
      const xs = coords(2, 16);
      const ys = coords(4, 32);
      if (p > f.length) return null; // byte reads past the end give undefined
      // Each contour from an on-curve point, an implied one between two
      // off-curve points, a virtual start for a contour with none.
      let d = "";
      for (let ci = 0, s = 0; ci < nc; s = ends[ci] + 1, ci++) {
        const pt: number[][] = [];
        for (let k = s; k <= ends[ci]; k++) {
          pt.push([xs[k], asc - ys[k], flags[k] & 1]);
        }
        const on = pt.findIndex((q) => q[2]);
        const seq =
          on < 0
            ? (() => {
                const a = pt[pt.length - 1];
                const m = [(a[0] + pt[0][0]) / 2, (a[1] + pt[0][1]) / 2, 1];
                return [m, ...pt, m];
              })()
            : [...pt.slice(on), ...pt.slice(0, on), pt[on]];
        const at = (q: number[]): string => num(q[0]) + " " + num(q[1]);
        d += "M" + at(seq[0]);
        let ctl: number[] | null = null;
        for (let i = 1; i < seq.length; i++) {
          const q = seq[i];
          if (q[2]) {
            d += ctl ? "Q" + at(ctl) + " " + at(q) : "L" + at(q);
            ctl = null;
          } else {
            if (ctl) {
              const m = [(ctl[0] + q[0]) / 2, (ctl[1] + q[1]) / 2];
              d += "Q" + at(ctl) + " " + at(m);
            }
            ctl = q;
          }
        }
        d += "Z";
      }
      const adv = u16(tab.hmtx + 4 * Math.min(g, nhm - 1));
      out.push(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${adv} ${asc - desc}"><path d="${d}"/></svg>`,
      );
    }
    return out;
  } catch {
    return null; // a read past the end of a truncated or malformed font
  }
}

interface FindChord {
  k: string; // KeyboardEvent.key, lowercased
  m: number; // metaKey (1/0)
  c: number; // ctrlKey
  s: number; // shiftKey
  a: number; // altKey
}
interface FindKeys {
  open: FindChord[];
  next: FindChord[];
  prev: FindChord[];
  bnext: FindChord[]; // next match block
  bprev: FindChord[]; // previous match block
}

// User keybindings.json location, supplied at activation (extension.ts derives
// it from globalStorageUri: <userData>/User/globalStorage/<id> -> two levels up
// is the User dir on every product and in portable mode). undefined => the
// platform defaults apply unmodified.
let findKeysFile: string | undefined;
export function initFindKeys(keybindingsJsonPath: string): void {
  findKeysFile = keybindingsJsonPath;
}
export function findKeysPath(): string | undefined {
  return findKeysFile;
}

// One chord spec ("shift+cmd+g") -> a FindChord, or undefined for anything the
// bar cannot capture (multi-chord sequences, empty keys). Keybinding key names
// and KeyboardEvent.key coincide for letters, digits, f-keys, and punctuation
// once lowercased; the named keys are mapped explicitly. (Two accepted
// approximations: keybindings are US-layout keyCode based while e.key is
// layout-aware, and shift+digit produces the shifted symbol in e.key.)
function parseChord(spec: string): FindChord | undefined {
  const s = spec.trim().toLowerCase();
  if (!s || /\s/.test(s)) return undefined;
  const named: Record<string, string> = {
    escape: "escape",
    enter: "enter",
    tab: "tab",
    space: " ",
    up: "arrowup",
    down: "arrowdown",
    left: "arrowleft",
    right: "arrowright",
    pageup: "pageup",
    pagedown: "pagedown",
    home: "home",
    end: "end",
    backspace: "backspace",
    delete: "delete",
  };
  let m = 0;
  let c = 0;
  let sh = 0;
  let a = 0;
  let key = "";
  const parts = s.split("+");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "cmd" || part === "meta" || part === "win") m = 1;
    else if (part === "ctrl") c = 1;
    else if (part === "shift") sh = 1;
    else if (part === "alt" || part === "opt" || part === "option") a = 1;
    else if (i === parts.length - 1 && part) key = part;
    else return undefined; // a misspelled modifier must not silently become the key
  }
  if (!key) return undefined;
  return { k: named[key] ?? key, m, c, s: sh, a };
}

// The stock bindings: open mirrors editor.action.webvieweditor.showFind
// (Cmd/Ctrl+F), next/previous mirror the editor find actions (Enter and F3,
// shifted for previous, plus Cmd+G / Cmd+Shift+G on macOS), and block skip
// defaults to Cmd/Ctrl+Enter with the shifted variant for previous (the
// modifier reads as "coarser jump", and inside the bar the chord is free).
function defaultFindKeys(): FindKeys {
  const mac = process.platform === "darwin";
  const mod = (k: string): FindChord =>
    mac ? { k, m: 1, c: 0, s: 0, a: 0 } : { k, m: 0, c: 1, s: 0, a: 0 };
  const plain = (k: string, s: number): FindChord => ({
    k,
    m: 0,
    c: 0,
    s,
    a: 0,
  });
  const next = [plain("enter", 0), plain("f3", 0)];
  const prev = [plain("enter", 1), plain("f3", 1)];
  if (mac) {
    next.push(mod("g"));
    prev.push({ ...mod("g"), s: 1 });
  }
  return {
    open: [mod("f")],
    next,
    prev,
    bnext: [mod("enter")],
    bprev: [{ ...mod("enter"), s: 1 }],
  };
}

// Strip // and /* */ comments and trailing commas from a JSONC source, string
// contents (escapes included) preserved; the caller falls back to defaults on
// any parse failure.
function stripJsonc(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let inStr = false;
  let esc = false;
  while (i < n) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const FINDBAR_COMMANDS: Record<string, keyof FindKeys> = {
  "editor.action.webvieweditor.showFind": "open",
  "editor.action.nextMatchFindAction": "next",
  "editor.action.previousMatchFindAction": "prev",
};

function chordEq(a: FindChord, b: FindChord): boolean {
  return (
    a.k === b.k && a.m === b.m && a.c === b.c && a.s === b.s && a.a === b.a
  );
}

// Comma-separated chord specs from a claudeCodeUiPatch setting ("f6, cmd+j"),
// parsed with the same rules as keybindings.json entries. The four
// chatFindBar*Keys settings make every navigation button bindable: the match
// pair ADDS to the resolved Find Next / Find Previous chords, the block pair
// ADDS to the Cmd/Ctrl+Enter (shifted for previous) block-skip defaults.
// One warning per new setting value: readFindChordSetting runs several times
// per apply (currentOn, set, analyze), and repeated toasts would spam.
const warnedChordSpecs: Record<string, string> = {};

function readFindChordSetting(key: string): FindChord[] {
  const raw = vscode.workspace.getConfiguration(CONFIG_NS).get<string>(key, "");
  const out: FindChord[] = [];
  if (typeof raw !== "string" || !raw.trim()) return out;
  const bad: string[] = [];
  for (const part of raw.split(",")) {
    if (!part.trim()) continue; // tolerate a trailing comma
    const ch = parseChord(part);
    if (!ch) {
      bad.push(part.trim());
      continue;
    }
    if (!out.some((x) => chordEq(x, ch)) && out.length < 8) out.push(ch);
  }
  if (bad.length && warnedChordSpecs[key] !== raw) {
    warnedChordSpecs[key] = raw;
    void vscode.window.showWarningMessage(
      `Claude Code UI Patch: ${key} skipped invalid chord(s): ${bad.join(", ")}`,
    );
  }
  return out;
}

function mergeChords(base: FindChord[], extra: FindChord[]): FindChord[] {
  for (const ch of extra) {
    if (!base.some((x) => chordEq(x, ch)) && base.length < 8) base.push(ch);
  }
  return base;
}

// The effective chords: platform defaults, minus the user's `-command`
// removals, plus their own bindings for the three commands (see the block
// comment above for the deliberate limits). Each list is capped defensively.
function readFindKeys(): FindKeys {
  const keys = defaultFindKeys();
  if (!findKeysFile) return keys;
  let rules: unknown;
  try {
    rules = JSON.parse(stripJsonc(fs.readFileSync(findKeysFile, "utf8")));
  } catch {
    return keys;
  }
  if (!Array.isArray(rules)) return keys;
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    const cmd = (r as Record<string, unknown>).command;
    const keySpec = (r as Record<string, unknown>).key;
    if (typeof cmd !== "string" || typeof keySpec !== "string") continue;
    const neg = cmd.startsWith("-");
    const slot = FINDBAR_COMMANDS[neg ? cmd.slice(1) : cmd];
    if (!slot) continue;
    const ch = parseChord(keySpec);
    if (!ch) continue;
    if (neg) keys[slot] = keys[slot].filter((x) => !chordEq(x, ch));
    else if (!keys[slot].some((x) => chordEq(x, ch)) && keys[slot].length < 8) {
      keys[slot].push(ch);
    }
  }
  return keys;
}

// Runs inside the chat webview, injected verbatim via toString(): the same
// constraints as ccupMathHelperWebview (fully self-contained, DOM reached
// through the any-typed globalThis since the project compiles without the DOM
// lib, and never the literal end-of-block marker in the body). Reads the cfg
// assignment the set() step appends ahead of this block.
function ccupFindBarWebview(): void {
  const g = globalThis as Record<string, any>;
  try {
    if (g.__ccupFindBar) return;
    const cfg = g.__ccupFindCfg;
    const doc = g.document;
    if (
      !cfg ||
      !doc ||
      !g.CSS ||
      !g.CSS.highlights ||
      typeof g.Highlight !== "function"
    ) {
      return;
    }
    g.__ccupFindBar = 1;

    // Match cap: bounds the match list and block skipping, so a degenerate
    // query (one letter over a huge transcript) cannot freeze the webview.
    // Real word searches stay far below it; beyond it the counter reads
    // "20000+" and navigation wraps within the found matches.
    const MAXM = 20000;
    const TOP = 48; // px kept clear under the fixed bar when revealing
    // Painted matches: those within WINM viewport heights of the view, at
    // most WINMAX of them (see hlSync).
    const WINM = 1.5;
    const WINMAX = 1000;
    const INLINE: Record<string, number> = {
      A: 1,
      ABBR: 1,
      B: 1,
      BDI: 1,
      BDO: 1,
      CITE: 1,
      CODE: 1,
      DATA: 1,
      DEL: 1,
      DFN: 1,
      EM: 1,
      FONT: 1,
      I: 1,
      INS: 1,
      KBD: 1,
      LABEL: 1,
      MARK: 1,
      Q: 1,
      S: 1,
      SAMP: 1,
      SMALL: 1,
      SPAN: 1,
      STRONG: 1,
      SUB: 1,
      SUP: 1,
      TIME: 1,
      U: 1,
      VAR: 1,
      WBR: 1,
    };

    let bar: any = null;
    let field: any = null; // the input box, the input and the option toggles
    let input: any = null;
    let optBs: any[] = [];
    let msg: any = null; // an invalid expression's error, under the input
    let count: any = null;
    let countText: any = null;
    let countSize: any = null;
    let tip: any = null;
    let tipT: any = 0;
    let prevB: any = null;
    let nextB: any = null;
    let blockPrevB: any = null;
    let blockNextB: any = null;
    let ruler: any = null;
    // A match is four numbers in mm (start node index into snap.nodes,
    // start offset, end node index, end offset), never a live Range apiece:
    // every DOM mutation updates each live Range until it is collected, and
    // building thousands per keystroke weighed on the scan. Ranges exist
    // only for the active match, the painted window, and rect reads.
    let snap: any = null; // cached haystack: nodes, offsets, text, folded text
    let dirty = true; // the transcript changed since snap was collected
    let err = ""; // the query's error as a regular expression, if invalid
    let mm: number[] = [];
    let nm = 0; // match count
    let starts: number[] = []; // haystack offset per match, for rescan continuity
    let blkMemo = new Map(); // match index -> block element, reset per scan
    let active = -1;
    let activeR: any = null; // live Range of the active match
    let probe: any = null; // one reusable Range for rect reads
    let gen = 0; // scan count, so the painted window knows a rescan replaced it
    let hlDirty = false;
    let winKey = ""; // what the registered window holds
    let winAct: any = null;
    let winSc: any = null;
    let winPos = 0; // scroll position the window was measured at
    let winVh = 0;
    let winM = 0;
    let obs: any = null;
    let lastFocus: any = null;
    let scanT: any = 0;
    let mutT: any = 0;
    let rraf: any = 0;
    // The search options, match case (c), whole word (w) and regular
    // expression (r), kept in the webview's localStorage across reloads.
    const OPT_KEY = "ccup-find-options";
    const opts: Record<string, number> = { c: 0, w: 0, r: 0 };
    try {
      const o = JSON.parse(g.localStorage.getItem(OPT_KEY) || "{}");
      for (const k in opts) if (o && o[k]) opts[k] = 1;
    } catch {
      // no storage: every option starts off
    }
    const BLOCKS: string[] = cfg.blocks || [];
    // Ruler column reference: the user-message (or turn-header) left edge.
    let refEl: any = null;
    let umClass = "";
    let shClass = "";
    for (let i = 0; i < BLOCKS.length; i++) {
      if (!umClass && BLOCKS[i].indexOf("userMessage_") === 0)
        umClass = BLOCKS[i];
      if (!shClass && BLOCKS[i].indexOf("stickyHeader_") === 0)
        shClass = BLOCKS[i];
    }

    const container = (): any =>
      doc.querySelector(".messagesContainer_" + cfg.chat);

    // Nearest non-inline ancestor (cached): the unit whose change marks a
    // block boundary in the haystack.
    const blockCache = new WeakMap();
    const blockOf = (el: any): any => {
      const hit = blockCache.get(el);
      if (hit) return hit;
      let e = el;
      while (e && e.nodeType === 1 && INLINE[e.tagName]) e = e.parentElement;
      const b = e || el;
      blockCache.set(el, b);
      return b;
    };

    // Math units: native math (2.1.301+) renders each formula in a wrapper
    // span carrying the baked attribute and keeps that element while it
    // swaps the contents between raw source (a response more than a
    // scroller height from view) and KaTeX; the patch's own chatMath wraps
    // in span.ccup-math, and a bare .katex is the fallback. The rendered
    // glyphs are never searched: they read in layout order (a fraction
    // denominator-first), and KaTeX's clipped MathML copy would match too.
    const MATH = cfg.math || "";
    const MATH_SEL = (MATH ? "[" + MATH + "]," : "") + ".ccup-math,.katex";
    const isMath = (el: any): boolean =>
      (!!MATH && el.hasAttribute(MATH)) ||
      el.classList.contains("ccup-math") ||
      el.classList.contains("katex");
    const DELIM =
      /^(?:\$\$([\s\S]*)\$\$|\$([\s\S]*)\$|\\\(([\s\S]*)\\\)|\\\[([\s\S]*)\\\])$/;
    // A unit's TeX body: KaTeX's annotation once typeset, else the raw
    // source the wrapper shows, minus its delimiters (the two agree).
    const texOf = (el: any): string => {
      const an = el.querySelector('annotation[encoding="application/x-tex"]');
      if (an) return String(an.textContent || "").trim();
      if (el.classList.contains("katex") || el.querySelector(".katex"))
        return ""; // typeset with no annotation: no source to search
      const raw = String(el.textContent || "").trim();
      const m = DELIM.exec(raw);
      return m ? (m[1] || m[2] || m[3] || m[4] || "").trim() : raw;
    };

    // Visible text nodes of the transcript, concatenated with per-node
    // offsets; "\n" separates blocks (a single-line query can't cross it).
    // A formula enters as its unit element and TeX, fenced by "\n" on both
    // sides, and the walk skips what renders inside it.
    const collect = (): any => {
      const nodes: any[] = [];
      const offs: number[] = [];
      let hay = "";
      const root = container();
      if (!root) return { nodes, offs, hay };
      const vis = new Map();
      const visible = (el: any): boolean => {
        let v = vis.get(el);
        if (v === undefined) {
          const t = el.tagName;
          v = t !== "SCRIPT" && t !== "STYLE" && t !== "NOSCRIPT";
          if (v && el.checkVisibility) {
            try {
              v = el.checkVisibility();
            } catch {
              v = true;
            }
          }
          vis.set(el, v);
        }
        return v;
      };
      // Elements are walked only when the transcript holds math, so a
      // math-free scan stays a text-only walk.
      const math = !!root.querySelector(MATH_SEL);
      const walker = doc.createTreeWalker(root, math ? 5 : 4); // ELEMENT|TEXT, TEXT
      // The node after the current one's subtree, moving the walker there.
      const past = (): any => {
        let n = walker.currentNode;
        while (n && n !== root) {
          const s = walker.nextSibling();
          if (s) return s;
          n = walker.parentNode();
        }
        return null;
      };
      let prevBlock: any = null;
      let nd = walker.nextNode();
      while (nd) {
        if (nd.nodeType === 1) {
          if (!isMath(nd)) {
            nd = walker.nextNode();
            continue;
          }
          const tex = visible(nd) ? texOf(nd) : "";
          if (tex) {
            if (nodes.length) hay += "\n";
            prevBlock = nd; // no text node's block, so "\n" follows it too
            offs.push(hay.length);
            nodes.push(nd);
            hay += tex;
          }
          nd = past();
          continue;
        }
        const p = nd.parentElement;
        const t = nd.nodeValue;
        if (p && t && visible(p)) {
          const b = blockOf(p);
          if (nodes.length && b !== prevBlock) hay += "\n";
          prevBlock = b;
          offs.push(hay.length);
          nodes.push(nd);
          hay += t;
        }
        nd = walker.nextNode();
      }
      return { nodes, offs, hay };
    };

    // Lowercased without a change in length, which the node offsets rely
    // on: U+0130 alone lowercases to two code units, so it folds to i first.
    const DOTTED_I = String.fromCharCode(0x130);
    const fold = (s: string): string =>
      (s.indexOf(DOTTED_I) < 0 ? s : s.split(DOTTED_I).join("i")).toLowerCase();
    // Whole word, the editor's rule: each end of a match meets the
    // haystack's edge, a non-word neighbor, or a non-word character of the
    // match itself. The sticky lookarounds read the character ending or
    // starting at an index, surrogate pairs included.
    const WEND = /(?<=[\p{L}\p{M}\p{N}\p{Pc}])/uy;
    const WSTART = /(?=[\p{L}\p{M}\p{N}\p{Pc}])/uy;
    const wAt = (re: RegExp, s: string, i: number): boolean => {
      re.lastIndex = i;
      return re.test(s);
    };
    const whole = (s: string, i: number, e: number): boolean =>
      (!wAt(WEND, s, i) || !wAt(WSTART, s, i)) &&
      (!wAt(WSTART, s, e) || !wAt(WEND, s, e));
    // The editor's test for a pattern that may span lines: an \n, \r, or \W
    // escape in it.
    const spans = (q: string): boolean => {
      for (let i = 0; i < q.length; i++) {
        if (q[i] !== "\\") continue;
        i++;
        if (q[i] === "n" || q[i] === "r" || q[i] === "W") return true;
      }
      return false;
    };

    // Non-overlapping matches over the cached haystack, in document order,
    // collected again only once the body observer has marked the
    // transcript changed, so a keystroke costs one pass over a string
    // rather than a walk of the whole transcript. Plain text runs indexOf,
    // on the folded copy unless case matters. A regular expression runs one
    // haystack line at a time, unless the pattern spans lines, and skips
    // empty matches. Whole word drops the matches it rejects, and an invalid
    // expression finds nothing and keeps its error for the bar.
    const search = (q: string): void => {
      mm = [];
      nm = 0;
      starts = [];
      blkMemo = new Map();
      activeR = null;
      gen++;
      err = "";
      if (!q) return;
      let re: any = null;
      if (opts.r) {
        try {
          re = new RegExp(
            q,
            "gu" + (opts.c ? "" : "i") + (spans(q) ? "m" : ""),
          );
        } catch (e: any) {
          err = String((e && e.message) || e);
          return;
        }
      }
      if (dirty || !snap || !obs) {
        const col = collect();
        snap = { nodes: col.nodes, offs: col.offs, hay: col.hay, low: null };
        dirty = false;
      }
      const offs = snap.offs;
      const hay = snap.hay;
      const last = snap.nodes.length - 1;
      if (last < 0) return;
      // Matches arrive in haystack order, so the node cursor only advances.
      let a = 0;
      const add = (i: number, e: number): void => {
        if (opts.w && !whole(hay, i, e)) return;
        while (a < last && offs[a + 1] <= i) a++;
        let b = a;
        while (b < last && offs[b + 1] <= e - 1) b++;
        mm.push(a, i - offs[a], b, e - offs[b]);
        starts.push(i);
        nm++;
      };
      if (!re) {
        if (!opts.c && snap.low === null) snap.low = fold(hay);
        const H = opts.c ? hay : snap.low;
        const Q = opts.c ? q : fold(q);
        const L = Q.length;
        let i = H.indexOf(Q);
        while (i >= 0 && nm < MAXM) {
          add(i, i + L);
          i = H.indexOf(Q, i + L);
        }
        return;
      }
      // A pattern that spans lines (the m flag) runs over the whole
      // haystack once, ^ and $ meeting each line's ends.
      const all = re.multiline;
      let ls = 0;
      while (ls <= hay.length && nm < MAXM) {
        let le = all ? hay.length : hay.indexOf("\n", ls);
        if (le < 0) le = hay.length;
        const line = all ? hay : hay.slice(ls, le);
        const base = all ? 0 : ls;
        re.lastIndex = 0;
        let m = re.exec(line);
        while (m && nm < MAXM) {
          const i = m.index;
          const e = i + m[0].length;
          if (e > i) add(base + i, base + e);
          else {
            const cp = line.codePointAt(i);
            re.lastIndex = i + (cp !== undefined && cp > 0xffff ? 2 : 1);
          }
          m = re.exec(line);
        }
        ls = le + 1;
      }
    };

    // A unit element's index among its parent's children, the offset its
    // whole-unit boundary points (setStartBefore/setEndAfter) carry.
    const idxOf = (el: any): number =>
      Array.prototype.indexOf.call(el.parentNode.childNodes, el);
    // Point the live Range r at match k; throws once a node has gone stale,
    // which the pending rescan rebuilds. A unit element is selected whole
    // (its fence keeps the start and end node the same).
    const setR = (r: any, k: number): any => {
      const a = snap.nodes[mm[4 * k]];
      const b = snap.nodes[mm[4 * k + 2]];
      if (a.nodeType === 1) r.setStartBefore(a);
      else r.setStart(a, mm[4 * k + 1]);
      if (b.nodeType === 1) r.setEndAfter(b);
      else r.setEnd(b, mm[4 * k + 3]);
      return r;
    };
    const liveAt = (k: number): any => {
      try {
        return setR(doc.createRange(), k);
      } catch {
        return null;
      }
    };
    // The painted window is static: a StaticRange costs nothing per DOM
    // mutation, and the rescan a mutation schedules replaces it anyway.
    const staticAt = (k: number): any => {
      try {
        const a = snap.nodes[mm[4 * k]];
        const b = snap.nodes[mm[4 * k + 2]];
        const ua = a.nodeType === 1;
        const ub = b.nodeType === 1;
        return new g.StaticRange({
          startContainer: ua ? a.parentNode : a,
          startOffset: ua ? idxOf(a) : mm[4 * k + 1],
          endContainer: ub ? b.parentNode : b,
          endOffset: ub ? idxOf(b) + 1 : mm[4 * k + 3],
        });
      } catch {
        return null;
      }
    };
    // Match k's viewport rect, read through the shared probe, or null.
    const rectOf = (k: number): any => {
      try {
        if (!probe) probe = doc.createRange();
        return setR(probe, k).getBoundingClientRect();
      } catch {
        return null;
      }
    };
    // The first k in [lo, nm) where ok holds, else nm. A binary search:
    // matches run in document order, and so top to bottom, give or take a
    // pinned sticky header (either side of one is a visible match).
    const firstWhere = (ok: (k: number) => boolean, lo?: number): number => {
      let l = lo || 0;
      let h = nm;
      while (l < h) {
        const mid = (l + h) >> 1;
        if (ok(mid)) h = mid;
        else l = mid + 1;
      }
      return l;
    };
    const bottomAt =
      (y: number) =>
      (k: number): boolean => {
        const r = rectOf(k);
        return !!r && r.bottom >= y;
      };
    // The matches in the header pinned at the top of scroller sc, as an
    // index range [lo, hi] (empty when none): they show at the top while
    // their document position lies above the view. The pinned one is the
    // last header at or above the scroller top (headers run in document
    // order) that still shows there.
    const pinnedMatches = (sc: any): number[] => {
      if (!sc || !shClass || !nm) return [0, -1];
      const rt = sc.getBoundingClientRect().top;
      const hs = sc.getElementsByClassName(shClass);
      let l = 0;
      let h = hs.length;
      while (l < h) {
        const mid = (l + h) >> 1;
        if (hs[mid].getBoundingClientRect().top <= rt + 4) l = mid + 1;
        else h = mid;
      }
      const ph = l > 0 ? hs[l - 1] : null;
      if (!ph || ph.getBoundingClientRect().bottom <= rt + 4) return [0, -1];
      // By document position: before the header (-1), in it (0), after.
      const where = (k: number): number => {
        const n = snap.nodes[mm[4 * k]];
        if (n === ph) return 0;
        const c = ph.compareDocumentPosition(n);
        return c & 16 ? 0 : c & 4 ? 1 : -1;
      };
      const lo = firstWhere((k) => where(k) >= 0);
      let hi = lo - 1;
      while (hi + 1 < nm && hi - lo < 200 && where(hi + 1) === 0) hi++;
      return [lo, hi];
    };

    // Marks the highlights for the next frame, where hlSync paints the
    // matches around the view; the active match gets its live Range now,
    // since reveal measures it right away.
    const paint = (): void => {
      activeR = active >= 0 && active < nm ? liveAt(active) : null;
      hlDirty = true;
      frameQ();
    };

    // The highlight registry holds only the matches near the view. Blink
    // rebuilds every custom highlight marker on any frame with a DOM or
    // style change (the find input's own keystrokes included), so
    // registering all of a frequent word's matches taxed every frame while
    // the bar was open. Registered: the matches within WINM viewport
    // heights of the view (at most WINMAX, kept centered on it), plus those
    // in the header pinned at the top, which sit far above in document
    // order while they show. Rebuilt after a scan or a navigation, and on a
    // resize or a scroll of half the margin.
    const hlSync = (): void => {
      if (!isOpen()) return;
      const sc = container();
      const vh = g.window.innerHeight || 0;
      const pos = sc ? sc.scrollTop - sc.getBoundingClientRect().top : 0;
      if (
        !hlDirty &&
        sc === winSc &&
        vh === winVh &&
        Math.abs(pos - winPos) <= winM / 2
      ) {
        return;
      }
      hlDirty = false;
      winSc = sc;
      winVh = vh;
      winPos = pos;
      winM = Math.max(300, vh * WINM);
      let lo = 0;
      let hi = -1;
      const p = pinnedMatches(sc);
      const plo = p[0];
      const phi = p[1];
      if (nm) {
        // The pinned header's matches are set aside here as in update, and
        // added on their own below.
        const near = bottomAt(-winM);
        lo = firstWhere((k) => (k < plo || k > phi) && near(k));
        hi =
          firstWhere((k) => {
            const r = rectOf(k);
            return !!r && r.top > vh + winM;
          }, lo) - 1;
        if (hi - lo + 1 > WINMAX) {
          const vis = bottomAt(0);
          const mid = firstWhere((k) => (k < plo || k > phi) && vis(k), lo);
          lo = Math.max(lo, Math.min(mid - (WINMAX >> 1), hi - WINMAX + 1));
          hi = lo + WINMAX - 1;
        }
      }
      try {
        const key = gen + ":" + lo + ":" + hi + ":" + plo + ":" + phi;
        if (key !== winKey) {
          winKey = key;
          const all = new g.Highlight();
          all.priority = 1;
          for (let k = plo; k <= phi; k++) {
            if (k >= lo && k <= hi) continue;
            const r = staticAt(k);
            if (r) all.add(r);
          }
          for (let k = lo; k <= hi; k++) {
            const r = staticAt(k);
            if (r) all.add(r);
          }
          g.CSS.highlights.set("ccup-find", all);
        }
        if (activeR !== winAct) {
          winAct = activeR;
          const act = new g.Highlight();
          act.priority = 2;
          if (activeR) act.add(activeR);
          g.CSS.highlights.set("ccup-find-active", act);
        }
      } catch {
        // Highlight registry unavailable: matches still navigate by scroll
      }
    };

    const status = (): void => {
      if (!count) return;
      const q = input ? input.value : "";
      const total = nm >= MAXM ? MAXM + "+" : String(nm);
      const txt = !q ? "" : nm ? active + 1 + " of " + total : "No results";
      // Write only on change: textContent assignment always emits a mutation,
      // and every body observer (the other toggles' too) wakes for one. The hidden
      // sizer twin holds a fixed "9999 of 9999" (or the real worst case once
      // the total runs wider), so the bar keeps one width across queries and
      // navigation alike.
      if (countText && countText.textContent !== txt)
        countText.textContent = txt;
      const sz = total.length > 4 ? total + " of " + total : "9999 of 9999";
      if (countSize && countSize.textContent !== sz) countSize.textContent = sz;
      if (bar) {
        if (q && !nm) bar.setAttribute("data-none", "");
        else bar.removeAttribute("data-none");
        // An invalid expression: the input box's error border, and the
        // message under it, as wide as the box, as the editor shows one.
        if (err && q) {
          if (msg.textContent !== err) msg.textContent = err;
          const l = field.offsetLeft + "px";
          const w = field.offsetWidth + "px";
          if (msg.style.left !== l) msg.style.left = l;
          if (msg.style.width !== w) msg.style.width = w;
          if (!bar.hasAttribute("data-err")) {
            bar.setAttribute("data-err", "");
            input.setAttribute("aria-invalid", "true");
          }
        } else if (bar.hasAttribute("data-err")) {
          bar.removeAttribute("data-err");
          input.removeAttribute("aria-invalid");
        }
      }
      // data-off instead of the disabled attribute: a disabled button gets no
      // mouse events, which would keep the hover tip from ever showing.
      const dis = !nm;
      const off = (b: any): void => {
        if (!b) return;
        const has = b.hasAttribute("data-off");
        if (dis && !has) {
          b.setAttribute("data-off", "");
          b.setAttribute("aria-disabled", "true");
        } else if (!dis && has) {
          b.removeAttribute("data-off");
          b.removeAttribute("aria-disabled");
        }
      };
      off(prevB);
      off(nextB);
      off(blockPrevB);
      off(blockNextB);
    };

    // The band a match must land in to read comfortably: below the find bar
    // AND whatever sticky header is currently pinned (its height varies with
    // the pinned message), above the composer box. Degenerates to the plain
    // viewport when the band would collapse (tiny panel, odd layout).
    const safeBand = (): number[] => {
      const vh = g.window.innerHeight || 0;
      let topS = TOP;
      let botS = vh - 16;
      try {
        const root = container();
        if (root && shClass) {
          const rt = root.getBoundingClientRect().top;
          const hs = root.querySelectorAll("." + shClass);
          for (let i = 0; i < hs.length; i++) {
            const hr = hs[i].getBoundingClientRect();
            if (hr.top <= rt + 4 && hr.bottom + 6 > topS) topS = hr.bottom + 6;
          }
        }
      } catch {
        // no sticky info: the find-bar clearance alone bounds the top
      }
      try {
        if (cfg.input) {
          const mi = doc.querySelector(".messageInput_" + cfg.input);
          if (mi) {
            const ir = mi.getBoundingClientRect();
            if (ir.top > topS + 60) botS = Math.min(botS, ir.top - 10);
          }
        }
      } catch {
        // no composer info: the viewport bottom bounds the band
      }
      if (botS - topS < 60) {
        topS = TOP;
        botS = vh - 16;
      }
      return [topS, botS];
    };

    // Scroll the transcript scroller so the active match sits inside the safe
    // band. A match clipped inside a folded box (overflow hides paint, not
    // layout, so its rect can sit far below anything visible) reveals its
    // BLOCK instead; a block taller than the band aligns its top under the
    // band top. Sticky pinning and Monaco's virtualized diff lines re-layout
    // DURING the scroll (a different header pins, lines mount), so a bounded
    // correction pass re-measures on the next frames until the target settles.
    const reveal = (tries?: number): void => {
      if (active < 0 || !activeR) return;
      try {
        let tr = activeR.getBoundingClientRect();
        try {
          const bl = blockAt(active);
          if (bl && bl.isConnected) {
            const br = bl.getBoundingClientRect();
            if (tr.bottom <= br.top + 1 || tr.top >= br.bottom - 1) tr = br;
          }
        } catch {
          // no block: the match rect itself is the target
        }
        const band = safeBand();
        const bandH = band[1] - band[0];
        const trH = tr.bottom - tr.top;
        if (trH < bandH - 24) {
          if (tr.top >= band[0] && tr.bottom <= band[1]) return;
        } else if (tr.top <= band[0] + 8 && tr.bottom >= band[1] - 8) {
          return; // a tall block already fills the band
        }
        let sc = container();
        if (!sc || sc.scrollHeight <= sc.clientHeight + 1) {
          let e = activeR.startContainer.parentElement;
          while (e && e.scrollHeight <= e.clientHeight + 1) e = e.parentElement;
          sc = e;
        }
        if (!sc) return;
        sc.scrollTop +=
          trH < bandH - 24
            ? tr.top + trH / 2 - (band[0] + bandH / 2)
            : tr.top - (band[0] + 12);
        const t = typeof tries === "number" ? tries : 0;
        if (t < 2) {
          g.requestAnimationFrame(() => {
            try {
              reveal(t + 1);
            } catch {
              // settled enough: the band check above ends the pass
            }
          });
        }
      } catch {
        // rect on a dead range: the next rescan rebuilds it
      }
    };

    const nav = (dir: number): void => {
      if (!nm) return;
      const base = active < 0 ? (dir > 0 ? -1 : 0) : active;
      active = (base + dir + nm) % nm;
      paint();
      status();
      reveal();
    };

    // The block a match lives in: the nearest ancestor carrying one of the
    // baked block classes, else the transcript row that contains the match.
    const blockAt = (k: number): any => {
      let el = blkMemo.get(k);
      if (el !== undefined) return el;
      el = null;
      try {
        const root = container();
        // Either kind of match starts in its node's parent: a text node's
        // element, or a formula unit's, which for a display formula is the
        // response's own markdown root, a block itself.
        let e = snap.nodes[mm[4 * k]].parentElement;
        let row = null;
        while (e && e !== root) {
          if (e.classList) {
            for (let i = 0; i < BLOCKS.length; i++) {
              if (e.classList.contains(BLOCKS[i])) {
                blkMemo.set(k, e);
                return e;
              }
            }
          }
          row = e;
          e = e.parentElement;
        }
        el = e === root ? row : null;
      } catch {
        el = null;
      }
      blkMemo.set(k, el);
      return el;
    };

    // Skip to the nearest match in a DIFFERENT block (wrapping); previous
    // lands on that block's first match, so both directions enter a block at
    // its top. A single block with matches leaves nothing to skip to.
    const navBlock = (dir: number): void => {
      const n = nm;
      if (!n) return;
      const cur = active < 0 ? 0 : active;
      const b = blockAt(cur);
      let j = -1;
      for (let s = 1; s < n; s++) {
        const k = (((cur + dir * s) % n) + n) % n;
        if (blockAt(k) !== b) {
          j = k;
          break;
        }
      }
      if (j < 0) return;
      if (dir < 0) {
        const bb = blockAt(j);
        while (j !== cur) {
          const p = (j - 1 + n) % n;
          if (blockAt(p) !== bb) break;
          j = p;
        }
      }
      active = j;
      paint();
      status();
      reveal();
    };

    // Query changed: rescan and land on the first match in or below the
    // current view (wrapping to the first overall), like a fresh native find.
    const update = (): void => {
      search(input ? input.value : "");
      active = -1;
      if (nm) {
        // The first match in document order whose bottom clears the bar,
        // found by binary search with the pinned header's matches set
        // aside, since they break the top-to-bottom order; when they come
        // first, they are the answer, as they show at the top.
        const p = pinnedMatches(container());
        const vis = bottomAt(TOP);
        const k = firstWhere((j) => (j < p[0] || j > p[1]) && vis(j));
        if (p[0] <= p[1] && p[0] < k && vis(p[0])) active = p[0];
        else active = k < nm ? k : 0;
      }
      paint();
      status();
      if (active >= 0) reveal();
    };

    // Transcript re-rendered while open: recompute and never scroll
    // (background changes must not yank). The active match is re-anchored by
    // its LIVE Range first: mutations around it adjust the boundary points,
    // so the same text keeps being the active match even when content
    // mounting above it (sticky pinning, Monaco's virtualized diff lines on
    // scroll) shifts every haystack offset. The offset is only the fallback
    // for a re-rendered (disconnected) active node.
    const rescan = (): void => {
      if (!isOpen() || !input || !input.value) return;
      const prevRange = activeR;
      const prevStart =
        active >= 0 && starts[active] !== undefined ? starts[active] : -1;
      search(input.value);
      active = -1;
      if (nm) {
        let found = -1;
        if (prevRange) {
          try {
            if (
              prevRange.startContainer &&
              prevRange.startContainer.isConnected
            ) {
              // The first new match starting at or after the old one:
              // comparePoint reads -1 only for a point before its start.
              found = firstWhere((k) => {
                const n = snap.nodes[mm[4 * k]];
                return n.nodeType === 1
                  ? prevRange.comparePoint(n.parentNode, idxOf(n)) >= 0
                  : prevRange.comparePoint(n, mm[4 * k + 1]) >= 0;
              });
              if (found >= nm) found = -1;
            }
          } catch {
            found = -1;
          }
        }
        if (found < 0) {
          found = firstWhere((k) => starts[k] >= prevStart);
          if (found >= nm) found = -1;
        }
        active = found >= 0 ? found : nm - 1;
      }
      paint();
      status();
    };

    // An option flipped: search again and keep the place, as the editor's
    // widget does. The first match from the active one on becomes active
    // (re-anchored as a rescan does) and is revealed, or, with no active
    // match, the landing is a new query's.
    const research = (): void => {
      if (active < 0) {
        update();
        return;
      }
      rescan();
      if (active >= 0) reveal();
    };

    const CHEV_UP =
      "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M18 15l-6-6-6 6'/></svg>";
    const CHEV_DN =
      "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9l6 6 6-6'/></svg>";
    const CROSS =
      "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M18 6L6 18'/><path d='M6 6l12 12'/></svg>";
    const CHEVS_UP =
      "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M17 11l-5-5-5 5'/><path d='M17 18l-5-5-5 5'/></svg>";
    const CHEVS_DN =
      "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M7 6l5 5 5-5'/><path d='M7 13l5 5 5-5'/></svg>";

    // Custom hover tip with a short fixed delay: the native title tooltip is
    // unreliable inside the webview (long OS delay, often absent entirely).
    const showTip = (btn: any, text: string): void => {
      if (!tip) return;
      tip.textContent = text;
      tip.style.display = "block";
      const br = btn.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const vw = doc.documentElement.clientWidth || 0;
      const x = Math.max(
        4,
        Math.min(br.left + br.width / 2 - tw / 2, vw - tw - 4),
      );
      tip.style.left = x + "px";
      tip.style.top = br.bottom + 6 + "px";
    };
    const hideTip = (): void => {
      if (tipT) {
        g.clearTimeout(tipT);
        tipT = 0;
      }
      if (tip) tip.style.display = "none";
    };

    // Buttons swallow mousedown so the input keeps focus (house pattern).
    const mkBtn = (svg: string, label: string, fn: any): any => {
      const b = doc.createElement("button");
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.innerHTML = svg;
      b.addEventListener("mouseenter", () => {
        if (tipT) g.clearTimeout(tipT);
        tipT = g.setTimeout(() => {
          tipT = 0;
          try {
            showTip(b, label);
          } catch {
            // measuring a detached tip: skip this hover
          }
        }, 250);
      });
      b.addEventListener("mouseleave", hideTip);
      b.addEventListener("mousedown", (e: any) => {
        e.preventDefault();
        e.stopPropagation();
        hideTip();
      });
      b.addEventListener("click", (e: any) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };

    // The toggles' checked state, written only on change.
    const optSync = (): void => {
      for (let i = 0; i < optBs.length; i++) {
        const b = optBs[i];
        const on = opts[b.getAttribute("data-opt")] ? "true" : "false";
        if (b.getAttribute("aria-checked") !== on) {
          b.setAttribute("aria-checked", on);
        }
      }
    };
    // A search option's toggle, its glyph drawn by the stylesheet. A flip
    // persists and searches again from the active match.
    const mkOpt = (k: string, label: string): any => {
      const b = mkBtn("", label, () => {
        opts[k] = opts[k] ? 0 : 1;
        optSync();
        try {
          g.localStorage.setItem(OPT_KEY, JSON.stringify(opts));
        } catch {
          // no storage: the flip lasts as long as the webview
        }
        research();
      });
      b.className = "ccup-find-opt";
      b.setAttribute("role", "checkbox");
      b.setAttribute("data-opt", k);
      optBs.push(b);
      return b;
    };

    // Over the chat header when one shows: centered on its button row (the
    // header's content box) and overhanging the row's right end by as much
    // as above and below, so the New session button there sits wholly
    // behind the bar. With no header (the editor tab hides it), the
    // stylesheet's top-right corner holds.
    const place = (): void => {
      let top = "";
      let right = "";
      try {
        const hd = cfg.head ? doc.querySelector("." + cfg.head) : null;
        const r = hd ? hd.getBoundingClientRect() : null;
        if (r && r.width > 0 && r.height > 0) {
          const cs = g.getComputedStyle(hd);
          const px = (v: string): number => parseFloat(v) || 0;
          const t = r.top + px(cs.borderTopWidth) + px(cs.paddingTop);
          const b = r.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom);
          const end = r.right - px(cs.borderRightWidth) - px(cs.paddingRight);
          const h = bar.offsetHeight;
          const over = Math.max(0, (h - (b - t)) / 2);
          const vw = doc.documentElement.clientWidth || 0;
          top = Math.max(0, (t + b - h) / 2) + "px";
          right = Math.max(0, vw - end - over) + "px";
        }
      } catch {
        // no header geometry: the stylesheet's corner
      }
      if (bar.style.top !== top) bar.style.top = top;
      if (bar.style.right !== right) bar.style.right = right;
    };

    const build = (): void => {
      if (bar) return;
      bar = doc.createElement("div");
      bar.className = "ccup-find-bar";
      bar.setAttribute("role", "search");
      bar.addEventListener("mousedown", (e: any) => {
        e.stopPropagation();
      });
      input = doc.createElement("input");
      input.type = "text";
      input.placeholder = "Find";
      input.setAttribute("aria-label", "Find in chat");
      input.addEventListener("input", () => {
        if (scanT) g.clearTimeout(scanT);
        scanT = g.setTimeout(() => {
          scanT = 0;
          update();
        }, 90);
      });
      // The input box, holding the input and the option toggles, as the
      // editor's find widget does.
      field = doc.createElement("div");
      field.className = "ccup-find-field";
      field.appendChild(input);
      field.appendChild(mkOpt("c", "Match Case"));
      field.appendChild(mkOpt("w", "Match Whole Word"));
      field.appendChild(mkOpt("r", "Use Regular Expression"));
      optSync();
      msg = doc.createElement("div");
      msg.className = "ccup-find-msg";
      msg.setAttribute("aria-live", "polite");
      count = doc.createElement("span");
      count.className = "ccup-find-count";
      count.setAttribute("aria-live", "polite");
      countText = doc.createElement("span");
      countSize = doc.createElement("span");
      countSize.className = "ccup-find-count-size";
      countSize.setAttribute("aria-hidden", "true");
      count.appendChild(countText);
      count.appendChild(countSize);
      tip = doc.createElement("div");
      tip.className = "ccup-find-tip";
      doc.body.appendChild(tip);
      prevB = mkBtn(CHEV_UP, "Previous Match", () => nav(-1));
      nextB = mkBtn(CHEV_DN, "Next Match", () => nav(1));
      blockPrevB = mkBtn(CHEVS_UP, "Previous Match Block", () => navBlock(-1));
      blockPrevB.classList.add("ccup-find-sep");
      blockNextB = mkBtn(CHEVS_DN, "Next Match Block", () => navBlock(1));
      const closeB = mkBtn(CROSS, "Close", () => closeBar());
      closeB.classList.add("ccup-find-sep");
      bar.appendChild(field);
      bar.appendChild(count);
      bar.appendChild(prevB);
      bar.appendChild(nextB);
      bar.appendChild(blockPrevB);
      bar.appendChild(blockNextB);
      bar.appendChild(closeB);
      bar.appendChild(msg);
      doc.body.appendChild(bar);
      ruler = doc.createElement("div");
      ruler.className = "ccup-find-ruler";
      doc.body.appendChild(ruler);
    };

    const isOpen = (): boolean => !!(bar && bar.hasAttribute("data-open"));

    // Ruler: a slim fixed bar on the left edge of the active match's block,
    // clamped to the block's visible slice of the scrollport and tracked on
    // scroll/resize/mutation, so the right block stands out even when the
    // match highlight itself is clipped (a folded IN/OUT row) or tiny (an
    // unexpanded diff card).
    const rulerUpd = (): void => {
      if (!ruler) return;
      let el = null;
      if (isOpen() && active >= 0 && active < nm) el = blockAt(active);
      if (!el || !el.isConnected) {
        ruler.style.display = "none";
        return;
      }
      let r;
      try {
        r = el.getBoundingClientRect();
      } catch {
        ruler.style.display = "none";
        return;
      }
      const vh = g.window.innerHeight || 0;
      let top = Math.max(r.top, 4);
      let bot = Math.min(r.bottom, vh - 4);
      // A block's rect is layout, not visibility: partly scrolled out it
      // keeps its full extent while the scroller edge clips it and the
      // pinned sticky header covers it, so the fixed ruler would otherwise
      // paint straight across the pinned header (and past the scroller onto
      // the composer). Clamp the segment to the scroller box, then under
      // every pinned header EXCEPT one that is the marked block itself,
      // wraps it, or sits inside it (a whole-row block): that header is the
      // block's own visible part, and the ruler should span it.
      try {
        const root = container();
        if (root) {
          const cr = root.getBoundingClientRect();
          if (cr.top > top) top = cr.top;
          if (cr.bottom < bot) bot = cr.bottom;
          if (shClass) {
            const hs = root.querySelectorAll("." + shClass);
            for (let i = 0; i < hs.length; i++) {
              const h = hs[i];
              if (h === el || h.contains(el) || el.contains(h)) continue;
              const hr = h.getBoundingClientRect();
              if (hr.top <= cr.top + 4 && hr.bottom > top) top = hr.bottom;
            }
          }
        }
      } catch {
        // no scroller geometry: the viewport clamps above still bound it
      }
      if (bot - top < 8 || r.width <= 0) {
        ruler.style.display = "none";
        return;
      }
      ruler.style.display = "block";
      // Fixed column: the bar's RIGHT edge sits just left of the user-message
      // history's own left rule, so it always lives in one gutter instead of
      // hugging whichever indentation the block happens to have; the width
      // grows leftward from that edge.
      if (!refEl || !refEl.isConnected) {
        refEl =
          (umClass && doc.querySelector("." + umClass)) ||
          (shClass && doc.querySelector("." + shClass)) ||
          null;
      }
      let right;
      if (refEl) right = refEl.getBoundingClientRect().left - 3;
      else {
        const root = container();
        right = root ? root.getBoundingClientRect().left + 7 : 11;
      }
      ruler.style.left = Math.max(2, right - 7.5) + "px";
      ruler.style.top = top + "px";
      ruler.style.height = bot - top + "px";
    };
    // One frame callback for the painted window and the ruler, queued by
    // scans, navigation, scroll, resize, and transcript mutations.
    const frame = (): void => {
      rraf = 0;
      try {
        hlSync();
      } catch {
        // a node gone stale mid-read: the pending rescan repaints
      }
      rulerUpd();
    };
    const frameQ = (): void => {
      if (!rraf) rraf = g.requestAnimationFrame(frame);
    };

    // Transcript changes while open: a record counts when it lands inside
    // the transcript or mounts a new one. The bar, the ruler and the tip sit
    // outside it, so the counter's own writes never retrigger a rescan, and
    // neither does typing in the composer. Text and tree changes rescan; an
    // attribute change (a class or style that may hide or show text) only
    // marks the haystack stale for the next keystroke, since Monaco restyles
    // its lines on every scroll frame and a rescan per frame would cost more
    // than the cache saves.
    const onMut = (rs: any): void => {
      if (!isOpen()) return;
      const root = container();
      if (!root) return;
      let hit = false;
      let text = false;
      for (let i = 0; i < rs.length && !text; i++) {
        const r = rs[i];
        const t = r.target;
        if (t === root || root.contains(t)) {
          hit = true;
          if (r.type !== "attributes") text = true;
        } else if (r.type === "childList" && t.contains(root)) {
          const ad = r.addedNodes;
          for (let j = 0; j < ad.length; j++) {
            if (ad[j] === root || ad[j].contains(root)) {
              hit = text = true;
              break;
            }
          }
        }
      }
      if (!hit) return;
      dirty = true;
      frameQ();
      if (!text || mutT) return;
      mutT = g.setTimeout(() => {
        mutT = 0;
        rescan();
      }, 180);
    };
    // Observed only while open, so a closed bar costs no mutation records.
    const watch = (): void => {
      try {
        if (!obs) obs = new g.MutationObserver(onMut);
        obs.observe(doc.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["class", "style", "hidden", "open"],
        });
      } catch {
        // no observer: matches go stale, and each keystroke collects afresh
        obs = null;
      }
    };

    const openBar = (): void => {
      build();
      if (!isOpen()) {
        lastFocus = doc.activeElement;
        bar.setAttribute("data-open", "");
        // Mirrored onto <body> for the button toggles' dim lift, which needs an
        // "is the bar open" test that costs nothing between transitions (see
        // dimCss). Harmless when those toggles are off: nothing reads the class.
        doc.body.classList.add("ccup-find-open");
        dirty = true; // nothing watched the transcript while closed
        watch();
      }
      place();
      let sel = "";
      try {
        sel = String(g.window.getSelection() || "");
      } catch {
        sel = "";
      }
      // Escaped for a regular expression, as the editor seeds its own.
      if (sel && sel.indexOf("\n") < 0 && sel.length <= 200) {
        input.value = opts.r ? sel.replace(/[\\{}*+?|^$.[\]()]/g, "\\$&") : sel;
      }
      input.focus();
      input.select();
      update();
    };

    const closeBar = (): void => {
      if (!isOpen()) return;
      bar.removeAttribute("data-open");
      doc.body.classList.remove("ccup-find-open");
      hideTip();
      try {
        g.CSS.highlights.delete("ccup-find");
        g.CSS.highlights.delete("ccup-find-active");
      } catch {
        // registry gone: nothing to clear
      }
      try {
        if (obs) obs.disconnect();
      } catch {
        // already gone
      }
      // A scan still pending would paint highlights with the bar closed.
      if (scanT) g.clearTimeout(scanT);
      if (mutT) g.clearTimeout(mutT);
      scanT = 0;
      mutT = 0;
      mm = [];
      nm = 0;
      starts = [];
      blkMemo = new Map();
      active = -1;
      activeR = null;
      snap = null;
      hlDirty = false;
      winKey = "";
      winAct = null;
      winSc = null;
      if (ruler) ruler.style.display = "none";
      const lf = lastFocus;
      lastFocus = null;
      try {
        if (lf && lf.isConnected && lf !== bar && !bar.contains(lf)) lf.focus();
        else if (cfg.input) {
          const mi = doc.querySelector(".messageInput_" + cfg.input);
          if (mi) mi.focus();
        }
      } catch {
        // focus restore is best effort
      }
    };

    const chordHit = (e: any, list: any): boolean => {
      if (!list) return false;
      const k = String(e.key || "").toLowerCase();
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (
          c &&
          c.k === k &&
          !!e.metaKey === !!c.m &&
          !!e.ctrlKey === !!c.c &&
          !!e.altKey === !!c.a &&
          !!e.shiftKey === !!c.s
        ) {
          return true;
        }
      }
      return false;
    };

    // Capture phase: fires ahead of VS Code's bubble-phase key forwarder, so a
    // swallowed chord never reaches the workbench (the native widget stays
    // closed). Navigation chords act only while focus is in the bar, so Enter
    // in the composer still sends messages; everything else falls through
    // untouched (typing, and the forwarded copy/paste round-trip).
    g.window.addEventListener(
      "keydown",
      (e: any) => {
        try {
          if (e.isComposing) return;
          if (chordHit(e, cfg.open)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            openBar();
            return;
          }
          if (!isOpen() || !bar.contains(doc.activeElement)) return;
          if (String(e.key || "").toLowerCase() === "escape") {
            e.preventDefault();
            e.stopImmediatePropagation();
            closeBar();
            return;
          }
          if (chordHit(e, cfg.prev)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            nav(-1);
            return;
          }
          if (chordHit(e, cfg.next)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            nav(1);
            return;
          }
          if (chordHit(e, cfg.bprev)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            navBlock(-1);
            return;
          }
          if (chordHit(e, cfg.bnext)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            navBlock(1);
          }
        } catch {
          // never break the chat's key handling
        }
      },
      true,
    );

    doc.addEventListener("scroll", frameQ, true);
    g.window.addEventListener("resize", () => {
      dirty = true; // a narrow panel hides tool bodies
      frameQ();
      if (isOpen()) place();
    });
  } catch {
    // never break the webview
  }
}

// The cfg line: baked class-map hashes plus the resolved chords. Rebuilt from
// bundle + keybindings state, so equality against the on-disk line doubles as
// the staleness check (a keybinding edit re-applies through the reconcile).
function findBarCfgBuild(c: string): string | undefined {
  const chat = c.match(FINDBAR_CHAT_HASH_RE)?.[1];
  if (!chat) return undefined;
  const input = c.match(FINDBAR_INPUT_HASH_RE)?.[1] ?? "";
  // Block classes for the block-skip buttons and the ruler, read from the
  // bundle's class maps; each is optional (a missing one just falls back to
  // the transcript-row block). The markdown module shares one hash across its
  // classes, so the chunk wrapper root_<hash> derives from codeBlockWrapper.
  const blocks: string[] = [];
  const push = (name: string | undefined): void => {
    if (name && !blocks.includes(name)) blocks.push(name);
  };
  for (const m of c.matchAll(
    /diffEditorContainer:"(diffEditorContainer_[-\w]+)"/g,
  )) {
    push(m[1]);
  }
  // The tool module's hash also names its body wrappers and card wrapper
  // (root_<hash>). Nearest ancestor wins, so a match in an IN/OUT row marks
  // the row, one elsewhere in a body (e.g. Write's plain-text content) marks
  // the body without the card header, and only a header match falls back to
  // the whole card.
  const io = c.match(/toolBodyRow:"toolBodyRow_([-\w]+)"/)?.[1];
  if (io) {
    push(`toolBodyRow_${io}`);
    push(`toolBodyPlainText_${io}`);
    push(`toolBody_${io}`);
    push(`root_${io}`);
  }
  const md = c.match(/codeBlockWrapper:"codeBlockWrapper_([-\w]+)"/)?.[1];
  if (md) push(`root_${md}`);
  push(c.match(/userMessage:"(userMessage_[-\w]+)"/)?.[1]);
  push(c.match(/stickyHeader:"(stickyHeader_[-\w]+)"/)?.[1]);
  // Native math's formula wrapper attribute (2.1.301+), the engine's math
  // unit; "" on a build without it leaves .ccup-math and .katex.
  const math = c.includes(`"${FINDBAR_MATH_ATTR}"`) ? FINDBAR_MATH_ATTR : "";
  // The chat header, whose right end the bar covers, named by the hash its
  // module's headerSpacer key carries; "" keeps the bar in its corner.
  const hs = c.match(/headerSpacer:"headerSpacer_([-\w]+)"/)?.[1];
  const head = hs && c.includes(`header:"header_${hs}"`) ? `header_${hs}` : "";
  const k = readFindKeys();
  mergeChords(k.next, readFindChordSetting("chatFindBarNextMatchKeys"));
  mergeChords(k.prev, readFindChordSetting("chatFindBarPreviousMatchKeys"));
  const cfg = {
    chat,
    input,
    head,
    blocks,
    math,
    open: k.open,
    next: k.next,
    prev: k.prev,
    bnext: mergeChords(
      k.bnext,
      readFindChordSetting("chatFindBarNextMatchBlockKeys"),
    ),
    bprev: mergeChords(
      k.bprev,
      readFindChordSetting("chatFindBarPreviousMatchBlockKeys"),
    ),
  };
  return `${FINDBAR_CFG_MARKER}window.__ccupFindCfg=${JSON.stringify(cfg)};`;
}

function findBarHelperBlock(): string {
  return `${FINDBAR_START};(${ccupFindBarWebview.toString()})();/*ccup:findBarEnd*/`;
}

function findBarMarksPresent(c: string): boolean {
  return c.includes(FINDBAR_CFG_MARKER) || c.includes(FINDBAR_START);
}
function findBarPresent(c: string): boolean {
  return findBarMarksPresent(c) || FINDBAR_CHAT_HASH_RE.test(c);
}
// true = ON in exactly this build+keybindings form (also when marked but
// unrebuildable, so an orphaned patch stays removable), false = OFF or stale,
// undefined = no marks and no anchor. Per-marker comparisons, never
// whole-file, so other toggles' EOF lines order freely around ours.
function findBarCurrentOn(c: string): boolean | undefined {
  if (!findBarMarksPresent(c)) {
    return FINDBAR_CHAT_HASH_RE.test(c) ? false : undefined;
  }
  const wantCfg = findBarCfgBuild(c);
  if (wantCfg === undefined) return true;
  if (cssMarkedLine(c, FINDBAR_CFG_MARKER) !== wantCfg) return false;
  FINDBAR_BLOCK_RE.lastIndex = 0;
  const h = FINDBAR_BLOCK_RE.exec(c)?.[0]?.replace(/^\n/, "");
  return h === findBarHelperBlock();
}
function findBarSet(c: string, on: boolean): string {
  if (on && findBarCurrentOn(c) === true) return c; // stable: no EOF reshuffle
  const stripped = c
    .replace(FINDBAR_BLOCK_RE, "")
    .replace(FINDBAR_CFG_LINE_RE, "");
  if (!on) return stripped;
  const cfgLine = findBarCfgBuild(stripped);
  if (cfgLine === undefined) return c; // anchor gone: leave the file as it is
  return `${stripped}\n${cfgLine}\n${findBarHelperBlock()}`;
}

// The appended stylesheet line: the two highlight pseudo-styles on the editor
// findMatch theme tokens (the same yellow/orange the native find paints), and
// the bar itself on the editorWidget/input tokens with the chat's own --app-*
// variables as first choice, so it reads native in either surface and theme.
// The option toggles take the inputOption tokens and the editor's codicons,
// painted in the toggle's color through masks of the glyphs read out of the
// bundle's codicon font (codiconGlyphSvgs), or text look-alikes when there is
// no font to read.
function findBarCssBuild(css: string): string | undefined {
  if (!FINDBAR_CSS_ANCHOR_RE.test(css)) return undefined;
  const ghost = "var(--app-ghost-button-hover-background,rgba(128,128,128,.2))";
  const svgs = codiconGlyphSvgs(css);
  const glyphs = svgs
    ? '.ccup-find-opt::before{content:"";width:16px;height:16px;background:currentColor;-webkit-mask-position:center;-webkit-mask-size:16px 16px;-webkit-mask-repeat:no-repeat}' +
      FINDBAR_GLYPHS.map(
        ([k], i) =>
          `.ccup-find-opt[data-opt=${k}]::before{-webkit-mask-image:url("data:image/svg+xml,${encodeURIComponent(svgs[i])}")}`,
      ).join("")
    : ".ccup-find-opt::before{font:600 11px/1 var(--vscode-font-family,system-ui)}" +
      '.ccup-find-opt[data-opt=c]::before{content:"Aa"}' +
      '.ccup-find-opt[data-opt=w]::before{content:"ab";text-decoration:underline}' +
      '.ccup-find-opt[data-opt=r]::before{content:".*"}';
  return (
    FINDBAR_CSS_MARKER +
    "::highlight(ccup-find){background-color:var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.33))}" +
    "::highlight(ccup-find-active){background-color:var(--vscode-editor-findMatchBackground,rgba(237,148,30,.8));color:var(--vscode-editor-foreground,inherit)}" +
    ".ccup-find-bar{position:fixed;top:8px;right:16px;z-index:1200;display:none;align-items:center;gap:4px;max-width:calc(100vw - 20px);padding:4px 6px;border:1px solid var(--vscode-widget-border,var(--app-input-border,#454545));border-radius:6px;background:var(--vscode-editorWidget-background,var(--app-input-background,#252526));color:var(--vscode-editorWidget-foreground,var(--app-primary-foreground,#cccccc));box-shadow:0 2px 8px var(--vscode-widget-shadow,rgba(0,0,0,.36));font-size:12px}" +
    ".ccup-find-bar[data-open]{display:flex}" +
    ".ccup-find-bar .ccup-find-field{flex:1 1 auto;display:flex;align-items:center;min-width:132px;min-height:24px;box-sizing:border-box;padding-right:2px;border:1px solid var(--app-input-border,var(--vscode-input-border,transparent));border-radius:4px;background:var(--app-input-background,var(--vscode-input-background,#3c3c3c))}" +
    ".ccup-find-bar .ccup-find-field:focus-within{border-color:var(--app-input-active-border,var(--vscode-focusBorder,#007fd4))}" +
    ".ccup-find-bar[data-err] .ccup-find-field{border-color:var(--vscode-inputValidation-errorBorder,#be1100)}" +
    ".ccup-find-bar input{flex:1 1 auto;width:200px;min-width:0;box-sizing:border-box;margin:0;border:none;background:transparent;color:var(--app-input-foreground,var(--vscode-input-foreground,#cccccc));padding:2px 6px;font-size:calc(var(--vscode-chat-font-size,13px)*.9);font-family:inherit;outline:none}" +
    ".ccup-find-bar .ccup-find-count{display:inline-flex;flex-direction:column;align-items:center;text-align:center;opacity:.85;white-space:nowrap;font-variant-numeric:tabular-nums}" +
    ".ccup-find-bar .ccup-find-count-size{visibility:hidden;height:0;overflow:hidden}" +
    ".ccup-find-tip{position:fixed;display:none;padding:2px 8px;border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-widget-border,#454545));border-radius:4px;background:var(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background,#252526));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-editorWidget-foreground,#cccccc));font-size:11px;white-space:nowrap;z-index:1300;pointer-events:none;box-shadow:0 2px 8px var(--vscode-widget-shadow,rgba(0,0,0,.36))}" +
    ".ccup-find-bar[data-none] .ccup-find-count{color:var(--vscode-errorForeground,#f48771);opacity:1}" +
    ".ccup-find-bar button{display:flex;align-items:center;justify-content:center;width:22px;height:22px;margin:0;padding:0;border:none;border-radius:4px;background:transparent;color:inherit;cursor:pointer}" +
    `.ccup-find-bar button${HOVER}{background:${ghost}}` +
    ".ccup-find-bar button[data-off]{opacity:.4;cursor:default}" +
    `.ccup-find-bar button[data-off]${HOVER}{background:transparent}` +
    ".ccup-find-bar svg{display:block;width:16px;height:16px}" +
    ".ccup-find-bar .ccup-find-sep{margin-left:4px}" +
    // The toggles a little wider and further apart than the editor's 20px
    // squares 2px apart, so a full-width glyph (whole word's bracket) keeps
    // some room inside its checked box and the three read apart.
    ".ccup-find-bar .ccup-find-opt{flex:none;width:22px;height:20px;margin-left:4px;box-sizing:border-box;border:1px solid transparent;border-radius:3px}" +
    `.ccup-find-bar .ccup-find-opt${HOVER}{background:var(--vscode-inputOption-hoverBackground,${ghost})}` +
    ".ccup-find-bar .ccup-find-opt[aria-checked=true]{border-color:var(--vscode-inputOption-activeBorder,#007acc);background:var(--vscode-inputOption-activeBackground,rgba(0,122,204,.4));color:var(--vscode-inputOption-activeForeground,#ffffff)}" +
    glyphs +
    ".ccup-find-msg{display:none;position:absolute;top:calc(100% + 2px);box-sizing:border-box;padding:4px 6px;border:1px solid var(--vscode-inputValidation-errorBorder,#be1100);background:var(--vscode-inputValidation-errorBackground,#5a1d1d);color:var(--vscode-inputValidation-errorForeground,inherit);line-height:1.4;white-space:normal;overflow-wrap:anywhere;pointer-events:none}" +
    ".ccup-find-bar[data-err] .ccup-find-msg{display:block}" +
    ".ccup-find-ruler{position:fixed;display:none;width:5px;border-radius:5px;background:var(--vscode-editor-findMatchBackground,var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.8)));z-index:1199;pointer-events:none}"
  );
}

// The webview bundle and stylesheet with the find bar in, as an apply writes
// them (any find bar already there replaced), or null when its anchor is gone.
// scripts/repro's find-math.mjs serves this, so it runs exactly what the
// patcher writes.
export function findBarWebview(
  js: string,
  css: string,
): { js: string; css: string } | null {
  const bar = findBarCssBuild(css);
  const out = findBarSet(js, true);
  if (!bar || findBarCurrentOn(out) !== true) return null;
  return { js: out, css: cssApplyLine(css, FINDBAR_CSS_MARKER, bar) };
}

// The chat message "Show more" (.expandButton_<hash>) and "Show less"
// (.collapseButton_<hash>) buttons live in the expandable-content module. "Show
// more" is position:absolute (bottom:0;right:0) anchored to the fit-content
// .expandableContainer and only renders on hover, so it overlays the content
// instead of taking a flow slot; its horizontal spot tracks the content width
// and drifts between messages. "Show less" is an in-flow flex item defaulting
// to the container's right edge. The chatShowMoreAndLessAlign inject point
// (below) pins each to the chosen side: "Show more" stays absolute (still
// overlaid, so it never adds height) with only its left/right anchor flipped;
// "Show less" keeps its flow slot, pushed with an auto margin. An earlier build
// forced "Show more" into normal flow (position:static), which grew the box
// taller whenever it appeared on hover, a vertical jitter. "" = leave native.
// Anchor on the buttonContainer rule to recover the hash.
const SHOW_MORE_MARKER = "/*cc-ui-patch:showMoreRight*/";
const SHOW_MORE_HASH_RE =
  /\.buttonContainer_([-\w]+)\{display:flex;opacity:\.9;justify-content:flex-end/;

// Plan-preview comment box send key (ON): natively, plain Enter in the comment
// textarea submits ("Add Comment") and Shift+Enter inserts a newline. When ON we
// move the submit chord to Cmd/Ctrl+Enter, so plain Enter (and Shift+Enter) fall
// through to a normal newline and a comment is sent only on Cmd/Ctrl+Enter (or
// the button). A plain value-swap on the keydown guard's condition: OFF is
// `!e.shiftKey`, ON is `(e.metaKey || e.ctrlKey)`; the guard body (preventDefault
// + submitBtn.click()) and the sibling Escape handler are left untouched. The /g
// lets the toggle helpers reset the anchor; the condition is unique in the
// bundle (the plan-preview inline script is not minified, like its CSS anchors).
const PLAN_COMMENT_SEND_RE =
  /(if \(e\.key === 'Enter' && )(!e\.shiftKey|\(e\.metaKey \|\| e\.ctrlKey\))(\) \{)/g;

// useCtrlEnterToSendEverywhere: extend the native claudeCode.useCtrlEnterToSend
// setting beyond the chat input. Natively only the chat input consults it (its
// keydown gates the send on `n.useCtrlEnterToSend ? metaOrCtrl : true`); the
// AskUserQuestion "Other" answer box and the permission feedback box hardcode
// plain Enter as their submit, so with the native setting on, an Enter meant as
// a newline still submits there. Three rewrites in webview/index.js make both
// boxes consult the same live config getter the chat input uses (so flipping
// the native setting mid-session applies immediately, no reload):
//
// - The permission component receives the app context as its `context` prop
//   (the class carrying the `useCtrlEnterToSend` getter). Its feedback-box
//   Enter handler gains a guard: with the native setting on and no modifier,
//   return before preventDefault, so the contenteditable inserts a newline
//   natively and Cmd/Ctrl+Enter keeps submitting (which it already did: the
//   native condition never checked modifiers).
// - The question component receives no context prop at all, so the
//   AskUserQuestion render site (the one `permissionRequest` method whose body
//   is exactly `return b(Comp,{input,onInputChange,options})`) threads it
//   through as a `ccupCtx` prop, the component signature picks it up as
//   `ccupQCtx`, and the "Other" box's Enter branch (preventDefault + advance to
//   the next question) runs only without the setting or with a modifier held.
//   Plain Enter then falls through to a native newline; the handler's existing
//   stopPropagation (any unmodified key) already keeps the container's own
//   Enter/digit shortcuts out of the way while typing. When the modifier chord
//   does advance, the gate adds a stopPropagation of its own: the option row
//   wrapping this box selects/toggles "Other" on any bubbled Enter without
//   checking modifiers (natively reachable via Cmd/Ctrl+Enter, where it
//   re-toggles the multi-select checkbox), and the send chord must not do that.
// - Advancing is all the box can do on its own, so the chord used to dead end
//   on the last question, and on a single-question popup, where there is no
//   next question at all. The answers are submitted by the container's primary
//   button, whose own Enter branch requires no modifier and which the gate's
//   stopPropagation deliberately keeps the chord away from, so the accept path
//   is threaded down as a `ccupSubmit` prop on the options object the component
//   already receives. It is built at the content render site out of the primary
//   button's props and mirrors that button's disabled condition (still arming,
//   or some question unanswered) by returning false instead of submitting, so
//   the chord submits a complete form and otherwise falls back to advancing.
//
// The seven sites are located by their structure (src/derive.ts), not by a
// regex over the text. Three units are parsed locally, each found from an
// invariant token: the question component (its params destructure
// input/onInputChange/options), the class around the AskUserQuestion render
// site (the call that renders that same component from a permissionRequest
// method, passing the method's params through), and the permission component
// (its params destructure request/context/onPermissionModeChange), which holds
// the feedback box's Enter handler, the primary button, and the options
// literal. Every site is matched by its role and by the SET of keys it
// carries, so props joining in any order (2.1.261, 2.1.280 and 2.1.286 each
// added some), operands swapping sides, or statements moving in ahead of a
// site do not lose it. Each must be found exactly once, and every minified
// name an insertion references must resolve, at that spot, to the binding the
// site was read from (no inner scope rebinding it), or the file is left
// native: a drifted bundle can never end up half-threaded with a dangling
// identifier. The three units are parsed again after the edits, so an
// insertion that would break the syntax refuses as well.
//
// Every insertion is wrapped in /*ccup:uce:<tag>*/.../*ccup:uceEnd*/, so
// restore strips the markers and never has to read native code. The
// /*ccup-uce*/-tagged forms 1.4.x-1.5.4 wrote are still recognized, only to
// strip them: an older patch reads as off, and the next apply rebuilds it in
// the marked form. The plan preview's comment box lives in a different webview
// with no access to this config, so it follows via the commentCtrlEnter toggle
// instead: readToggles() folds (ctrlEnterEverywhere && the native setting's
// value at apply time) into that toggle, and a native-setting change re-runs
// the apply through the foreign-key watch (taking effect there on reload).
const UCE_FRAG_END = "/*ccup:uceEnd*/";
// An insertion with its text wrapped in the tag's markers.
const uceEdit = (tag: string, e: Edit): Edit => ({
  pos: e.pos,
  text: `/*ccup:uce:${tag}*/${e.text}${UCE_FRAG_END}`,
});
const UCE_FRAG_RE = /\/\*ccup:uce:[-\w]+\*\/[\s\S]*?\/\*ccup:uceEnd\*\//g;

// The props the question component and the permission component destructure.
const UCE_Q_KEYS = ["input", "onInputChange", "options"];
const UCE_PERM_KEYS = ["request", "context", "onPermissionModeChange"];
// How far ahead of a destructured prop its function keyword may sit, and how
// far ahead of a render site its class may start.
const UCE_PARAMS_REACH = 2000;
const UCE_CLASS_REACH = 200000;

// `ev.key==="Enter"&&!ev.shiftKey`, in either operand order and with the
// comparison written either way round.
function uceIsEnterNoShift(t: N, ev: string): boolean {
  if (t.type !== "LogicalExpression" || t.operator !== "&&") return false;
  const sides: N[] = [t.left, t.right];
  const enter = (n: N) =>
    n.type === "BinaryExpression" &&
    (n.operator === "===" || n.operator === "==") &&
    ((isMember(n.left, ev, "key") && isStr(n.right, "Enter")) ||
      (isMember(n.right, ev, "key") && isStr(n.left, "Enter")));
  const noShift = (n: N) =>
    n.type === "UnaryExpression" &&
    n.operator === "!" &&
    isMember(n.argument, ev, "shiftKey");
  return sides.some(enter) && sides.some(noShift);
}

// `if(ev.nativeEvent.isComposing)return;`, the bare return braced or not.
function uceIsComposingReturn(s: N | undefined, ev: string): boolean {
  if (!s || s.type !== "IfStatement" || s.alternate) return false;
  if (
    memberProp(s.test) !== "isComposing" ||
    !isMember(s.test.object, ev, "nativeEvent")
  )
    return false;
  const r =
    s.consequent.type === "BlockStatement" && s.consequent.body.length === 1
      ? s.consequent.body[0]
      : s.consequent;
  return r.type === "ReturnStatement" && !r.argument;
}

// The patched bundle for a native one, or null when any site is missing,
// ambiguous, or would reference a name that resolves elsewhere.
function uceBuild(c: string): string | null {
  // The question component.
  const qs = unitsWith(
    c,
    "onInputChange:",
    "function",
    isFn,
    UCE_PARAMS_REACH,
  ).filter((f) => hasKeys(f.params[0], UCE_Q_KEYS));
  if (qs.length !== 1) return null;
  const q = qs[0];
  const qName = idName(q.id);
  const opts = boundName(q.params[0], "options");
  if (!qName || !opts) return null;

  // Its "Other" box keydown: the Enter branch that opens with the composition
  // check and then advances under `ev.preventDefault(), <condition>`.
  const keys: { k: string; branch: N; advance: N }[] = [];
  walk(q, (n) => {
    if (n.type !== "Property" || keyName(n) !== "onKeyDown") return;
    const h = n.value;
    const k = isFn(h) && h.params.length === 1 ? idName(h.params[0]) : null;
    if (!k || h.body.type !== "BlockStatement") return;
    for (const s of h.body.body as N[]) {
      if (s.type !== "IfStatement" || !uceIsEnterNoShift(s.test, k)) continue;
      const b = s.consequent;
      if (b.type !== "BlockStatement" || !uceIsComposingReturn(b.body[0], k))
        continue;
      const adv = (b.body as N[])
        .slice(1)
        .filter(
          (x) =>
            x.type === "IfStatement" &&
            x.test.type === "SequenceExpression" &&
            x.test.expressions.length >= 2 &&
            isCallOf(x.test.expressions[0], k, "preventDefault"),
        );
      if (adv.length === 1) keys.push({ k, branch: b, advance: adv[0] });
    }
  });
  if (keys.length !== 1) return null;
  const { k, branch, advance } = keys[0];
  if (bindingSite(advance, opts, q) !== q) return null;

  // The render site: the call rendering that same component, returned from a
  // class's permissionRequest method and handed that method's params.
  const renders: { cls: N; obj: N; ctx: string }[] = [];
  const tok = `(${qName},`;
  for (let i = c.indexOf(tok); i >= 0; i = c.indexOf(tok, i + 1)) {
    let at = i;
    while (at > 0 && /[\w$]/.test(c[at - 1])) at--;
    if (at === i) continue;
    const cls = unitAround(c, at, "class ", isClass, UCE_CLASS_REACH);
    if (!cls) continue;
    walk(cls, (n) => {
      if (n.type !== "MethodDefinition") return;
      const m = n.value;
      if (n.computed || idName(n.key) !== "permissionRequest") return false;
      if (!(m.start <= at && at < m.end)) return false;
      const ps: (string | null)[] = m.params.map(idName);
      walk(m.body, (r) => {
        if (r !== m.body && isFn(r)) return false;
        if (r.type !== "ReturnStatement" || r.argument?.start !== at) return;
        const call = r.argument;
        const obj = call.type === "CallExpression" ? call.arguments[1] : null;
        if (
          idName(call.arguments?.[0]) === qName &&
          hasKeys(obj, UCE_Q_KEYS) &&
          ps.length >= 4 &&
          ps[0] &&
          UCE_Q_KEYS.every(
            (key, j) => idName(propOf(obj, key)!.value) === ps[j + 1],
          ) &&
          bindingSite(obj, ps[0], m) === m
        )
          renders.push({ cls, obj, ctx: ps[0] });
      });
      return false;
    });
  }
  if (renders.length !== 1) return null;
  const render = renders[0];

  // The permission component, and inside it the feedback box's Enter handler,
  // the primary button's props, and the options literal for the content.
  const perms = unitsWith(
    c,
    "onPermissionModeChange:",
    "function",
    isFn,
    UCE_PARAMS_REACH,
  ).filter((f) => hasKeys(f.params[0], UCE_PERM_KEYS));
  if (perms.length !== 1) return null;
  const p = perms[0];
  const ctx = boundName(p.params[0], "context");
  const req = boundName(p.params[0], "request");
  if (!ctx || !req) return null;
  const handlers: { ev: string; first: N }[] = [];
  const buttons: {
    obj: N;
    accept: string;
    pending: string;
    answered: string;
  }[] = [];
  const contents: N[] = [];
  walk(p, (n) => {
    const ev =
      isFn(n) && n !== p && n.params.length === 1 ? idName(n.params[0]) : null;
    if (ev && n.body.type === "BlockStatement") {
      for (const s of n.body.body as N[]) {
        if (s.type !== "IfStatement" || !uceIsEnterNoShift(s.test, ev))
          continue;
        const b = s.consequent;
        if (
          b.type === "BlockStatement" &&
          uceIsComposingReturn(b.body[0], ev) &&
          (b.body as N[]).slice(1).some((x) => callsOf(x, ev, "preventDefault"))
        )
          handlers.push({ ev, first: b.body[0] });
      }
    }
    if (n.type !== "ObjectExpression") return;
    if (hasKeys(n, ["className", "onClick", "disabled"])) {
      // className `${S.button} ${S.primary}` (with whatever else), onClick the
      // accept call, disabled `pending||!answered`.
      const cn = propOf(n, "className")!.value;
      const dis = propOf(n, "disabled")!.value;
      const accept = idName(propOf(n, "onClick")!.value);
      const parts: N[] = cn.type === "TemplateLiteral" ? cn.expressions : [];
      const sheet = idName(
        parts.find((x) => memberProp(x) === "button")?.object,
      );
      if (
        accept &&
        sheet &&
        parts.some((x) => isMember(x, sheet, "primary")) &&
        dis.type === "LogicalExpression" &&
        dis.operator === "||" &&
        idName(dis.left) &&
        dis.right.type === "UnaryExpression" &&
        dis.right.operator === "!" &&
        idName(dis.right.argument)
      )
        buttons.push({
          obj: n,
          accept,
          pending: idName(dis.left)!,
          answered: idName(dis.right.argument)!,
        });
    }
    if (
      hasKeys(n, ["onClose", "channelId", "fold", "foldButtonRef"]) &&
      n.parent?.type === "CallExpression" &&
      n.parent.arguments.includes(n) &&
      isMember(propOf(n, "channelId")!.value, req, "channelId")
    )
      contents.push(n);
  });
  if (handlers.length !== 1 || buttons.length !== 1 || contents.length !== 1)
    return null;
  const { ev, first } = handlers[0];
  const btn = buttons[0];
  const content = contents[0];
  if (bindingSite(first, ctx, p) !== p) return null;
  for (const name of [btn.accept, btn.pending, btn.answered]) {
    if (bindingSite(content, name, p) !== bindingSite(btn.obj, name, p))
      return null;
  }

  const edits: Edit[] = [
    uceEdit("render", appendProp(render.obj, `ccupCtx:${render.ctx}`)),
    uceEdit("sig", appendProp(q.params[0], "ccupCtx:ccupQCtx")),
    uceEdit("qgate", {
      pos: branch.body[0].end,
      text:
        "var ccupOn=ccupQCtx&&ccupQCtx.useCtrlEnterToSend;" +
        `if(!ccupOn||${k}.metaKey||${k}.ctrlKey){if(ccupOn)${k}.stopPropagation();`,
    }),
    uceEdit("qsub", {
      pos: advance.test.expressions[1].start,
      text: `ccupOn&&${opts}&&${opts}.ccupSubmit&&${opts}.ccupSubmit())return;if(`,
    }),
    uceEdit("qclose", { pos: branch.end - 1, text: "}" }),
    uceEdit(
      "submit",
      appendProp(
        content,
        `ccupSubmit:()=>{if(${btn.pending}||!${btn.answered})return!1;return ${btn.accept}(),!0}`,
      ),
    ),
    uceEdit("perm", {
      pos: first.end,
      text: `if(${ctx}.useCtrlEnterToSend&&!${ev}.metaKey&&!${ev}.ctrlKey)return;`,
    }),
  ];
  const out = applyEdits(c, edits);
  const units: [N, (n: N) => boolean][] = [
    [q, isFn],
    [p, isFn],
    [render.cls, isClass],
  ];
  return unitsReparse(out, edits, units) ? out : null;
}

// The /*ccup-uce*/-tagged forms 1.4.x-1.5.4 wrote, matched only to strip them
// (the native text around each was identical when they were written, and
// still is in the bundle they were written to).
const UCE_OLD_RENDER_RE =
  /(permissionRequest\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{return [\w$]+\([\w$]+,\{(?:[\w$]+:[\w$]+,)*input:\3,onInputChange:\4,options:\5),ccupCtx:\2(\}\)\})/;
const UCE_OLD_SIG_RE =
  /(function [\w$]+\(\{(?:[\w$]+:[\w$]+,)*input:[\w$]+,onInputChange:[\w$]+,options:([\w$]+)),ccupCtx:ccupQCtx(\}\)\{)/;
const UCE_OLD_KEY_RE =
  /onKeyDown:\(([\w$]+)\)=>\{if\(!\1\.metaKey&&!\1\.ctrlKey\)\1\.stopPropagation\(\);if\(\1\.key==="Enter"&&!\1\.shiftKey\)\{if\(\1\.nativeEvent\.isComposing\)return;\/\*ccup-uce\*\/var ccupOn=ccupQCtx&&ccupQCtx\.useCtrlEnterToSend;if\(!ccupOn\|\|\1\.metaKey\|\|\1\.ctrlKey\)\{if\(ccupOn\)\1\.stopPropagation\(\);if\(\1\.preventDefault\(\),ccupOn&&([\w$]+)&&\2\.ccupSubmit&&\2\.ccupSubmit\(\)\)return;if\(([\w$]+)\.questions&&([\w$]+)<\3\.questions\.length-1\)([\w$]+)\(\4\+1\)\}\}\}/;
// The 1.4.x-1.5.0 form of that handler, which advanced but never submitted.
const UCE_OLD_KEY_NOSUBMIT_RE =
  /onKeyDown:\(([\w$]+)\)=>\{if\(!\1\.metaKey&&!\1\.ctrlKey\)\1\.stopPropagation\(\);if\(\1\.key==="Enter"&&!\1\.shiftKey\)\{if\(\1\.nativeEvent\.isComposing\)return;\/\*ccup-uce\*\/var ccupOn=ccupQCtx&&ccupQCtx\.useCtrlEnterToSend;if\(!ccupOn\|\|\1\.metaKey\|\|\1\.ctrlKey\)\{if\(ccupOn\)\1\.stopPropagation\(\);if\(\1\.preventDefault\(\),([\w$]+)\.questions&&([\w$]+)<\2\.questions\.length-1\)([\w$]+)\(\3\+1\)\}\}\}/;
const UCE_OLD_CONTENT_RE =
  /(\([\w$]+,([\w$]+),[\w$]+,\{onClose:[\w$]+,(?:[\w$]+:[\w$]+,)*channelId:\2\.channelId,(?:[\w$]+:[\w$]+,)*fold:[\w$]+,(?:[\w$]+:[\w$]+,)*foldButtonRef:[\w$]+[^{}]*),ccupSubmit:\(\)=>\{\/\*ccup-uce\*\/if\([\w$]+\|\|![\w$]+\)return!1;return [\w$]+\(\),!0\}\}\)/;
const UCE_OLD_PERM_RE =
  /(=async\(([\w$]+)\)=>\{if\(\2\.key==="Enter"&&!\2\.shiftKey\)\{if\(\2\.nativeEvent\.isComposing\)return;)\/\*ccup-uce\*\/if\([\w$]+\.useCtrlEnterToSend&&!\2\.metaKey&&!\2\.ctrlKey\)return;/;

function uceOldKeyNativeText(
  k: string,
  props: string,
  idx: string,
  setIdx: string,
): string {
  return (
    `onKeyDown:(${k})=>{if(!${k}.metaKey&&!${k}.ctrlKey)${k}.stopPropagation();` +
    `if(${k}.key==="Enter"&&!${k}.shiftKey){if(${k}.nativeEvent.isComposing)return;` +
    `if(${k}.preventDefault(),${props}.questions&&${idx}<${props}.questions.length-1)${setIdx}(${idx}+1)}}`
  );
}

// Strip every form, marked or old, back to native. Each old form carries the
// tag, so a bundle without it skips their six passes over the file.
function uceStrip(c: string): string {
  let out = c.replace(UCE_FRAG_RE, "");
  if (!out.includes("/*ccup-uce*/")) return out;
  out = out.replace(
    UCE_OLD_RENDER_RE,
    (_w, head, _p1, _p2, _p3, _p4, tail) => `${head}${tail}`,
  );
  out = out.replace(
    UCE_OLD_SIG_RE,
    (_w, head, _opts, tail) => `${head}${tail}`,
  );
  out = out.replace(UCE_OLD_KEY_RE, (_w, k, _opts, props, idx, setIdx) =>
    uceOldKeyNativeText(k, props, idx, setIdx),
  );
  out = out.replace(UCE_OLD_KEY_NOSUBMIT_RE, (_w, k, props, idx, setIdx) =>
    uceOldKeyNativeText(k, props, idx, setIdx),
  );
  out = out.replace(UCE_OLD_CONTENT_RE, (_w, head) => `${head}})`);
  out = out.replace(UCE_OLD_PERM_RE, (_w, head) => head);
  return out;
}

// One apply pass asks for the same build several times (present, current,
// set, then the reconcile and refresh reads), so the last native -> patched
// pair is kept; a hit costs one string compare.
let uceMemo: { input: string; output: string | null } | undefined;

function uceBuildMemo(native: string): string | null {
  if (uceMemo?.input !== native) {
    uceMemo = { input: native, output: uceBuild(native) };
  }
  return uceMemo.output;
}

// true = on in exactly this build's form (also when marked but no longer
// buildable, so an orphaned patch still reads as on and stays removable),
// false = off, or on in an older form, undefined = no marks and no sites.
function uceCurrentOn(c: string): boolean | undefined {
  const native = uceStrip(c);
  const on = uceBuildMemo(native);
  if (on === null) return c !== native ? true : undefined;
  return c === on;
}

function ucePresent(c: string): boolean {
  return uceCurrentOn(c) !== undefined;
}

function uceSet(c: string, on: boolean): string {
  const native = uceStrip(c);
  if (!on) return native;
  return uceBuildMemo(native) ?? c; // sites drifted: leave the file as it is
}

// ---------------------------------------------------------------------------
// Raw markdown of an agent response (ON): the chat renders every agent text
// block through one shared markdown component, so what Claude actually wrote
// (table pipes, link targets, list markers, a fence's language tag, the literal
// TeX behind a formula) is only ever visible as rendered output. When ON each
// response grows a button, on hover, that swaps the rendered tree for the
// markdown source and back. The button rides the turn's own timeline GUTTER,
// centered on the thread line that runs down through the message dots: it sits
// level with the block's top while that is in view, and once the block scrolls
// past it pins just under the turn header stuck to the top of the chat, so a
// long response keeps the toggle a click away at any scroll depth.
// Not the right edge, which is taken: a code block's own copy button is
// absolute at top:4px;right:4px inside .codeBlockWrapper_<hash>, which spans
// the full content column, so a button at the right edge covers that copy
// button's 24px square whenever a fence's top passes under it (a response
// that opens with one collides immediately), and ours, later in the tree with
// z-index:2, takes the click. Not the content column's left edge either, where
// it masked the first ~26px of the response's own first line. The gutter is
// the one column that carries no text and no control of its own, so the button
// covers nothing but the message dot it lands on and a 26px slice of the
// thread line, which is also why raw mode keeps it there translucent.
// It matches the jump pair's 26px square. The state is per block, so one
// response can read as source while the rest of the transcript stays rendered,
// and it resets to rendered when the webview reloads.
//
// The source needs no reconstruction: the component takes
// `{content,context,isPartialText}` (`streaming` in place of the flag since
// 2.1.301), and `content` is the markdown string as it arrived. Four inline
// fragments and one EOF line do the work, the fragments all React-rendered so
// React keeps owning the DOM it produced (the discipline the math patch follows
// too: no post-hoc mutation of a rendered tree, which React can crash on):
//
//   hook   a useState pair appended to the component's own hook chain, holding
//          this block's raw/rendered flag (appending keeps hook order stable)
//   wrapA  opens a position:relative <div> host around the component's root
//          <span>. The host is what the rail anchors to: the root span is
//          inline (its width and overflow-x declarations are inert on an inline
//          box), so it can never be a containing block itself, and its
//          `>:first-child{margin-top:0}` rule means a button placed inside it
//          would steal that reset from the response's first paragraph.
//   pre    a ternary at the head of the root span's children: raw mode renders
//          <pre><code>{content}</code></pre> in place of the markdown element
//   wrapB  the button inside its rail, then the host's closing bracket
//   pin    a marked IIFE line appended to the file (the jumpMsg pattern) that
//          measures the header stuck to the top of the chat, see below
//
// The rail is what lets the button ride: a layout-inert position:absolute strip
// (top:0;bottom:0, pointer-events:none, a negative `left` measured off the
// turn's gutter by rawMdRailLeft) down the block's left side,
// with the button position:sticky inside it. Sticky measures from the
// scrollport, so the offset has to clear whatever user turn header is stuck
// there, and that is a scroll-time question with no constant answer: a header
// is a user message, wrapping to as many lines as it needs, and the one on top
// of the pile is not always the block's own turn header, since a message sent
// while Claude is busy is folded into the running turn (foldedIntoTurn) as a
// second sticky header that takes the top over once its natural position
// scrolls past. The pin line therefore watches the chat itself: on every
// scroll, resize, or DOM change, coalesced to one rAF, it finds the header
// stuck to the top of each chat scroller and publishes that header's
// border-box height as --ccup-rawmd-top on the scroller, where every rail
// inside inherits it, with the CSS adding a 6px gap. Headers pin at top:0 and
// pile, and their natural positions only grow in document order, so the stuck
// ones are a document-order prefix and a binary search on rect.top finds the
// last of them, the one painted on top; with none stuck (scrolled to the very
// start, the transcript preview, non-sticky layouts) the value is 0 and the
// button sticks to the scrollport top. The line writes only on a change, and
// its observer drops the record that write produces, so it never re-queues
// itself.
//
// Reading the `content` prop rather than the initialized local is what keeps
// this composable with chatMathRendering: that patch routes the local through
// the KaTeX preprocessor, so the local carries base64 marker spans while the
// prop still holds the bytes Claude sent. The anchors do not overlap either
// (math wraps the initializer; the hook fragment lands after the next useState
// call), so the two apply in either order.
//
// <pre><code> is deliberate. Inside the markdown root the stock sheet already
// carries `.root_<hash> pre code{background:0 0;padding:0}` and
// `.root_<hash> code{font-family:...;font-size:.9em}`, so the raw view lands on
// the chat's code font and size (including whatever codeFontFamily and
// chatCodeBlockFontSize are set to), with none of a code block's panel chrome.
// Our own CSS only has to drop the UA <pre> margin and let long source lines
// wrap.
//
// Scope: the rail is CSS-gated to responses, via
// `[data-testid="assistant-message"]>.ccup-rawmd-host>.ccup-rawmd-rail`.
// Thinking blocks, tool-result text, compact summaries, banner copy and
// slash-command output all render through the same component but sit deeper in
// the tree, so the selector passes them over and their flag never leaves
// "rendered". That testid joins the anchor set: without it the button can never
// paint, so the point reports missing rather than writing in a feature nothing
// can reach. The messagesContainer and stickyHeader class-map hashes join it
// for the same reason: with no way to find the header stuck to the top, the
// button would pin over it, so a build that renames either key reports missing
// too.
// ---------------------------------------------------------------------------

const RAWMD_HOOK_MARKER = "/*ccup:rawMdHook*/";
const RAWMD_WRAPA_MARKER = "/*ccup:rawMdWrapA*/";
const RAWMD_PRE_MARKER = "/*ccup:rawMdPre*/";
const RAWMD_WRAPB_MARKER = "/*ccup:rawMdWrapB*/";
const RAWMD_FRAG_END = "/*ccup:rawMdEnd*/";
const RAWMD_FRAG_RE =
  /\/\*ccup:rawMd(?:Hook|WrapA|Pre|WrapB)\*\/[\s\S]*?\/\*ccup:rawMdEnd\*\//g;
const RAWMD_CSS_MARKER = "/*ccup:rawMdCss*/";
const RAWMD_PIN_MARKER = "/*ccup:rawMdPin*/";
const RAWMD_PIN_LINE_RE = /\n?\/\*ccup:rawMdPin\*\/[^\n]*/g;

// The assistant turn's own div: the scope gate for the rail, and the box whose
// hover reveals the button (it stretches the chat's full width, so its hover is
// a band at the response's height rather than a target to aim at).
const RAWMD_ROW_SEL = '[data-testid="assistant-message"]';
const RAWMD_HOST_CLASS = "ccup-rawmd-host";
const RAWMD_RAIL_CLASS = "ccup-rawmd-rail";
const RAWMD_BTN_CLASS = "ccup-rawmd-btn";
const RAWMD_PRE_CLASS = "ccup-rawmd";
// The stuck header's height, set on the buttons by the pin line's rule.
const RAWMD_TOP_VAR = "--ccup-rawmd-top";
// Gap between that header's bottom edge and the pinned button.
const RAWMD_GAP = 6;
// The jump pair's square, so the two read as one family.
const RAWMD_BTN_SIZE = 26;
const RAWMD_ICON_SIZE = 16;
// Opacity of the button in raw mode with nothing hovered, the one state where
// it stays visible, faint enough to let the dot and thread line under it show.
const RAWMD_DIM = 0.4;
// The turn's timeline gutter in webview/index.css: an assistant message's own
// padding-left, and the thread line its :after draws down through the dots
// (left + width/2 is the column the dots share, since :before centers on it
// too). The button rides that column, so both are read at build time rather
// than hardcoded, and a build that drops either falls back to the content edge.
const RAWMD_TL_RE = /\.timelineMessage_([-\w]+)\{([^}]*)\}/;
const RAWMD_TL_AFTER_RE = (h: string): RegExp =>
  new RegExp(`\\.timelineMessage_${h}:after\\{([^}]*)\\}`);
// The pin line's once-only guard on window, and the attribute numbering each
// chat scroller for its rule.
const RAWMD_PIN_FLAG = "__ccupRawMdPin";
const RAWMD_PIN_ATTR = "data-ccup-pin";
// Injected locals. The bundle is minified to short identifiers and vendors
// nothing prefixed "ccup", so these cannot shadow anything.
const RAWMD_ON = "ccupRawOn";
const RAWMD_SET = "ccupRawSet";

const rawMdFrag = (marker: string, code: string): string =>
  `${marker}${code}${RAWMD_FRAG_END}`;

// The rawMd sites, found by structure in the markdown component. hook: a
// top-level `[a,b]=useState(null)` declarator (the link context menu's state;
// top-level because hooks must be), which the hook fragment's own useState
// follows. ret: the returned root span, `return <multi>("span",{className:
// X.root,children:[...]})`, which wrapA and wrapB wrap in the host div and
// whose first child takes the pre ternary as its else branch (the markdown
// element through 2.1.281, a map over memoized source chunks since 2.1.282).
// The single-child jsx factory the pre and rail fragments call is read off the
// component's other element calls, as the one callee besides the span's that
// takes a props object. The content prop and that factory must mean at the
// root span what they mean where they were read.
let rawMdMemo: { input: string; output: string | null } | undefined;

// The attribute the CSS gate keys on, so a build that drops it reports missing.
const RAWMD_TESTID_RE = /"data-testid":"assistant-message"/;

// The two class-map hashes the pin line needs: the chat scroller, and the
// header class whose stuck member sets the offset.
const RAWMD_CHAT_HASH_RE = /messagesContainer:"messagesContainer_([-\w]+)"/;
const RAWMD_STICKY_HASH_RE = /stickyHeader:"stickyHeader_([-\w]+)"/;

// The markdown mark (rounded tag, M, descending arrow), drawn in currentColor
// with single-quoted attributes so the markup embeds in a double-quoted JS
// string without escaping.
const RAWMD_ICON =
  "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.3' " +
  "stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>" +
  "<rect x='1.4' y='3.4' width='13.2' height='9.2' rx='1.8'/>" +
  "<path d='M4.1 10.3V5.9l1.95 2.4 1.95-2.4v4.4'/>" +
  "<path d='M11.4 5.9v4.4'/><path d='M9.9 8.6l1.5 1.7 1.5-1.7'/></svg>";

const RAWMD_TIP = "Show raw markdown";
const RAWMD_TIP_ON = "Show rendered response";

// The pin line for this bundle, or undefined when a class-map anchor is gone.
// Deterministic given the bundle content, so equality against the on-disk line
// doubles as the staleness check (see rawMdCurrentOn).
function rawMdPinBuild(c: string): string | undefined {
  const chat = c.match(RAWMD_CHAT_HASH_RE)?.[1];
  const sticky = c.match(RAWMD_STICKY_HASH_RE)?.[1];
  if (!chat || !sticky) return undefined;
  const js =
    `(function(){try{` +
    `if(window.${RAWMD_PIN_FLAG})return;window.${RAWMD_PIN_FLAG}=1;` +
    `var raf=0,st=null,txt="";` +
    // Per chat scroller: the headers at or above the top are a document-order
    // prefix, so a binary search on rect.top (1px of tolerance for sub-pixel
    // drift) finds the last of them, the one painted on top of the pile. It
    // still has to sit AT the top: one scrolled clean past (an expanded header,
    // which the expandedHeader fix unsticks, or a turn's end with nothing
    // pinned after it) means nothing is stuck, and that reads 0.
    `function upd(){raf=0;var cs=document.querySelectorAll(".messagesContainer_${chat}"),css="";` +
    `for(var k=0;k<cs.length;k++){var t=cs[k],hs=t.querySelectorAll(".stickyHeader_${sticky}"),` +
    `top=t.getBoundingClientRect().top+1,lo=0,hi=hs.length-1,i=-1,v=0;` +
    `while(lo<=hi){var m=(lo+hi)>>1;if(hs[m].getBoundingClientRect().top<=top){i=m;lo=m+1}else hi=m-1}` +
    `if(i>=0){var r=hs[i].getBoundingClientRect();if(r.top>=top-3)v=r.height}` +
    // The height reaches the buttons through one rule per scroller in a
    // <style> of our own, never as an inline variable on the scroller: a
    // custom property inherits, so setting one there restyled every element
    // in the transcript at each turn crossing (~21k elements, 40-55ms in a
    // long session), where a changed rule restyles only the buttons it
    // matches. The style element sits in <head>, out of every body observer.
    `if(t.getAttribute("${RAWMD_PIN_ATTR}")!==""+k)t.setAttribute("${RAWMD_PIN_ATTR}",k);` +
    `css+='[${RAWMD_PIN_ATTR}="'+k+'"] .${RAWMD_BTN_CLASS}{${RAWMD_TOP_VAR}:'+v+'px}'}` +
    `if(!st||!st.isConnected){st=document.createElement("style");` +
    `(document.head||document.documentElement).appendChild(st);txt=""}` +
    `if(css!==txt){txt=css;st.textContent=css}}` +
    `function que(){if(!raf)raf=requestAnimationFrame(upd)}` +
    `document.addEventListener("scroll",que,!0);window.addEventListener("resize",que);` +
    // Anything in the chat (a turn arriving, a header growing, another
    // toggle's style probes) refreshes; our own writes land outside it.
    `new MutationObserver(que)` +
    `.observe(document.body,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["class","style"]});` +
    `que()` +
    `}catch(e){}})();`;
  return `${RAWMD_PIN_MARKER}${js}`;
}

// The bundle with the four inline fragments in, or null when a site is
// missing, ambiguous, or the edit would not parse.
function rawMdBuild(c: string): string | null {
  if (rawMdMemo?.input !== c) {
    rawMdMemo = { input: c, output: rawMdBuildUncached(c) };
  }
  return rawMdMemo.output;
}

function rawMdBuildUncached(c: string): string | null {
  const m = mdComponent(c);
  const content = m ? boundName(m.params[0], "content") : null;
  if (!m || !content) return null;
  const hooks: N[] = [];
  const spans: N[] = [];
  walkOwn(m, (n) => {
    const init = n.type === "VariableDeclarator" ? n.init : null;
    if (
      init?.type === "CallExpression" &&
      idName(init.callee) &&
      init.arguments.length === 1 &&
      init.arguments[0].type === "Literal" &&
      init.arguments[0].value === null &&
      n.id.type === "ArrayPattern" &&
      n.id.elements.length === 2 &&
      n.id.elements.every((e: N | null) => idName(e)) &&
      n.parent?.parent === m.body
    )
      hooks.push(n);
    const a = n.type === "ReturnStatement" ? n.argument : null;
    const props =
      a?.type === "CallExpression" &&
      idName(a.callee) &&
      isStr(a.arguments[0], "span") &&
      a.arguments[1]?.type === "ObjectExpression"
        ? a.arguments[1]
        : null;
    const kids = props ? propOf(props, "children")?.value : null;
    if (
      props &&
      memberProp(propOf(props, "className")?.value) === "root" &&
      kids?.type === "ArrayExpression" &&
      kids.elements[0]
    )
      spans.push(a);
  });
  if (hooks.length !== 1 || spans.length !== 1) return null;
  const span = spans[0];
  const multi = idName(span.callee)!;
  const singles = new Map<string, N>();
  walk(m, (n) => {
    const f = n.type === "CallExpression" ? idName(n.callee) : null;
    if (f && f !== multi && n.arguments[1]?.type === "ObjectExpression")
      singles.set(f, n);
  });
  if (singles.size !== 1) return null;
  const [[single, singleAt]] = [...singles];
  if (
    bindingSite(span, content, m) !== m ||
    bindingSite(span, single, m) !== bindingSite(singleAt, single, m)
  )
    return null;
  const first = propOf(span.arguments[1], "children")!.value.elements[0];
  const useState = idName(hooks[0].init.callee)!;
  const edits: Edit[] = [
    {
      pos: hooks[0].end,
      text: rawMdFrag(
        RAWMD_HOOK_MARKER,
        `,[${RAWMD_ON},${RAWMD_SET}]=${useState}(!1)`,
      ),
    },
    {
      pos: span.start,
      text: rawMdFrag(
        RAWMD_WRAPA_MARKER,
        `${multi}("div",{className:"${RAWMD_HOST_CLASS}",children:[`,
      ),
    },
    {
      pos: first.start,
      text: rawMdFrag(
        RAWMD_PRE_MARKER,
        `${RAWMD_ON}?${single}("pre",{className:"${RAWMD_PRE_CLASS}",` +
          `children:${single}("code",{children:${content}})}):`,
      ),
    },
    {
      pos: span.end,
      text: rawMdFrag(
        RAWMD_WRAPB_MARKER,
        `,${single}("div",{className:"${RAWMD_RAIL_CLASS}",children:` +
          `${single}("button",{type:"button",className:"${RAWMD_BTN_CLASS}",` +
          `title:${RAWMD_ON}?"${RAWMD_TIP_ON}":"${RAWMD_TIP}",` +
          `"aria-label":${RAWMD_ON}?"${RAWMD_TIP_ON}":"${RAWMD_TIP}",` +
          `"aria-pressed":${RAWMD_ON},` +
          `onClick:function(){${RAWMD_SET}(!${RAWMD_ON})},` +
          `dangerouslySetInnerHTML:{__html:"${RAWMD_ICON}"}})})]})`,
      ),
    },
  ];
  const out = applyEdits(c, edits);
  return unitsReparse(out, edits, [[m, isFn]]) ? out : null;
}

function rawMdAnchorsPresent(c: string): boolean {
  return (
    RAWMD_TESTID_RE.test(c) &&
    RAWMD_CHAT_HASH_RE.test(c) &&
    RAWMD_STICKY_HASH_RE.test(c) &&
    rawMdBuild(c) !== null
  );
}
function rawMdMarksPresent(c: string): boolean {
  RAWMD_FRAG_RE.lastIndex = 0;
  return RAWMD_FRAG_RE.test(c) || c.includes(RAWMD_PIN_MARKER);
}
function rawMdStrip(c: string): string {
  return c.replace(RAWMD_FRAG_RE, "").replace(RAWMD_PIN_LINE_RE, "");
}
// Insert the four inline fragments into a STRIPPED bundle (the caller has
// checked rawMdAnchorsPresent; an unbuildable bundle comes back unchanged).
// The pin line is appended separately, see rawMdSet.
function rawMdApplyInline(c: string): string {
  return rawMdBuild(c) ?? c;
}

// Whether a bundle, patched or not, still carries every site the inline
// fragments go into. scripts/repro/raw-markdown.mjs reads this as its drift
// canary, so it checks exactly what the patcher locates.
export function rawMdSitesFound(c: string): boolean {
  return rawMdBuild(rawMdStrip(c)) !== null;
}

function rawMdPresent(c: string): boolean {
  return rawMdMarksPresent(c) || rawMdAnchorsPresent(c);
}
// true = ON in exactly this build's form (also when marked but no longer
// rebuildable, so an orphaned patch still reads as ON and stays removable),
// false = OFF or stale, undefined = neither marks nor anchors. The inline
// fragments are compared by re-deriving them onto the stripped bundle and the
// pin line by rebuilding it, each on its own and never by whole-file equality:
// other toggles' edits elsewhere in the file are not drift, and neither is the
// order several toggles' EOF lines end up in.
function rawMdCurrentOn(c: string): boolean | undefined {
  if (!rawMdMarksPresent(c)) return rawMdAnchorsPresent(c) ? false : undefined;
  const stripped = rawMdStrip(c);
  if (!rawMdAnchorsPresent(stripped)) return true;
  return (
    c.replace(RAWMD_PIN_LINE_RE, "") === rawMdApplyInline(stripped) &&
    cssMarkedLine(c, RAWMD_PIN_MARKER) === rawMdPinBuild(stripped)
  );
}
function rawMdSet(c: string, on: boolean): string {
  if (!on) return rawMdStrip(c);
  if (rawMdCurrentOn(c) === true) return c; // stable: no rewrite on re-apply
  const stripped = rawMdStrip(c);
  if (!rawMdAnchorsPresent(stripped)) return c; // can't build here
  const line = rawMdPinBuild(stripped);
  if (line === undefined) return c;
  return `${rawMdApplyInline(stripped)}\n${line}`;
}

// A declaration's px value out of one rule body. The (?:^|;) guard is what
// keeps a bare `left` from matching `padding-left`.
function rawMdCssPx(body: string, prop: string): number | undefined {
  const m = body.match(new RegExp(`(?:^|;)${prop}:\\s*([\\d.]+)px`));
  return m ? parseFloat(m[1]) : undefined;
}
// The rail's `left`, relative to the host's own left edge (the content column):
// far enough out that the button's 26px square centers on the thread line the
// turn draws through its dots. 0 when the gutter can't be read, which puts it
// back at the content edge.
function rawMdRailLeft(css: string): number {
  const tl = css.match(RAWMD_TL_RE);
  if (!tl) return 0;
  const after = css.match(RAWMD_TL_AFTER_RE(tl[1]));
  if (!after) return 0;
  const pad = rawMdCssPx(tl[2], "padding-left");
  const left = rawMdCssPx(after[1], "left");
  const width = rawMdCssPx(after[1], "width");
  if (pad === undefined || left === undefined || width === undefined) return 0;
  return left + width / 2 - pad - RAWMD_BTN_SIZE / 2;
}
// The css side-effect: the host's positioning context, the raw block's own
// (deliberately short) rules, the rail, and the button. The rail carries the
// scope gate: only a text block that is a direct child of an assistant turn
// grows one, which is what keeps the button off thinking blocks, tool-result
// text and the other surfaces the component serves. It is absolute and
// pointer-events:none, so it neither takes flow space nor shadows anything it
// covers. Its `left` is negative, reaching back out of the host and into the
// turn's padding, where nothing clips it: an assistant message is always a
// .timelineMessage_ (the class list carrying the testid the gate keys on says
// so), and the chat scroller's own 20px side padding leaves the 26px square
// room to sit there. The host's stretch stays for the response's own blocks,
// which would otherwise shrink to fit their longest line instead of keeping
// the full column width.
//
// Out in the gutter the reveal cannot hang off the host. `:hover` follows the
// DOM rather than the boxes, so the button does keep its own host hovered from
// out there, but the few px between the rail's right edge and the text column
// belong to neither box: a pointer crossing them drops the host's hover, which
// takes the button's own pointer-events with it, so it faded and could not be
// re-hovered on the way in, and only a sweep fast enough to land in one
// mousemove ever reached it. The reveal is keyed on the turn's own div instead
// (RAWMD_ROW_SEL, the same element the scope gate keys on), which stretches
// the chat's full width: hovering anywhere at the response's height, gutter
// and text and the ragged space past the lines alike, raises that response's
// button and holds it up all the way in. That is a band, not a target, and it
// costs no new box and no new hit area, which a pseudo-element bridging the
// strip would have. A deeper surface's button cannot leak in through the
// descendant combinator either, since its rail never leaves display:none.
// The button pins inside it, clearing the turn header stuck at the top of the
// chat by the height the pin line measures. Raw mode is the one state that
// keeps the button visible with nothing hovered, sitting on the dot and the
// thread line for as long as the response reads as source, so it fades to
// RAWMD_DIM there and goes solid again on hover or keyboard focus. Both halves
// of that ride on the same appended line, where a later rule of equal
// specificity wins: the dim rule follows the lit one, and the hover/focus pair
// follows the dim one at one class more. Element opacity, not a translucent
// background, so the gutter art shows through the icon and the border too. The
// pointer-events the lit rule grants are untouched, so the ghost stays
// clickable. z-index puts it in the
// header's own layer, where tree order paints it on top: should an offset ever
// go stale the button overlaps the header instead of vanishing under it.
function rawMdCssBuild(css: string): string | undefined {
  const railLeft = rawMdRailLeft(css);
  const rail =
    `display:none;position:absolute;top:0;left:${railLeft}px;bottom:0;` +
    `width:${RAWMD_BTN_SIZE}px;pointer-events:none`;
  const btn =
    "box-sizing:border-box;display:flex;position:sticky;" +
    `top:calc(var(${RAWMD_TOP_VAR},0px) + ${RAWMD_GAP}px);` +
    "align-items:center;justify-content:center;" +
    `width:${RAWMD_BTN_SIZE}px;height:${RAWMD_BTN_SIZE}px;margin:0;padding:0;` +
    "border:1px solid var(--app-input-border);border-radius:5px;" +
    "background:var(--app-input-secondary-background);color:var(--app-secondary-foreground);" +
    "box-shadow:0 1px 3px #00000033;cursor:pointer;opacity:0;pointer-events:none;" +
    "transition:opacity .15s ease;z-index:2";
  const lit = "opacity:1;pointer-events:auto";
  const on = `color:var(--app-primary-foreground);border-color:var(--app-secondary-foreground)`;
  const dim = `opacity:${RAWMD_DIM}`;
  return (
    `${RAWMD_CSS_MARKER}.${RAWMD_HOST_CLASS}{position:relative}` +
    `${RAWMD_ROW_SEL}>.${RAWMD_HOST_CLASS}{align-self:stretch}` +
    `.${RAWMD_PRE_CLASS}{margin:0;white-space:pre-wrap;overflow-wrap:break-word;tab-size:4}` +
    `.${RAWMD_RAIL_CLASS}{${rail}}` +
    `${RAWMD_ROW_SEL}>.${RAWMD_HOST_CLASS}>.${RAWMD_RAIL_CLASS}{display:block}` +
    `.${RAWMD_BTN_CLASS}{${btn}}` +
    `${RAWMD_ROW_SEL}${HOVER} .${RAWMD_BTN_CLASS},.${RAWMD_BTN_CLASS}:focus-visible,` +
    `.${RAWMD_BTN_CLASS}[aria-pressed=true]{${lit}}` +
    `.${RAWMD_BTN_CLASS}[aria-pressed=true]{${dim}}` +
    `${RAWMD_ROW_SEL}${HOVER} .${RAWMD_BTN_CLASS}[aria-pressed=true],` +
    `.${RAWMD_BTN_CLASS}[aria-pressed=true]:focus-visible{${lit}}` +
    `.${RAWMD_BTN_CLASS}${HOVER},.${RAWMD_BTN_CLASS}[aria-pressed=true]{${on}}` +
    `.${RAWMD_BTN_CLASS} svg{display:block;` +
    `width:${RAWMD_ICON_SIZE}px;height:${RAWMD_ICON_SIZE}px}`
  );
}

interface TogglePoint {
  id: string;
  section: Section;
  label: string;
  key: string; // settings sub-key under the claudeCodeUiPatch namespace (boolean)
  defaultOn: boolean; // native default (the "off"/stock state)
  file: string; // path relative to the install dir
  // Value-swap model (re captures (prefix)(value)(suffix); onValue/offValue
  // replace the captured value). Used by the diff-card toggles.
  re?: RegExp; // global; captures (prefix)(value)(suffix)
  onValue?: string; // literal written for ON
  offValue?: string; // literal written for OFF (native)
  isOn?: (value: string) => boolean; // detect ON from the captured value (default: === onValue)
  // Custom transform for an on/off change the value-swap model can't express
  // (e.g. injecting a statement). When present, these override re/onValue/offValue/isOn.
  fnPresent?: (c: string) => boolean;
  fnCurrentOn?: (c: string) => boolean | undefined; // undefined => anchor gone
  fnSet?: (c: string, on: boolean) => string;
  // This build implements the feature itself, so there is no anchor to patch and
  // no setting value to disagree with. Checked before the anchor, and it makes
  // the point report "native": satisfied, never "missing", never actionable.
  nativeOn?: (c: string) => boolean;
  // Optional secondary CSS side-effect (a different file) applied when ON.
  cssFile?: string;
  cssMarker?: string; // comment tagging the appended rule
  cssBuild?: (css: string) => string | undefined; // full marked rule, or undefined if anchor gone
}

const TOGGLE_POINTS: TogglePoint[] = [
  {
    id: "diffLineNumbers",
    section: "Chat Panel or Tab",
    label: "diff card line numbers",
    key: "chatDiffCardLineNumbers",
    defaultOn: false,
    file: "webview/index.js",
    // Custom transform (see the absLn block above the effort-sync section): the
    // base lineNumbers swap at both createDiffEditor sites, a digit-count-based
    // gutter width (minChars:1), and the absolute-numbering enhancement that
    // threads each live Edit result's tool_use_result through to Monaco.
    fnPresent: diffLinesPresent,
    fnCurrentOn: diffLinesCurrentOn,
    fnSet: diffLinesSet,
    cssFile: "webview/index.css",
    cssMarker: DIFF_LINES_CSS_MARKER,
    cssBuild: diffLinesCssBuild,
  },
  {
    id: "diffThemeSync",
    section: "Chat Panel or Tab",
    label: "diff card theme sync",
    key: "chatDiffCardThemeSync",
    defaultOn: false,
    file: "webview/index.js",
    re: /(automaticLayout:!0,theme:)([\s\S]*?)(,fontSize:)/g,
    onValue: THEME_SYNC_ON,
    offValue: '"vs-dark"',
    isOn: (v) => v.includes("ccup-theme"),
    // 2.1.267 and later do this themselves; the anchor above serves 2.1.266
    // and earlier, where the bundle hardcoded theme:"vs-dark".
    nativeOn: themeSyncNative,
  },
  {
    id: "effortSyncFix",
    section: "Behavior",
    label: "effort-level indicator sync",
    key: "effortSyncFix",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: effortSyncPresent,
    fnCurrentOn: effortSyncCurrentOn,
    fnSet: effortSyncSet,
  },
  {
    id: "permCode",
    section: "Behavior",
    label: "Chat panel or tab: permission request syncs code block font size",
    key: "chatPermissionCodeMatchChatCodeBlock",
    defaultOn: false,
    file: "webview/index.css",
    fnPresent: permCodePresent,
    fnCurrentOn: permCodeCurrentOn,
    fnSet: permCodeSet,
  },
  {
    id: "permNoWrap",
    section: "Behavior",
    label: "Chat panel or tab: permission request code block no-wrap",
    key: "chatPermissionCodeNoWrap",
    defaultOn: false,
    file: "webview/index.css",
    fnPresent: permNoWrapPresent,
    fnCurrentOn: permNoWrapCurrentOn,
    fnSet: permNoWrapSet,
  },
  {
    id: "chatMath",
    section: "Chat Panel or Tab",
    label: "math rendering (KaTeX)",
    key: "chatMathRendering",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: mathPresent,
    fnCurrentOn: mathCurrentOn,
    fnSet: mathSet,
    // 2.1.301 and later render math themselves; the sites above serve 2.1.300
    // and earlier.
    nativeOn: mathNative,
    cssFile: "webview/index.css",
    cssMarker: MATH_CSS_MARKER,
    cssBuild: mathCssBuild,
  },
  {
    id: "scrollDot",
    section: "Behavior",
    label: "Chat panel or tab: add scroll-to-bottom button",
    key: "chatScrollToBottomDot",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: scrollDotPresent,
    fnCurrentOn: scrollDotCurrentOn,
    fnSet: scrollDotSet,
  },
  {
    id: "jumpMsg",
    section: "Behavior",
    label: "Chat panel or tab: jump to previous/next msg in chat history",
    key: "chatJumpToMessageButtons",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: jumpMsgPresent,
    fnCurrentOn: jumpMsgCurrentOn,
    fnSet: jumpMsgSet,
  },
  {
    // After scrollDot and jumpMsg: its button's slot reads both markers.
    id: "promptHist",
    section: "Behavior",
    label: "Chat panel or tab: list history of sent msgs to jump to one",
    key: "chatPromptHistoryButton",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: promptHistPresent,
    fnCurrentOn: promptHistCurrentOn,
    fnSet: promptHistSet,
  },
  {
    id: "rawMd",
    section: "Behavior",
    label: "Chat panel or tab: show an agent response as raw markdown",
    key: "chatRawMarkdownButton",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: rawMdPresent,
    fnCurrentOn: rawMdCurrentOn,
    fnSet: rawMdSet,
    cssFile: "webview/index.css",
    cssMarker: RAWMD_CSS_MARKER,
    cssBuild: rawMdCssBuild,
  },
  {
    id: "histKeys",
    section: "Behavior",
    label: "Chat panel or tab: Cmd/Ctrl + Up/Down to recall previous/next msg",
    key: "chatInputCtrlUpDownToHistory",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: histKeysPresent,
    fnCurrentOn: histKeysCurrentOn,
    fnSet: histKeysSet,
  },
  {
    id: "findBar",
    section: "Behavior",
    label: "Chat panel or tab: add FindBar (Cmd/Ctrl+F)",
    key: "chatFindBar",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: findBarPresent,
    fnCurrentOn: findBarCurrentOn,
    fnSet: findBarSet,
    cssFile: "webview/index.css",
    cssMarker: FINDBAR_CSS_MARKER,
    cssBuild: findBarCssBuild,
  },
  {
    id: "commentCtrlEnter",
    section: "Behavior",
    label: "Plan mode preview: Cmd/Ctrl + Enter to send comment",
    key: "planPreviewCommentInputCtrlEnterToSend",
    defaultOn: false,
    file: "extension.js",
    re: PLAN_COMMENT_SEND_RE,
    onValue: "(e.metaKey || e.ctrlKey)",
    offValue: "!e.shiftKey",
    isOn: (v) => v.includes("metaKey"),
  },
  {
    id: "ctrlEnterEverywhere",
    section: "Behavior",
    label: "Cmd/Ctrl + Enter to send everywhere",
    key: "useCtrlEnterToSendEverywhere",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: ucePresent,
    fnCurrentOn: uceCurrentOn,
    fnSet: uceSet,
  },
];

export type ToggleMap = Record<string, boolean>;

// The native claudeCode.useCtrlEnterToSend value: what the chat input already
// follows live, and what ctrlEnterEverywhere extends to the other boxes.
function nativeUseCtrlEnterToSend(): boolean {
  return vscode.workspace
    .getConfiguration("claudeCode")
    .get<boolean>("useCtrlEnterToSend", false);
}

export function readToggles(): ToggleMap {
  const c = vscode.workspace.getConfiguration(CONFIG_NS);
  const m: ToggleMap = {};
  for (const t of TOGGLE_POINTS) m[t.id] = c.get<boolean>(t.key, t.defaultOn);
  // The plan preview's comment box cannot read the native setting live (its
  // webview has no config channel), so ctrlEnterEverywhere reaches it by baking
  // the native value into the commentCtrlEnter swap at apply time. The explicit
  // plan toggle still forces the swap on its own, so this is a pure widening.
  if (m["ctrlEnterEverywhere"] && nativeUseCtrlEnterToSend()) {
    m["commentCtrlEnter"] = true;
  }
  return m;
}

// One-time migration for renamed settings. Copy any user-set legacy value to the
// new key (when the new key is unset) and clear the legacy key. Covered renames:
// the diff-card keys (chatDiff* → chatDiffCard*), the chat code-block size
// (chatCodeFontSize → chatCodeBlockFontSize), and the "Codeblock" → "CodeBlock"
// casing normalization of the shipped code-block keys. Safe to run every
// activation: a no-op once nothing legacy remains, and it must run before the
// Patcher reads settings so nothing reverts. (codeFontFamily needs no entry: its
// former name codeblockFontFamily never shipped.)
const LEGACY_KEY_RENAMES: [string, string][] = [
  ["chatDiffFontSize", "chatDiffCardFontSize"],
  ["chatDiffLineNumbers", "chatDiffCardLineNumbers"],
  ["chatDiffThemeSync", "chatDiffCardThemeSync"],
  ["chatCodeFontSize", "chatCodeBlockFontSize"],
  ["chatCodeblockFontSize", "chatCodeBlockFontSize"],
  ["planPreviewCodeblockFontSize", "planPreviewCodeBlockFontSize"],
  [
    "chatPermissionCodeMatchChatCodeblock",
    "chatPermissionCodeMatchChatCodeBlock",
  ],
];

export async function migrateLegacyKeys(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  for (const [oldKey, newKey] of LEGACY_KEY_RENAMES) {
    const legacy = cfg.inspect(oldKey)?.globalValue;
    if (legacy === undefined) continue;
    try {
      if (cfg.inspect(newKey)?.globalValue === undefined) {
        await cfg.update(newKey, legacy, vscode.ConfigurationTarget.Global);
      }
      await cfg.update(oldKey, undefined, vscode.ConfigurationTarget.Global);
    } catch {
      // best effort: the value is copied; clearing an unregistered legacy key can
      // throw on some VS Code versions, which is harmless (it just lingers).
    }
  }
}

// One-time migration for the 1.6.0 size schema. The seven patch-point sizes
// used to default to Claude Code's stock px, where a value equal to that stock
// meant native; they now default to 0 = native like every other size setting,
// and any px pins. A user value still equal to its old stock (Factory Reset
// wrote those, and a ▲/▼ round trip leaves one) is cleared, so it keeps
// meaning native. Once only, so a stock px pinned after the upgrade stays.
// The global scope only, the one this extension ever writes. Must run before
// the Patcher reads settings.
const SIZE_SCHEMA_MIGRATED_KEY = "claudeCodeUiPatch.sizeSchemaMigrated";

export async function migrateSizeDefaults(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.globalState.get<boolean>(SIZE_SCHEMA_MIGRATED_KEY)) return;
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const capture = context.globalState.get<StockCapture>(STOCK_VALUES_KEY, {});
  for (const p of PATCH_POINTS) {
    const v = cfg.inspect<number>(p.key)?.globalValue;
    if (typeof v !== "number") continue;
    const stock = [p.originalPx, stockNumberFor(p, capture)].map(formatPx);
    if (!stock.includes(formatPx(v))) continue;
    try {
      await cfg.update(p.key, undefined, vscode.ConfigurationTarget.Global);
    } catch {
      // best effort: a value left behind pins the old stock, which is what it
      // renders today on every build up to Claude Code 2.1.299
    }
  }
  await context.globalState.update(SIZE_SCHEMA_MIGRATED_KEY, true);
}

// One-time migration for the math size, which became 0 = native once Claude
// Code 2.1.301 began rendering math itself. A value still at the old default
// of 1 (Factory Reset wrote it) is cleared, so it keeps meaning native: the
// bundled renderer draws the text size at 0 just as it drew 1, and Claude
// Code's own math keeps its stock size. Once only, so a 1 set after the
// upgrade stays. The global scope only, as above.
const MATH_SIZE_MIGRATED_KEY = "claudeCodeUiPatch.mathSizeSchemaMigrated";

export async function migrateMathSizeDefault(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.globalState.get<boolean>(MATH_SIZE_MIGRATED_KEY)) return;
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  if (cfg.inspect<number>(MATH_EM_KEY)?.globalValue === 1) {
    try {
      await cfg.update(
        MATH_EM_KEY,
        undefined,
        vscode.ConfigurationTarget.Global,
      );
    } catch {
      // best effort: a 1 left behind pins the text size, which is what the
      // bundled renderer drew for it anyway
    }
  }
  await context.globalState.update(MATH_SIZE_MIGRATED_KEY, true);
}

function togglePresent(content: string, t: TogglePoint): boolean {
  if (t.fnPresent) return t.fnPresent(content);
  t.re!.lastIndex = 0;
  return t.re!.test(content);
}
// on/off in the bundle (reads the first match; all sites are kept in sync), or
// undefined when the anchor is absent.
function toggleCurrentOn(content: string, t: TogglePoint): boolean | undefined {
  if (t.fnCurrentOn) return t.fnCurrentOn(content);
  t.re!.lastIndex = 0;
  const m = t.re!.exec(content);
  if (!m) return undefined;
  return t.isOn ? t.isOn(m[2]) : m[2] === t.onValue;
}
// Canonical string of a toggle's FULL on-disk state: the JS anchor plus any CSS
// side-effect. Used for status, drift detection, and pending-reload. undefined if
// the JS anchor is gone. A mixed state (e.g. JS "on" from a prior build but the
// CSS rule not yet appended) yields its own string, so it never looks "current"
// and therefore gets reconciled — the fix for the CSS half being skipped.
function toggleStateStr(
  read: (rel: string) => string | undefined,
  t: TogglePoint,
): string | undefined {
  // A build that ships the feature has no state of ours, except a leftover,
  // whose own string makes stripping it ask the webview for a reload.
  if (toggleNative(read, t))
    return toggleLeftover(read, t) ? "leftover" : undefined;
  const js = read(t.file);
  if (js === undefined || !togglePresent(js, t)) return undefined;
  const jsOn = toggleCurrentOn(js, t) ? "on" : "off";
  if (!t.cssFile || !t.cssMarker) return jsOn;
  const css = read(t.cssFile);
  // "css" only when the EXACT current rule matches what we'd build now. A missing
  // rule is "nocss"; a rule that differs from the current build (e.g. a newer
  // patch version) is "stale" — both differ from "css" so they get re-applied.
  let cssState = "nocss";
  if (css !== undefined && css.includes(t.cssMarker)) {
    const want = t.cssBuild ? t.cssBuild(css) : undefined;
    cssState =
      want !== undefined && cssMarkedLine(css, t.cssMarker) === want
        ? "css"
        : "stale";
  }
  return `${jsOn}+${cssState}`;
}

// The full-state string a toggle should have for a given on/off setting.
function toggleWantStr(t: TogglePoint, on: boolean): string {
  const js = on ? "on" : "off";
  if (!t.cssFile || !t.cssMarker) return js;
  return `${js}+${on ? "css" : "nocss"}`;
}
// Whether the install's build ships the toggle's feature itself (nativeOn).
function toggleNative(read: BundleReader, t: TogglePoint): boolean {
  const js = t.nativeOn ? read(t.file) : undefined;
  return js !== undefined && t.nativeOn!(js);
}
// Whether a toggle the build now ships still carries what an earlier version
// wrote: its own edits, or its css side-effect, which 1.6.0 went on writing on
// Claude Code 2.1.301 beside the native KaTeX stylesheet. Apply strips both.
function toggleLeftover(read: BundleReader, t: TogglePoint): boolean {
  const js = read(t.file);
  if (js !== undefined && togglePresent(js, t) && toggleCurrentOn(js, t))
    return true;
  const css = t.cssFile && t.cssMarker ? read(t.cssFile) : undefined;
  return css !== undefined && css.includes(t.cssMarker!);
}
function toggleSet(content: string, t: TogglePoint, on: boolean): string {
  if (t.fnSet) return t.fnSet(content, on);
  const value = on ? t.onValue : t.offValue;
  return content.replace(t.re!, (_w, p, _v, s) => `${p}${value}${s}`);
}

function toggleByFile(): Map<string, TogglePoint[]> {
  const m = new Map<string, TogglePoint[]>();
  for (const t of TOGGLE_POINTS) {
    (m.get(t.file) ?? m.set(t.file, []).get(t.file)!).push(t);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Always-on fixes: edits the patch writes unconditionally, with no setting
// behind them. Reserved for spots where the native UI simply omits something it
// applies everywhere else, and for small additions that stay inert until used
// (the session list's delete button), so there is no native behavior worth
// preserving as an option and a knob would only be noise. They ride the same
// analyze / apply / restore / reload-cue machinery as the toggles but read no
// configuration: applying always writes the current form, restoring always
// strips it, and the panel shows no row for them. Their one user-visible
// consequence is that an install with every setting left at its default still
// patches the bundle (and so still asks for the one reload), where before it
// would leave it untouched.
// ---------------------------------------------------------------------------

// Reads one file of the install being patched, as the current pass has it.
type BundleReader = (rel: string) => string | undefined;

interface AlwaysBase {
  id: string;
  label: string;
  file: string; // path relative to the install dir
}
// One marked line appended to the file.
interface AlwaysLine extends AlwaysBase {
  kind: "line";
  marker: string;
  // The full marked line for this bundle, or undefined when the anchor is gone
  // (a drifted build: this fix is skipped, everything else still applies).
  // Deterministic given the file content, so equality against the on-disk line
  // doubles as the staleness check across Claude Code versions.
  build: (c: string) => string | undefined;
}
// Marker-delimited fragments inside the native code.
interface AlwaysInline extends AlwaysBase {
  kind: "inline";
  // Every fragment this point writes, markers included (global): removing
  // them all gives back the native bytes.
  frags: RegExp;
  // The native file with the fragments in, or null when a site is missing.
  // Deterministic given the files, so equality against the on-disk file is
  // the staleness check. `read` reaches the install's other files, for a
  // feature whose halves have to land together.
  patch: (native: string, read: BundleReader) => string | null;
  // Whether this build gives the fix nothing to change (the native code it
  // amends is absent altogether), so a null patch reads inert, not missing.
  inert?: (native: string) => boolean;
}
type AlwaysPoint = AlwaysLine | AlwaysInline;

const ALWAYS_POINTS: AlwaysPoint[] = [
  {
    kind: "line",
    id: "permRing",
    label: "permission focus ring",
    file: "webview/index.css",
    marker: PERM_RING_MARKER,
    build: permRingBuild,
  },
  {
    kind: "line",
    id: "questionReveal",
    label: "question answer box reveal",
    file: "webview/index.css",
    marker: QUESTION_REVEAL_MARKER,
    build: questionRevealBuild,
  },
  {
    kind: "line",
    id: "expandedHeader",
    label: "expanded prompt header",
    file: "webview/index.css",
    marker: EXPANDED_HEADER_MARKER,
    build: expandedHeaderBuild,
  },
  {
    kind: "line",
    id: "expandedView",
    label: "expanded prompt header view",
    file: "webview/index.js",
    marker: EXPANDED_VIEW_MARKER,
    build: expandedViewBuild,
  },
  {
    kind: "inline",
    id: "hiddenCursorHover",
    label: "hidden cursor hover gate",
    file: "webview/index.css",
    frags: NOHOVER_FRAG_RE,
    patch: hiddenCursorHoverPatch,
  },
  {
    kind: "line",
    id: "hiddenCursorWatch",
    label: "hidden cursor watch",
    file: "webview/index.js",
    marker: HIDDEN_CURSOR_MARKER,
    build: hiddenCursorWatchBuild,
  },
  {
    kind: "line",
    id: "selectionColorsCss",
    label: "editor selection colors",
    file: "webview/index.css",
    marker: SELECTION_CSS_MARKER,
    build: selectionCssBuild,
  },
  {
    kind: "line",
    id: "selectionColors",
    label: "editor selection focus watch",
    file: "webview/index.js",
    marker: SELECTION_MARKER,
    build: selectionWatchBuild,
  },
  {
    kind: "inline",
    id: "mentionRedraw",
    label: "input box selection redraw",
    file: MREDRAW_FILE,
    frags: MREDRAW_FRAG_RE,
    patch: mentionRedrawPatch,
  },
  {
    kind: "inline",
    id: "sessionDelete",
    label: "session list delete button",
    file: SDEL_WEBVIEW_FILE,
    frags: SDEL_FRAG_RE,
    patch: sessionDeleteRowPatch,
  },
  {
    kind: "inline",
    id: "sessionDeleteHost",
    label: "session list delete handler",
    file: SDEL_HOST_FILE,
    frags: SDEL_FRAG_RE,
    patch: sessionDeleteHostPatch,
  },
  {
    kind: "inline",
    id: "untitledStays",
    label: "untitled session stays",
    file: STAY_FILE,
    frags: STAY_FRAG_RE,
    patch: untitledStaysPatch,
  },
  {
    kind: "inline",
    id: "mathSpans",
    label: "inline math spans",
    file: MSPAN_FILE,
    frags: MSPAN_FRAG_RE,
    patch: mathSpansPatch,
    inert: (native) => !mathNative(native),
  },
  {
    kind: "inline",
    id: "turnRewind",
    label: "last turn delete",
    file: TRW_WEBVIEW_FILE,
    frags: TRW_FRAG_RE,
    patch: turnRewindWebPatch,
  },
  {
    kind: "inline",
    id: "turnRewindHost",
    label: "last turn delete handler",
    file: TRW_HOST_FILE,
    frags: TRW_FRAG_RE,
    patch: turnRewindHostPatch,
  },
  {
    kind: "inline",
    id: "bookmarkNote",
    label: "bookmark notes",
    file: BNOTE_WEBVIEW_FILE,
    frags: BNOTE_FRAG_RE,
    patch: bookmarkNoteWebPatch,
    inert: (native) => !native.includes(".updateSessionBookmark("),
  },
  {
    kind: "inline",
    id: "bookmarkNoteHost",
    label: "bookmark notes store",
    file: BNOTE_HOST_FILE,
    frags: BNOTE_FRAG_RE,
    patch: bookmarkNoteHostPatch,
    inert: (native) => !native.includes('"update_session_bookmark"'),
  },
];

// The on-disk state of one always-on fix, for the reload-cue comparison: its
// marked line or its fragments in file order, "off" when absent, undefined
// when the file is unreadable.
function alwaysStateStr(
  c: string | undefined,
  a: AlwaysPoint,
): string | undefined {
  if (c === undefined) return undefined;
  if (a.kind === "line") return cssMarkedLine(c, a.marker) ?? "off";
  return c.match(a.frags)?.join("") ?? "off";
}

// One always-on fix applied to a file: its current form written in, or, where
// its anchor or a site is gone, any stale form stripped. `on` says which.
function alwaysApply(
  c: string,
  a: AlwaysPoint,
  read: BundleReader,
): { out: string; on: boolean } {
  if (a.kind === "line") {
    const want = a.build(c);
    // An already-correct line stays where it sits (see cssApplyLine).
    if (cssMarkedLine(c, a.marker) === want) return { out: c, on: !!want };
    return want === undefined
      ? { out: cssRemoveLine(c, a.marker), on: false }
      : { out: cssApplyLine(c, a.marker, want), on: true };
  }
  const native = c.replace(a.frags, "");
  const want = a.patch(native, read);
  return want === null ? { out: native, on: false } : { out: want, on: true };
}

function alwaysRestore(c: string, a: AlwaysPoint): string {
  return a.kind === "line"
    ? cssRemoveLine(c, a.marker)
    : c.replace(a.frags, "");
}

// Build the diff-card gutter-cleanup rule, scoped to the diff container whose
// CSS-module hash is read from the stylesheet (undefined if the anchor is gone,
// so a future build fails gracefully: line numbers still show, just not cleaned).
function diffLinesCssBuild(css: string): string | undefined {
  DIFF_CONTAINER_HASH_RE.lastIndex = 0;
  const hashes = [
    ...new Set([...css.matchAll(DIFF_CONTAINER_HASH_RE)].map((m) => m[1])),
  ];
  if (!hashes.length) return undefined;
  const asText =
    "font-family:var(--vscode-editor-font-family),monospace !important";
  const perContainer = (hash: string): string => {
    const c = `.diffEditorContainer_${hash}`;
    const ins = `${c} .codicon-diff-insert`;
    const rem = `${c} .codicon-diff-remove`;
    return (
      // undo the codicon shrink so the sign fills the gutter, and force a text
      // font on both the element and the ::before (the box is a notdef glyph).
      `${ins},${rem}{${asText};transform:none !important;font-size:12px !important;line-height:1 !important}` +
      `${ins}::before{content:"+" !important;${asText}}` +
      `${rem}::before{content:"-" !important;${asText}}` +
      `${c} .line-numbers.active-line-number{color:var(--vscode-editorLineNumber-foreground) !important}` +
      // inset the editor from the card's left edge (see the marker's comment).
      `${c}>.monaco-diff-editor{border-left:4px solid var(--vscode-editorGutter-background)}`
    );
  };
  return DIFF_LINES_CSS_MARKER + hashes.map(perContainer).join("");
}

// Append (or replace) a single marker-tagged line in a CSS file, and its inverse.
// String-based (not regex) so a marker containing /* */ needs no escaping.
// A line that already reads exactly right is left where it sits: several marked
// lines can share one stylesheet, and a strip-and-re-append would rotate their
// order on every pass, so identical settings would keep producing different
// bytes (and a spurious "changed" entry each time).
function cssApplyLine(css: string, marker: string, line: string): string {
  if (cssMarkedLine(css, marker) === line) return css;
  const stripped = cssRemoveLine(css, marker);
  return `${stripped}\n${line}`;
}
function cssRemoveLine(css: string, marker: string): string {
  const i = css.indexOf(marker);
  if (i < 0) return css;
  const start = i > 0 && css[i - 1] === "\n" ? i - 1 : i;
  const end = css.indexOf("\n", i);
  return css.slice(0, start) + (end < 0 ? "" : css.slice(end));
}
// The marker-tagged line's current contents (marker through end of line), for
// comparing the on-disk rule against the freshly built one.
function cssMarkedLine(css: string, marker: string): string | undefined {
  const i = css.indexOf(marker);
  if (i < 0) return undefined;
  const end = css.indexOf("\n", i);
  return css.slice(i, end < 0 ? undefined : end);
}

// ---------------------------------------------------------------------------
// Injection points: settings that are neither a px slot nor a boolean toggle
// (a font-family string, a decoupled chat size, a textarea row count). Each maps
// its setting to a self-contained CSS/JS injection with an "off" state
// (undefined) meaning "leave the bundle native". They ride the same file-write /
// drift / pending-reload machinery, but carry their own value type and
// transforms so the px and toggle models are untouched.
//
//   read()    -> the EFFECTIVE value, or undefined for "off" (size 0 = inherit
//                chat.fontSize; family "" = native; rows 0 = native).
//   current() -> the value currently written into the bundle, or undefined when
//                native. So (current === read) means in sync.
// ---------------------------------------------------------------------------
type InjectValue = string | number;

interface InjectPoint {
  id: string;
  section: Section;
  label: string;
  key: string; // settings sub-key under the claudeCodeUiPatch namespace
  kind: "size" | "family" | "rows" | "align" | "scale" | "weight";
  file: string;
  showInPanel: boolean; // size shows as a knob; strings/rows are settings-only
  max: number; // upper clamp for a size knob (unused otherwise)
  min?: number; // lower clamp for a knob; MIN_PX when omitted
  defaultRaw: InjectValue; // config default
  effective: (raw: InjectValue) => InjectValue | undefined; // undefined = off
  inheritFrom?: string; // PATCH_POINT id whose size this follows when off (panel display)
  present: (c: string) => boolean; // anchor patchable in this file?
  current: (c: string) => InjectValue | undefined; // value in bundle, or undefined
  apply: (c: string, v: InjectValue) => string;
  remove: (c: string) => string;
  // A build this point has nothing to write on: it reads "inert" there,
  // satisfied and never lost, rather than "missing".
  inert?: (c: string) => boolean;
  // Factory Reset and a native floor clear the key rather than write
  // defaultRaw: its default became 0 = native, and older versions of this
  // extension read an explicit 0 as their minimum.
  clearAtNative?: boolean;
}

// chatHistoryFontSize: size the agent message body only (.root_<hash>), NOT the
// whole webview. Everything else (user messages, input box, interface
// chrome, other extensions' chats) stays on the shared native chat.fontSize, so
// the agent transcript can be enlarged (e.g. to compensate for a proportional
// reading font) without inflating the textarea or Codex. 0 = inherit (no rule).
const CHAT_SIZE_MARKER = "/*cc-ui-patch:chatSize*/";
const CHAT_SIZE_PX_RE =
  /\/\*cc-ui-patch:chatSize\*\/\.root_[-\w]+[^{\n]*\{font-size:(\d+(?:\.\d+)?)px/;

// chatHistoryFontFamily: apply a font to the agent message body only
// (.root_<hash>). Reset the whole webview's chat family to the native UI font
// (so the interface, input box, user messages, attachments, and diff-card chrome
// stay native, which also fixes caret drift under a proportional font), then
// apply the chosen family to the agent markdown, re-asserting a monospace family
// so code blocks and inline code stay monospace. User messages are left native
// on purpose: the file-name attachment chip renders INSIDE .userMessage_, so
// scoping there would drag the reading font onto that chrome (the
// chatInputHistoryFontFamily point below restyles just their text by scoping
// one level deeper).
const CHAT_FAMILY_MARKER = "/*cc-ui-patch:chatFamily*/";
const CHAT_FAMILY_VAL_RE =
  /\/\*cc-ui-patch:chatFamily\*\/[^\n]*?\.root_[-\w]+[^{\n]*\{font-family:(.+?) !important\}/;
// The agent message body is the rich markdown module: the only .root_ with
// element rules, anchored via its inline-code rule.
const CHAT_MD_HASH_RE = /\.root_([-\w]+) code\{font-family/;

// Selector the family/size scope to: the agent markdown body only. undefined if
// the markdown module is gone (leave native).
function chatContentSelector(c: string): string | undefined {
  const md = c.match(CHAT_MD_HASH_RE)?.[1];
  return md ? `.root_${md}` : undefined;
}

// chatHistoryBoldWeight: weight for **bold** runs in the agent markdown body.
// Reading serifs drawn for print (Charter, Charis, Source Serif) tend to pair a
// sturdy regular with a restrained bold, so at transcript sizes the two can read
// alike; picking a heavier cut (many families ship a 900 Black) restores the
// contrast without touching the regular weight. The bundle has no rule of its own
// for <strong>/<b> here, so native is the browser default of 700.
//
// Scoped to <strong>/<b> only, NOT headings: headings carry their own size-based
// hierarchy and are not what this knob is tuning. Code inside a bold run inherits
// the weight, which is what the surrounding sentence implies.
const CHAT_BOLD_MARKER = "/*cc-ui-patch:chatBold*/";
const CHAT_BOLD_VAL_RE =
  /\/\*cc-ui-patch:chatBold\*\/[^\n]*?\{font-weight:(\d+) !important\}/;

// chatHistoryParagraphSpacing: scale the vertical gaps between agent-message
// paragraphs. The native rule is
// `.root_<hash> p{white-space:pre-wrap;margin-top:.1em;margin-bottom:.2em}`, so
// the gap is already em-relative (it tracks chatHistoryFontSize) and asymmetric.
// The multiplier targets the VISIBLE gap, not the raw margins: what the eye
// reads as "space between paragraphs" is the collapsed margin PLUS the line
// leading (1lh - 1em; the chat container sets line-height 1.5, so ~0.5em),
// which dwarfs the tiny native margins. Multiplying only the margins made a 5x
// setting render ~2x (measured by ink-band pixels), so margin-bottom carries
// the compensation: base*mult + (mult-1)*(1lh - 1em), clamped at 0 so sub-1
// values bottom out at "paragraph break reads as a plain line break" rather
// than pulling lines closer than the in-paragraph rhythm. margin-top scales
// plainly: adjacent p margins collapse to max(), which the compensated bottom
// dominates for mult >= 1, and the plain top keeps spacing after non-p blocks
// (headings, lists, code) on its native scale. The remaining sub-mult residue
// is the font's own ink slack inside the em box, which no margin can subtract.
// The base ems are read from the native rule at apply time, so a native change
// to them is followed faithfully; the multiplier reads back out of the
// margin-bottom calc (per-marker, not whole-file, so EOF line order never
// matters), and requiring the max(0em,...) form there makes a rule written by
// the older margins-only patch read as stale and rebuild in place. Because our
// p rule carries !important it would beat the native
// `.root_<hash>>:first-child{margin-top:0}` (important over non-important) and
// re-open a gap above the first block, so we re-assert that reset with
// !important on the same line (0 needs no scaling). 1 = native (no rule).
// Settings-only, like the family points.
const CHAT_PARA_MARKER = "/*cc-ui-patch:chatParaSpacing*/";
// The native paragraph rule (captures: 1=module hash, 2=top em, 3=bottom em).
// Requires white-space:pre-wrap so our own appended rule can never re-match.
const CHAT_PARA_BASE_RE =
  /\.root_([-\w]+) p\{white-space:pre-wrap;margin-top:(\d*\.?\d+)em;margin-bottom:(\d*\.?\d+)em\}/;
// The multiplier baked into our appended rule (recovered from the compensated
// margin-bottom calc; older margins-only lines fail this on purpose).
const CHAT_PARA_MULT_RE =
  /\/\*cc-ui-patch:chatParaSpacing\*\/[^\n]*?margin-bottom:max\(0em, calc\(\d*\.?\d+em \* (\d*\.?\d+) \+ /;

// chatInputHistoryFontSize / chatInputHistoryFontFamily: size and font for the
// TEXT of sent user messages in the chat history (.expandableContainer_<hash>,
// the user-message text renderer's own CSS module, used nowhere else in the
// bundle). The text natively inherits the body's var(--vscode-chat-font-size,
// 13px) and var(--vscode-chat-font-family), i.e. the shared chat.fontSize and
// chat.fontFamily; nothing under the wrapper sets its own size or family, so
// one inherited rule per knob restyles exactly the typed text (@-mention chips
// included). Scoping one level BELOW the .userMessage_ bubble keeps its chrome
// native: the attachment chips are a SIBLING of this wrapper
// (.userMessageAttachments_), slash-command echoes render without the wrapper
// (keeping their monospace 0.9em rule), and the "Show more"/"Show less"
// buttons inside it keep the native FAMILY (the stylesheet's global button
// rule matches them directly, beating inheritance) while their em-based size
// scales with the size knob, exactly as it scales under chat.fontSize.
// Composes with the chatHistorySize/Family points in either order: those scope
// to the agent markdown module, and the chatFamily :root var reset only
// changes what this wrapper INHERITS, while these rules target it directly.
const CHAT_INPUT_SIZE_MARKER = "/*cc-ui-patch:chatInputHistorySize*/";
const CHAT_INPUT_SIZE_PX_RE =
  /\/\*cc-ui-patch:chatInputHistorySize\*\/\.expandableContainer_[-\w]+\{font-size:(\d+(?:\.\d+)?)px/;
const CHAT_INPUT_FAMILY_MARKER = "/*cc-ui-patch:chatInputHistoryFamily*/";
const CHAT_INPUT_FAMILY_VAL_RE =
  /\/\*cc-ui-patch:chatInputHistoryFamily\*\/[^\n]*?font-family:(.+?) !important\}/;
// The wrapper's class name is unique across the stylesheet (13 modules share a
// `content_` class; only the user-message text module has this one).
const CHAT_INPUT_HASH_RE = /\.expandableContainer_([-\w]+)\{/;

// codeFontFamily (chat side): apply the chosen font to chat code ONLY,
// fenced blocks (.codeBlockWrapper_<hash> pre) and inline code (.root_<hash>
// code), leaving prose, UI chrome, and diff cards native. Same selector set as
// the chatCode size patch, so block and inline stay matched. This must win over
// the chatHistoryFontFamily monospace re-assertion (which also targets
// .root_<hash> code/pre at equal specificity), so its inject point is ordered
// AFTER chatHistoryFamily below and later source order wins the tie. The wrapper
// and markdown module share one CSS-module hash, read via CHAT_CODE_HASH_RE.
const CHAT_CODE_FAMILY_MARKER = "/*cc-ui-patch:chatCodeFamily*/";
const CHAT_CODE_FAMILY_VAL_RE =
  /\/\*cc-ui-patch:chatCodeFamily\*\/[^\n]*?font-family:(.+?) !important\}/;

function applyChatCodeFamilyCss(css: string, v: string): string {
  const hash = css.match(CHAT_CODE_HASH_RE)?.[1];
  if (!hash) return css; // wrapper rule gone (version changed): nothing to anchor
  return cssApplyLine(
    css,
    CHAT_CODE_FAMILY_MARKER,
    `${CHAT_CODE_FAMILY_MARKER}.codeBlockWrapper_${hash} pre,.codeBlockWrapper_${hash} pre code,.root_${hash} code{font-family:${v} !important}`,
  );
}

// codeFontFamily (permission side): the permission "Allow this command?"
// block (.bashCommand_<hash>) is monospace via --app-monospace-font-family;
// append a scoped rule pinning it to the chosen font. Shares the
// .bashCommand_<hash> anchor with the permCode / permNoWrap toggles, setting a
// disjoint property (font-family) so all three compose freely.
const PERM_CODE_FAMILY_MARKER = "/*cc-ui-patch:permCodeFamily*/";
const PERM_CODE_FAMILY_VAL_RE =
  /\/\*cc-ui-patch:permCodeFamily\*\/[^\n]*?font-family:(.+?) !important\}/;

// planPreviewFontFamily: the plan preview is its own webview; swap its <body>
// font-family so the chosen reading font applies to the rendered plan (stock is
// the markdown var). Composes with the planPreviewFontSize point, which anchors
// on the same rule's font-size independent of the family.
//
// One deliberate exception: the floating "Add Comment" button (#comment-btn)
// that appears on text selection is a native VS Code button, but it inherits the
// <body> font, so a reading font drags a serif face onto it. When a family is
// set we pin ONLY that button back to the UI font; the rest of the preview (the
// prose, the review banner, and the comment popup's own controls) keeps the
// reading font, as before. The override rides with the family: added when a
// family is set, removed when it is cleared.
const PLAN_BTN_MARKER = "/*cc-ui-patch:planCommentBtn*/";
const PLAN_FAMILY_STOCK =
  "var(--vscode-markdown-font-family, var(--vscode-font-family))";
// The whole plan-preview <body> rule (unique in the bundle): the splice anchor
// for the button override.
const PLAN_BODY_RULE_RE = /body \{[^}]*\}/;
const PLAN_FAMILY_RE =
  /(body \{\s*font-family:\s*)(var\(--vscode-markdown-font-family, var\(--vscode-font-family\)\)|[^;]+?)(;\s*font-size:)/;
// The button override rule, present only while a family is applied.
const PLAN_BTN_RE =
  /\/\*cc-ui-patch:planCommentBtn\*\/#comment-btn\{font-family:.+? !important\}/;

// Reset any <body> swap back to stock and drop the button override, returning
// the preview to native. Idempotent (a no-op when neither is present), so it
// doubles as the reconcile/restore path and cleans a legacy swap-only bundle.
function planRemoveFamily(c: string): string {
  const body = c.replace(
    PLAN_FAMILY_RE,
    (_w, p, _v, s) => `${p}${PLAN_FAMILY_STOCK}${s}`,
  );
  const i = body.indexOf(PLAN_BTN_MARKER);
  if (i < 0) return body;
  const end = body.indexOf("}", i);
  return end < 0 ? body : body.slice(0, i) + body.slice(end + 1);
}

// Swap the <body> font-family to the chosen family (so the rendered plan uses
// it) and splice a rule pinning the floating "Add Comment" button back to the UI
// font, right after the <body> rule.
function planInjectFamily(c: string, v: InjectValue): string {
  const swapped = planRemoveFamily(c).replace(
    PLAN_FAMILY_RE,
    (_w, p, _v, s) => `${p}${v}${s}`,
  );
  const m = swapped.match(PLAN_BODY_RULE_RE);
  if (!m) return swapped; // body rule gone: family swapped, no anchor for override
  const idx = (m.index ?? 0) + m[0].length;
  const rule = `${PLAN_BTN_MARKER}#comment-btn{font-family:var(--vscode-font-family) !important}`;
  return swapped.slice(0, idx) + rule + swapped.slice(idx);
}

// planPreviewCommentInputRows: the select-and-comment textarea has no rows
// attribute (defaults to ~3 lines via min-height); inject one so it opens taller.
const PLAN_ROWS_RE =
  /(<textarea id="comment-textarea")(?: rows="\d+")?( placeholder=)/;
const PLAN_ROWS_READ_RE = /<textarea id="comment-textarea" rows="(\d+)"/;

function clampSizePx(n: number): number {
  return Math.min(MAX_PX, Math.max(MIN_PX, Math.round(n * 100) / 100));
}

// chatCodeInlineFontSize / planPreviewCodeInlineFontSize: add-on overrides that
// size ONLY inline code (a <code> whose parent is not <pre>), so blocks and
// inline can be tuned separately. 0 = off, inline then follows the block/code
// knob (chatCodeBlockFontSize / planPreviewCodeBlockFontSize), which is left
// unchanged. `:not(pre) > code` wins over the base code rule by specificity and
// never matches block code (parent <pre>), so block sizing is untouched.
const CHAT_CODE_INLINE_MARKER = "/*cc-ui-patch:chatCodeInline*/";
const CHAT_CODE_INLINE_PX_RE =
  /\/\*cc-ui-patch:chatCodeInline\*\/[^\n]*?font-size:(\d+(?:\.\d+)?)px/;

// Plan preview: the inline override is spliced in right after the general
// `code {}` rule (anchored on its editor-font-family declaration).
const PLAN_CODE_INLINE_MARKER = "/*cc-ui-patch:planCodeInline*/";
const PLAN_CODE_INLINE_PX_RE =
  /\/\*cc-ui-patch:planCodeInline\*\/:not\(pre\) > code\{font-size:(\d+(?:\.\d+)?)px/;
const PLAN_CODE_RULE_RE =
  /code \{\s*font-family: var\(--vscode-editor-font-family\);[^}]*\}/;

function planRemoveCodeInline(c: string): string {
  const i = c.indexOf(PLAN_CODE_INLINE_MARKER);
  if (i < 0) return c;
  const end = c.indexOf("}", i);
  return end < 0 ? c : c.slice(0, i) + c.slice(end + 1);
}

function planInjectCodeInline(c: string, v: InjectValue): string {
  const cleaned = planRemoveCodeInline(c);
  const m = cleaned.match(PLAN_CODE_RULE_RE);
  if (!m) return c; // general code rule gone: leave native
  const idx = (m.index ?? 0) + m[0].length;
  const rule = `${PLAN_CODE_INLINE_MARKER}:not(pre) > code{font-size:${v}px !important}`;
  return cleaned.slice(0, idx) + rule + cleaned.slice(idx);
}

// codeFontFamily (plan-preview side): the preview `code {}` rule reads
// font-family: var(--vscode-editor-font-family) and covers both inline and
// `pre code`. Two other anchors (planPreviewCodeBlockFontSize, planCodeInline)
// key off that literal declaration, so we must NOT rewrite it. Instead append a
// scoped `code{font-family:<v> !important}` rule after the stable `pre code`
// rule: the !important beats the base rule (which has none) for inline and block
// code alike, while the anchored text stays intact for the other points.
const PLAN_CODE_FAMILY_MARKER = "/*cc-ui-patch:planCodeFamily*/";
const PLAN_PRE_CODE_RE = /pre code\s*\{[^}]*\}/;
const PLAN_CODE_FAMILY_VAL_RE =
  /\/\*cc-ui-patch:planCodeFamily\*\/code\{font-family:(.+?) !important\}/;

function planRemoveCodeFamily(c: string): string {
  const i = c.indexOf(PLAN_CODE_FAMILY_MARKER);
  if (i < 0) return c;
  const end = c.indexOf("}", i);
  return end < 0 ? c : c.slice(0, i) + c.slice(end + 1);
}

function planInjectCodeFamily(c: string, v: InjectValue): string {
  const cleaned = planRemoveCodeFamily(c);
  const m = cleaned.match(PLAN_PRE_CODE_RE);
  if (!m) return c; // pre code rule gone: leave native
  const idx = (m.index ?? 0) + m[0].length;
  const rule = `${PLAN_CODE_FAMILY_MARKER}code{font-family:${v} !important}`;
  return cleaned.slice(0, idx) + rule + cleaned.slice(idx);
}

// chatInputMaxLines: the chat input box (.messageInput_<hash>, a contenteditable
// div; .mentionMirror_<hash> is the overlay that paints its text) grows with
// content up to a hardcoded max-height:200px, then scrolls. Two native quirks
// at that cap: how many lines fit depends on chat.fontSize (the cap is a fixed
// px, not a line count), and the caret reveal scrolls just far enough to show
// the caret's line box, so the 10px bottom padding stays below the fold and the
// last line sits flush on the box edge. N >= 1 appends a scoped rule replacing
// the cap with exactly N lines (line-height em units, so it tracks any chat
// font size), clamped to 70vh so a huge N cannot swallow a short window, plus
// scroll-padding matching the box's vertical padding so the caret reveal always
// keeps that spacing visible above and below. 0 = native (both quirks). The
// line-height and paddings are parsed from the anchored rule so the numbers
// track the bundle; the anchor requires a unitless line-height and a 4-value px
// padding and fails gracefully (native) on any other form. The mirror gets the
// same cap to stay metric-identical; it needs no scroll-padding (overflow is
// hidden there, the JS copies the input's scrollTop on the input's scroll
// events).
//
// The mirror also gets one line of extra bottom padding. The editable layer can
// lay out a caret line the static mirror does not: deleting back to a trailing
// newline leaves the input's scrollHeight one line taller than a fresh layout
// of the same text (the mirror's), so at max scroll the mirror clamps a line
// short of the copied scrollTop and every glyph paints a line below the caret
// ("cursor on the wrong line" while typing at the end). Extra padding-bottom
// extends only the mirror's scrollable range (its box is capped by max-height,
// and text position at a given scrollTop is unchanged), so the copy can always
// reach the input's scrollTop; whenever the heights already agree the extra
// range is simply never scrolled into.
const MSG_INPUT_MARKER = "/*cc-ui-patch:inputLines*/";
const MSG_INPUT_RULE_RE =
  /\.messageInput_([-\w]+)\{[^{}]*?max-height:\d+(?:\.\d+)?px;padding:(\d+(?:\.\d+)?)px \d+(?:\.\d+)?px (\d+(?:\.\d+)?)px \d+(?:\.\d+)?px;[^{}]*?line-height:(\d+(?:\.\d+)?)\}/;
// Requires the mirror's compensating padding-bottom segment, so a line written
// by the older patch (without it) reads as stale and rebuilds in place.
const MSG_INPUT_EM_RE =
  /\/\*cc-ui-patch:inputLines\*\/[^\n]*?max-height:min\((\d+(?:\.\d+)?)em,70vh\)[^\n]*?\.mentionMirror_[-\w]+\{padding-bottom:calc\(\d+(?:\.\d+)?px \+ 1lh\)/;

// chatPopupInputMaxLines: the AskUserQuestion "Other" answer box and the
// permission feedback box are the two mounts of one ContentEditableInput
// module: a padded, bordered wrapper (.otherInput_ / .rejectMessageInput_)
// around an inner scroller (.input_<hash>) that grows with content up to a
// hardcoded max-height:120px, then scrolls. As with the chat input, the cap is
// fixed px, so how many lines fit shrinks as the chat font grows (both boxes
// inherit it, the Other box at .9em). N >= 1 appends a scoped rule replacing
// the cap with exactly N lines (line-height em units, so it tracks each box's
// own font size), clamped to 70vh so a huge N cannot swallow a short window.
// 0 = native. No scroll-padding or mirror term here, unlike the chat input:
// the inner scroller carries no padding or border of its own (the wrapper
// does), so the caret reveal already aligns line boxes flush with its edges,
// and the box paints its text directly (no mirror overlay). The questionReveal
// scroll-padding fix reads only wrapper and option-row numbers, so it is
// unaffected by the taller scroller. The .input_ class name is generic (other
// modules hash one too), so the anchor requires the module's distinctive
// overflow-y:auto + px max-height + unitless line-height run, confirmed by the
// wrapper and placeholder rules sharing its hash.
const POPUP_INPUT_MARKER = "/*cc-ui-patch:popupInputLines*/";
const POPUP_INPUT_RULE_RE =
  /\.input_([-\w]+)\{[^{}]*?overflow-y:auto[^{}]*?max-height:\d+(?:\.\d+)?px;line-height:(\d+(?:\.\d+)?)\}/;
const POPUP_INPUT_EM_RE =
  /\/\*cc-ui-patch:popupInputLines\*\/[^\n]*?max-height:min\((\d+(?:\.\d+)?)em,70vh\)/;
// The module's inner-scroller rule, with the sibling-rule confirmation.
// undefined when the module is gone or reshaped (leave native).
function popupInputAnchor(c: string): RegExpMatchArray | undefined {
  const m = c.match(POPUP_INPUT_RULE_RE);
  if (
    !m ||
    !c.includes(`.wrapper_${m[1]}{`) ||
    !c.includes(`.placeholder_${m[1]}{`)
  )
    return undefined;
  return m;
}

const INJECT_POINTS: InjectPoint[] = [
  {
    id: "chatHistorySize",
    section: "Chat Panel or Tab",
    label: "agent response",
    key: "chatHistoryFontSize",
    kind: "size",
    file: "webview/index.css",
    showInPanel: true,
    max: 48,
    defaultRaw: 0,
    effective: (raw) =>
      typeof raw === "number" && raw > 0 ? clampSizePx(raw) : undefined,
    present: (c) => CHAT_MD_HASH_RE.test(c),
    current: (c) => {
      const m = c.match(CHAT_SIZE_PX_RE);
      return m ? Number(m[1]) : undefined;
    },
    apply: (c, v) => {
      const sel = chatContentSelector(c);
      if (!sel) return c; // markdown anchor gone: leave native
      return cssApplyLine(
        c,
        CHAT_SIZE_MARKER,
        `${CHAT_SIZE_MARKER}${sel}{font-size:${v}px !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, CHAT_SIZE_MARKER),
  },
  {
    id: "chatHistoryFamily",
    section: "Chat Panel or Tab",
    label: "font family",
    key: "chatHistoryFontFamily",
    kind: "family",
    file: "webview/index.css",
    showInPanel: false,
    max: 0,
    defaultRaw: "",
    effective: (raw) =>
      typeof raw === "string" && raw.trim() ? raw.trim() : undefined,
    present: (c) => CHAT_MD_HASH_RE.test(c),
    current: (c) => c.match(CHAT_FAMILY_VAL_RE)?.[1],
    apply: (c, v) => {
      const sel = chatContentSelector(c);
      const md = c.match(CHAT_MD_HASH_RE)?.[1];
      if (!sel || !md) return c; // markdown anchor gone: leave native
      return cssApplyLine(
        c,
        CHAT_FAMILY_MARKER,
        `${CHAT_FAMILY_MARKER}:root{--vscode-chat-font-family:var(--vscode-font-family) !important}` +
          `${sel}{font-family:${v} !important}` +
          `.root_${md} code,.root_${md} pre{font-family:var(--app-monospace-font-family) !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, CHAT_FAMILY_MARKER),
  },
  {
    id: "chatBoldWeight",
    section: "Chat Panel or Tab",
    label: "agent bold weight",
    key: "chatHistoryBoldWeight",
    kind: "weight",
    file: "webview/index.css",
    showInPanel: true,
    max: MAX_WEIGHT,
    min: MIN_WEIGHT,
    defaultRaw: 0,
    // 0 = native. Anything else snaps to the nearest 100 within [400, 900]; the
    // native 700 also writes no rule, so the knob returns to native by stepping
    // back up to it rather than needing the setting cleared by hand.
    effective: (raw) => {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)
        return undefined;
      const w =
        Math.round(
          Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, raw)) / WEIGHT_STEP,
        ) * WEIGHT_STEP;
      return w === NATIVE_BOLD_WEIGHT ? undefined : w;
    },
    present: (c) => CHAT_MD_HASH_RE.test(c),
    current: (c) => {
      const m = c.match(CHAT_BOLD_VAL_RE);
      return m ? Number(m[1]) : undefined;
    },
    apply: (c, v) => {
      const sel = chatContentSelector(c);
      if (!sel) return c; // markdown anchor gone: leave native
      return cssApplyLine(
        c,
        CHAT_BOLD_MARKER,
        `${CHAT_BOLD_MARKER}${sel} strong,${sel} b{font-weight:${v} !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, CHAT_BOLD_MARKER),
  },
  {
    id: "chatParaSpacing",
    section: "Chat Panel or Tab",
    label: "agent paragraph spacing",
    key: "chatHistoryParagraphSpacing",
    kind: "scale",
    file: "webview/index.css",
    showInPanel: false,
    max: 0,
    defaultRaw: 1,
    effective: (raw) => {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
      const m = Math.round(Math.min(5, Math.max(0, raw)) * 100) / 100;
      return m === 1 ? undefined : m; // 1x = native, no rule
    },
    present: (c) => CHAT_PARA_BASE_RE.test(c),
    current: (c) => {
      const m = c.match(CHAT_PARA_MULT_RE);
      return m ? Number(m[1]) : undefined;
    },
    apply: (c, v) => {
      const m = c.match(CHAT_PARA_BASE_RE);
      if (!m) return c; // native paragraph rule gone: leave native
      return cssApplyLine(
        c,
        CHAT_PARA_MARKER,
        `${CHAT_PARA_MARKER}.root_${m[1]} p{margin-top:calc(${m[2]}em * ${v}) !important;margin-bottom:max(0em, calc(${m[3]}em * ${v} + (${v} - 1) * (1lh - 1em))) !important}` +
          `.root_${m[1]}>:first-child{margin-top:0 !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, CHAT_PARA_MARKER),
  },
  {
    id: "chatMathSize",
    section: "Chat Panel or Tab",
    label: "math size",
    key: MATH_EM_KEY,
    kind: "scale",
    file: "webview/index.css",
    showInPanel: false,
    max: 0,
    defaultRaw: 0,
    clearAtNative: true,
    effective: (raw) => mathEmPin(raw),
    inert: (c) => !nativeMathCss(c),
    present: (c) => mathSizeRoot(c) !== undefined,
    current: (c) => {
      const m = c.match(MATH_SIZE_EM_RE);
      return m ? Number(m[1]) : undefined;
    },
    apply: (c, v) => {
      const h = mathSizeRoot(c);
      if (!h) return c; // native math rule gone: leave native
      return cssApplyLine(
        c,
        MATH_SIZE_MARKER,
        `${MATH_SIZE_MARKER}.root_${h} .katex{font-size:${v}em}`,
      );
    },
    remove: (c) => cssRemoveLine(c, MATH_SIZE_MARKER),
  },
  {
    id: "chatInputHistorySize",
    section: "Chat Panel or Tab",
    label: "user message history",
    key: "chatInputHistoryFontSize",
    kind: "size",
    file: "webview/index.css",
    showInPanel: true,
    max: 48,
    defaultRaw: 0,
    effective: (raw) =>
      typeof raw === "number" && raw > 0 ? clampSizePx(raw) : undefined,
    present: (c) =>
      c.includes(CHAT_INPUT_SIZE_MARKER) || CHAT_INPUT_HASH_RE.test(c),
    current: (c) => {
      const m = c.match(CHAT_INPUT_SIZE_PX_RE);
      return m ? Number(m[1]) : undefined;
    },
    apply: (c, v) => {
      const hash = c.match(CHAT_INPUT_HASH_RE)?.[1];
      if (!hash) return c; // anchor gone: leave native
      return cssApplyLine(
        c,
        CHAT_INPUT_SIZE_MARKER,
        `${CHAT_INPUT_SIZE_MARKER}.expandableContainer_${hash}{font-size:${v}px !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, CHAT_INPUT_SIZE_MARKER),
  },
  {
    id: "chatInputHistoryFamily",
    section: "Chat Panel or Tab",
    label: "user message font family",
    key: "chatInputHistoryFontFamily",
    kind: "family",
    file: "webview/index.css",
    showInPanel: false,
    max: 0,
    defaultRaw: "",
    effective: (raw) =>
      typeof raw === "string" && raw.trim() ? raw.trim() : undefined,
    present: (c) =>
      c.includes(CHAT_INPUT_FAMILY_MARKER) || CHAT_INPUT_HASH_RE.test(c),
    current: (c) => c.match(CHAT_INPUT_FAMILY_VAL_RE)?.[1],
    apply: (c, v) => {
      const hash = c.match(CHAT_INPUT_HASH_RE)?.[1];
      if (!hash) return c; // anchor gone: leave native
      return cssApplyLine(
        c,
        CHAT_INPUT_FAMILY_MARKER,
        `${CHAT_INPUT_FAMILY_MARKER}.expandableContainer_${hash}{font-family:${v} !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, CHAT_INPUT_FAMILY_MARKER),
  },
  {
    id: "chatCodeFamily",
    section: "Chat Panel or Tab",
    label: "code font family",
    key: "codeFontFamily",
    kind: "family",
    file: "webview/index.css",
    showInPanel: false,
    max: 0,
    defaultRaw: "",
    effective: (raw) =>
      typeof raw === "string" && raw.trim() ? raw.trim() : undefined,
    present: (c) =>
      c.includes(CHAT_CODE_FAMILY_MARKER) || CHAT_CODE_WRAP_RE.test(c),
    current: (c) => c.match(CHAT_CODE_FAMILY_VAL_RE)?.[1],
    apply: (c, v) => applyChatCodeFamilyCss(c, String(v)),
    remove: (c) => cssRemoveLine(c, CHAT_CODE_FAMILY_MARKER),
  },
  {
    id: "permCodeFamily",
    section: "Chat Panel or Tab",
    label: "permission code font family",
    key: "codeFontFamily",
    kind: "family",
    file: "webview/index.css",
    showInPanel: false,
    max: 0,
    defaultRaw: "",
    effective: (raw) =>
      typeof raw === "string" && raw.trim() ? raw.trim() : undefined,
    present: (c) =>
      c.includes(PERM_CODE_FAMILY_MARKER) || BASH_CMD_HASH_RE.test(c),
    current: (c) => c.match(PERM_CODE_FAMILY_VAL_RE)?.[1],
    apply: (c, v) => {
      const hash = c.match(BASH_CMD_HASH_RE)?.[1];
      if (!hash) return c; // anchor gone: leave native
      return cssApplyLine(
        c,
        PERM_CODE_FAMILY_MARKER,
        `${PERM_CODE_FAMILY_MARKER}.bashCommand_${hash}{font-family:${v} !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, PERM_CODE_FAMILY_MARKER),
  },
  {
    id: "planFamily",
    section: "Plan Mode Markdown Preview",
    label: "font family",
    key: "planPreviewFontFamily",
    kind: "family",
    file: "extension.js",
    showInPanel: false,
    max: 0,
    defaultRaw: "",
    effective: (raw) =>
      typeof raw === "string" && raw.trim() ? raw.trim() : undefined,
    present: (c) => PLAN_FAMILY_RE.test(c),
    // Report the applied family only when the button override is also in place:
    // a legacy swap-only bundle (older builds set just the body font) then reads
    // as native, so a saved family drifts on this build's first activation and
    // applyPatch re-applies, adding the override.
    current: (c) => {
      if (!PLAN_BTN_RE.test(c)) return undefined;
      const m = c.match(PLAN_FAMILY_RE);
      return m && m[2] !== PLAN_FAMILY_STOCK ? m[2] : undefined;
    },
    apply: (c, v) => planInjectFamily(c, v),
    remove: (c) => planRemoveFamily(c),
  },
  {
    id: "planCommentRows",
    section: "Plan Mode Markdown Preview",
    label: "comment rows",
    key: "planPreviewCommentInputRows",
    kind: "rows",
    file: "extension.js",
    showInPanel: false,
    max: 0,
    defaultRaw: 0,
    effective: (raw) =>
      typeof raw === "number" && raw >= 1
        ? Math.min(40, Math.round(raw))
        : undefined,
    present: (c) => PLAN_ROWS_RE.test(c),
    current: (c) => {
      const m = c.match(PLAN_ROWS_READ_RE);
      return m ? Number(m[1]) : undefined;
    },
    apply: (c, v) =>
      c.replace(PLAN_ROWS_RE, (_w, p, s) => `${p} rows="${v}"${s}`),
    remove: (c) => c.replace(PLAN_ROWS_RE, (_w, p, s) => `${p}${s}`),
  },
  {
    id: "chatCodeInline",
    section: "Chat Panel or Tab",
    label: "inline code",
    key: "chatCodeInlineFontSize",
    kind: "size",
    file: "webview/index.css",
    showInPanel: true,
    max: 24,
    defaultRaw: 0,
    effective: (raw) =>
      typeof raw === "number" && raw > 0 ? clampSizePx(raw) : undefined,
    inheritFrom: "chatCode",
    present: (c) => CHAT_MD_HASH_RE.test(c),
    current: (c) => {
      const m = c.match(CHAT_CODE_INLINE_PX_RE);
      return m ? Number(m[1]) : undefined;
    },
    apply: (c, v) => {
      const hash = c.match(CHAT_MD_HASH_RE)?.[1];
      if (!hash) return c; // markdown anchor gone: leave native
      return cssApplyLine(
        c,
        CHAT_CODE_INLINE_MARKER,
        `${CHAT_CODE_INLINE_MARKER}.root_${hash} :not(pre) > code{font-size:${v}px !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, CHAT_CODE_INLINE_MARKER),
  },
  {
    id: "planCodeInline",
    section: "Plan Mode Markdown Preview",
    label: "inline code",
    key: "planPreviewCodeInlineFontSize",
    kind: "size",
    file: "extension.js",
    showInPanel: true,
    max: 24,
    defaultRaw: 0,
    effective: (raw) =>
      typeof raw === "number" && raw > 0 ? clampSizePx(raw) : undefined,
    inheritFrom: "code",
    present: (c) => PLAN_CODE_RULE_RE.test(c),
    current: (c) => {
      const m = c.match(PLAN_CODE_INLINE_PX_RE);
      return m ? Number(m[1]) : undefined;
    },
    apply: (c, v) => planInjectCodeInline(c, v),
    remove: (c) => planRemoveCodeInline(c),
  },
  {
    id: "planCodeFamily",
    section: "Plan Mode Markdown Preview",
    label: "code font family",
    key: "codeFontFamily",
    kind: "family",
    file: "extension.js",
    showInPanel: false,
    max: 0,
    defaultRaw: "",
    effective: (raw) =>
      typeof raw === "string" && raw.trim() ? raw.trim() : undefined,
    present: (c) => PLAN_PRE_CODE_RE.test(c),
    current: (c) => c.match(PLAN_CODE_FAMILY_VAL_RE)?.[1],
    apply: (c, v) => planInjectCodeFamily(c, v),
    remove: (c) => planRemoveCodeFamily(c),
  },
  {
    id: "showMoreAlign",
    section: "Behavior",
    label: "show more/less align",
    key: "chatShowMoreAndLessAlign",
    kind: "align",
    file: "webview/index.css",
    showInPanel: false,
    max: 0,
    defaultRaw: "",
    effective: (raw) => (raw === "left" || raw === "right" ? raw : undefined),
    present: (c) => SHOW_MORE_HASH_RE.test(c),
    current: (c) => {
      const line = cssMarkedLine(c, SHOW_MORE_MARKER);
      if (line === undefined) return undefined; // native (no rule)
      // A pre-fix rule (no absolute "Show more" block) reads as native so the
      // drift gate re-applies the current form on upgrade.
      if (!line.includes("position:absolute")) return undefined;
      return line.includes("margin-left:auto") ? "right" : "left";
    },
    apply: (c, v) => {
      const hash = c.match(SHOW_MORE_HASH_RE)?.[1];
      if (!hash) return c; // anchor gone: leave native
      // "Show more" stays position:absolute so it keeps overlaying the content
      // and never adds height (the source of the old hover jitter); only its
      // horizontal anchor flips. "Show less" is already in flow, so an auto
      // margin on the opposite side pins it without changing its slot.
      const expand =
        v === "right"
          ? "position:absolute !important;left:auto !important;right:0 !important"
          : "position:absolute !important;right:auto !important;left:0 !important";
      const collapse =
        v === "right"
          ? "position:static !important;margin-left:auto !important"
          : "position:static !important;margin-right:auto !important";
      return cssApplyLine(
        c,
        SHOW_MORE_MARKER,
        `${SHOW_MORE_MARKER}.expandButton_${hash}{${expand}}.collapseButton_${hash}{${collapse}}`,
      );
    },
    remove: (c) => cssRemoveLine(c, SHOW_MORE_MARKER),
  },
  {
    id: "chatInputLines",
    section: "Behavior",
    label: "input box max lines",
    key: "chatInputMaxLines",
    kind: "rows",
    file: "webview/index.css",
    showInPanel: false,
    max: 0,
    defaultRaw: 0,
    effective: (raw) =>
      typeof raw === "number" && raw >= 1
        ? Math.min(40, Math.round(raw))
        : undefined,
    present: (c) => c.includes(MSG_INPUT_MARKER) || MSG_INPUT_RULE_RE.test(c),
    // Lines currently written, derived as em-cap / line-height. Deriving (rather
    // than storing N) means a rule built by an older patch against different
    // metrics stops reading as current and gets rebuilt in place.
    current: (c) => {
      const em = c.match(MSG_INPUT_EM_RE)?.[1];
      const lh = c.match(MSG_INPUT_RULE_RE)?.[4];
      if (em === undefined || lh === undefined) return undefined;
      return Math.round((Number(em) / Number(lh)) * 100) / 100;
    },
    apply: (c, v) => {
      const m = c.match(MSG_INPUT_RULE_RE);
      if (!m) return c; // input rule gone or reshaped: leave native
      const [, hash, padTop, padBottom, lineHeight] = m;
      const em = Math.round(Number(lineHeight) * Number(v) * 100) / 100;
      return cssApplyLine(
        c,
        MSG_INPUT_MARKER,
        `${MSG_INPUT_MARKER}.messageInput_${hash},.mentionMirror_${hash}{max-height:min(${em}em,70vh) !important}` +
          `.messageInput_${hash}{scroll-padding:${padTop}px 0 ${padBottom}px !important}` +
          `.mentionMirror_${hash}{padding-bottom:calc(${padBottom}px + 1lh) !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, MSG_INPUT_MARKER),
  },
  {
    id: "popupInputLines",
    section: "Behavior",
    label: "popup input max lines",
    key: "chatPopupInputMaxLines",
    kind: "rows",
    file: "webview/index.css",
    showInPanel: false,
    max: 0,
    defaultRaw: 0,
    effective: (raw) =>
      typeof raw === "number" && raw >= 1
        ? Math.min(40, Math.round(raw))
        : undefined,
    present: (c) => c.includes(POPUP_INPUT_MARKER) || !!popupInputAnchor(c),
    // Lines currently written, derived as em-cap / line-height (see
    // chatInputLines above for why derive rather than store N).
    current: (c) => {
      const em = c.match(POPUP_INPUT_EM_RE)?.[1];
      const lh = c.match(POPUP_INPUT_RULE_RE)?.[2];
      if (em === undefined || lh === undefined) return undefined;
      return Math.round((Number(em) / Number(lh)) * 100) / 100;
    },
    apply: (c, v) => {
      const m = popupInputAnchor(c);
      if (!m) return c; // module gone or reshaped: leave native
      const em = Math.round(Number(m[2]) * Number(v) * 100) / 100;
      return cssApplyLine(
        c,
        POPUP_INPUT_MARKER,
        `${POPUP_INPUT_MARKER}.input_${m[1]}{max-height:min(${em}em,70vh) !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, POPUP_INPUT_MARKER),
  },
];

function readInject(ip: InjectPoint): InjectValue | undefined {
  const raw = vscode.workspace
    .getConfiguration(CONFIG_NS)
    .get<InjectValue>(ip.key, ip.defaultRaw);
  return ip.effective(raw);
}

function injectByFile(): Map<string, InjectPoint[]> {
  const m = new Map<string, InjectPoint[]>();
  for (const ip of INJECT_POINTS) {
    (m.get(ip.file) ?? m.set(ip.file, []).get(ip.file)!).push(ip);
  }
  return m;
}

function injectEq(
  a: InjectValue | undefined,
  b: InjectValue | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return String(a) === String(b);
}

// The value a point currently has on disk ("off" when native), for pending-reload
// and activation-floor tracking. undefined when the anchor is absent.
function injectStateStr(
  content: string | undefined,
  ip: InjectPoint,
): string | undefined {
  if (content === undefined || !ip.present(content)) return undefined;
  const cur = ip.current(content);
  return cur === undefined ? "off" : String(cur);
}

// Map an activation-floor string (from injectStateStr) back to a config value,
// or undefined to clear the key.
function injectFloorToRaw(
  ip: InjectPoint,
  floor: string | undefined,
): InjectValue | undefined {
  if (floor === undefined || floor === "off")
    return ip.clearAtNative ? undefined : ip.defaultRaw;
  return ip.kind === "family" || ip.kind === "align" ? floor : Number(floor);
}

// px per patch point id, where 0 means native: no edit, Claude Code's own size.
export type SizeMap = Record<string, number>;

export function readSizes(): SizeMap {
  const c = vscode.workspace.getConfiguration(CONFIG_NS);
  const m: SizeMap = {};
  for (const p of PATCH_POINTS) {
    const raw = c.get<number>(p.key, 0);
    m[p.id] = typeof raw === "number" && raw > 0 ? Number(formatPx(raw)) : 0;
  }
  return m;
}

export function formatPx(n: number): string {
  const clamped = Math.min(
    MAX_PX,
    Math.max(MIN_PX, Number.isFinite(n) ? n : 14),
  );
  return String(Math.round(clamped * 100) / 100);
}

// Native (chat.fontSize) is the user's own VS Code setting, so it is not bound
// by the patch clamp (MAX_PX). Round to 2dp and clamp to [MIN_PX, 100].
export function formatNativePx(n: number): string {
  const clamped = Math.min(100, Math.max(MIN_PX, Number.isFinite(n) ? n : 13));
  return String(Math.round(clamped * 100) / 100);
}

// ---------------------------------------------------------------------------
// Live-preview model. The panel renders a small sample of the chat and plan
// surfaces and styles it from these EFFECTIVE values, so tuning a font / size /
// spacing setting shows immediately with no window reload. (The real Claude
// Code webview still needs the reload: it loads the patched bundle once, and an
// extension can't restyle another extension's webview at runtime. This preview
// is a faithful mock of that styling, not the live UI.)
//
// Reads settings only, never the on-disk bundle, so it reflects what the knobs
// AND the settings-only family / paragraph-spacing values ask for, resolving
// each inherit (size 0 -> chat.fontSize or the matching block knob; family "" ->
// native). A null family means "native": the webview renders it via the
// matching --vscode-*-font-family variable rather than a pinned family. A patch
// point at 0 renders its native size, which depends on the form the analyzer
// found, so the caller passes each point's effective px in.
// ---------------------------------------------------------------------------
export interface PreviewModel {
  chat: {
    agentSizePx: number;
    agentFamily: string | null;
    agentBoldWeight: number; // weight for <strong>/<b> runs (700 = native)
    paraSpacing: number; // multiplier on the em-relative paragraph gaps (1 = native)
    inputSizePx: number; // the chat input box size (native chat.fontSize)
    userSizePx: number;
    userFamily: string | null;
    codeBlockSizePx: number;
    codeInlineSizePx: number;
    codeFamily: string | null;
  };
  plan: {
    textSizePx: number;
    textFamily: string | null;
    codeBlockSizePx: number;
    codeInlineSizePx: number;
    codeFamily: string | null;
    // Select-and-comment popup. The quote carries no family of its own, so it
    // rides textFamily (the body swap reaches it); the composer is pinned to the
    // native UI font in the bundle, so only its size is tunable.
    quoteSizePx: number;
    commentSizePx: number;
    commentRows: number | null; // null = native (the 60px floor, about 3 rows)
    badgeSizePx: number; // the digit inside the 14px comment badge
  };
}

export function previewModel(sizes: SizeMap): PreviewModel {
  const nativeChat = nativeChatFontSizePx();
  const inj = (id: string): InjectPoint | undefined =>
    INJECT_POINTS.find((p) => p.id === id);
  const effNum = (id: string, fallback: number): number => {
    const ip = inj(id);
    const v = ip ? readInject(ip) : undefined;
    return typeof v === "number" ? v : fallback;
  };
  const effFamily = (id: string): string | null => {
    const ip = inj(id);
    const v = ip ? readInject(ip) : undefined;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const effScale = (id: string): number => {
    const ip = inj(id);
    const v = ip ? readInject(ip) : undefined;
    return typeof v === "number" ? v : 1;
  };
  // A rows count, or null for native (no rows attribute on the textarea).
  const effRows = (id: string): number | null => {
    const ip = inj(id);
    const v = ip ? readInject(ip) : undefined;
    return typeof v === "number" ? v : null;
  };
  // codeFontFamily is a single setting shared by the chat / permission / plan
  // code points, so read it once and use it for both surfaces' code.
  const codeFamily = effFamily("chatCodeFamily");
  return {
    chat: {
      agentSizePx: Number(
        formatNativePx(effNum("chatHistorySize", nativeChat)),
      ),
      agentFamily: effFamily("chatHistoryFamily"),
      agentBoldWeight: effNum("chatBoldWeight", NATIVE_BOLD_WEIGHT),
      paraSpacing: effScale("chatParaSpacing"),
      inputSizePx: Number(formatNativePx(nativeChat)),
      userSizePx: Number(
        formatNativePx(effNum("chatInputHistorySize", nativeChat)),
      ),
      userFamily: effFamily("chatInputHistoryFamily"),
      codeBlockSizePx: sizes["chatCode"],
      codeInlineSizePx: effNum("chatCodeInline", sizes["chatCode"]),
      codeFamily,
    },
    plan: {
      textSizePx: sizes["text"],
      textFamily: effFamily("planFamily"),
      codeBlockSizePx: sizes["code"],
      codeInlineSizePx: effNum("planCodeInline", sizes["code"]),
      codeFamily,
      quoteSizePx: sizes["preview"],
      commentSizePx: sizes["input"],
      commentRows: effRows("planCommentRows"),
      badgeSizePx: sizes["badge"],
    },
  };
}

// --- per-point primitives (dispatch to custom fns or the value-slot model) ---

// Which model serves the bundle: the point's own slot ("own", its custom fns or
// value-slot regexes), else its alternate form ("alt", see AltForm), else none
// (the anchor is gone). A bundle carrying the alternate form's fragments is that
// form's by construction: they land only where the own slot found nothing, and
// the native code around them never changes while they are in place. Callers
// that go on to read or edit the point pass the form along, so each decides it
// once per bundle text.
type PointForm = "own" | "alt" | undefined;
function pointForm(content: string, p: PatchPoint): PointForm {
  if (p.alt?.marked(content)) return "alt";
  if (
    p.fnPresent ? p.fnPresent(content) : p.res!.some((re) => re.test(content))
  )
    return "own";
  return p.alt?.present(content) ? "alt" : undefined;
}

// Whether the alternate form serves, for a point that has one.
function altServes(content: string, p: PatchPoint, form?: PointForm): boolean {
  return !!p.alt && (form ?? pointForm(content, p)) === "alt";
}

// px string if a fixed size is in place, or undefined for the stock/native form.
function pointCurrentPx(
  content: string,
  p: PatchPoint,
  form?: PointForm,
): string | undefined {
  if (altServes(content, p, form)) return p.alt!.currentPx(content);
  if (p.fnCurrentPx) return p.fnCurrentPx(content);
  for (const re of p.res!) {
    const m = content.match(re);
    if (!m) continue;
    if (p.style === "number") return m[2];
    return /^\d/.test(m[2]) ? m[2].replace("px", "") : undefined; // value style
  }
  return undefined;
}

function pointSet(
  content: string,
  p: PatchPoint,
  px: string,
  form?: PointForm,
): string {
  if (altServes(content, p, form))
    return p.alt!.apply(p.alt!.strip(content), px);
  if (p.fnApply) return p.fnApply(content, px);
  const value = p.style === "number" ? px : `${px}px`;
  let out = content;
  for (const re of p.res!) {
    out = out.replace(re, (_w, prefix, _v, suffix) => prefix + value + suffix);
  }
  return out;
}

function pointRestore(
  content: string,
  p: PatchPoint,
  stockValue: string,
  form?: PointForm,
): string {
  if (altServes(content, p, form)) return p.alt!.strip(content);
  if (p.fnRestore) return p.fnRestore(content);
  let out = content;
  for (const re of p.res!) {
    out = out.replace(
      re,
      (_w, prefix, _v, suffix) => prefix + stockValue + suffix,
    );
  }
  return out;
}

// --- stock-capture helpers ---

// The effective stock px for a point: parsed from the captured value if
// available, else the hardcoded originalPx fallback.
function stockNumberFor(p: PatchPoint, capture: StockCapture): number {
  const c = capture[p.id];
  if (!c) return p.originalPx;
  if (p.style === "number") return parseFloat(c);
  const m = c.match(/(\d+(?:\.\d+)?)px/);
  return m ? parseFloat(m[1]) : p.originalPx;
}

// The stock px of the point's slot on this bundle, which a bare-number own slot
// reads at native (see analyze). Where the alternate form serves, the native
// value is an expression rather than a px, so no capture is consulted (a
// captured calc(... - 2px) would read as 2) and originalPx stands in.
function stockPxFor(
  p: PatchPoint,
  capture: StockCapture,
  form: PointForm,
): number {
  return form === "alt" ? p.originalPx : stockNumberFor(p, capture);
}

// The effective stock value string for restore: the captured value if
// available, else the hardcoded fallback (bare number or originalValue var).
function stockValueFor(p: PatchPoint, capture: StockCapture): string {
  const c = capture[p.id];
  if (c) return c;
  return p.style === "number" ? `${p.originalPx}` : p.originalValue!;
}

// Read the real native stock values from the bundle. Value-style points are
// captured whenever they are at stock (var() present — reliably detected).
// Number-style points are captured only when force=true (fresh bundle after a
// version change), because a bare number can't be distinguished from a
// previously patched value.
function captureStockValues(
  ext: ClaudeExt,
  force: boolean,
  cache?: ReadCache,
): StockCapture {
  const captured: StockCapture = {};
  const read = cacheReader(ext, cache);
  for (const p of PATCH_POINTS) {
    if (!p.style || !p.res) continue;
    const content = read(p.file);
    // Only the own slot holds a stock value to capture (see stockPxFor).
    if (!content || pointForm(content, p) !== "own") continue;

    if (p.style === "value") {
      if (pointCurrentPx(content, p, "own") === undefined) {
        for (const re of p.res) {
          const m = content.match(re);
          if (m) {
            captured[p.id] = m[2];
            break;
          }
        }
      }
    } else if (force) {
      for (const re of p.res) {
        const m = content.match(re);
        if (m) {
          captured[p.id] = m[2];
          break;
        }
      }
    }
  }
  return captured;
}

export interface ClaudeExt {
  dir: string;
  version: string;
}

function filePath(ext: ClaudeExt, rel: string): string {
  return path.join(ext.dir, rel);
}

// Roots that may hold Claude Code installs. The extensions API names the copy
// this window actually loaded, exact on any fork, remote host, or custom
// --extensions-dir (`?.`: absent in the test stub's vscode). The parent of our
// own install covers an API miss (Claude Code installed but not loaded in
// this extension host): both extensions live in the same extensions root.
// Scanning other products' roots (~/.vscode, ~/.vscode-oss, ...) would risk
// patching a copy the current window never loads, so only these two count.
function extensionsDirs(context: vscode.ExtensionContext): string[] {
  const dirs = new Set<string>();
  const loaded = vscode.extensions?.getExtension("anthropic.claude-code");
  if (loaded) dirs.add(path.dirname(loaded.extensionUri.fsPath));
  dirs.add(path.dirname(context.extensionUri.fsPath));
  return [...dirs].filter((d) => fs.existsSync(d));
}

// The extensions root's .obsolete file maps folder names pending deletion to
// true (an uninstall, the old version after an update, or the new one after a
// downgrade). A leftover listed there must not win the version scan.
function readObsolete(base: string): Set<string> {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(base, ".obsolete"), "utf8"),
    );
    return new Set(Object.keys(raw).filter((k) => raw[k] === true));
  } catch {
    return new Set();
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function findLatestClaudeExt(
  context: vscode.ExtensionContext,
): ClaudeExt | undefined {
  const verRe = /^anthropic\.claude-code-(\d+(?:\.\d+)*)/;
  let best: ClaudeExt | undefined;
  for (const base of extensionsDirs(context)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    const obsolete = readObsolete(base);
    for (const name of entries) {
      if (!name.startsWith(EXT_PREFIX)) continue;
      if (obsolete.has(name)) continue;
      const m = name.match(verRe);
      if (!m) continue;
      const dir = path.join(base, name);
      if (!fs.existsSync(path.join(dir, MARKER_FILE))) continue;
      if (!best || compareVersions(m[1], best.version) > 0) {
        best = { dir, version: m[1] };
      }
    }
  }
  return best;
}

export type PointState = (
  | {
      id: string;
      label: string;
      section: Section;
      status: "current";
      px: string;
    }
  | {
      id: string;
      label: string;
      section: Section;
      status: "stock" | "custom";
      px: string;
      want: string;
    }
  | { id: string; label: string; section: Section; status: "missing" }
) & {
  // Served by the point's alternate form (see AltForm), whose markers are owed
  // on this install only; the anchor audit reads it.
  alt?: true;
};

function readFileSafe(ext: ClaudeExt, rel: string): string | undefined {
  try {
    return fs.readFileSync(filePath(ext, rel), "utf8");
  } catch {
    return undefined;
  }
}

// A per-pass read cache: the target files are multi-megabyte (webview/index.js
// alone is ~5 MB), and one apply pass consults them from applyPatch, the
// pendingReload reconcile, the stock capture, and four analyzers, each of which
// otherwise re-reads from disk. Sharing one cache across a pass turns that into
// a single read per file. The cache is pinned to the install dir it was filled
// from, so a Claude Code update that swaps the versioned directory mid-pass can
// never serve content from the old dir: helpers fall back to a private map when
// the dir differs. applyPatch seeds the cache with each file's post-write
// content, so downstream consumers see exactly what landed on disk.
export interface ReadCache {
  dir: string;
  map: Map<string, string | undefined>;
}

function cacheReader(
  ext: ClaudeExt,
  cache?: ReadCache,
): (rel: string) => string | undefined {
  const map =
    cache && cache.dir === ext.dir
      ? cache.map
      : new Map<string, string | undefined>();
  return (rel: string) => {
    if (!map.has(rel)) map.set(rel, readFileSafe(ext, rel));
    return map.get(rel);
  };
}

export function analyze(
  ext: ClaudeExt,
  sizes: SizeMap,
  capture: StockCapture,
  cache?: ReadCache,
): PointState[] {
  const read = cacheReader(ext, cache);
  return PATCH_POINTS.map((p): PointState => {
    const content = read(p.file);
    const form = content === undefined ? undefined : pointForm(content, p);
    const base = {
      id: p.id,
      label: p.label,
      section: p.section,
      ...(form === "alt" ? { alt: true as const } : {}),
    };
    if (content === undefined || !form) {
      return { ...base, status: "missing" };
    }
    const stockNum = stockPxFor(p, capture, form);
    // undefined = native (the setting is 0); any px is pinned, stock or not.
    const want = sizes[p.id] > 0 ? formatPx(sizes[p.id]) : undefined;
    const cur = pointCurrentPx(content, p, form);
    // A bare-number own slot reads its stock number at native, the same bytes
    // a pin at that number writes, so either setting finds it current. Every
    // other form, the alternate one included, reads native as undefined.
    const isStock =
      p.style === "number" && form === "own"
        ? cur === formatPx(stockNum)
        : cur === undefined;

    if (want === undefined && isStock)
      return { ...base, status: "current", px: `${stockNum}` };
    if (want !== undefined && cur === want)
      return { ...base, status: "current", px: cur };
    if (isStock)
      return {
        ...base,
        status: "stock",
        px: `${stockNum}`,
        want: want ?? "native",
      };
    return {
      ...base,
      status: "custom",
      px: cur ?? `${stockNum}`,
      want: want ?? "native",
    };
  });
}

// "native" = this build ships the feature itself (see nativeOn), so the point is
// satisfied with no edit owed and the setting is inert. It is deliberately NOT
// "missing": a missing anchor means a wanted customization silently can't apply
// and the panel should say so, whereas here the user gets the behavior anyway.
export type ToggleStatus =
  "current" | "stock" | "custom" | "missing" | "native";
export interface ToggleState {
  id: string;
  label: string;
  section: Section;
  key: string; // public settings sub-key, so tooling can report without knowing ids
  status: ToggleStatus;
  wantOn: boolean; // the setting value (what the panel shows and apply targets)
}

// Same shape as analyze() but for on/off points: "stock" = bundle at native and
// the setting wants it flipped; "custom" = bundle flipped the other way from the
// setting (e.g. a leftover patch the setting no longer wants).
export function analyzeToggles(
  ext: ClaudeExt,
  toggles: ToggleMap,
  cache?: ReadCache,
): ToggleState[] {
  const read = cacheReader(ext, cache);
  return TOGGLE_POINTS.map((t): ToggleState => {
    const base = { id: t.id, label: t.label, section: t.section, key: t.key };
    const wantOn = toggles[t.id];
    // Before the anchor: on a build that ships the feature the anchor is gone by
    // design, and reading that as "missing" would flag a healthy install.
    // A leftover from before reads as drift instead, so a pass strips it.
    if (toggleNative(read, t)) {
      const status = toggleLeftover(read, t) ? "custom" : "native";
      return { ...base, status, wantOn };
    }
    const cur = toggleStateStr(read, t);
    if (cur === undefined) return { ...base, status: "missing", wantOn };
    if (cur === toggleWantStr(t, wantOn))
      return { ...base, status: "current", wantOn };
    if (cur === toggleWantStr(t, t.defaultOn))
      return { ...base, status: "stock", wantOn };
    return { ...base, status: "custom", wantOn };
  });
}

// Always-on fixes have no setting to disagree with, so there is no "custom":
// "current" = this bundle's line is in place, "stock" = it is absent or stale
// (including a leftover line whose anchor is now gone, which apply strips),
// "missing" = the file is unreadable, "inert" = this build gives the fix
// nothing to change (see AlwaysInline.inert).
export type AlwaysStatus = "current" | "stock" | "missing" | "inert";
export interface AlwaysState {
  id: string;
  label: string;
  status: AlwaysStatus;
}

export function analyzeAlways(
  ext: ClaudeExt,
  cache?: ReadCache,
): AlwaysState[] {
  const read = cacheReader(ext, cache);
  return ALWAYS_POINTS.map((a): AlwaysState => {
    const base = { id: a.id, label: a.label };
    const c = read(a.file);
    if (c === undefined) return { ...base, status: "missing" };
    if (a.kind === "line") {
      const want = a.build(c);
      const cur = cssMarkedLine(c, a.marker);
      if (want === undefined)
        return { ...base, status: cur === undefined ? "missing" : "stock" };
      return { ...base, status: cur === want ? "current" : "stock" };
    }
    const native = c.replace(a.frags, "");
    const want = a.patch(native, read);
    if (want === null) {
      if (c !== native) return { ...base, status: "stock" };
      return { ...base, status: a.inert?.(native) ? "inert" : "missing" };
    }
    return { ...base, status: c === want ? "current" : "stock" };
  });
}

export type InjectStatus = "current" | "stock" | "custom" | "missing" | "inert";
export interface InjectState {
  id: string;
  label: string;
  section: Section;
  status: InjectStatus;
  value: InjectValue | undefined; // the setting value (undefined = off)
}

// Same shape as analyze()/analyzeToggles() for the string/size/rows injections:
// "stock" = bundle native and the setting wants an injection; "custom" = the
// bundle carries an injection differing from the setting (leftover or drifted);
// "inert" = this build gives the point nothing to write (see InjectPoint.inert).
export function analyzeInjects(
  ext: ClaudeExt,
  cache?: ReadCache,
): InjectState[] {
  const read = cacheReader(ext, cache);
  return INJECT_POINTS.map((ip): InjectState => {
    const base = { id: ip.id, label: ip.label, section: ip.section };
    const want = readInject(ip);
    const content = read(ip.file);
    if (content !== undefined && ip.inert?.(content)) {
      return { ...base, status: "inert", value: want };
    }
    if (content === undefined || !ip.present(content)) {
      return { ...base, status: "missing", value: want };
    }
    const cur = ip.current(content);
    if (injectEq(cur, want)) return { ...base, status: "current", value: want };
    if (cur === undefined) return { ...base, status: "stock", value: want };
    return { ...base, status: "custom", value: want };
  });
}

export interface PatchReport {
  version: string;
  changed: string[]; // human-readable summaries of the edits actually written
}

function byFile(): Map<string, PatchPoint[]> {
  const m = new Map<string, PatchPoint[]>();
  for (const p of PATCH_POINTS) {
    (m.get(p.file) ?? m.set(p.file, []).get(p.file)!).push(p);
  }
  return m;
}

// Write atomically: stage to a unique temp file in the same directory, then
// rename over the target. rename(2) is atomic on POSIX, and on Windows Node
// maps it to MoveFileEx with replace, so a concurrent reader (another window's
// apply, or Claude Code loading the bundle) never observes a half-written file.
// The temp name is per-process + counter so parallel writers never collide.
let atomicWriteCounter = 0;
function copyFileAtomic(src: string, dst: string): void {
  const tmp = `${dst}.${process.pid}.${atomicWriteCounter++}.tmp`;
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort: nothing to clean up if the temp was never created
    }
    throw err;
  }
}
function writeFileAtomic(abs: string, data: string): void {
  const tmp = `${abs}.${process.pid}.${atomicWriteCounter++}.tmp`;
  try {
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort: nothing to clean up if the temp was never created
    }
    throw err;
  }
}

// Reconcile each patch point to its wanted size: a non-stock want is written as
// a fixed px; a stock want restores the point to its native form. A point is
// only reported (and its file only rewritten) when the transform actually
// changes the content, so a no-op (already at target, or an anchor whose form
// changed so the transform can't apply) never produces a spurious "changed".
export function applyPatch(
  ext: ClaudeExt,
  sizes: SizeMap,
  toggles: ToggleMap,
  capture: StockCapture,
  cache?: ReadCache,
): PatchReport {
  const changed: string[] = [];
  const pointsByFile = byFile();
  const togglesByFile = toggleByFile();
  const injectsByFile = injectByFile();
  const files = allPatchedFiles();
  // Each file's post-write content lands in the map, for the downstream
  // readers of the same cache and for the always-on points of the files after
  // it; a file not reached yet is read as it stands.
  const map =
    cache && cache.dir === ext.dir
      ? cache.map
      : new Map<string, string | undefined>();
  const seed = (rel: string, c: string | undefined) => void map.set(rel, c);
  const read: BundleReader = (rel) => {
    if (!map.has(rel)) map.set(rel, readFileSafe(ext, rel));
    return map.get(rel);
  };
  for (const file of files) {
    const abs = filePath(ext, file);
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      seed(file, undefined);
      continue;
    }
    let out = content;
    for (const p of pointsByFile.get(file) ?? []) {
      const form = pointForm(out, p);
      if (!form) continue;
      // undefined = native (the setting is 0); any px is pinned, stock or not.
      const want = sizes[p.id] > 0 ? formatPx(sizes[p.id]) : undefined;
      const cur = pointCurrentPx(out, p, form);
      const next =
        want === undefined
          ? pointRestore(out, p, stockValueFor(p, capture), form)
          : pointSet(out, p, want, form);
      if (next !== out) {
        out = next;
        changed.push(
          want === undefined
            ? `${p.label} ${cur}px→native`
            : `${p.label} ${cur ?? "native"}→${want}px`,
        );
      }
    }
    for (const ip of injectsByFile.get(file) ?? []) {
      if (!ip.present(out)) continue;
      const want = readInject(ip);
      const cur = ip.current(out);
      const next = want === undefined ? ip.remove(out) : ip.apply(out, want);
      if (next !== out) {
        out = next;
        changed.push(
          want === undefined
            ? `${ip.label} ${cur}→native`
            : `${ip.label} ${cur ?? "native"}→${want}`,
        );
      }
    }
    for (const t of togglesByFile.get(file) ?? []) {
      if (!togglePresent(out, t)) continue;
      // A build that ships the feature is owed none of it (see nativeOn).
      const wantOn = toggles[t.id] && !t.nativeOn?.(out);
      const cur = toggleCurrentOn(out, t);
      const next = toggleSet(out, t, wantOn);
      if (next !== out) {
        out = next;
        changed.push(
          `${t.label} ${cur ? "on" : "off"}→${wantOn ? "on" : "off"}`,
        );
      }
    }
    for (const t of TOGGLE_POINTS) {
      if (t.cssFile !== file || !t.cssMarker || !t.cssBuild) continue;
      const wantOn = toggles[t.id] && !toggleNative(read, t);
      const rule = wantOn ? t.cssBuild(out) : undefined;
      const next = rule
        ? cssApplyLine(out, t.cssMarker, rule)
        : cssRemoveLine(out, t.cssMarker);
      if (next !== out) {
        out = next;
        changed.push(`${t.label} css ${wantOn ? "applied" : "native"}`);
      }
    }
    // No setting to consult: write the form this bundle wants, or strip a stale
    // one whose anchor is gone. An already-correct form is left as it is (a
    // re-appended line would shuffle past the other marked lines). An inline
    // point may read the install's other files: this one as edited so far, the
    // rest as this pass has them.
    const readHere: BundleReader = (rel) => (rel === file ? out : read(rel));
    for (const a of ALWAYS_POINTS) {
      if (a.file !== file) continue;
      const next = alwaysApply(out, a, readHere);
      if (next.out === out) continue;
      out = next.out;
      changed.push(`${a.label} ${next.on ? "applied" : "native"}`);
    }
    if (out !== content) writeFileAtomic(abs, out);
    seed(file, out);
  }
  // Math rendering ships webfont FILES alongside the bundle edits: keep them in
  // step with the toggle (copied when on, removed when off). A build that
  // renders math itself owns its fonts, see syncMathFonts.
  const math = TOGGLE_POINTS.find((t) => t.id === "chatMath")!;
  syncMathFonts(
    ext,
    toggles["chatMath"] === true && !toggleNative(read, math),
    changed,
  );
  return { version: ext.version, changed };
}

// Every file any point, toggle (including a toggle's CSS side-effect), or
// injection touches.
function allPatchedFiles(): Set<string> {
  const files = new Set<string>();
  for (const p of PATCH_POINTS) files.add(p.file);
  for (const t of TOGGLE_POINTS) {
    files.add(t.file);
    if (t.cssFile) files.add(t.cssFile);
  }
  for (const ip of INJECT_POINTS) files.add(ip.file);
  for (const a of ALWAYS_POINTS) files.add(a.file);
  return files;
}

export function restorePatch(
  ext: ClaudeExt,
  capture: StockCapture,
): PatchReport {
  const changed: string[] = [];
  const pointsByFile = byFile();
  const togglesByFile = toggleByFile();
  const injectsByFile = injectByFile();
  const files = allPatchedFiles();
  for (const file of files) {
    const abs = filePath(ext, file);
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    let out = content;
    for (const p of pointsByFile.get(file) ?? []) {
      const form = pointForm(out, p);
      if (!form) continue;
      const next = pointRestore(out, p, stockValueFor(p, capture), form);
      if (next !== out) {
        out = next;
        changed.push(`${p.label} restored`);
      }
    }
    for (const ip of injectsByFile.get(file) ?? []) {
      if (!ip.present(out)) continue;
      const next = ip.remove(out);
      if (next !== out) {
        out = next;
        changed.push(`${ip.label} restored`);
      }
    }
    for (const t of togglesByFile.get(file) ?? []) {
      if (!togglePresent(out, t)) continue;
      const next = toggleSet(out, t, t.defaultOn);
      if (next !== out) {
        out = next;
        changed.push(`${t.label} restored`);
      }
    }
    for (const t of TOGGLE_POINTS) {
      if (t.cssFile !== file || !t.cssMarker) continue;
      const next = cssRemoveLine(out, t.cssMarker);
      if (next !== out) {
        out = next;
        changed.push(`${t.label} css restored`);
      }
    }
    for (const a of ALWAYS_POINTS) {
      if (a.file !== file) continue;
      const next = alwaysRestore(out, a);
      if (next !== out) {
        out = next;
        changed.push(`${a.label} restored`);
      }
    }
    if (out !== content) writeFileAtomic(abs, out);
  }
  syncMathFonts(ext, false, changed);
  return { version: ext.version, changed };
}

// --- Apply actions -------------------------------------------------------

// The command that runs the cheapest apply for whatever is pending. Registered
// in activate() (it has to close this extension's own panel first, which the
// patcher can't import without a cycle), and referenced by the panel banner,
// the status-bar tooltip link, and the activation toast.
export const APPLY_COMMAND = "claudeCodeUiPatch.applyPending";

// Where a patch point lands decides what has to restart for it to take effect.
// webview/index.{css,js} are fetched by the chat webview's iframe, so rebuilding
// that iframe is enough; extension.js is required by the extension host process,
// so only a fresh host picks it up.
const HOST_FILE = "extension.js";

// Point id -> the bundle files it writes (a toggle can carry a CSS side-effect
// in a second file). Built once at load, below every point array.
const POINT_FILES: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  const add = (id: string, ...files: (string | undefined)[]) =>
    m.set(
      id,
      files.filter((f): f is string => f !== undefined),
    );
  for (const p of PATCH_POINTS) add(p.id, p.file);
  for (const t of TOGGLE_POINTS) add(t.id, t.file, t.cssFile);
  for (const ip of INJECT_POINTS) add(ip.id, ip.file);
  for (const a of ALWAYS_POINTS) add(a.id, a.file);
  return m;
})();

// True when this point's edits stay inside the webview bundle.
function isWebviewPoint(id: string): boolean {
  const files = POINT_FILES.get(id);
  return !!files && !files.includes(HOST_FILE);
}

export type ApplyScope = "webview" | "host" | "window";

export interface ApplyAction {
  scope: ApplyScope;
  command: string; // the VS Code command that performs it
  label: string; // button / link text, reused in the activation toast
  icon: string; // codicon for the status-bar tooltip link
  detail: string; // hover text
}

const WEBVIEW_APPLY: ApplyAction = {
  scope: "webview",
  command: "workbench.action.webview.reloadWebviewAction",
  label: "Refresh Webviews",
  icon: "$(refresh)",
  detail:
    "Refresh the chat webview to apply the pending changes (the extension host and the Claude Code session stay up)",
};

const HOST_APPLY: ApplyAction = {
  scope: "host",
  command: "workbench.action.restartExtensionHost",
  label: "Restart Extensions",
  icon: "$(debug-restart)",
  detail:
    "Restart the extension host to apply the pending changes (the window stays up)",
};

const WINDOW_APPLY: ApplyAction = {
  scope: "window",
  command: "workbench.action.reloadWindow",
  label: "Reload Window",
  icon: "$(refresh)",
  detail: "Reload the window to apply the pending changes",
};

// workbench.action.restartExtensionHost calls startExtensionHosts() with no
// delta, so the new host relaunches the extension descriptions this window
// already resolved rather than a fresh scan of disk. (The Extensions view's
// "Restart Extensions" button differs exactly there: it passes the newly
// scanned versions as toAdd/toRemove.) When Claude Code has updated since this
// window started, the running description still points at the previous version
// directory, which VS Code deletes once it is obsolete, so a host restart would
// relaunch Claude Code from a path that is gone. Only a window reload re-scans.
function registryMatchesDisk(ext: ClaudeExt): boolean {
  const running = vscode.extensions?.getExtension("anthropic.claude-code")
    ?.extensionUri?.fsPath;
  return !!running && path.resolve(running) === path.resolve(ext.dir);
}

// A Claude Code chat opened as an editor tab does not survive a host restart:
// the workbench never disposes a live webview editor when the host goes away,
// and only re-resolves inputs that were awaiting revival, so the tab is left
// showing its pre-restart DOM behind a dead message channel. A window reload
// disposes it and revives it through Claude Code's panel serializer. Duck-typed
// on viewType (a webview tab reports it prefixed with "mainThreadWebview-") so
// this also works where TabInputWebview is absent.
function claudeEditorTabOpen(): boolean {
  for (const group of vscode.window.tabGroups?.all ?? []) {
    for (const tab of group.tabs) {
      const viewType = (tab.input as { viewType?: string } | undefined)
        ?.viewType;
      if (
        typeof viewType === "string" &&
        viewType.includes("claudeVSCodePanel")
      )
        return true;
    }
  }
  return false;
}

// The cheapest restart that puts every pending point in effect. Webview-only
// edits just need the iframe rebuilt; anything touching extension.js needs a new
// host process, which is only safe when the registry still matches disk and no
// Claude Code editor tab would be orphaned. With nothing pending this stays the
// plain window reload, so the status-bar link keeps working as a general escape
// hatch.
export function resolveApplyAction(
  ext: ClaudeExt | undefined,
  pending: Iterable<string>,
): ApplyAction {
  const ids = [...pending];
  if (!ext || ids.length === 0) return WINDOW_APPLY;
  if (ids.every(isWebviewPoint)) return WEBVIEW_APPLY;
  if (registryMatchesDisk(ext) && !claudeEditorTabOpen()) return HOST_APPLY;
  return WINDOW_APPLY;
}

// Cheap, cached view for the hover popup.
export interface Knob {
  id: string;
  section: Section;
  label: string;
  kind: "size" | "weight" | "toggle";
  px: string; // size/weight knobs: current value; toggle knobs: unused ("")
  on: boolean; // toggle knobs: current on/off; size knobs: unused (false)
  max: number; // upper clamp for the panel's ▲/▼ controls (size/weight knobs)
  min: number; // lower clamp for the panel's ▲/▼ controls
  step: number; // increment per ▲/▼ click (px sizes step finer than weights)
  unit: string; // suffix rendered after the value ("px", or "" for a weight)
  native: boolean;
  state: "current" | "stock" | "custom" | "missing" | "native" | "inert";
  pendingReload: boolean; // this row's bundle was written but window not reloaded
  lost: boolean; // wanted (non-native) but its anchor is absent on this version
  nativeKey?: string;
}

export interface Snapshot {
  available: boolean;
  supported: boolean; // at least one patch anchor present
  version: string;
  knobs: Knob[]; // native chat + present/lost patch knobs, in section order
  applied: boolean;
  actionable: boolean;
  needsReload: boolean; // bundle written this session but window not reloaded
  partialLoss: boolean; // a wanted setting can't be applied: its anchor is gone here
  apply: ApplyAction; // cheapest restart that applies what is pending
  preview: PreviewModel; // effective font / size / spacing values for the live preview
}

export class Patcher {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private ext: ClaudeExt | undefined;
  private states: PointState[] = [];
  private toggleStates: ToggleState[] = [];
  private injectStates: InjectState[] = [];
  private alwaysStates: AlwaysState[] = [];
  private stockCapture: StockCapture = {};
  private pendingReload = new Set<string>(); // point IDs written but not reloaded
  private activationPx = new Map<string, string | undefined>(); // on-disk px at activation

  constructor(private readonly context: vscode.ExtensionContext) {
    // Read the last-seen Claude Code version before refresh() overwrites it, so
    // the activation re-apply below can tell an update (version changed) from a
    // first-time apply of saved settings.
    const priorVersion =
      this.context.globalState.get<string>(STOCK_VERSION_KEY);
    this.refresh();
    // Re-apply the saved sizes when the on-disk bundle has drifted from the
    // settings (e.g. a Claude Code update reverted the patch). This is a no-op
    // on a fresh install: every setting defaults to Claude Code's native value,
    // so there is nothing to apply and the UI is left untouched.
    const drifted = (s: { status: string }) =>
      s.status === "stock" || s.status === "custom";
    if (
      this.ext &&
      (this.states.some(drifted) ||
        this.toggleStates.some(drifted) ||
        this.injectStates.some(drifted) ||
        // Always-on fixes have no setting, so a fresh or updated bundle is
        // "stock" here even when every knob is native: this is what makes them
        // apply (and prompt the reload) without the user asking for anything.
        this.alwaysStates.some(drifted))
    ) {
      void this.autoApply({
        updated:
          priorVersion !== undefined && priorVersion !== this.ext.version,
      });
    }
  }

  register(): vscode.Disposable[] {
    const patchKeys = [
      ...PATCH_POINTS.map((p) => p.key),
      ...TOGGLE_POINTS.map((t) => t.key),
      ...INJECT_POINTS.map((ip) => ip.key),
      ...EXTRA_PATCH_KEYS.map(([k]) => k),
    ].map((k) => `${CONFIG_NS}.${k}`);
    // Foreign settings a patch bakes a value from: the plan comment box takes
    // claudeCode.useCtrlEnterToSend through the commentCtrlEnter fold, so a
    // change there must re-run the apply pass too.
    patchKeys.push("claudeCode.useCtrlEnterToSend");
    // chat.fontSize is no longer a knob, but the chatHistoryFontSize knob shows it
    // while inheriting, so a native change should refresh (not re-patch) the view.
    // The editor sizes feed what the patch knobs show at 0 (see NativeEnv).
    const nativeKeys = [
      ...NATIVE_KNOBS.map((k) => k.vscodeKey),
      "chat.editor.fontSize",
      "editor.fontSize",
    ];
    return [
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (patchKeys.some((k) => e.affectsConfiguration(k))) {
          this.scheduleAutoApply();
        } else if (nativeKeys.some((k) => e.affectsConfiguration(k))) {
          this.refresh();
        }
      }),
      // A Claude Code auto-update swaps in a pristine bundle mid-session, and
      // with only the configuration trigger above it stays native until the
      // next settings change or window reload (observed as an hour of stock
      // composer behavior). Repatch as soon as the new install lands: the
      // extensions API event covers install/update/enable in this host, and
      // the root watchers below catch the versioned directory appearing on
      // disk even before the extension host restarts into it, so the swap
      // finds the bundle already patched.
      ...(vscode.extensions?.onDidChange
        ? [vscode.extensions.onDidChange(() => this.scheduleAutoApply())]
        : []),
      this.watchExtensionRoots(),
      this.emitter,
    ];
  }

  // Watch the extension roots for a Claude Code install appearing or being
  // rewritten. Debounced longer than the config path so a mid-extraction
  // event does not run the pass against half-written files; the marker-file
  // check in findLatestClaudeExt and the anchors simply not matching guard
  // the remainder, and another event re-arms the timer. A watch failure just
  // means the update is picked up by the next activation or config event.
  private watchExtensionRoots(): vscode.Disposable {
    const watchers: fs.FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (const base of extensionsDirs(this.context)) {
      try {
        const watcher = fs.watch(base, (_event, file) => {
          if (!file || !file.startsWith(EXT_PREFIX)) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = undefined;
            this.scheduleAutoApply();
          }, EXT_WATCH_SETTLE_MS);
        });
        watchers.push(watcher);
      } catch {
        // root not watchable: fall back to the activation/config triggers
      }
    }
    return {
      dispose: () => {
        if (timer) clearTimeout(timer);
        for (const watcher of watchers) {
          try {
            watcher.close();
          } catch {
            // already closed
          }
        }
      },
    };
  }

  snapshot(): Snapshot | undefined {
    if (!this.ext) return undefined;
    const sizes = readSizes();
    // Each size point's effective px: its setting, or while that is 0, what
    // Claude Code renders natively in the form the analyzer found here.
    const env = nativeEnv();
    const altIds = new Set(this.states.filter((s) => s.alt).map((s) => s.id));
    const effSizes: SizeMap = {};
    for (const p of PATCH_POINTS) {
      effSizes[p.id] =
        sizes[p.id] > 0
          ? sizes[p.id]
          : p.nativeSize(
              altIds.has(p.id),
              env,
              stockNumberFor(p, this.stockCapture),
            );
    }
    const toggles = readToggles();
    const statusById = new Map(this.states.map((s) => [s.id, s.status]));
    const toggleStatusById = new Map(
      this.toggleStates.map((s) => [s.id, s.status]),
    );
    const injectStatusById = new Map(
      this.injectStates.map((s) => [s.id, s.status]),
    );

    const presentSizes = this.states.filter((s) => s.status !== "missing");
    const presentToggles = this.toggleStates.filter(
      (s) => s.status !== "missing",
    );
    // An inert point has nothing to write here: neither present nor lost.
    const presentInjects = this.injectStates.filter(
      (s) => s.status !== "missing" && s.status !== "inert",
    );
    const anyPresent =
      presentSizes.length + presentToggles.length + presentInjects.length > 0;

    // A "lost" point: its anchor is absent from this bundle, yet the user's
    // setting asks for a non-native value, so the customization silently can't
    // apply (typically a Claude Code update changed the code we patch). A missing
    // point left at its native value loses nothing, so it stays hidden. We treat
    // this as a partial loss only while something else is still present; when
    // nothing is present at all the "not supported" banner already covers it.
    const sizeWanted = (p: PatchPoint) => sizes[p.id] > 0;
    const toggleWanted = (t: TogglePoint) => toggles[t.id] !== t.defaultOn;
    const injectWanted = (ip: InjectPoint) => readInject(ip) !== undefined;
    const sizeLost = (p: PatchPoint) =>
      statusById.get(p.id) === "missing" && sizeWanted(p);
    const toggleLost = (t: TogglePoint) =>
      toggleStatusById.get(t.id) === "missing" && toggleWanted(t);
    const injectLost = (ip: InjectPoint) =>
      injectStatusById.get(ip.id) === "missing" && injectWanted(ip);
    const partialLoss =
      anyPresent &&
      (PATCH_POINTS.some(sizeLost) ||
        TOGGLE_POINTS.some(toggleLost) ||
        INJECT_POINTS.some(injectLost));

    // Panel knobs: every present point, plus any lost point (rendered with a red
    // dot). A lost knob shows its wanted value and keeps live controls, so the
    // preference is retained and re-applies if a later build restores the anchor.
    // The chat text size knob (formerly the native chat.fontSize knob) is now the
    // chatHistoryFontSize injection: it shows the effective size (its own value, or
    // the inherited chat.fontSize when unset) and adjusting it takes control.
    // The native chat.fontSize knob, surfaced as "user message input": it sizes
    // the chat input box (and, natively, any chat text still inheriting it).
    // Writing it applies live, no reload, so it carries a green "live" dot. Shown
    // only on a supported version, alongside the patch knobs.
    const native: Knob[] = anyPresent
      ? NATIVE_KNOBS.map((k) => ({
          id: k.id,
          section: "Chat Panel or Tab" as const,
          label: k.label,
          kind: "size" as const,
          px: formatNativePx(nativePx(k)),
          on: false,
          max: MAX_PX,
          min: MIN_PX,
          step: STEP,
          unit: "px",
          native: true,
          state: "current" as const,
          pendingReload: false,
          lost: false,
          nativeKey: k.vscodeKey,
        }))
      : [];
    const chat: Knob[] = INJECT_POINTS.filter(
      (ip) =>
        ip.showInPanel &&
        (injectStatusById.get(ip.id) !== "missing" ||
          (anyPresent && injectWanted(ip))),
    ).map((ip) => {
      const eff = readInject(ip);
      // A weight knob is numeric like a size knob but is not a px measurement:
      // it has its own clamp, steps in hundreds, renders bare, and shows the
      // browser's 700 while native (as a size knob shows its inherited px).
      const weight = ip.kind === "weight";
      return {
        id: ip.id,
        section: ip.section,
        label: ip.label,
        kind: weight ? ("weight" as const) : ("size" as const),
        px: weight
          ? String(typeof eff === "number" ? eff : NATIVE_BOLD_WEIGHT)
          : formatNativePx(
              typeof eff === "number"
                ? eff
                : ip.inheritFrom
                  ? effSizes[ip.inheritFrom]
                  : nativeChatFontSizePx(),
            ),
        on: false,
        max: ip.max,
        min: ip.min ?? MIN_PX,
        step: weight ? WEIGHT_STEP : STEP,
        unit: weight ? "" : "px",
        native: false,
        state: injectStatusById.get(ip.id) ?? "stock",
        pendingReload: this.pendingReload.has(ip.id),
        lost: injectStatusById.get(ip.id) === "missing",
      };
    });
    const patch: Knob[] = PATCH_POINTS.filter(
      (p) =>
        statusById.get(p.id) !== "missing" || (anyPresent && sizeWanted(p)),
    ).map((p) => ({
      id: p.id,
      section: p.section,
      label: p.label,
      kind: "size" as const,
      px: formatPx(effSizes[p.id]),
      on: false,
      max: p.maxPx,
      min: MIN_PX,
      step: STEP,
      unit: "px",
      native: false,
      state: statusById.get(p.id) ?? "stock",
      pendingReload: this.pendingReload.has(p.id),
      lost: statusById.get(p.id) === "missing",
    }));
    const toggleKnobs: Knob[] = TOGGLE_POINTS.filter(
      (t) =>
        toggleStatusById.get(t.id) !== "missing" ||
        (anyPresent && toggleWanted(t)),
    ).map((t) => ({
      id: t.id,
      section: t.section,
      label: t.label,
      kind: "toggle" as const,
      px: "",
      on: toggles[t.id],
      max: 0,
      min: 0,
      step: 0,
      unit: "",
      native: false,
      state: toggleStatusById.get(t.id) ?? "stock",
      pendingReload: this.pendingReload.has(t.id),
      lost: toggleStatusById.get(t.id) === "missing",
    }));
    const allCurrent =
      presentSizes.every((s) => s.status === "current") &&
      // "native" counts as satisfied: nothing to apply, so leaving it out here
      // would strand the panel on a permanent "apply" prompt that changes
      // nothing, and this toggle defaults to off, so that would be everyone.
      presentToggles.every(
        (s) => s.status === "current" || s.status === "native",
      ) &&
      presentInjects.every((s) => s.status === "current") &&
      // No row of their own, but a missing always-on fix still leaves the
      // bundle out of sync, so the panel should offer to apply. An inert one
      // has nothing to apply on this build.
      this.alwaysStates.every(
        (s) =>
          s.status === "current" ||
          s.status === "missing" ||
          s.status === "inert",
      );
    return {
      available: true,
      supported: anyPresent,
      version: this.ext.version,
      knobs: [...native, ...chat, ...patch, ...toggleKnobs].sort(
        (a, b) => knobOrder(a.id) - knobOrder(b.id),
      ),
      applied: anyPresent && allCurrent,
      actionable: !allCurrent,
      needsReload: this.pendingReload.size > 0,
      partialLoss,
      apply: resolveApplyAction(this.ext, this.pendingReload),
      preview: previewModel(effSizes),
    };
  }

  private refresh(cache?: ReadCache): void {
    this.ext = findLatestClaudeExt(this.context);
    if (this.ext) {
      this.refreshStockCapture(this.ext, cache);
      this.states = analyze(this.ext, readSizes(), this.stockCapture, cache);
      this.toggleStates = analyzeToggles(this.ext, readToggles(), cache);
      this.injectStates = analyzeInjects(this.ext, cache);
      this.alwaysStates = analyzeAlways(this.ext, cache);
      if (this.activationPx.size === 0) this.captureActivationPx();
    } else {
      this.states = [];
      this.toggleStates = [];
      this.injectStates = [];
      this.alwaysStates = [];
    }
    this.emitter.fire();
  }

  private captureActivationPx(): void {
    if (!this.ext) return;
    const cache = new Map<string, string | undefined>();
    const read = (rel: string) => {
      if (!cache.has(rel)) cache.set(rel, readFileSafe(this.ext!, rel));
      return cache.get(rel);
    };
    for (const p of PATCH_POINTS) {
      const content = read(p.file);
      this.activationPx.set(
        p.id,
        content ? pointCurrentPx(content, p) : undefined,
      );
    }
    for (const t of TOGGLE_POINTS) {
      this.activationPx.set(t.id, toggleStateStr(read, t));
    }
    for (const ip of INJECT_POINTS) {
      this.activationPx.set(ip.id, injectStateStr(read(ip.file), ip));
    }
    for (const a of ALWAYS_POINTS) {
      this.activationPx.set(a.id, alwaysStateStr(read(a.file), a));
    }
  }

  // Auto-apply: any patch setting change writes to the bundle immediately.
  // After writing, reconcile pendingReload in a single pass, then refresh once.
  // `activation` is set only for the activation-time re-apply (constructor); on
  // that path we prompt a reload once the write leaves the running window stale.
  // One ReadCache spans the whole pass: applyPatch seeds it with what landed on
  // disk, and the reconcile plus every analyzer read from it, so each target
  // file is read once per pass instead of once per consumer.
  private async autoApply(activation?: { updated: boolean }): Promise<void> {
    // Re-resolve the install in case Claude Code updated in place since the last
    // refresh (its versioned directory changes on update, so a cached ext could
    // point at a directory that no longer exists).
    this.ext = findLatestClaudeExt(this.context);
    if (!this.ext) {
      this.refresh();
      return;
    }
    const cache: ReadCache = { dir: this.ext.dir, map: new Map() };
    try {
      applyPatch(
        this.ext,
        readSizes(),
        readToggles(),
        this.stockCapture,
        cache,
      );
      this.reconcilePendingReload(cache);
      // A drifted bundle at activation means Claude Code reverted the patch
      // (typically an update). We just re-applied it to disk, but the running
      // window still shows the reverted UI, so prompt a reload. Only notify when
      // the write actually left the window stale (pendingReload non-empty).
      if (activation && this.pendingReload.size > 0) {
        this.notifyReapplied(activation.updated);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Claude Code UI Patch: failed to patch Claude Code: ${(err as Error).message}`,
      );
    }
    this.refresh(cache);
  }

  // Config changes arrive one event per written key, and rapid panel clicks
  // arrive as a burst of writes. Firing the emitter immediately keeps the
  // settings-derived panel state (live preview, px readouts) tracking each
  // click with no disk work on the path, while the heavy disk pass (multi-MB
  // reads, regex transforms, writes, re-analysis) coalesces behind a short
  // trailing debounce: a burst runs one pass, against the settings current at
  // pass time. Disk-truth indicators (dots, the reload cue) update when that
  // pass lands. A change arriving mid-pass queues exactly one follow-up.
  private applyTimer: ReturnType<typeof setTimeout> | undefined;
  private applyRunning = false;
  private applyQueued = false;

  private scheduleAutoApply(): void {
    this.emitter.fire();
    if (this.applyTimer !== undefined) clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => {
      this.applyTimer = undefined;
      void this.runCoalescedApply();
    }, APPLY_DEBOUNCE_MS);
  }

  private async runCoalescedApply(): Promise<void> {
    if (this.applyRunning) {
      this.applyQueued = true;
      return;
    }
    this.applyRunning = true;
    try {
      await this.autoApply();
    } finally {
      this.applyRunning = false;
      if (this.applyQueued) {
        this.applyQueued = false;
        void this.runCoalescedApply();
      }
    }
  }

  // Re-run the reconcile outside a configuration change. Used by the
  // keybindings.json watcher: the find bar bakes resolved chords into its cfg
  // line, so an edit there re-derives the line (and lights the reload cue)
  // without any claudeCodeUiPatch.* setting having changed.
  reapply(): void {
    void this.autoApply();
  }

  // The cheapest restart for what is pending right now (see resolveApplyAction).
  applyAction(): ApplyAction {
    return resolveApplyAction(this.ext, this.pendingReload);
  }

  // Run it, then re-baseline whatever it actually reloaded. A host restart or a
  // window reload takes this extension down with it, so the next activation
  // re-captures the baseline by itself. A webview reload leaves us running, so
  // the webview-side points have to be re-based here or their dots stay amber
  // forever; the extension.js points stay pending, because the live host is
  // still running the code it required at startup.
  async runApplyAction(action: ApplyAction): Promise<void> {
    await vscode.commands.executeCommand(action.command);
    if (action.scope === "webview") this.rebaselineWebviewPoints();
  }

  // Re-read the webview-side points and treat what is on disk as what the UI is
  // now showing. reconcilePendingReload then clears exactly those ids, leaving
  // any extension.js point pending.
  private rebaselineWebviewPoints(): void {
    if (!this.ext) return;
    const cache = new Map<string, string | undefined>();
    const read = (rel: string) => {
      if (!cache.has(rel)) cache.set(rel, readFileSafe(this.ext!, rel));
      return cache.get(rel);
    };
    for (const p of PATCH_POINTS) {
      if (!isWebviewPoint(p.id)) continue;
      const content = read(p.file);
      this.activationPx.set(
        p.id,
        content ? pointCurrentPx(content, p) : undefined,
      );
    }
    for (const t of TOGGLE_POINTS) {
      if (isWebviewPoint(t.id))
        this.activationPx.set(t.id, toggleStateStr(read, t));
    }
    for (const ip of INJECT_POINTS) {
      if (isWebviewPoint(ip.id))
        this.activationPx.set(ip.id, injectStateStr(read(ip.file), ip));
    }
    for (const a of ALWAYS_POINTS) {
      if (isWebviewPoint(a.id))
        this.activationPx.set(a.id, alwaysStateStr(read(a.file), a));
    }
    this.reconcilePendingReload();
    this.refresh();
  }

  // Toast shown after the activation-time re-apply, prompting the restart the
  // re-applied patch needs to take effect in the still-stale running window.
  // Mirrors the amber status-bar / panel cue with an actionable button, and
  // names the same cheapest action those two offer. The button re-resolves at
  // click time (via APPLY_COMMAND), so a Claude Code tab opened between the
  // toast appearing and the click still downgrades it to a window reload.
  private notifyReapplied(updated: boolean): void {
    if (!this.ext) return;
    const version = this.ext.version;
    const label = this.applyAction().label;
    const message = updated
      ? `Claude Code UI Patch: Claude Code updated to v${version}. ${label} for UI patches to take effect.`
      : `Claude Code UI Patch: Applied UI patch to Claude Code v${version}. ${label} for it to take effect.`;
    void vscode.window.showInformationMessage(message, label).then((choice) => {
      if (choice === label) {
        void vscode.commands.executeCommand(APPLY_COMMAND);
      }
    });
  }

  private reconcilePendingReload(cache?: ReadCache): void {
    if (!this.ext) return;
    const read = cacheReader(this.ext, cache);
    const reconcile = (id: string, now: string | undefined) => {
      if (now === this.activationPx.get(id)) this.pendingReload.delete(id);
      else this.pendingReload.add(id);
    };
    for (const p of PATCH_POINTS) {
      const content = read(p.file);
      reconcile(p.id, content ? pointCurrentPx(content, p) : undefined);
    }
    for (const t of TOGGLE_POINTS) {
      reconcile(t.id, toggleStateStr(read, t));
    }
    for (const ip of INJECT_POINTS) {
      reconcile(ip.id, injectStateStr(read(ip.file), ip));
    }
    for (const a of ALWAYS_POINTS) {
      reconcile(a.id, alwaysStateStr(read(a.file), a));
    }
  }

  // Capture the real native stock values from the bundle. Only force-capture
  // (including number-style points) when a saved version exists and genuinely
  // differs — that means a real Claude Code update laid down a fresh unpatched
  // bundle. When savedVersion is undefined (first install or reinstall after
  // globalState was cleared), the bundle may already be patched, so we only
  // capture value-style points (reliably detected as stock via var()) and fall
  // back to hardcoded originalPx for number-style points.
  private refreshStockCapture(ext: ClaudeExt, cache?: ReadCache): void {
    const savedVersion =
      this.context.globalState.get<string>(STOCK_VERSION_KEY);
    const savedValues = this.context.globalState.get<StockCapture>(
      STOCK_VALUES_KEY,
      {},
    );
    const realVersionChange =
      savedVersion !== undefined && savedVersion !== ext.version;

    let capture: StockCapture;
    if (realVersionChange) {
      capture = captureStockValues(ext, true, cache);
    } else {
      capture = { ...savedValues, ...captureStockValues(ext, false, cache) };
    }

    this.stockCapture = capture;
    // globalState writes hit the extension-host storage DB; skip them when the
    // pass changed nothing, which is every pass but the first per version.
    if (savedVersion !== ext.version) {
      void this.context.globalState.update(STOCK_VERSION_KEY, ext.version);
    }
    if (JSON.stringify(savedValues) !== JSON.stringify(capture)) {
      void this.context.globalState.update(STOCK_VALUES_KEY, capture);
    }
  }

  // Set an absolute size for a patch knob. The panel computes the target value
  // (accumulating rapid clicks on its own optimistic display) and sends it here,
  // so quick successive clicks can't lose increments to a read-modify-write
  // race. The setting update triggers onDidChangeConfiguration → autoApply,
  // which writes the bundle and refreshes.
  async setSize(target: string, value: number): Promise<void> {
    // The chat text size knob is an injection (chatHistoryFontSize): adjusting it
    // from the inherited display writes an absolute px, taking control from the
    // native chat.fontSize.
    // Weight knobs ride the same path: the panel sends an absolute number and
    // the point's own effective() snaps it (and maps the native weight back to
    // "no rule"), so only the clamp differs.
    const ip = INJECT_POINTS.find(
      (x) => x.id === target && (x.kind === "size" || x.kind === "weight"),
    );
    if (ip) {
      const next = Math.min(
        ip.max,
        Math.max(ip.min ?? MIN_PX, Math.round(value * 100) / 100),
      );
      const cur = readInject(ip);
      if (typeof cur === "number" && cur === next) return;
      await vscode.workspace
        .getConfiguration(CONFIG_NS)
        .update(ip.key, next, vscode.ConfigurationTarget.Global);
      return;
    }
    const p = PATCH_POINTS.find((x) => x.id === target);
    if (!p) return;
    const next = Math.min(p.maxPx, Math.max(MIN_PX, Number(formatPx(value))));
    if (next === readSizes()[target]) return;
    await vscode.workspace
      .getConfiguration(CONFIG_NS)
      .update(p.key, next, vscode.ConfigurationTarget.Global);
  }

  // Set an absolute size for the native chat.fontSize knob. The config listener
  // reacts with a refresh, so no explicit refresh is needed here.
  async setNative(target: string, value: number): Promise<void> {
    const k = NATIVE_KNOBS.find((x) => x.id === target);
    if (!k) return;
    const next = Number(formatNativePx(value));
    if (next === nativePx(k)) return;
    await vscode.workspace
      .getConfiguration()
      .update(k.vscodeKey, next, vscode.ConfigurationTarget.Global);
  }

  // Flip a toggle knob. Writing the boolean setting triggers
  // onDidChangeConfiguration → autoApply, which rewrites the bundle and refreshes.
  async setToggle(target: string, on: boolean): Promise<void> {
    const t = TOGGLE_POINTS.find((x) => x.id === target);
    if (!t) return;
    if (on === readToggles()[target]) return;
    await vscode.workspace
      .getConfiguration(CONFIG_NS)
      .update(t.key, on, vscode.ConfigurationTarget.Global);
  }

  // Discard modifications made since the last window reload: reset every knob to
  // the value that was on disk at activation (the "floor" a reload establishes),
  // i.e. what the live UI currently shows. Unlike restore (which always goes to
  // native), this reverts only the not-yet-reloaded changes, so it needs no
  // reload. The config changes trigger autoApply, which rewrites the bundle to
  // the floor.
  async discard(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    await Promise.all([
      ...PATCH_POINTS.map((p) => {
        const floor = this.activationPx.get(p.id);
        // The floor was native where it read undefined, or where a bare-number
        // own slot held its stock number: a pin at that number is the same
        // bytes there, and native is the reading that still holds after a
        // Claude Code update. Native is cleared, never set to 0 (see restore).
        const alt = this.states.find((s) => s.id === p.id)?.alt;
        const native =
          floor === undefined ||
          (p.style === "number" &&
            !alt &&
            floor === formatPx(stockNumberFor(p, this.stockCapture)));
        return cfg.update(
          p.key,
          native ? undefined : Number(floor),
          vscode.ConfigurationTarget.Global,
        );
      }),
      ...TOGGLE_POINTS.flatMap((t) => {
        // floor is the full state string (e.g. "on+css" / "off+nocss"); its on/off
        // is the leading token.
        const floor = this.activationPx.get(t.id);
        // A build that ships the feature has no floor of ours, and the setting
        // is inert there, so it stays as the user left it.
        const status = this.toggleStates.find((s) => s.id === t.id)?.status;
        if (floor === "leftover" || status === "native") return [];
        const value =
          floor !== undefined ? floor.startsWith("on") : t.defaultOn;
        return [cfg.update(t.key, value, vscode.ConfigurationTarget.Global)];
      }),
      ...INJECT_POINTS.flatMap((ip) => {
        // Nor does an inert point: another point carries its setting here.
        const status = this.injectStates.find((s) => s.id === ip.id)?.status;
        if (status === "inert") return [];
        return [
          cfg.update(
            ip.key,
            injectFloorToRaw(ip, this.activationPx.get(ip.id)),
            vscode.ConfigurationTarget.Global,
          ),
        ];
      }),
    ]);
    this.refresh();
  }

  // Factory reset (the panel's red button): revert every knob to Claude Code's
  // native value. Writes the native bundle and resets the settings; the panel's
  // "Reload Window" link lights up to apply it, so no separate prompt is needed.
  async restore(): Promise<void> {
    if (!this.ext) {
      void vscode.window.showErrorMessage(
        "Claude Code UI Patch: couldn't find an installed Claude Code extension.",
      );
      return;
    }
    try {
      restorePatch(this.ext, this.stockCapture);
      this.reconcilePendingReload();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Claude Code UI Patch: failed to restore Claude Code v${this.ext.version}: ${(err as Error).message}`,
      );
      return;
    }
    // Reset all patch settings to their stock values so the panel/settings
    // reflect the restored native state, not the enlarged values. The size
    // settings are cleared rather than set to 0: before 1.6.0 they bottomed out
    // at 6 and read 0 as 6px, so an explicit 0 that Settings Sync carried to a
    // machine still on an older build would shrink its text. The math size is
    // cleared for the same reason (older builds read its 0 as 0.5em).
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    await Promise.all([
      ...PATCH_POINTS.map((p) =>
        cfg.update(p.key, undefined, vscode.ConfigurationTarget.Global),
      ),
      ...TOGGLE_POINTS.map((t) =>
        cfg.update(t.key, t.defaultOn, vscode.ConfigurationTarget.Global),
      ),
      ...INJECT_POINTS.map((ip) =>
        cfg.update(
          ip.key,
          ip.clearAtNative ? undefined : ip.defaultRaw,
          vscode.ConfigurationTarget.Global,
        ),
      ),
      ...EXTRA_PATCH_KEYS.map(([k, v]) =>
        cfg.update(k, v, vscode.ConfigurationTarget.Global),
      ),
    ]);
    this.refresh();
  }
}

function cmdLink(label: string, command: string, args?: unknown[]): string {
  const query = args ? "?" + encodeURIComponent(JSON.stringify(args)) : "";
  return `[${label}](command:${command}${query})`;
}

// Read-only font-size summary for the status-bar hover. Requires a trusted,
// theme-icon MarkdownString. Click the status-bar item to open the webview
// panel for interactive controls; click the gear to jump to settings.
export function tooltipLines(snap: Snapshot | undefined): string[] {
  if (!snap || !snap.available) return [];

  // Title (heading) with the version on its own plain line below it.
  const out: string[] = [
    `### Claude Code UI Patch`,
    `Claude Code v${snap.version}`,
  ];

  // Right-align the px in a monospace column. A status-bar tooltip is a
  // MarkdownString, whose text size VS Code controls (extensions can't set it);
  // the only lever is heading level, so section titles are rendered as headings
  // and the rows as a fenced (monospace) block that keeps the numbers aligned.
  // `gap` widens the label→value spacing so the popup has more horizontal room.
  const valueStr = (k: Knob) =>
    k.kind === "toggle" ? (k.on ? "on" : "off") : `${k.px}${k.unit}`;
  // The tooltip stays a glanceable summary of the two surface sections; the
  // Behavior toggles are set-and-forget, shown in the panel only.
  const rows = snap.knobs.filter(
    (k) => !HIDDEN_KNOBS.has(k.id) && k.section !== "Behavior",
  );
  // One shared set of column widths: the section blocks render stacked in the
  // same monospace face, so the value column lines up across them.
  const labelW = rows.length ? Math.max(...rows.map((k) => k.label.length)) : 0;
  const pxW = rows.length
    ? Math.max(...rows.map((k) => valueStr(k).length))
    : 0;
  const gap = "        "; // 8 spaces

  for (const section of SECTION_ORDER) {
    const ks = rows.filter((k) => k.section === section);
    if (!ks.length) continue;
    out.push("", "---", "", `### ${section}`, "```text");
    for (const k of ks) {
      out.push(`${k.label.padEnd(labelW)}${gap}${valueStr(k).padStart(pxW)}`);
    }
    out.push("```");
  }

  out.push(
    "",
    "---",
    "",
    `${cmdLink("$(gear) Open Settings", "workbench.action.openSettings", ["claudeCodeUiPatch"])}  ·  ${cmdLink(`${snap.apply.icon} ${snap.apply.label}`, APPLY_COMMAND)}`,
  );

  if (!snap.supported) {
    out.push(
      "",
      `$(circle-slash) patch not supported on Claude Code v${snap.version}`,
    );
  }

  return out;
}
