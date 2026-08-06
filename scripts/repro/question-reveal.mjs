// Scenario for scripts/cdp-driver.mjs: reproduce the AskUserQuestion "Other"
// box losing its bottom padding under caret reveal, then verify the
// questionReveal rule (patcher.ts) restores it.
//
//   node scripts/cdp-driver.mjs scripts/repro/question-reveal.mjs 640 420
//
// The viewport must be short enough that the popup exceeds the questions
// container's 40vh cap (the default 640x420 is); in a tall viewport nothing
// scrolls and both passes trivially show the padding.
//
// Anchor regexes and the scroll-padding formula mirror questionRevealBuild in
// src/patcher.ts; keep the two in sync. The live bundle CSS is located under
// ~/.vscode/extensions (newest Claude Code install) or via $CCUP_CSS.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const QUESTIONS_CONTAINER_RULE_RE =
  /\.questionsContainer_([-\w]+)\{[^{}]*?overflow-y:auto[^{}]*?\}/;
const OTHER_INPUT_RULE_RE =
  /\.otherInput_([-\w]+)\{[^{}]*?border:(\d+(?:\.\d+)?)px solid[^{}]*?padding:(\d+(?:\.\d+)?)px \d+(?:\.\d+)?px[^{}]*?\}/;
const OPTION_ROW_RULE_RE = /\.option_([-\w]+)\{[^{}]*?padding:(\d+(?:\.\d+)?)px\}/;

function liveBundleCss() {
  if (process.env.CCUP_CSS) return process.env.CCUP_CSS;
  const root = join(homedir(), ".vscode", "extensions");
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("anthropic.claude-code-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!dirs.length) throw new Error(`no Claude Code install under ${root}`);
  return join(root, dirs[dirs.length - 1], "webview", "index.css");
}

const TEXT =
  "to a certain extent, the declared interface is also a boundary interface, " +
  'with the difference that it\'s the other side of the "boundary" that the ' +
  "current semantics of boundary interface";

export async function run(ctx) {
  const cssPath = liveBundleCss();
  const css = readFileSync(cssPath, "utf8");
  console.log(`live bundle: ${cssPath}`);

  // Same derivation as questionRevealBuild
  const qHash = css.match(QUESTIONS_CONTAINER_RULE_RE)?.[1];
  const box = css.match(OTHER_INPUT_RULE_RE);
  const row = css.match(OPTION_ROW_RULE_RE);
  let ok = true;
  const check = (name, cond, detail) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    if (!cond) ok = false;
    return cond;
  };
  check("anchors parse in live bundle", Boolean(qHash && box && row));
  if (!qHash || !box || !row) return false;
  const pad = Math.round(Number(box[2]) + Number(box[3]) + Number(row[2]) + 2);
  const rule = `.questionsContainer_${qHash}{scroll-padding:${pad}px 0 ${pad}px}`;
  console.log(`built rule: ${rule}`);

  await ctx.navigate(`file://${ctx.dir}/question-reveal.html`);

  const typeAll = async () => {
    await ctx.evaluate(`(() => {
      const ed = document.getElementById('ed');
      ed.focus();
      const sel = getSelection(), range = document.createRange();
      range.selectNodeContents(ed); range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
      return true;
    })()`);
    for (const w of TEXT.split(/(?<= )/)) await ctx.insertText(w);
    await ctx.sleep(250);
  };
  const measure = () =>
    ctx.evaluate(`(() => {
      const qc = document.getElementById('qc');
      const wrapR = document.getElementById('otherWrap').getBoundingClientRect();
      const qcR = qc.getBoundingClientRect();
      return {
        scrollable: qc.scrollHeight > qc.clientHeight,
        wrapBelowFold: +(wrapR.bottom - qcR.bottom).toFixed(2),
      };
    })()`);

  // Pass 1: native rules; expect the bug (box bottom clipped below the fold)
  await typeAll();
  const native = await measure();
  await ctx.shot("question-reveal-native");
  check(
    "container scrolls at this viewport",
    native.scrollable,
    "shrink the viewport if this fails",
  );
  check(
    "native: box bottom border clipped",
    native.wrapBelowFold > 0,
    `wrapBelowFold=${native.wrapBelowFold}`,
  );

  // Pass 2: inject the patcher's rule, retype; expect the box chrome visible
  await ctx.evaluate(`(() => {
    const s = document.createElement('style');
    s.textContent = ${JSON.stringify(rule)};
    document.head.appendChild(s);
    document.getElementById('ed').textContent = '';
    document.getElementById('qc').scrollTop = 0;
    return true;
  })()`);
  await typeAll();
  const fixed = await measure();
  await ctx.shot("question-reveal-fixed");
  check(
    "fixed: box bottom border visible",
    fixed.wrapBelowFold < 0,
    `wrapBelowFold=${fixed.wrapBelowFold}`,
  );
  return ok;
}
