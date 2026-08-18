// Scenario for scripts/cdp-driver.mjs: the chatInputMaxLines point
// (inputLines marker in patcher.ts) at the box's cap, reproducing the
// caret-reveal sequence from the 2026-08 report:
//
//   1. Shift+Enter at the end of a capped, bottom-scrolled input: the new
//      caret line should get one full line of room above the bottom padding.
//   2. Typing one char on that line: the glyph's line should sit one bottom
//      padding above the box edge (the scroll-padding term), not flush on it.
//   3. Deleting back springs to state 1; retyping must restore state 2.
//
// Runs the sequence twice: native (documents the stock quirks) and patched
// (asserts the desired behavior; these checks double as the drift canary for
// the inputLines anchor and its scroll-padding fix).
//
//   node scripts/cdp-driver.mjs scripts/repro/chat-input-lines.mjs 640 400
//
// Uses the chat-input-lines.html replica. The anchor regex and the em/rule
// derivation mirror the point's apply() in src/patcher.ts; keep the two in
// sync. The live bundle CSS is located under ~/.vscode/extensions (newest
// Claude Code install) or via $CCUP_CSS.
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Mirror of the chatInputLines patcher anchor
const MSG_INPUT_RULE_RE =
  /\.messageInput_([-\w]+)\{[^{}]*?max-height:\d+(?:\.\d+)?px;padding:(\d+(?:\.\d+)?)px \d+(?:\.\d+)?px (\d+(?:\.\d+)?)px \d+(?:\.\d+)?px;[^{}]*?line-height:(\d+(?:\.\d+)?)\}/;
// The replica snapshots this hash; the built rule is rewritten to it so a
// hash drift in the live bundle cannot silently unpatch the fixture
const FIXTURE_HASH = "cKsPxg";

function liveBundleCss() {
  if (process.env.CCUP_CSS) return process.env.CCUP_CSS;
  const root = join(homedir(), ".vscode", "extensions");
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("anthropic.claude-code-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!dirs.length) throw new Error(`no Claude Code install under ${root}`);
  return join(root, dirs[dirs.length - 1], "webview", "index.css");
}

const N = 6; // the knob value under test
const LINES = 12; // typed content, past both the native and patched caps

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

  // Same derivation as the point's apply(), then pinned to the fixture hash
  const m = css.match(MSG_INPUT_RULE_RE);
  check("inputLines anchor parses in live bundle", Boolean(m));
  if (!m) return false;
  const [, , padTop, padBottom, lineHeight] = m;
  const em = Math.round(Number(lineHeight) * N * 100) / 100;
  const patchRule = (
    `.messageInput_${FIXTURE_HASH},.mentionMirror_${FIXTURE_HASH}{max-height:min(${em}em,70vh) !important}` +
    `.messageInput_${FIXTURE_HASH}{scroll-padding:${padTop}px 0 ${padBottom}px !important}` +
    `.mentionMirror_${FIXTURE_HASH}{padding-bottom:calc(${padBottom}px + 1lh) !important}`
  );
  console.log(`built rule: ${patchRule}`);
  const pad = Number(padBottom);

  const shiftEnter = async () => {
    await ctx.cdp("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Enter", code: "Enter", text: "\r",
      unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      modifiers: 8,
    });
    await ctx.cdp("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8,
    });
  };
  const backspace = async () => {
    await ctx.cdp("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Backspace", code: "Backspace",
      windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    });
    await ctx.cdp("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Backspace", code: "Backspace",
      windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
    });
  };

  // Everything runs the native editing pipeline, like the real webview:
  // chars via Input.insertText, newlines via Shift+Enter key events
  const fill = async () => {
    await ctx.evaluate(`(() => {
      const ed = document.getElementById('ed');
      ed.textContent = '';
      document.getElementById('mirror').textContent = '';
      ed.scrollTop = 0;
      ed.focus();
      const sel = getSelection(), range = document.createRange();
      range.selectNodeContents(ed); range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
      return true;
    })()`);
    for (let i = 1; i <= LINES; i++) {
      await ctx.insertText(`line ${i} of the log`);
      if (i < LINES) await shiftEnter();
    }
    await ctx.sleep(150);
  };

  // lastGlyph is the final non-newline character: after Shift+Enter the final
  // text char is the "\n" itself, whose rect is a zero-width sliver whose
  // placement is itself a diagnostic (recorded as lastChar)
  const measure = () =>
    ctx.evaluate(`(() => {
      const ed = document.getElementById('ed');
      const mirror = document.getElementById('mirror');
      const edR = ed.getBoundingClientRect();
      const rectOfLast = (root, skipNewlines) => {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n; const nodes = [];
        while ((n = w.nextNode())) if (n.data.length) nodes.push(n);
        for (let i = nodes.length - 1; i >= 0; i--) {
          let d = nodes[i].data, j = d.length - 1;
          if (skipNewlines) while (j >= 0 && d[j] === '\\n') j--;
          if (j < 0) continue;
          const r = document.createRange();
          r.setStart(nodes[i], j); r.setEnd(nodes[i], j + 1);
          const rect = r.getBoundingClientRect();
          return { ch: JSON.stringify(d[j]), y: +rect.y.toFixed(2),
                   bottom: +rect.bottom.toFixed(2), h: +rect.height.toFixed(2) };
        }
        return null;
      };
      const sel = getSelection();
      let caretRect = null, caretRects = 0;
      if (sel.rangeCount) {
        const rects = sel.getRangeAt(0).getClientRects();
        caretRects = rects.length;
        if (rects.length) {
          const c = rects[0];
          caretRect = { y: +c.y.toFixed(2), bottom: +c.bottom.toFixed(2), h: +c.height.toFixed(2) };
        }
      }
      const glyph = rectOfLast(ed, true);
      return {
        st: +ed.scrollTop.toFixed(2),
        maxSt: +(ed.scrollHeight - ed.clientHeight).toFixed(2),
        sh: ed.scrollHeight, chH: ed.clientHeight,
        edBottom: +edR.bottom.toFixed(2),
        lineH: parseFloat(getComputedStyle(ed).lineHeight),
        caretRects, caretRect,
        lastChar: rectOfLast(ed, false),
        lastGlyph: glyph,
        gapBelowGlyph: glyph ? +(edR.bottom - glyph.bottom).toFixed(2) : null,
        mirror: { st: +mirror.scrollTop.toFixed(2), sh: mirror.scrollHeight,
                  lastGlyph: rectOfLast(mirror, true) },
      };
    })()`);

  const row = (tag, s) =>
    console.log(
      `  ${tag.padEnd(9)} st=${String(s.st).padEnd(7)} max=${String(s.maxSt).padEnd(7)}` +
      ` sh=${String(s.sh).padEnd(4)} gapBelowGlyph=${String(s.gapBelowGlyph).padEnd(6)}` +
      ` caret=${s.caretRect ? `${s.caretRect.y}..${s.caretRect.bottom}(h${s.caretRect.h})` : `none(${s.caretRects})`}` +
      ` lastChar=${s.lastChar ? `${s.lastChar.ch}@${s.lastChar.y}..${s.lastChar.bottom}` : "-"}` +
      ` mirror(st=${s.mirror.st},sh=${s.mirror.sh})`,
    );

  for (const pass of ["native", "patched"]) {
    console.log(`-- ${pass} pass --`);
    await ctx.navigate(`file://${ctx.dir}/chat-input-lines.html`);
    if (pass === "patched")
      await ctx.evaluate(`(() => {
        const s = document.createElement('style');
        s.textContent = ${JSON.stringify(patchRule)};
        document.head.appendChild(s);
        return true;
      })()`);

    await fill();
    const base = await measure();
    row("base", base);
    await ctx.shot(`chat-input-${pass}-1-base`);

    await shiftEnter();
    await ctx.sleep(120);
    const entered = await measure();
    row("enter", entered);
    await ctx.shot(`chat-input-${pass}-2-enter`);

    await ctx.insertText("r");
    await ctx.sleep(120);
    const typed = await measure();
    row("typed", typed);
    await ctx.shot(`chat-input-${pass}-3-typed`);

    await backspace();
    await ctx.sleep(120);
    const deleted = await measure();
    row("deleted", deleted);
    await ctx.shot(`chat-input-${pass}-4-deleted`);

    await ctx.insertText("r");
    await ctx.sleep(120);
    const retyped = await measure();
    row("retyped", retyped);

    if (pass === "native") {
      check(
        "native: box capped at 200px content",
        Math.abs(base.chH - (200 + 2 * pad)) < 1,
        `clientHeight=${base.chH}`,
      );
      continue;
    }

    check(
      `patched: box caps at ${N} lines of content`,
      Math.abs(base.chH - (N * base.lineH + 2 * pad)) < 1,
      `clientHeight=${base.chH}, want ${N}*${base.lineH}+${2 * pad}`,
    );
    check(
      "patched: typing at the cap keeps the bottom padding visible",
      base.gapBelowGlyph !== null && base.gapBelowGlyph >= pad - 1,
      `gapBelowGlyph=${base.gapBelowGlyph}, want >= ${pad}`,
    );
    check(
      "patched: Shift+Enter gives the caret line a full line of room",
      entered.lastGlyph !== null &&
        entered.edBottom - entered.lastGlyph.bottom >= entered.lineH + pad - 1,
      `roomBelowGlyph=${(entered.edBottom - (entered.lastGlyph?.bottom ?? 0)).toFixed(2)}, want >= ${entered.lineH + pad}`,
    );
    check(
      "patched: first char on the new line keeps the padding visible",
      typed.gapBelowGlyph !== null && typed.gapBelowGlyph >= pad - 1,
      `gapBelowGlyph=${typed.gapBelowGlyph}, want >= ${pad}`,
    );
    check(
      "patched: delete springs back to the post-Enter state",
      Math.abs(deleted.st - entered.st) < 1,
      `st=${deleted.st} vs ${entered.st}`,
    );
    check(
      "patched: retyping restores the typed state",
      Math.abs(retyped.st - typed.st) < 1 &&
        retyped.gapBelowGlyph === typed.gapBelowGlyph,
      `st=${retyped.st} vs ${typed.st}`,
    );
    check(
      "patched: mirror paints the typed glyph on the input's line",
      typed.lastGlyph !== null && typed.mirror.lastGlyph !== null &&
        Math.abs(typed.mirror.lastGlyph.y - typed.lastGlyph.y) < 0.5,
      `mirrorY=${typed.mirror.lastGlyph?.y} inputY=${typed.lastGlyph?.y}`,
    );
    check(
      "patched: mirror scroll range reaches the input's scrollTop",
      Math.abs(typed.mirror.st - typed.st) < 0.5,
      `mirror.st=${typed.mirror.st} input.st=${typed.st}`,
    );
  }
  return ok;
}
