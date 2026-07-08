import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

export type Section = "Chat Panel or Tab" | "Plan Mode Markdown Preview";
export const SECTION_ORDER: Section[] = [
  "Chat Panel or Tab",
  "Plan Mode Markdown Preview",
];

// Display order of knobs within a section (panel and popup), by point id. Ids
// not listed keep their natural order after the listed ones.
const KNOB_ORDER: string[] = [
  "chatHistorySize", // agent response
  "chatCodeInline", // inline code
  "chatCode", // code block
  "diffCard",
  "diffLineNumbers",
  "diffThemeSync",
  "permCode",
  "permNoWrap",
  "effortSyncFix",
  "text", // plan agent response
  "planCodeInline", // plan inline code
  "code", // plan code block
  "preview", // plan comment quote
  "input", // plan comment composer
  "badge", // plan comment badge
];
function knobOrder(id: string): number {
  const i = KNOB_ORDER.indexOf(id);
  return i < 0 ? KNOB_ORDER.length : i;
}

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
  { id: "chatText", label: "text", vscodeKey: "chat.fontSize", fallback: 13 },
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
  key: string; // settings sub-key under the claudeCodeUiPatch namespace
  defaultPx: number;
  maxPx: number; // clamp for ▲/▼ adjust
  file: string; // path relative to the install dir
  originalPx: number; // stock px (for messaging / number-style restore)
  style?: "number" | "value";
  originalValue?: string; // value-style restore target
  res?: RegExp[]; // value-slot regexes, each capturing (prefix)(value)(suffix)
  // Custom transform (used when fnApply is present):
  fnPresent?: (c: string) => boolean;
  fnCurrentPx?: (c: string) => string | undefined; // undefined => stock/native
  fnApply?: (c: string, px: string) => string;
  fnRestore?: (c: string) => string;
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
// The fixed size in the bundle, or undefined when at the native stock (12).
function diffFontCurrent(c: string): string | undefined {
  DIFF_FONT_RE.lastIndex = 0;
  const v = DIFF_FONT_RE.exec(c)?.[2];
  return v === undefined || Number(v) === DIFF_FONT_STOCK ? undefined : v;
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

const PATCH_POINTS: PatchPoint[] = [
  {
    id: "chatCode",
    section: "Chat Panel or Tab",
    label: "code block",
    key: "chatCodeBlockFontSize",
    defaultPx: 11,
    maxPx: 24,
    file: "webview/index.css",
    originalPx: 11,
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
    defaultPx: 12,
    maxPx: 24,
    file: "webview/index.js",
    originalPx: 12,
    fnPresent: diffFontPresent,
    fnCurrentPx: diffFontCurrent,
    fnApply: diffFontSet,
    fnRestore: diffFontRestore,
  },
  {
    id: "text",
    section: "Plan Mode Markdown Preview",
    label: "agent response",
    key: "planPreviewFontSize",
    defaultPx: 14,
    maxPx: 24,
    file: "extension.js",
    originalPx: 14,
    style: "value",
    originalValue: "var(--vscode-markdown-font-size, 14px)",
    // Anchor on the plan-preview `body` rule's font-size, tolerating any
    // font-family value before it, so this composes with the planPreviewFontFamily
    // injection (which rewrites that same rule's font-family). extension.js has a
    // single `body {` rule, so this stays unambiguous.
    res: [
      /(body \{\s*font-family:[^;]+;\s*font-size:\s*)(var\(--vscode-markdown-font-size, \d+(?:\.\d+)?px\)|\d+(?:\.\d+)?px)(;)/,
    ],
  },
  {
    id: "code",
    section: "Plan Mode Markdown Preview",
    label: "code block",
    key: "planPreviewCodeBlockFontSize",
    defaultPx: 13,
    maxPx: 24,
    file: "extension.js",
    originalPx: 13,
    style: "value",
    originalValue: "var(--vscode-editor-font-size, 13px)",
    res: [
      /(font-family: var\(--vscode-editor-font-family\);\s*font-size:\s*)(var\(--vscode-editor-font-size, \d+(?:\.\d+)?px\)|\d+(?:\.\d+)?px)(;)/,
    ],
  },
  {
    id: "preview",
    section: "Plan Mode Markdown Preview",
    label: "comment quote",
    key: "planPreviewCommentQuoteFontSize",
    defaultPx: 12,
    maxPx: 24,
    file: "extension.js",
    originalPx: 12,
    style: "number",
    res: [
      /(\.selected-text-preview\s*\{[^}]*?font-size:\s*)(\d+(?:\.\d+)?)(px)/,
    ],
  },
  {
    id: "input",
    section: "Plan Mode Markdown Preview",
    label: "comment input box",
    key: "planPreviewCommentInputFontSize",
    defaultPx: 13,
    maxPx: 24,
    file: "extension.js",
    originalPx: 13,
    style: "number",
    res: [
      /(#comment-input textarea\s*\{[^}]*?font-size:\s*)(\d+(?:\.\d+)?)(px)/,
    ],
  },
  {
    id: "badge",
    section: "Plan Mode Markdown Preview",
    label: "comment badge",
    key: "planPreviewCommentBadgeFontSize",
    defaultPx: 10,
    maxPx: 12,
    file: "extension.js",
    originalPx: 10,
    style: "number",
    res: [/(\.comment-indicator\s*\{[^}]*?font-size:\s*)(\d+(?:\.\d+)?)(px)/],
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

// Gutter cleanup appended to webview/index.css when line numbers are ON. The diff
// card marks changed lines with codicon glyphs (codicon-diff-insert = the "+"
// icon, codicon-diff-remove = the "-" icon), but this bundle's codicon subset
// can't draw them, so they fall back to empty notdef boxes next to each line. We
// re-point those glyphs at a text font and render literal "+"/"-", turning the
// boxes into the real diff signs; and we flatten line 1's always-bright active
// line number to the normal color. Scoped to every diff container found in the
// stylesheet (the inline card and the expand modal use different CSS-module
// hashes, e.g. _s6OFow and _oXZawA), so both render the signs.
const DIFF_LINES_CSS_MARKER = "/*ccup:diffLines*/";
const DIFF_CONTAINER_HASH_RE = /\.diffEditorContainer_([-\w]+)\{/g;

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
    // Swap the whole lineNumbers value; ON also sets lineNumbersMinChars:2 to keep
    // the gutter narrow (Monaco's default minimum is 5 chars, which widens the
    // margin noticeably). The optional min-chars group in the match also accepts a
    // prior build's bare lineNumbers:"on", so re-applying upgrades it in place.
    re: /(fontSize:\d+(?:\.\d+)?,)(lineNumbers:"(?:off|on)"(?:,lineNumbersMinChars:\d+)?)(,)/g,
    onValue: 'lineNumbers:"on",lineNumbersMinChars:2',
    offValue: 'lineNumbers:"off"',
    isOn: (v) => v.includes('"on"'),
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
  },
  {
    id: "effortSyncFix",
    section: "Chat Panel or Tab",
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
    section: "Chat Panel or Tab",
    label: "permission code fontsize sync",
    key: "chatPermissionCodeMatchChatCodeBlock",
    defaultOn: false,
    file: "webview/index.css",
    fnPresent: permCodePresent,
    fnCurrentOn: permCodeCurrentOn,
    fnSet: permCodeSet,
  },
  {
    id: "permNoWrap",
    section: "Chat Panel or Tab",
    label: "permission code no-wrap",
    key: "chatPermissionCodeNoWrap",
    defaultOn: false,
    file: "webview/index.css",
    fnPresent: permNoWrapPresent,
    fnCurrentOn: permNoWrapCurrentOn,
    fnSet: permNoWrapSet,
  },
];

export type ToggleMap = Record<string, boolean>;

export function readToggles(): ToggleMap {
  const c = vscode.workspace.getConfiguration(CONFIG_NS);
  const m: ToggleMap = {};
  for (const t of TOGGLE_POINTS) m[t.id] = c.get<boolean>(t.key, t.defaultOn);
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
  ["chatPermissionCodeMatchChatCodeblock", "chatPermissionCodeMatchChatCodeBlock"],
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
      `${c} .line-numbers.active-line-number{color:var(--vscode-editorLineNumber-foreground) !important}`
    );
  };
  return DIFF_LINES_CSS_MARKER + hashes.map(perContainer).join("");
}

// Append (or replace) a single marker-tagged line in a CSS file, and its inverse.
// String-based (not regex) so a marker containing /* */ needs no escaping.
function cssApplyLine(css: string, marker: string, line: string): string {
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
  kind: "size" | "family" | "rows" | "align";
  file: string;
  showInPanel: boolean; // size shows as a knob; strings/rows are settings-only
  max: number; // upper clamp for a size knob (unused otherwise)
  defaultRaw: InjectValue; // config default
  effective: (raw: InjectValue) => InjectValue | undefined; // undefined = off
  inheritFrom?: string; // PATCH_POINT id whose size this follows when off (panel display)
  present: (c: string) => boolean; // anchor patchable in this file?
  current: (c: string) => InjectValue | undefined; // value in bundle, or undefined
  apply: (c: string, v: InjectValue) => string;
  remove: (c: string) => string;
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
// scoping there would drag the reading font onto that chrome.
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
// font-family (stock is the markdown var). Composes with the planPreviewFontSize
// point, which anchors on the same rule's font-size independent of the family.
const PLAN_FAMILY_STOCK =
  "var(--vscode-markdown-font-family, var(--vscode-font-family))";
const PLAN_FAMILY_RE =
  /(body \{\s*font-family:\s*)(var\(--vscode-markdown-font-family, var\(--vscode-font-family\)\)|[^;]+?)(;\s*font-size:)/;

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
    current: (c) => {
      const m = c.match(PLAN_FAMILY_RE);
      if (!m) return undefined;
      return m[2] === PLAN_FAMILY_STOCK ? undefined : m[2];
    },
    apply: (c, v) =>
      c.replace(PLAN_FAMILY_RE, (_w, p, _v, s) => `${p}${v}${s}`),
    remove: (c) =>
      c.replace(
        PLAN_FAMILY_RE,
        (_w, p, _v, s) => `${p}${PLAN_FAMILY_STOCK}${s}`,
      ),
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
    section: "Chat Panel or Tab",
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

// Map an activation-floor string (from injectStateStr) back to a config value.
function injectFloorToRaw(
  ip: InjectPoint,
  floor: string | undefined,
): InjectValue {
  if (floor === undefined || floor === "off") return ip.defaultRaw;
  return ip.kind === "family" || ip.kind === "align" ? floor : Number(floor);
}

export type SizeMap = Record<string, number>;

export function readSizes(): SizeMap {
  const c = vscode.workspace.getConfiguration(CONFIG_NS);
  const m: SizeMap = {};
  for (const p of PATCH_POINTS)
    m[p.id] = Number(formatPx(c.get<number>(p.key, p.defaultPx)));
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

// --- per-point primitives (dispatch to custom fns or the value-slot model) ---

function pointPresent(content: string, p: PatchPoint): boolean {
  return p.fnPresent
    ? p.fnPresent(content)
    : p.res!.some((re) => re.test(content));
}

// px string if a fixed size is in place, or undefined for the stock/native form.
function pointCurrentPx(content: string, p: PatchPoint): string | undefined {
  if (p.fnCurrentPx) return p.fnCurrentPx(content);
  for (const re of p.res!) {
    const m = content.match(re);
    if (!m) continue;
    if (p.style === "number") return m[2];
    return /^\d/.test(m[2]) ? m[2].replace("px", "") : undefined; // value style
  }
  return undefined;
}

function pointSet(content: string, p: PatchPoint, px: string): string {
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
): string {
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
function captureStockValues(ext: ClaudeExt, force: boolean): StockCapture {
  const captured: StockCapture = {};
  const cache = new Map<string, string | undefined>();
  const read = (rel: string) => {
    if (!cache.has(rel)) cache.set(rel, readFileSafe(ext, rel));
    return cache.get(rel);
  };
  for (const p of PATCH_POINTS) {
    if (!p.style || !p.res) continue;
    const content = read(p.file);
    if (!content || !pointPresent(content, p)) continue;

    if (p.style === "value") {
      if (pointCurrentPx(content, p) === undefined) {
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

function extensionsDirs(context: vscode.ExtensionContext): string[] {
  const dirs = new Set<string>();
  dirs.add(path.dirname(context.extensionUri.fsPath));
  dirs.add(path.join(os.homedir(), ".vscode", "extensions"));
  dirs.add(path.join(os.homedir(), ".vscode-insiders", "extensions"));
  dirs.add(path.join(os.homedir(), ".vscode-oss", "extensions"));
  return [...dirs].filter((d) => fs.existsSync(d));
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
    for (const name of entries) {
      if (!name.startsWith(EXT_PREFIX)) continue;
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

export type PointState =
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
  | { id: string; label: string; section: Section; status: "missing" };

function readFileSafe(ext: ClaudeExt, rel: string): string | undefined {
  try {
    return fs.readFileSync(filePath(ext, rel), "utf8");
  } catch {
    return undefined;
  }
}

export function analyze(
  ext: ClaudeExt,
  sizes: SizeMap,
  capture: StockCapture,
): PointState[] {
  const cache = new Map<string, string | undefined>();
  const read = (rel: string) => {
    if (!cache.has(rel)) cache.set(rel, readFileSafe(ext, rel));
    return cache.get(rel);
  };
  return PATCH_POINTS.map((p): PointState => {
    const base = { id: p.id, label: p.label, section: p.section };
    const content = read(p.file);
    if (content === undefined || !pointPresent(content, p)) {
      return { ...base, status: "missing" };
    }
    const stockNum = stockNumberFor(p, capture);
    const want = formatPx(sizes[p.id]);
    const stockWant = want === formatPx(stockNum);
    const cur = pointCurrentPx(content, p);
    const isStock =
      p.style === "number" ? cur === formatPx(stockNum) : cur === undefined;

    if (stockWant && isStock)
      return { ...base, status: "current", px: `${stockNum}` };
    if (!stockWant && cur === want)
      return { ...base, status: "current", px: cur };
    if (isStock) return { ...base, status: "stock", px: `${stockNum}`, want };
    return { ...base, status: "custom", px: cur ?? `${stockNum}`, want };
  });
}

export type ToggleStatus = "current" | "stock" | "custom" | "missing";
export interface ToggleState {
  id: string;
  label: string;
  section: Section;
  status: ToggleStatus;
  wantOn: boolean; // the setting value (what the panel shows and apply targets)
}

// Same shape as analyze() but for on/off points: "stock" = bundle at native and
// the setting wants it flipped; "custom" = bundle flipped the other way from the
// setting (e.g. a leftover patch the setting no longer wants).
export function analyzeToggles(
  ext: ClaudeExt,
  toggles: ToggleMap,
): ToggleState[] {
  const cache = new Map<string, string | undefined>();
  const read = (rel: string) => {
    if (!cache.has(rel)) cache.set(rel, readFileSafe(ext, rel));
    return cache.get(rel);
  };
  return TOGGLE_POINTS.map((t): ToggleState => {
    const base = { id: t.id, label: t.label, section: t.section };
    const wantOn = toggles[t.id];
    const cur = toggleStateStr(read, t);
    if (cur === undefined) return { ...base, status: "missing", wantOn };
    if (cur === toggleWantStr(t, wantOn))
      return { ...base, status: "current", wantOn };
    if (cur === toggleWantStr(t, t.defaultOn))
      return { ...base, status: "stock", wantOn };
    return { ...base, status: "custom", wantOn };
  });
}

export type InjectStatus = "current" | "stock" | "custom" | "missing";
export interface InjectState {
  id: string;
  label: string;
  section: Section;
  status: InjectStatus;
  value: InjectValue | undefined; // the setting value (undefined = off)
}

// Same shape as analyze()/analyzeToggles() for the string/size/rows injections:
// "stock" = bundle native and the setting wants an injection; "custom" = the
// bundle carries an injection differing from the setting (leftover or drifted).
export function analyzeInjects(ext: ClaudeExt): InjectState[] {
  const cache = new Map<string, string | undefined>();
  const read = (rel: string) => {
    if (!cache.has(rel)) cache.set(rel, readFileSafe(ext, rel));
    return cache.get(rel);
  };
  return INJECT_POINTS.map((ip): InjectState => {
    const base = { id: ip.id, label: ip.label, section: ip.section };
    const want = readInject(ip);
    const content = read(ip.file);
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
      if (!pointPresent(out, p)) continue;
      const want = formatPx(sizes[p.id]);
      const stockWant = want === formatPx(stockNumberFor(p, capture));
      const cur = pointCurrentPx(out, p);
      const next = stockWant
        ? pointRestore(out, p, stockValueFor(p, capture))
        : pointSet(out, p, want);
      if (next !== out) {
        out = next;
        changed.push(
          stockWant
            ? `${p.label} ${cur}px→stock`
            : `${p.label} ${cur ?? "stock"}→${want}px`,
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
      const wantOn = toggles[t.id];
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
      const wantOn = toggles[t.id];
      const rule = wantOn ? t.cssBuild(out) : undefined;
      const next = rule
        ? cssApplyLine(out, t.cssMarker, rule)
        : cssRemoveLine(out, t.cssMarker);
      if (next !== out) {
        out = next;
        changed.push(`${t.label} gutter ${wantOn ? "clean" : "native"}`);
      }
    }
    if (out !== content) writeFileAtomic(abs, out);
  }
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
      if (!pointPresent(out, p)) continue;
      const next = pointRestore(out, p, stockValueFor(p, capture));
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
        changed.push(`${t.label} gutter restored`);
      }
    }
    if (out !== content) writeFileAtomic(abs, out);
  }
  return { version: ext.version, changed };
}

// Cheap, cached view for the hover popup.
export interface Knob {
  id: string;
  section: Section;
  label: string;
  kind: "size" | "toggle";
  px: string; // size knobs: current px; toggle knobs: unused ("")
  on: boolean; // toggle knobs: current on/off; size knobs: unused (false)
  max: number; // upper clamp for the panel's ▲/▼ controls (size knobs)
  native: boolean;
  state: "current" | "stock" | "custom" | "missing";
  pendingReload: boolean; // this row's bundle was written but window not reloaded
  nativeKey?: string;
}

export interface Snapshot {
  available: boolean;
  supported: boolean; // at least one patch anchor present
  version: string;
  knobs: Knob[]; // native chat + present patch knobs, in section order
  applied: boolean;
  actionable: boolean;
  needsReload: boolean; // bundle written this session but window not reloaded
}

export class Patcher {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private ext: ClaudeExt | undefined;
  private states: PointState[] = [];
  private toggleStates: ToggleState[] = [];
  private injectStates: InjectState[] = [];
  private stockCapture: StockCapture = {};
  private pendingReload = new Set<string>(); // point IDs written but not reloaded
  private activationPx = new Map<string, string | undefined>(); // on-disk px at activation

  constructor(private readonly context: vscode.ExtensionContext) {
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
        this.injectStates.some(drifted))
    ) {
      void this.autoApply();
    }
  }

  register(): vscode.Disposable[] {
    const patchKeys = [
      ...PATCH_POINTS.map((p) => p.key),
      ...TOGGLE_POINTS.map((t) => t.key),
      ...INJECT_POINTS.map((ip) => ip.key),
    ].map((k) => `${CONFIG_NS}.${k}`);
    // chat.fontSize is no longer a knob, but the chatHistoryFontSize knob shows it
    // while inheriting, so a native change should refresh (not re-patch) the view.
    const nativeKeys = NATIVE_KNOBS.map((k) => k.vscodeKey);
    return [
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (patchKeys.some((k) => e.affectsConfiguration(k))) {
          this.autoApply();
        } else if (nativeKeys.some((k) => e.affectsConfiguration(k))) {
          this.refresh();
        }
      }),
      this.emitter,
    ];
  }

  snapshot(): Snapshot | undefined {
    if (!this.ext) return undefined;
    const sizes = readSizes();
    const toggles = readToggles();
    const statusById = new Map(this.states.map((s) => [s.id, s.status]));
    const toggleStatusById = new Map(
      this.toggleStates.map((s) => [s.id, s.status]),
    );
    const injectStatusById = new Map(
      this.injectStates.map((s) => [s.id, s.status]),
    );
    // The chat text size knob (formerly the native chat.fontSize knob) is now the
    // chatHistoryFontSize injection: it shows the effective size (its own value, or
    // the inherited chat.fontSize when unset) and adjusting it takes control.
    const chat: Knob[] = INJECT_POINTS.filter(
      (ip) => ip.showInPanel && injectStatusById.get(ip.id) !== "missing",
    ).map((ip) => {
      const eff = readInject(ip);
      return {
        id: ip.id,
        section: ip.section,
        label: ip.label,
        kind: "size" as const,
        px: formatNativePx(
          typeof eff === "number"
            ? eff
            : ip.inheritFrom
              ? sizes[ip.inheritFrom]
              : nativeChatFontSizePx(),
        ),
        on: false,
        max: ip.max,
        native: false,
        state:
          (injectStatusById.get(ip.id) as "current" | "stock" | "custom") ??
          "stock",
        pendingReload: this.pendingReload.has(ip.id),
      };
    });
    const patch: Knob[] = PATCH_POINTS.filter(
      (p) => statusById.get(p.id) !== "missing",
    ).map((p) => ({
      id: p.id,
      section: p.section,
      label: p.label,
      kind: "size" as const,
      px: formatPx(sizes[p.id]),
      on: false,
      max: p.maxPx,
      native: false,
      state:
        (statusById.get(p.id) as "current" | "stock" | "custom") ?? "stock",
      pendingReload: this.pendingReload.has(p.id),
    }));
    const toggleKnobs: Knob[] = TOGGLE_POINTS.filter(
      (t) => toggleStatusById.get(t.id) !== "missing",
    ).map((t) => ({
      id: t.id,
      section: t.section,
      label: t.label,
      kind: "toggle" as const,
      px: "",
      on: toggles[t.id],
      max: 0,
      native: false,
      state:
        (toggleStatusById.get(t.id) as "current" | "stock" | "custom") ??
        "stock",
      pendingReload: this.pendingReload.has(t.id),
    }));
    const presentSizes = this.states.filter((s) => s.status !== "missing");
    const presentToggles = this.toggleStates.filter(
      (s) => s.status !== "missing",
    );
    const presentInjects = this.injectStates.filter(
      (s) => s.status !== "missing",
    );
    const anyPresent =
      presentSizes.length + presentToggles.length + presentInjects.length > 0;
    const allCurrent =
      presentSizes.every((s) => s.status === "current") &&
      presentToggles.every((s) => s.status === "current") &&
      presentInjects.every((s) => s.status === "current");
    return {
      available: true,
      supported: anyPresent,
      version: this.ext.version,
      knobs: [...chat, ...patch, ...toggleKnobs].sort(
        (a, b) => knobOrder(a.id) - knobOrder(b.id),
      ),
      applied: anyPresent && allCurrent,
      actionable: !allCurrent,
      needsReload: this.pendingReload.size > 0,
    };
  }

  private refresh(): void {
    this.ext = findLatestClaudeExt(this.context);
    if (this.ext) {
      this.refreshStockCapture(this.ext);
      this.states = analyze(this.ext, readSizes(), this.stockCapture);
      this.toggleStates = analyzeToggles(this.ext, readToggles());
      this.injectStates = analyzeInjects(this.ext);
      if (this.activationPx.size === 0) this.captureActivationPx();
    } else {
      this.states = [];
      this.toggleStates = [];
      this.injectStates = [];
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
  }

  // Auto-apply: any patch setting change writes to the bundle immediately.
  // After writing, reconcile pendingReload in a single pass, then refresh once.
  private async autoApply(): Promise<void> {
    // Re-resolve the install in case Claude Code updated in place since the last
    // refresh (its versioned directory changes on update, so a cached ext could
    // point at a directory that no longer exists).
    this.ext = findLatestClaudeExt(this.context);
    if (!this.ext) {
      this.refresh();
      return;
    }
    try {
      applyPatch(this.ext, readSizes(), readToggles(), this.stockCapture);
      this.reconcilePendingReload();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Claude Code UI Patch: failed to patch Claude Code: ${(err as Error).message}`,
      );
    }
    this.refresh();
  }

  private reconcilePendingReload(): void {
    if (!this.ext) return;
    const cache = new Map<string, string | undefined>();
    const read = (rel: string) => {
      if (!cache.has(rel)) cache.set(rel, readFileSafe(this.ext!, rel));
      return cache.get(rel);
    };
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
  }

  // Capture the real native stock values from the bundle. Only force-capture
  // (including number-style points) when a saved version exists and genuinely
  // differs — that means a real Claude Code update laid down a fresh unpatched
  // bundle. When savedVersion is undefined (first install or reinstall after
  // globalState was cleared), the bundle may already be patched, so we only
  // capture value-style points (reliably detected as stock via var()) and fall
  // back to hardcoded originalPx for number-style points.
  private refreshStockCapture(ext: ClaudeExt): void {
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
      capture = captureStockValues(ext, true);
    } else {
      capture = { ...savedValues, ...captureStockValues(ext, false) };
    }

    this.stockCapture = capture;
    void this.context.globalState.update(STOCK_VERSION_KEY, ext.version);
    void this.context.globalState.update(STOCK_VALUES_KEY, capture);
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
    const ip = INJECT_POINTS.find((x) => x.id === target && x.kind === "size");
    if (ip) {
      const next = Math.min(
        ip.max,
        Math.max(MIN_PX, Math.round(value * 100) / 100),
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
        const value =
          floor !== undefined
            ? Number(floor)
            : stockNumberFor(p, this.stockCapture);
        return cfg.update(p.key, value, vscode.ConfigurationTarget.Global);
      }),
      ...TOGGLE_POINTS.map((t) => {
        // floor is the full state string (e.g. "on+css" / "off+nocss"); its on/off
        // is the leading token.
        const floor = this.activationPx.get(t.id);
        const value =
          floor !== undefined ? floor.startsWith("on") : t.defaultOn;
        return cfg.update(t.key, value, vscode.ConfigurationTarget.Global);
      }),
      ...INJECT_POINTS.map((ip) =>
        cfg.update(
          ip.key,
          injectFloorToRaw(ip, this.activationPx.get(ip.id)),
          vscode.ConfigurationTarget.Global,
        ),
      ),
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
    // reflect the restored native state, not the enlarged values.
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    await Promise.all([
      ...PATCH_POINTS.map((p) =>
        cfg.update(p.key, p.originalPx, vscode.ConfigurationTarget.Global),
      ),
      ...TOGGLE_POINTS.map((t) =>
        cfg.update(t.key, t.defaultOn, vscode.ConfigurationTarget.Global),
      ),
      ...INJECT_POINTS.map((ip) =>
        cfg.update(ip.key, ip.defaultRaw, vscode.ConfigurationTarget.Global),
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
    k.kind === "toggle" ? (k.on ? "on" : "off") : `${k.px}px`;
  const rows = snap.knobs;
  const labelW = rows.length ? Math.max(...rows.map((k) => k.label.length)) : 0;
  const pxW = rows.length
    ? Math.max(...rows.map((k) => valueStr(k).length))
    : 0;
  const gap = "        "; // 8 spaces

  for (const section of SECTION_ORDER) {
    const ks = snap.knobs.filter((k) => k.section === section);
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
    `${cmdLink("$(gear) Open VS Code Settings", "workbench.action.openSettings", ["claudeCodeUiPatch"])}  ·  ${cmdLink("$(refresh) Reload Window", "workbench.action.reloadWindow")}`,
  );

  if (!snap.supported) {
    out.push(
      "",
      `$(circle-slash) patch not supported on Claude Code v${snap.version}`,
    );
  }

  return out;
}
