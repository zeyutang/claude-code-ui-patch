// Scenario for scripts/cdp-driver.mjs: verify the chatPopupInputMaxLines
// point (popupInputLines marker in patcher.ts): the AskUserQuestion "Other"
// box (and the permission feedback box, which mounts the same
// ContentEditableInput module) grows to exactly N lines before its inner
// scroller kicks in, and the questionReveal scroll-padding fix keeps the box's
// bottom chrome visible with the taller box.
//
//   node scripts/cdp-driver.mjs scripts/repro/popup-input-lines.mjs 640 420
//
// Reuses the question-reveal.html replica. The anchor regexes and the em
// formula mirror popupInputAnchor / the point's apply() in src/patcher.ts;
// keep the two in sync. The live bundle CSS is located under
// ~/.vscode/extensions (newest Claude Code install) or via $CCUP_CSS.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Mirrors of the popupInputLines patcher logic
const POPUP_INPUT_RULE_RE =
  /\.input_([-\w]+)\{[^{}]*?overflow-y:auto[^{}]*?max-height:\d+(?:\.\d+)?px;line-height:(\d+(?:\.\d+)?)\}/;
// questionReveal mirrors (from question-reveal.mjs); both rules ride together
// in a patched install, so the reveal assertion runs against the pair
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

const N = 10; // the knob value under test
const LINES = 14; // typed content, past the cap

export async function run(ctx) {
  const cssPath = liveBundleCss();
  const css = readFileSync(cssPath, "utf8");
  console.log(`live bundle: ${cssPath}`);
  let ok = true;
  const check = (name, cond, detail) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    if (!cond) ok = false;
    return cond;
  };

  // Same derivation as the point's apply()
  const m = css.match(POPUP_INPUT_RULE_RE);
  const anchored =
    m && css.includes(`.wrapper_${m[1]}{`) && css.includes(`.placeholder_${m[1]}{`);
  check("popupInputLines anchor parses in live bundle", Boolean(anchored));
  if (!anchored) return false;
  const em = Math.round(Number(m[2]) * N * 100) / 100;
  const popupRule = `.input_${m[1]}{max-height:min(${em}em,70vh) !important}`;
  console.log(`built rule: ${popupRule}`);

  // Same derivation as questionRevealBuild
  const qHash = css.match(QUESTIONS_CONTAINER_RULE_RE)?.[1];
  const box = css.match(OTHER_INPUT_RULE_RE);
  const row = css.match(OPTION_ROW_RULE_RE);
  check("questionReveal anchors parse in live bundle", Boolean(qHash && box && row));
  if (!qHash || !box || !row) return false;
  const pad = Math.round(Number(box[2]) + Number(box[3]) + Number(row[2]) + 2);
  const revealRule = `.questionsContainer_${qHash}{scroll-padding:${pad}px 0 ${pad}px}`;

  await ctx.navigate(`file://${ctx.dir}/question-reveal.html`);

  const typeLines = async (count) => {
    await ctx.evaluate(`(() => {
      const ed = document.getElementById('ed');
      ed.textContent = '';
      document.getElementById('qc').scrollTop = 0;
      ed.focus();
      const sel = getSelection(), range = document.createRange();
      range.selectNodeContents(ed); range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
      return true;
    })()`);
    for (let i = 1; i <= count; i++)
      await ctx.insertText(`line ${i} of the answer${i < count ? "\n" : ""}`);
    await ctx.sleep(250);
  };
  const measure = () =>
    ctx.evaluate(`(() => {
      const ed = document.getElementById('ed');
      const qc = document.getElementById('qc');
      const wrapR = document.getElementById('otherWrap').getBoundingClientRect();
      const qcR = qc.getBoundingClientRect();
      return {
        edH: +ed.getBoundingClientRect().height.toFixed(2),
        edScrollH: ed.scrollHeight,
        edScrolls: ed.scrollHeight > ed.clientHeight + 1,
        lineH: parseFloat(getComputedStyle(ed).lineHeight),
        wrapBelowFold: +(wrapR.bottom - qcR.bottom).toFixed(2),
      };
    })()`);

  // Pass 1: native cap
  await typeLines(LINES);
  const native = await measure();
  await ctx.shot("popup-lines-native");
  check("native: box capped at 120px", Math.abs(native.edH - 120) < 1, `edH=${native.edH}`);
  check("native: inner box scrolls", native.edScrolls, `scrollH=${native.edScrollH}`);

  // Pass 2: patched rules (popup lines + reveal), retype past the cap
  await ctx.evaluate(`(() => {
    const s = document.createElement('style');
    s.textContent = ${JSON.stringify(popupRule + revealRule)};
    document.head.appendChild(s);
    return true;
  })()`);
  await typeLines(LINES);
  const patched = await measure();
  await ctx.shot("popup-lines-patched");
  check(
    `patched: box grows to ${N} lines`,
    Math.abs(patched.edH - N * patched.lineH) < 1,
    `edH=${patched.edH}, ${N}*lineH=${(N * patched.lineH).toFixed(2)}`,
  );
  check("patched: inner box scrolls past the cap", patched.edScrolls);
  check(
    "patched: reveal fix keeps box bottom chrome visible",
    patched.wrapBelowFold < 0,
    `wrapBelowFold=${patched.wrapBelowFold}`,
  );

  // Pass 3: below the cap the box must grow without scrolling internally
  await typeLines(N - 2);
  const under = await measure();
  check(
    "patched: below cap, grows without scrolling",
    !under.edScrolls && Math.abs(under.edH - (N - 2) * under.lineH) < 1,
    `edH=${under.edH}, scrollH=${under.edScrollH}`,
  );
  return ok;
}
