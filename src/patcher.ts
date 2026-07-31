import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

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
  "chatInputHistorySize", // user message history
  "chatCodeInline", // inline code
  "chatCode", // code block
  "chatMath", // math rendering (KaTeX)
  "diffCard",
  "diffLineNumbers",
  "diffThemeSync",
  "permCode",
  "permNoWrap",
  "effortSyncFix",
  "scrollDot", // scroll-to-bottom dot
  "jumpMsg", // jump to previous/next message
  "histKeys", // input history recall on Cmd/Ctrl+Up/Down
  "findBar", // in-chat find bar (Cmd/Ctrl+F)
  "text", // plan agent response
  "planCodeInline", // plan inline code
  "code", // plan code block
  "preview", // plan comment quote
  "input", // plan comment composer
  "badge", // plan comment badge
  "commentCtrlEnter", // plan comment send key
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
// The anchors capture the build's minified identifiers and cross-check them
// against each other (same component, same destructured names in the deps and
// the modal call, useEffect alias read from the editor-creation effect a short
// hop above the models effect it is spliced after); if ANY anchor or
// cross-check fails, the enhancement is
// skipped as a block and ON degrades to the base swap alone, so a partial
// application can never reference an identifier another edit failed to
// introduce. Injected names are ccup-prefixed to dodge minified locals, and
// every injected code path is try/catch-wrapped so it can never break the card.
// ---------------------------------------------------------------------------
const DIFF_LN_BASE_RE =
  /(fontSize:\d+(?:\.\d+)?,)(lineNumbers:"(?:off|on)"(?:,lineNumbersMinChars:\d+)?)(,)/g;
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

// tur: the webview store's result-pairing loop, `for(let o of t.message.content)
// if(o.type==="tool_result"){let r=BG(e,o.tool_use_id);if(r)r.setToolResult(o)}`
// (captures: 2=block, 3=message, 4=wrapper, 5=finder, 6=list).
const ABS_LN_TUR_RE =
  /(for\(let (\w+) of (\w+)\.message\.content\)if\(\2\.type==="tool_result"\)\{let (\w+)=(\w+)\((\w+),\2\.tool_use_id\);)(if\(\4\)\4\.setToolResult\(\2\)\})/g;

// prop: the Edit card's body, from its `is_error?"Edit failed"` head through the
// diff-component JSX call (captures: 2/3/4=body params ctx/input/result,
// 5=jsx factory, 6=component; the bounded lazy gap spans the summary line).
const ABS_LN_PROP_RE =
  /(body\((\w+),(\w+),(\w+)\)\{let \w+=\4&&\4\.is_error\?"Edit failed"[\s\S]{1,800}?\b(\w+)\((\w+),\{original:\3\.old_string\|\|"",modified:\3\.new_string\|\|"",filePath:\3\.file_path\|\|"")(\}\))/g;

// arg: the diff component's props destructure (captures: 2=component,
// 3=original, 4=modified, 5=language, 6=filePath).
const ABS_LN_ARG_RE =
  /(function (\w+)\(\{original:(\w+),modified:(\w+),language:(\w+)="plaintext",filePath:(\w+))(\}\))/g;

// card: the card's models effect, setModel followed by a FOUR-dep array (the
// modal's twin has one dep, so the arity disambiguates; captures: 1=editor ref,
// 2=setModel chunk, 3=models ref, 4..7=deps original/modified/language/
// filePath). The fx fragment is spliced in after this effect's closing `])`.
// The editor ref is read through a lookbehind so the pattern proper starts at a
// literal: a leading (\w+) has no fixed head for the regex engine to skip-scan
// with and costs ~80ms per pass over the ~5MB bundle (~3ms this way), which the
// toggle round-trip pays several times.
const ABS_LN_CARD_FX_RE =
  /(?<=(\w+))(\.current\.setModel\(\{original:(\w+)\.current\.original,modified:\3\.current\.modified\}\))\},\[(\w+),(\w+),(\w+),(\w+)\]\)/g;

// use: the diff component's editor-creation effect, read only for the build's
// useEffect alias, which the fx fragment needs to declare an effect of its own
// (captures: 1=useEffect, 2=container ref). Same lookbehind trick as above so
// the pattern proper starts at the literal `.createDiffEditor(`. This anchor
// sits a couple of thousand bytes above the models effect in the same
// component, which absLnThread checks by distance.
const ABS_LN_USEEFFECT_RE =
  /(?<=(\w+)\(\(\)=>\{if\(!(\w+)\.current\)return;let (\w+)=(\w+))\.createDiffEditor\(/g;
const ABS_LN_USEEFFECT_MAX_GAP = 4000;

// mprop: the card's expand click, openModal({original,modified,language,
// filePath}) (captures: 2=openModal, 3=original, 4=modified).
const ABS_LN_MODAL_PROP_RE =
  /(\{(\w+)\(\{original:(\w+),modified:(\w+),language:(\w+),filePath:(\w+))(\}\)\})/g;

// modal: the modal's models effect, setModel followed by the ONE-dep array
// (captures: 1=editor ref via the same lookbehind, 2=setModel chunk, 3=models
// ref, 4=deps tail, 5=modal state).
const ABS_LN_MODAL_FX_RE =
  /(?<=(\w+))(\.current\.setModel\(\{original:(\w+)\.current\.original,modified:\3\.current\.modified\}\))(\},\[(\w+)\]\))/g;

// gm: the diff editor's left-hand-side option derive, which forces the original
// editor's glyph margin on in side-by-side view.
const ABS_LN_GM_RE =
  /(\.glyphMargin=this\._options\.renderSideBySide\.get\(\))/g;

// gap: the inline-view layout's original-editor slice width (cut at the end of
// its line-number column).
const ABS_LN_GAP_RE =
  /(Math\.max\(5,this\._editors\.originalObs\.layoutInfoDecorationsLeft\.read\(\w+\)\))/g;

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

// The tool_use_result thread, or the input unchanged when any anchor or
// cross-check fails (all-or-nothing, see the block comment above).
function absLnThread(c: string): string {
  const mTur = absLnExec(ABS_LN_TUR_RE, c);
  const mProp = absLnExec(ABS_LN_PROP_RE, c);
  const mArg = absLnExec(ABS_LN_ARG_RE, c);
  const mCardFx = absLnExec(ABS_LN_CARD_FX_RE, c);
  const mUse = absLnExec(ABS_LN_USEEFFECT_RE, c);
  const mModalProp = absLnExec(ABS_LN_MODAL_PROP_RE, c);
  const mModalFx = absLnExec(ABS_LN_MODAL_FX_RE, c);
  if (
    !mTur ||
    !mProp ||
    !mArg ||
    !mCardFx ||
    !mUse ||
    !mModalProp ||
    !mModalFx
  ) {
    return c;
  }
  if (
    mArg[2] !== mProp[6] || // the card renders this same component
    mCardFx[4] !== mArg[3] || // effect deps are the destructured strings
    mCardFx[5] !== mArg[4] ||
    mModalProp[3] !== mArg[3] || // the modal receives those same strings
    mModalProp[4] !== mArg[4] ||
    // the useEffect alias comes from this component's own create effect
    mUse.index >= mCardFx.index ||
    mCardFx.index - mUse.index > ABS_LN_USEEFFECT_MAX_GAP
  ) {
    return c;
  }
  let out = c;
  out = out.replace(
    ABS_LN_TUR_RE,
    (_w, head, blk, msg, wrap, _find, _list, tail) => {
      const stash =
        `try{var ccupR=${msg}.tool_use_result;` +
        'if(ccupR&&typeof ccupR==="object"&&!ccupR.replaceAll&&' +
        'typeof ccupR.originalFile==="string"){' +
        'var ccupQ=typeof ccupR.oldString==="string"&&ccupR.oldString?' +
        `ccupR.oldString:(${wrap}&&${wrap}.content&&${wrap}.content.input&&` +
        `${wrap}.content.input.old_string);` +
        "if(ccupQ){var ccupX=ccupR.originalFile.indexOf(ccupQ);" +
        "if(ccupX>=0){var ccupN=1,ccupP=0;" +
        'while((ccupP=ccupR.originalFile.indexOf("\\n",ccupP))>=0&&ccupP<ccupX)' +
        "{ccupN++;ccupP++}" +
        `${blk}.ccupStart=ccupN}}}}catch(ccupE){}`;
      return `${head}${absLnFrag("tur", stash)}${tail}`;
    },
  );
  out = out.replace(
    ABS_LN_PROP_RE,
    (_w, head, _ctx, _input, result, _jsx, _comp, tail) =>
      `${head}${absLnFrag(
        "prop",
        `,ccupStart:(${result}&&${result}.ccupStart)`,
      )}${tail}`,
  );
  out = out.replace(
    ABS_LN_ARG_RE,
    (_w, head, _comp, _o, _m, _l, _f, tail) =>
      `${head}${absLnFrag("arg", ",ccupStart:ccupS")}${tail}`,
  );
  out = out.replace(
    ABS_LN_CARD_FX_RE,
    (_w, ref, set, _models, d1, d2, d3, d4) =>
      `${set}},[${d1},${d2},${d3},${d4}])${absLnFrag(
        "fx",
        `;${mUse[1]}(()=>{window.__ccupAbsLn&&` +
          `window.__ccupAbsLn(${ref}.current,ccupS,${d1},${d2})},` +
          `[ccupS,${d1},${d2}])`,
      )}`,
  );
  out = out.replace(
    ABS_LN_MODAL_PROP_RE,
    (_w, head, _open, _o, _m, _l, _f, tail) =>
      `${head}${absLnFrag("mprop", ",ccupStart:ccupS")}${tail}`,
  );
  out = out.replace(
    ABS_LN_MODAL_FX_RE,
    (_w, ref, set, _models, tail, state) =>
      `${set}${absLnFrag(
        "modal",
        `;window.__ccupAbsLn&&window.__ccupAbsLn(${ref}.current,${state}.ccupStart,${state}.original,${state}.modified)`,
      )}${tail}`,
  );
  return `${out}\n${ABS_LN_HELPER}`;
}

function diffLinesPresent(c: string): boolean {
  DIFF_LN_BASE_RE.lastIndex = 0;
  return DIFF_LN_BASE_RE.test(c);
}
// ON means base swap on AND the enhancement in exactly this build's form: an
// older layout (e.g. the fixed minChars:2 build, or stale fragments) compares
// unequal, reads as off, and the next apply rebuilds it in place. The compare
// factors the EOF helper line out and checks it separately, because other
// toggles (scroll dot, jump buttons, math) also append EOF lines and re-anchor
// them on each apply: whole-file equality would read as drifted forever once
// any of them lands after the helper, while the inline fragments and the
// helper's own bytes are what actually matter.
function diffLinesCurrentOn(c: string): boolean | undefined {
  const m = absLnExec(DIFF_LN_BASE_RE, c);
  if (!m) return undefined;
  if (!m[2].includes('"on"')) return false;
  const want = diffLinesSet(c, true);
  const stripHelper = (s: string) => s.replace(ABS_LN_HELPER_LINE_RE, "");
  return (
    stripHelper(c) === stripHelper(want) &&
    cssMarkedLine(c, ABS_LN_HELPER_MARKER) ===
      cssMarkedLine(want, ABS_LN_HELPER_MARKER)
  );
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
// All variable names are captured and rebuilt via backreferences, so the
// anchors survive re-minification renames across Claude Code versions; the ON
// anchor accepts either modifier property, so on/off detection does not
// depend on the platform that baked it.
const HIST_KEYS_MARKER = "/*ccup-histKeys*/";
const HIST_KEYS_MOD = process.platform === "darwin" ? "metaKey" : "ctrlKey";
const HK_ID = "[a-zA-Z_$][\\w$]*";
// Composer keydown pair; captures (1)=event, (2)=popup gates, (3)=hook handle.
const HIST_KEYS_KEY_OFF_RE = new RegExp(
  `if\\((${HK_ID})\\.key==="ArrowUp"&&(!${HK_ID}&&!${HK_ID})\\)\\{if\\((${HK_ID})\\.cycleMessage\\(-1\\)\\)\\{\\1\\.preventDefault\\(\\);return\\}\\}` +
    `if\\(\\1\\.key==="ArrowDown"&&\\2\\)\\{if\\(\\3\\.cycleMessage\\(1\\)\\)\\{\\1\\.preventDefault\\(\\);return\\}\\}`,
);
const HIST_KEYS_KEY_ON_RE = new RegExp(
  `if\\((${HK_ID})\\.key==="ArrowUp"&&\\/\\*ccup-histKeys\\*\\/\\1\\.(?:metaKey|ctrlKey)&&(!${HK_ID}&&!${HK_ID})\\)\\{if\\((${HK_ID})\\.cycleMessage\\(-1\\)\\)\\{\\1\\.preventDefault\\(\\);return\\}\\}` +
    `if\\(\\1\\.key==="ArrowDown"&&\\1\\.(?:metaKey|ctrlKey)&&\\2\\)\\{if\\(\\3\\.cycleMessage\\(1\\)\\)\\{\\1\\.preventDefault\\(\\);return\\}\\}`,
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

function histKeysKeyStr(e: string, g: string, h: string, on: boolean): string {
  const up = on ? `${HIST_KEYS_MARKER}${e}.${HIST_KEYS_MOD}&&` : "";
  const down = on ? `${e}.${HIST_KEYS_MOD}&&` : "";
  return (
    `if(${e}.key==="ArrowUp"&&${up}${g}){if(${h}.cycleMessage(-1)){${e}.preventDefault();return}}` +
    `if(${e}.key==="ArrowDown"&&${down}${g}){if(${h}.cycleMessage(1)){${e}.preventDefault();return}}`
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
// true only when BOTH edits are ON. fnSet writes the pair in one pass so a
// mixed state is not produced; if one ever appeared it reports false and a
// want=ON reconcile renormalizes it (strip, then re-apply both).
function histKeysCurrentOn(c: string): boolean | undefined {
  const key = HIST_KEYS_KEY_ON_RE.test(c)
    ? true
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
// the same stale-line reconcile as any other knob (the key is listed in
// EXTRA_PATCH_KEYS so the config listener picks it up).
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

// wrap: the markdown component's content initializer,
// `({content:e,context:t,isPartialText:i}){let n=i?wlt(e):e,` (captures:
// 1=head, 2=content, 3=isPartialText, 4=initializer, 5=separator).
const MATH_WRAP_RE =
  /(\(\{content:([\w$]+),context:[\w$]+,isPartialText:([\w$]+)\}\)\{let [\w$]+=)(\3\?[\w$]+\(\2\):\2)([,;])/g;

// code: the head of the component map's `code` renderer,
// `code:({children:c,className:d})=>{if(d)return b("code",...)` (captures:
// 1=head, 2=children, 3=className, 4=original first statement, 5=jsx factory).
const MATH_CODE_RE =
  /(code:\(\{children:([\w$]+),className:([\w$]+)\}\)=>\{)(if\(\3\)return ([\w$]+)\("code",\{className:\3,children:\2\}\);)/g;

const MATH_FRAG_END = "/*ccup:mathEnd*/";
const mathFrag = (tag: string, code: string): string =>
  `/*ccup:math:${tag}*/${code}${MATH_FRAG_END}`;
const MATH_FRAG_RE = /\/\*ccup:math:[-\w]+\*\/[\s\S]*?\/\*ccup:mathEnd\*\//g;

const MATH_KATEX_START = "/*ccup:mathKatexStart*/";
const MATH_KATEX_BLOCK_RE =
  /\n?\/\*ccup:mathKatexStart\*\/[\s\S]*?\/\*ccup:mathKatexEnd\*\//g;

const MATH_HELPER_START = "/*ccup:mathHelperStart*/";
const MATH_HELPER_BLOCK_RE =
  /\n?\/\*ccup:mathHelperStart\*\/[\s\S]*?\/\*ccup:mathHelperEnd\*\//g;

const MATH_CSS_MARKER = "/*ccup:mathCss*/";
const MATH_EM_KEY = "chatMathFontSizeEm";

// Settings that feed a point's build output without being a point of their own
// (the math css line bakes the em size in; the find-bar chord settings bake
// into its cfg line), so a change must run autoApply and a factory reset must
// clear them like any point key.
export const EXTRA_PATCH_KEYS: [string, number | string][] = [
  [MATH_EM_KEY, 1],
  ["chatFindBarNextMatchKeys", ""],
  ["chatFindBarPreviousMatchKeys", ""],
  ["chatFindBarNextMatchBlockKeys", ""],
  ["chatFindBarPreviousMatchBlockKeys", ""],
];

function readMathEm(): string {
  const raw = vscode.workspace
    .getConfiguration(CONFIG_NS)
    .get<number>(MATH_EM_KEY, 1);
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : 1;
  return String(Math.round(Math.min(3, Math.max(0.5, n)) * 100) / 100);
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
  return `${MATH_KATEX_START};(function(define,module,exports){${mathAssets.js}})();/*ccup:mathKatexEnd*/`;
}

function mathAnchorsPresent(c: string): boolean {
  MATH_WRAP_RE.lastIndex = 0;
  MATH_CODE_RE.lastIndex = 0;
  return MATH_WRAP_RE.test(c) && MATH_CODE_RE.test(c);
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
// Insert the inline fragments into a STRIPPED bundle (caller verified both
// anchors; all-or-nothing is the anchors' job, the two replaces are safe).
function mathApplyInline(c: string): string {
  let out = c.replace(
    MATH_WRAP_RE,
    (_w, head, _content, _partial, init, sep) =>
      `${head}${mathFrag(
        "wrapA",
        "(window.__ccupMathW||function(ccupX){return ccupX})(",
      )}${init}${mathFrag("wrapB", ")")}${sep}`,
  );
  out = out.replace(
    MATH_CODE_RE,
    (_w, head, ch, _cls, origIf, jsx) =>
      `${head}${mathFrag(
        "code",
        `var ccupM=window.__ccupMathR&&window.__ccupMathR(${jsx},${ch});if(ccupM)return ccupM;`,
      )}${origIf}`,
  );
  return out;
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

// Copy the KaTeX woff2 fonts into <install>/webview/fonts when ON (skipping
// up-to-date files); remove exactly those files (and the dir if it emptied)
// when OFF. Same atomic stage-and-rename as the bundle writes.
function syncMathFonts(ext: ClaudeExt, on: boolean, changed: string[]): void {
  const dir = path.join(ext.dir, "webview", "fonts");
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
      const tmp = `${dst}.${process.pid}.${atomicWriteCounter++}.tmp`;
      try {
        fs.copyFileSync(src, tmp);
        fs.renameSync(tmp, dst);
        copied++;
      } catch (err) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // best effort: nothing to clean up if the temp was never created
        }
        throw err;
      }
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

// Scroll-to-bottom button (ON): the chat auto-sticks to the newest message only
// while the view is within 50px of the bottom; once the user scrolls up to read,
// nothing signals that the conversation has run ahead, and the only way back is
// manual scrolling. When ON we append a marked, self-contained IIFE at the end
// of webview/index.js that mounts a small button just OUTSIDE the input box's
// contour, above its top-right corner (anchored to the bordered box
// .inputContainer_<hash> at top:-34px/right:5px, so it clears the box border,
// shares the send button's 5px right inset (the footer padding) and therefore
// its vertical column, and never shares a row with the send button, the source
// of the earlier dot's shifting). It mirrors the send button's footprint (a
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
// .inputContainer_<hash>; the chat module via messagesContainer); if either map
// is gone the point reports missing and the bundle stays native. While ON, the
// permission-popup auto-scroll guard (see PERM_YANK_MARKER above) also rewrites
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
// the duplicate CSS rule is byte-identical and harmless.
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
// buttons normally anchor to the input box (.inputContainer_<hash>), but while
// a permission request or AskUserQuestion popup is up the app hides that box
// (display:none on its wrapper) and shows the request UI inside a sibling
// wrapper (.permissionsContainer_<hash>, a plain centered block shared with the
// auth/refusal dialogs), so the buttons vanish exactly when reading history is
// most likely. hosts() therefore returns the input boxes plus, for each mounted
// request card (.permissionRequestContainer_<hash>, the popup module's root,
// which identifies the tool-permission/question wrapper among the dialogs
// sharing the wrapper class), its closest() wrapper. The card itself cannot
// host (overflow:hidden clips anything above its border), so the wrapper gets a
// ccup-btn-host marker class making it position:relative, and the buttons'
// top:-34px/right offsets land in the same spots as on the input box. The class
// add is guarded by a contains() check so the body observers (class/style in
// their filter) see at most one mutation per mount and settle; React never
// rewrites the wrapper's static className, so the marker survives re-renders
// and dies with the popup. Both permission hashes are read from the bundle's
// class maps at patch time; if either is gone hosts() degrades to the input
// boxes alone (the popups just lose the buttons) instead of failing the toggle.
// The same pass syncs the ccup-dim marker onto the messages container, since the
// card query that drives it is already in hand here (see dimCss for what the
// marker replaced and why). Unlike ccup-btn-host it has to come off again, the
// container outliving the popup, so it is toggled both ways, each direction
// guarded by a contains() check so the observers see one mutation per
// transition. It reads the container through sc(), which both callers declare.
const PERM_WRAP_HASH_RE =
  /permissionsContainer:"permissionsContainer_([-\w]+)"/;
const PERM_REQ_HASH_RE =
  /permissionRequestContainer:"permissionRequestContainer_([-\w]+)"/;
const BTN_HOST_CSS = ".ccup-btn-host{position:relative}";
function btnHostsJs(
  input: string,
  perm: string | undefined,
  preq: string | undefined,
): string {
  const base = `var a=[].slice.call(document.querySelectorAll(".inputContainer_${input}"))`;
  if (!perm || !preq) return `function hosts(){${base};return a}`;
  return (
    `function hosts(){${base},p=document.querySelectorAll(".permissionRequestContainer_${preq}");` +
    `for(var i=0;i<p.length;i++){var w=p[i].closest(".permissionsContainer_${perm}");` +
    `if(w){if(!w.classList.contains("ccup-btn-host"))w.classList.add("ccup-btn-host");` +
    `if(a.indexOf(w)<0)a.push(w)}}` +
    `var m=sc();if(m){var dm=m.classList.contains("${DIM_CLASS}");` +
    `if(p.length&&!dm)m.classList.add("${DIM_CLASS}");` +
    `else if(!p.length&&dm)m.classList.remove("${DIM_CLASS}")}` +
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
// chat view's render effect scrolls the history to the bottom UNCONDITIONALLY
// whenever a permission request or AskUserQuestion popup is pending (the
// branch if(e.permissionRequests.value.length>0){PD(r,!0);return}), yanking
// the view down while reading history (every other branch of that effect
// defers to the stick-to-bottom flag, recomputed each render as "within 50px
// of the bottom").
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
// native helper as the fallback for a bundle whose injected line failed. Both
// take (ref, smooth), so the site is a one-token widening of the callee.
// All three minified names (session, scroll helper, container ref) are captured
// and re-emitted, so restore is byte-identical; the marker makes the guarded
// state detectable. The edit is best-effort: on a drifted bundle where the
// branch is gone the toggle still applies (buttons only), and permYankGuardOk
// treats "no native site" as satisfied so the state machinery never loops on it.
const PERM_YANK_MARKER = "/*ccup:permYankGuard*/";
const PERM_YANK_NATIVE_RE =
  /if\((\w+)\.permissionRequests\.value\.length>0\)\{(\w+)\((\w+),!0\);return\}/;
const PERM_YANK_GUARDED_RE =
  /if\((\w+)\.permissionRequests\.value\.length>0\)\{\/\*ccup:permYankGuard\*\/if\(\(\(n\)=>!n\|\|n\.scrollHeight-n\.scrollTop-n\.clientHeight<50\)\((\w+)\.current\)\)\(window\.__ccupPermGlide\|\|(\w+)\)\(\2,!0\);return\}/;
// The 1.3.2-1.3.6 guard, which called the native helper directly. Stripping it
// is what lets an in-place upgrade rebuild the branch instead of stranding the
// old form (the native regex no longer matches an already-guarded branch).
const PERM_YANK_LEGACY_RE =
  /if\((\w+)\.permissionRequests\.value\.length>0\)\{\/\*ccup:permYankGuard\*\/if\(\(\(n\)=>!n\|\|n\.scrollHeight-n\.scrollTop-n\.clientHeight<50\)\((\w+)\.current\)\)(\w+)\(\2,!0\);return\}/;
function permYankGuardedText(e: string, fn: string, ref: string): string {
  return (
    `if(${e}.permissionRequests.value.length>0){${PERM_YANK_MARKER}` +
    `if(((n)=>!n||n.scrollHeight-n.scrollTop-n.clientHeight<50)(${ref}.current))` +
    `(window.__ccupPermGlide||${fn})(${ref},!0);return}`
  );
}
// Strip any guard (current or legacy) back to the native branch, then re-apply
// when on.
function permYankGuardSet(c: string, on: boolean): string {
  const native = (_m: string, e: string, ref: string, fn: string): string =>
    `if(${e}.permissionRequests.value.length>0){${fn}(${ref},!0);return}`;
  const off = c
    .replace(PERM_YANK_GUARDED_RE, native)
    .replace(PERM_YANK_LEGACY_RE, native);
  if (!on) return off;
  return off.replace(PERM_YANK_NATIVE_RE, (_m, e, fn, ref) =>
    permYankGuardedText(e, fn, ref),
  );
}
// The guard's ON-state health: guarded in the current form, or nothing left to
// guard (drift). A legacy guard reads as unhealthy so the next apply rebuilds it.
function permYankGuardOk(c: string): boolean {
  if (PERM_YANK_GUARDED_RE.test(c)) return true;
  return !PERM_YANK_NATIVE_RE.test(c) && !PERM_YANK_LEGACY_RE.test(c);
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
  // The button floats just above the box's top-right corner, outside its border.
  // box-sizing:border-box keeps the 26px footprint matching the send button's
  // despite the 1px border; it stays hidden (opacity 0, no pointer events, nudged
  // down) until data-show is set. currentColor drives the arrow's stroke.
  const ghost2 =
    "linear-gradient(var(--app-ghost-button-hover-background),var(--app-ghost-button-hover-background)),linear-gradient(var(--app-ghost-button-hover-background),var(--app-ghost-button-hover-background))";
  const css =
    ".ccup-scroll-btn{box-sizing:border-box;position:absolute;top:-34px;right:5px;display:flex;align-items:center;justify-content:center;width:26px;height:26px;margin:0;padding:0;border:1px solid var(--app-input-border);border-radius:5px;background:var(--app-input-secondary-background);color:var(--app-primary-foreground);box-shadow:0 1px 3px #00000033;cursor:pointer;opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .15s ease,transform .15s ease,filter .15s ease;z-index:21}" +
    ".ccup-scroll-btn[data-show]{opacity:1;transform:none;pointer-events:auto}" +
    ".ccup-scroll-btn[data-show][data-off]{opacity:.35;cursor:default}" +
    `.ccup-scroll-btn:hover{background:${ghost2},var(--app-input-secondary-background);border-color:var(--app-secondary-foreground)}` +
    ".ccup-scroll-btn[data-off]:hover{background:var(--app-input-secondary-background);border-color:var(--app-input-border)}" +
    ".ccup-scroll-btn:not([data-off]):active{filter:brightness(.85)}" +
    ".ccup-scroll-btn svg{display:block;width:20px;height:20px}" +
    // The composer's own dropdowns (mention, mode, model, slash, add) all open
    // above the box (.menuPopup_<hash>, bottom:100%, z-index <= 10) inside this
    // same input container, which has no z-index of its own: it and the button
    // flatten into the composer's z:20 context, where the button's z:21 paints
    // THROUGH the popup. Hide the button while any popup is mounted rather than
    // chase a z-index below every popup (one is z:auto, so that means negative).
    // Matched by the stable menuPopup_ class-name substring, no per-build hash;
    // scoped to this input so a popup in one chat view never blanks another's.
    `.inputContainer_${input}:has([class*=menuPopup_]) .ccup-scroll-btn[data-show]{opacity:0;pointer-events:none}` +
    (perm && preq ? BTN_HOST_CSS : "") +
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
    btnHostsJs(input, perm, preq) +
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
// top-right corner (anchored to .inputContainer_<hash>), in the same row
// (top:-34px) as the scroll-to-bottom button and to its left: with that button
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
// re-triggers itself. The three class-map hashes (messageInput's inputContainer,
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
  // Two 26px squares matching the scroll-to-bottom button, above the input's
  // top-right corner: left of the scroll button's right:5px slot when its marker
  // is in the bundle, slid into its place otherwise (30px pitch either way);
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
    `.ccup-nav-btn:hover{background:${ghost2},var(--app-input-secondary-background);border-color:var(--app-secondary-foreground)}` +
    ".ccup-nav-btn[data-off]:hover{background:var(--app-input-secondary-background);border-color:var(--app-input-border)}" +
    ".ccup-nav-btn:not([data-off]):active{filter:brightness(.85)}" +
    ".ccup-nav-btn svg{display:block;width:20px;height:20px}" +
    // Hide both nav buttons while any composer dropdown is open: they mount in
    // the input container (no stacking context of its own), so their z:21 would
    // paint through the popups that open above the box. See scrollDotBuild for
    // the full stacking rationale; matched by the menuPopup_ class substring.
    `.inputContainer_${input}:has([class*=menuPopup_]) .ccup-nav-btn[data-show]{opacity:0;pointer-events:none}` +
    (perm && preq ? BTN_HOST_CSS : "") +
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
    btnHostsJs(input, perm, preq) +
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
  const stripped = c.replace(JUMP_MSG_LINE_RE, "");
  if (!on) return stripped;
  const line = jumpMsgBuild(stripped);
  if (line === undefined) return c; // anchors gone: leave the file as it is
  return `${stripped}\n${line}`;
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
//   bar     a fixed top-right widget (input, "k of n" counter, prev/next/close
//           buttons) styled from the editorWidget/input theme variables, so it
//           reads native in either theme; created lazily on first open
//   scan    a TreeWalker over the transcript container (.messagesContainer_
//           <hash>, baked at patch time like the scroll-dot button) collects
//           visible text nodes into one haystack with per-node offsets;
//           consecutive nodes under one nearest non-inline ancestor
//           concatenate seamlessly, so a match may span inline markup
//           (bold/code/links), while block boundaries insert "\n", which a
//           single-line query can never match across; hidden text is skipped
//           via checkVisibility (collapsed "Show more" content stays
//           unsearchable, matching native find's visible-only semantics)
//   paint   matches become Ranges under two CSS Custom Highlights (all
//           matches + the active one, the active at higher priority), colored
//           by the editor findMatch theme tokens in the appended CSS line; no
//           DOM mutation, so React re-renders never fight the highlights
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
//   rescan  a body MutationObserver (debounced, active only while the bar is
//           open) recomputes matches when the chat re-renders or streams,
//           without scrolling. Batches produced entirely by the bar/ruler are
//           dropped (the counter's textContent writes would otherwise
//           re-trigger it), and the active match re-anchors via its LIVE
//           Range, whose boundaries track surrounding mutations, so content
//           mounting above (sticky pinning, Monaco's virtualized diff lines
//           during scroll) cannot walk the active match forward; the haystack
//           offset is only the fallback for a re-rendered active node
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

    // Match cap: bounds Range building, highlight registration, and the
    // per-scan rect walks, so a degenerate query (one letter over a huge
    // transcript) cannot freeze the webview. Real word searches stay far
    // below it; beyond it the counter reads "20000+" and navigation wraps
    // within the built matches.
    const MAXM = 20000;
    const TOP = 48; // px kept clear under the fixed bar when revealing
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
    let input: any = null;
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
    let ranges: any[] = [];
    let starts: number[] = []; // haystack offset per match, for rescan continuity
    let blkMemo = new Map(); // match index -> block element, reset per scan
    let active = -1;
    let lastFocus: any = null;
    let scanT: any = 0;
    let mutT: any = 0;
    let rraf: any = 0;
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

    // Visible text nodes of the transcript, concatenated with per-node
    // offsets; "\n" separates blocks (a single-line query can't cross it).
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
      const walker = doc.createTreeWalker(root, 4); // SHOW_TEXT
      let prevBlock: any = null;
      for (let nd = walker.nextNode(); nd; nd = walker.nextNode()) {
        const p = nd.parentElement;
        if (!p || !visible(p)) continue;
        const t = nd.nodeValue;
        if (!t) continue;
        const b = blockOf(p);
        if (nodes.length && b !== prevBlock) hay += "\n";
        prevBlock = b;
        offs.push(hay.length);
        nodes.push(nd);
        hay += t;
      }
      return { nodes, offs, hay };
    };

    // Case-insensitive, non-overlapping substring matches -> Ranges.
    const search = (q: string): void => {
      ranges = [];
      starts = [];
      blkMemo = new Map();
      if (!q) return;
      const col = collect();
      const nodes = col.nodes;
      const offs = col.offs;
      if (!nodes.length) return;
      const H = col.hay.toLowerCase();
      const Q = q.toLowerCase();
      const L = Q.length;
      const nodeAt = (pos: number): number => {
        let lo = 0;
        let hi = nodes.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (offs[mid] <= pos) lo = mid;
          else hi = mid - 1;
        }
        return lo;
      };
      let i = H.indexOf(Q);
      while (i >= 0 && ranges.length < MAXM) {
        const a = nodeAt(i);
        const b = nodeAt(i + L - 1);
        try {
          const r = doc.createRange();
          r.setStart(nodes[a], i - offs[a]);
          r.setEnd(nodes[b], i + L - offs[b]);
          ranges.push(r);
          starts.push(i);
        } catch {
          // a node changed under us mid-scan: skip this match
        }
        i = H.indexOf(Q, i + L);
      }
    };

    const paint = (): void => {
      try {
        const all = new g.Highlight();
        all.priority = 1;
        for (let k = 0; k < ranges.length; k++) all.add(ranges[k]);
        g.CSS.highlights.set("ccup-find", all);
        const act = new g.Highlight();
        act.priority = 2;
        if (active >= 0 && ranges[active]) act.add(ranges[active]);
        g.CSS.highlights.set("ccup-find-active", act);
      } catch {
        // Highlight registry unavailable: matches still navigate by scroll
      }
      rulerQ();
    };

    const status = (): void => {
      if (!count) return;
      const q = input ? input.value : "";
      const total = ranges.length >= MAXM ? MAXM + "+" : String(ranges.length);
      const txt = !q
        ? ""
        : ranges.length
          ? active + 1 + " of " + total
          : "No results";
      // Write only on change: textContent assignment always emits a mutation,
      // which the body observer must never see as chat activity. The hidden
      // sizer twin holds a fixed "9999 of 9999" (or the real worst case once
      // the total runs wider), so the bar keeps one width across queries and
      // navigation alike.
      if (countText && countText.textContent !== txt)
        countText.textContent = txt;
      const sz = total.length > 4 ? total + " of " + total : "9999 of 9999";
      if (countSize && countSize.textContent !== sz) countSize.textContent = sz;
      if (bar) {
        if (q && !ranges.length) bar.setAttribute("data-none", "");
        else bar.removeAttribute("data-none");
      }
      // data-off instead of the disabled attribute: a disabled button gets no
      // mouse events, which would keep the hover tip from ever showing.
      const dis = !ranges.length;
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
      if (active < 0 || !ranges[active]) return;
      try {
        let tr = ranges[active].getBoundingClientRect();
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
          let e = ranges[active].startContainer.parentElement;
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
      if (!ranges.length) return;
      const base = active < 0 ? (dir > 0 ? -1 : 0) : active;
      active = (base + dir + ranges.length) % ranges.length;
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
        let e = ranges[k].startContainer.parentElement;
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
      const n = ranges.length;
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
      if (ranges.length) {
        active = 0;
        for (let k = 0; k < ranges.length; k++) {
          let r;
          try {
            r = ranges[k].getBoundingClientRect();
          } catch {
            continue;
          }
          if (r.bottom >= TOP) {
            active = k;
            break;
          }
        }
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
      const prevRange = active >= 0 ? ranges[active] : null;
      const prevStart =
        active >= 0 && starts[active] !== undefined ? starts[active] : -1;
      search(input.value);
      active = -1;
      if (ranges.length) {
        let found = -1;
        if (prevRange) {
          try {
            if (
              prevRange.startContainer &&
              prevRange.startContainer.isConnected
            ) {
              for (let k = 0; k < ranges.length; k++) {
                // 0 = START_TO_START: first new match at or after the old one
                if (ranges[k].compareBoundaryPoints(0, prevRange) >= 0) {
                  found = k;
                  break;
                }
              }
            }
          } catch {
            found = -1;
          }
        }
        if (found < 0) {
          for (let k = 0; k < starts.length; k++) {
            if (starts[k] >= prevStart) {
              found = k;
              break;
            }
          }
        }
        active = found >= 0 ? found : ranges.length - 1;
      }
      paint();
      status();
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
      bar.appendChild(input);
      bar.appendChild(count);
      bar.appendChild(prevB);
      bar.appendChild(nextB);
      bar.appendChild(blockPrevB);
      bar.appendChild(blockNextB);
      bar.appendChild(closeB);
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
      rraf = 0;
      if (!ruler) return;
      let el = null;
      if (isOpen() && active >= 0 && ranges[active]) el = blockAt(active);
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
    const rulerQ = (): void => {
      if (!rraf) rraf = g.requestAnimationFrame(rulerUpd);
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
      }
      let sel = "";
      try {
        sel = String(g.window.getSelection() || "");
      } catch {
        sel = "";
      }
      if (sel && sel.indexOf("\n") < 0 && sel.length <= 200) input.value = sel;
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
      ranges = [];
      starts = [];
      blkMemo = new Map();
      active = -1;
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

    doc.addEventListener("scroll", rulerQ, true);
    g.window.addEventListener("resize", rulerQ);

    try {
      new g.MutationObserver((rs: any) => {
        if (!isOpen()) return;
        // Drop batches produced entirely by our own bar/ruler (the counter's
        // textContent writes), or the rescan would re-trigger itself.
        let ours = true;
        for (let i = 0; i < rs.length; i++) {
          const t = rs[i].target;
          if (t !== ruler && !(bar && bar.contains(t))) {
            ours = false;
            break;
          }
        }
        if (ours) return;
        rulerQ();
        if (mutT) return;
        mutT = g.setTimeout(() => {
          mutT = 0;
          rescan();
        }, 180);
      }).observe(doc.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch {
      // without the observer the bar still works; matches just go stale
    }
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
  const k = readFindKeys();
  mergeChords(k.next, readFindChordSetting("chatFindBarNextMatchKeys"));
  mergeChords(k.prev, readFindChordSetting("chatFindBarPreviousMatchKeys"));
  const cfg = {
    chat,
    input,
    blocks,
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
function findBarCssBuild(css: string): string | undefined {
  if (!FINDBAR_CSS_ANCHOR_RE.test(css)) return undefined;
  const ghost = "var(--app-ghost-button-hover-background,rgba(128,128,128,.2))";
  return (
    FINDBAR_CSS_MARKER +
    "::highlight(ccup-find){background-color:var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.33))}" +
    "::highlight(ccup-find-active){background-color:var(--vscode-editor-findMatchBackground,rgba(237,148,30,.8));color:var(--vscode-editor-foreground,inherit)}" +
    ".ccup-find-bar{position:fixed;top:8px;right:16px;z-index:1200;display:none;align-items:center;gap:4px;max-width:calc(100vw - 20px);padding:4px 6px;border:1px solid var(--vscode-widget-border,var(--app-input-border,#454545));border-radius:6px;background:var(--vscode-editorWidget-background,var(--app-input-background,#252526));color:var(--vscode-editorWidget-foreground,var(--app-primary-foreground,#cccccc));box-shadow:0 2px 8px var(--vscode-widget-shadow,rgba(0,0,0,.36));font-size:12px}" +
    ".ccup-find-bar[data-open]{display:flex}" +
    ".ccup-find-bar input{flex:1 1 auto;width:200px;min-width:60px;box-sizing:border-box;border:1px solid var(--app-input-border,var(--vscode-input-border,transparent));background:var(--app-input-background,var(--vscode-input-background,#3c3c3c));color:var(--app-input-foreground,var(--vscode-input-foreground,#cccccc));border-radius:4px;padding:3px 6px;font-size:calc(var(--vscode-chat-font-size,13px)*.9);font-family:inherit;outline:none}" +
    ".ccup-find-bar input:focus{border-color:var(--app-input-active-border,var(--vscode-focusBorder,#007fd4))}" +
    ".ccup-find-bar .ccup-find-count{display:inline-flex;flex-direction:column;align-items:center;text-align:center;opacity:.85;white-space:nowrap;font-variant-numeric:tabular-nums}" +
    ".ccup-find-bar .ccup-find-count-size{visibility:hidden;height:0;overflow:hidden}" +
    ".ccup-find-tip{position:fixed;display:none;padding:2px 8px;border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-widget-border,#454545));border-radius:4px;background:var(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background,#252526));color:var(--vscode-editorHoverWidget-foreground,var(--vscode-editorWidget-foreground,#cccccc));font-size:11px;white-space:nowrap;z-index:1300;pointer-events:none;box-shadow:0 2px 8px var(--vscode-widget-shadow,rgba(0,0,0,.36))}" +
    ".ccup-find-bar[data-none] .ccup-find-count{color:var(--vscode-errorForeground,#f48771);opacity:1}" +
    ".ccup-find-bar button{display:flex;align-items:center;justify-content:center;width:22px;height:22px;margin:0;padding:0;border:none;border-radius:4px;background:transparent;color:inherit;cursor:pointer}" +
    `.ccup-find-bar button:hover{background:${ghost}}` +
    ".ccup-find-bar button[data-off]{opacity:.4;cursor:default}" +
    ".ccup-find-bar button[data-off]:hover{background:transparent}" +
    ".ccup-find-bar svg{display:block;width:16px;height:16px}" +
    ".ccup-find-bar .ccup-find-sep{margin-left:4px}" +
    ".ccup-find-ruler{position:fixed;display:none;width:5px;border-radius:5px;background:var(--vscode-editor-findMatchBackground,var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.8)));z-index:1199;pointer-events:none}"
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
    cssFile: "webview/index.css",
    cssMarker: MATH_CSS_MARKER,
    cssBuild: mathCssBuild,
  },
  {
    id: "scrollDot",
    section: "Chat Panel or Tab",
    label: "scroll-to-bottom button",
    key: "chatScrollToBottomDot",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: scrollDotPresent,
    fnCurrentOn: scrollDotCurrentOn,
    fnSet: scrollDotSet,
  },
  {
    id: "jumpMsg",
    section: "Chat Panel or Tab",
    label: "previous/next message buttons",
    key: "chatJumpToMessageButtons",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: jumpMsgPresent,
    fnCurrentOn: jumpMsgCurrentOn,
    fnSet: jumpMsgSet,
  },
  {
    id: "histKeys",
    section: "Chat Panel or Tab",
    label: "input Cmd/Ctrl + Up/Down to recall",
    key: "chatInputCtrlUpDownToHistory",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: histKeysPresent,
    fnCurrentOn: histKeysCurrentOn,
    fnSet: histKeysSet,
  },
  {
    id: "findBar",
    section: "Chat Panel or Tab",
    label: "find in chat (Cmd/Ctrl+F)",
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
    section: "Plan Mode Markdown Preview",
    label: "comment Cmd/Ctrl + Enter to send",
    key: "planPreviewCommentInputCtrlEnterToSend",
    defaultOn: false,
    file: "extension.js",
    re: PLAN_COMMENT_SEND_RE,
    onValue: "(e.metaKey || e.ctrlKey)",
    offValue: "!e.shiftKey",
    isOn: (v) => v.includes("metaKey"),
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

// ---------------------------------------------------------------------------
// Always-on fixes: edits the patch writes unconditionally, with no setting
// behind them. Reserved for spots where the native UI simply omits something it
// applies everywhere else, so there is no native behavior worth preserving as an
// option and a knob would only be noise. They ride the same analyze / apply /
// restore / reload-cue machinery as the toggles but read no configuration:
// applying always writes the current line, restoring always strips it, and the
// panel shows no row for them. Their one user-visible consequence is that an
// install with every setting left at its default still patches the bundle (and
// so still asks for the one reload), where before it would leave it untouched.
// ---------------------------------------------------------------------------
interface AlwaysPoint {
  id: string;
  label: string;
  file: string; // path relative to the install dir
  marker: string;
  // The full marked line for this bundle, or undefined when the anchor is gone
  // (a drifted build: this fix is skipped, everything else still applies).
  // Deterministic given the file content, so equality against the on-disk line
  // doubles as the staleness check across Claude Code versions.
  build: (c: string) => string | undefined;
}

const ALWAYS_POINTS: AlwaysPoint[] = [
  {
    id: "permRing",
    label: "permission focus ring",
    file: "webview/index.css",
    marker: PERM_RING_MARKER,
    build: permRingBuild,
  },
];

// The on-disk state of one always-on fix, for the reload-cue comparison:
// its marked line, "off" when absent, undefined when the file is unreadable.
function alwaysStateStr(
  c: string | undefined,
  a: AlwaysPoint,
): string | undefined {
  if (c === undefined) return undefined;
  return cssMarkedLine(c, a.marker) ?? "off";
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
  kind: "size" | "family" | "rows" | "align" | "scale";
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

// chatHistoryParagraphSpacing: scale the vertical gaps between agent-message
// paragraphs. The native rule is
// `.root_<hash> p{white-space:pre-wrap;margin-top:.1em;margin-bottom:.2em}`, so
// the gap is already em-relative (it tracks chatHistoryFontSize) and asymmetric.
// We multiply BOTH margins by the setting, preserving their ratio. The base ems
// are read from the native rule at apply time and baked into a calc(base*mult)
// with !important, so: a native change to the base values is followed
// faithfully, the rule stays em-relative, and the multiplier reads back out of
// the calc factor (per-marker, not whole-file, so EOF line order never matters).
// Because our p rule carries !important it would beat the native
// `.root_<hash>>:first-child{margin-top:0}` (important over non-important) and
// re-open a gap above the first block, so we re-assert that reset with
// !important on the same line (0 needs no scaling). 1 = native (no rule).
// Settings-only, like the family points.
const CHAT_PARA_MARKER = "/*cc-ui-patch:chatParaSpacing*/";
// The native paragraph rule (captures: 1=module hash, 2=top em, 3=bottom em).
// Requires white-space:pre-wrap so our own appended rule can never re-match.
const CHAT_PARA_BASE_RE =
  /\.root_([-\w]+) p\{white-space:pre-wrap;margin-top:(\d*\.?\d+)em;margin-bottom:(\d*\.?\d+)em\}/;
// The multiplier baked into our appended rule (recovered from the calc factor).
const CHAT_PARA_MULT_RE =
  /\/\*cc-ui-patch:chatParaSpacing\*\/[^\n]*?margin-top:calc\(\d*\.?\d+em \* (\d*\.?\d+)\)/;

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
// hidden there, the JS copies the input's scrollTop).
const MSG_INPUT_MARKER = "/*cc-ui-patch:inputLines*/";
const MSG_INPUT_RULE_RE =
  /\.messageInput_([-\w]+)\{[^{}]*?max-height:\d+(?:\.\d+)?px;padding:(\d+(?:\.\d+)?)px \d+(?:\.\d+)?px (\d+(?:\.\d+)?)px \d+(?:\.\d+)?px;[^{}]*?line-height:(\d+(?:\.\d+)?)\}/;
const MSG_INPUT_EM_RE =
  /\/\*cc-ui-patch:inputLines\*\/[^\n]*?max-height:min\((\d+(?:\.\d+)?)em,70vh\)/;

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
        `${CHAT_PARA_MARKER}.root_${m[1]} p{margin-top:calc(${m[2]}em * ${v}) !important;margin-bottom:calc(${m[3]}em * ${v}) !important}` +
          `.root_${m[1]}>:first-child{margin-top:0 !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, CHAT_PARA_MARKER),
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
  {
    id: "chatInputLines",
    section: "Chat Panel or Tab",
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
          `.messageInput_${hash}{scroll-padding:${padTop}px 0 ${padBottom}px !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, MSG_INPUT_MARKER),
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
// matching --vscode-*-font-family variable rather than a pinned family.
// ---------------------------------------------------------------------------
export interface PreviewModel {
  chat: {
    agentSizePx: number;
    agentFamily: string | null;
    paraSpacing: number; // multiplier on the em-relative paragraph gaps (1 = native)
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
  };
}

export function previewModel(): PreviewModel {
  const sizes = readSizes();
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
  // codeFontFamily is a single setting shared by the chat / permission / plan
  // code points, so read it once and use it for both surfaces' code.
  const codeFamily = effFamily("chatCodeFamily");
  return {
    chat: {
      agentSizePx: Number(formatNativePx(effNum("chatHistorySize", nativeChat))),
      agentFamily: effFamily("chatHistoryFamily"),
      paraSpacing: effScale("chatParaSpacing"),
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
    },
  };
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

// Always-on fixes have no setting to disagree with, so there is no "custom":
// "current" = this bundle's line is in place, "stock" = it is absent or stale
// (including a leftover line whose anchor is now gone, which apply strips),
// "missing" = the file is unreadable.
export type AlwaysStatus = "current" | "stock" | "missing";
export interface AlwaysState {
  id: string;
  label: string;
  status: AlwaysStatus;
}

export function analyzeAlways(ext: ClaudeExt): AlwaysState[] {
  return ALWAYS_POINTS.map((a): AlwaysState => {
    const base = { id: a.id, label: a.label };
    const c = readFileSafe(ext, a.file);
    if (c === undefined) return { ...base, status: "missing" };
    const want = a.build(c);
    const cur = cssMarkedLine(c, a.marker);
    if (want === undefined)
      return { ...base, status: cur === undefined ? "missing" : "stock" };
    return { ...base, status: cur === want ? "current" : "stock" };
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
        changed.push(`${t.label} css ${wantOn ? "applied" : "native"}`);
      }
    }
    // No setting to consult: write the line this bundle wants, or strip a stale
    // one whose anchor is gone. Skipping the equal case avoids re-appending an
    // already-correct line, which would shuffle it past the other marked lines.
    for (const a of ALWAYS_POINTS) {
      if (a.file !== file) continue;
      const want = a.build(out);
      if (cssMarkedLine(out, a.marker) === want) continue;
      out =
        want === undefined
          ? cssRemoveLine(out, a.marker)
          : cssApplyLine(out, a.marker, want);
      changed.push(`${a.label} ${want === undefined ? "native" : "applied"}`);
    }
    if (out !== content) writeFileAtomic(abs, out);
  }
  // Math rendering ships webfont FILES alongside the bundle edits: keep them in
  // step with the toggle (copied when on, removed when off).
  syncMathFonts(ext, toggles["chatMath"] === true, changed);
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
        changed.push(`${t.label} css restored`);
      }
    }
    for (const a of ALWAYS_POINTS) {
      if (a.file !== file) continue;
      const next = cssRemoveLine(out, a.marker);
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

    const presentSizes = this.states.filter((s) => s.status !== "missing");
    const presentToggles = this.toggleStates.filter(
      (s) => s.status !== "missing",
    );
    const presentInjects = this.injectStates.filter(
      (s) => s.status !== "missing",
    );
    const anyPresent =
      presentSizes.length + presentToggles.length + presentInjects.length > 0;

    // A "lost" point: its anchor is absent from this bundle, yet the user's
    // setting asks for a non-native value, so the customization silently can't
    // apply (typically a Claude Code update changed the code we patch). A missing
    // point left at its native value loses nothing, so it stays hidden. We treat
    // this as a partial loss only while something else is still present; when
    // nothing is present at all the "not supported" banner already covers it.
    const sizeWanted = (p: PatchPoint) =>
      formatPx(sizes[p.id]) !== formatPx(p.originalPx);
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
    const chat: Knob[] = INJECT_POINTS.filter(
      (ip) =>
        ip.showInPanel &&
        (injectStatusById.get(ip.id) !== "missing" ||
          (anyPresent && injectWanted(ip))),
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
      px: formatPx(sizes[p.id]),
      on: false,
      max: p.maxPx,
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
      native: false,
      state: toggleStatusById.get(t.id) ?? "stock",
      pendingReload: this.pendingReload.has(t.id),
      lost: toggleStatusById.get(t.id) === "missing",
    }));
    const allCurrent =
      presentSizes.every((s) => s.status === "current") &&
      presentToggles.every((s) => s.status === "current") &&
      presentInjects.every((s) => s.status === "current") &&
      // No row of their own, but a missing always-on fix still leaves the
      // bundle out of sync, so the panel should offer to apply.
      this.alwaysStates.every(
        (s) => s.status === "current" || s.status === "missing",
      );
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
      partialLoss,
      preview: previewModel(),
    };
  }

  private refresh(): void {
    this.ext = findLatestClaudeExt(this.context);
    if (this.ext) {
      this.refreshStockCapture(this.ext);
      this.states = analyze(this.ext, readSizes(), this.stockCapture);
      this.toggleStates = analyzeToggles(this.ext, readToggles());
      this.injectStates = analyzeInjects(this.ext);
      this.alwaysStates = analyzeAlways(this.ext);
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
  private async autoApply(activation?: { updated: boolean }): Promise<void> {
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
    this.refresh();
  }

  // Re-run the reconcile outside a configuration change. Used by the
  // keybindings.json watcher: the find bar bakes resolved chords into its cfg
  // line, so an edit there re-derives the line (and lights the reload cue)
  // without any claudeCodeUiPatch.* setting having changed.
  reapply(): void {
    void this.autoApply();
  }

  // Toast shown after the activation-time re-apply, prompting the reload the
  // re-applied patch needs to take effect in the still-stale running window.
  // Mirrors the amber status-bar / panel reload cue with an actionable button.
  private notifyReapplied(updated: boolean): void {
    if (!this.ext) return;
    const version = this.ext.version;
    const message = updated
      ? `Claude Code UI Patch: Claude Code updated to v${version}. Reload the window for UI patches to take effect.`
      : `Claude Code UI Patch: Applied UI patch to Claude Code v${version}. Reload the window for it to take effect.`;
    void vscode.window
      .showInformationMessage(message, "Reload Window")
      .then((choice) => {
        if (choice === "Reload Window") {
          void vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
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
    `${cmdLink("$(gear) Open Settings", "workbench.action.openSettings", ["claudeCodeUiPatch"])}  ·  ${cmdLink("$(refresh) Reload Window", "workbench.action.reloadWindow")}`,
  );

  if (!snap.supported) {
    out.push(
      "",
      `$(circle-slash) patch not supported on Claude Code v${snap.version}`,
    );
  }

  return out;
}
