// Scenario for scripts/cdp-driver.mjs: reproduce the scroll-to-bottom and jump
// buttons landing on top of a notice banner (Remote Control, rate limit,
// browser/debugger/Jupyter MCP, settings-parse error), then verify that
// hosting them on the composer WRAPPER instead of the composer box lifts them
// clear of however many banners are up.
//
//   node scripts/cdp-driver.mjs scripts/repro/banner-overlap.mjs 760 520
//
// The fieldset's OVERLAY banners (the session feedback survey, the review
// upsell) are the other half of this problem and take the opposite remedy, the
// buttons hiding rather than clearing; see overlay-banner.mjs.
//
// Anchors mirror btnHostsJs in src/patcher.ts; keep the two in sync. The live
// bundle is located under ~/.vscode/extensions (newest Claude Code install) or
// via $CCUP_BUNDLE (the webview directory).
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const INPUT_HASH_RE = /messageInput:"messageInput_([-\w]+)"/;
const WRAP_HASH_RE = /inputWrapper:"inputWrapper_([-\w]+)"/;
// The notice-banner module is the two-key map; the review upsell banner shares
// the "banner" key but carries bannerVertical/content/text/actions alongside.
const NOTICE_HASH_RE = /banner:"banner_([-\w]+)",closeButton:"closeButton_\1"/;
const PERM_WRAP_HASH_RE = /permissionsContainer:"permissionsContainer_([-\w]+)"/;

// The button host's own offsets: 26px tall at top:-34px leaves an 8px gap.
const BTN = 26;
const TOP = -34;
const GAP = -TOP - BTN;

function liveBundleDir() {
  if (process.env.CCUP_BUNDLE) return process.env.CCUP_BUNDLE;
  const root = join(homedir(), ".vscode", "extensions");
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("anthropic.claude-code-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!dirs.length) throw new Error(`no Claude Code install under ${root}`);
  return join(root, dirs[dirs.length - 1], "webview");
}

// First declaration block for a class selector, ".cls{...}" with no combinator.
function rule(css, cls) {
  return css.match(new RegExp(`\\.${cls}\\{([^}]*)\\}`))?.[1];
}

export async function run(ctx) {
  const dir = liveBundleDir();
  const js = readFileSync(join(dir, "index.js"), "utf8");
  const css = readFileSync(join(dir, "index.css"), "utf8");
  console.log(`live bundle: ${dir}`);

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };

  // --- live-bundle anchors the fix leans on ------------------------------
  const input = js.match(INPUT_HASH_RE)?.[1];
  const wrap = js.match(WRAP_HASH_RE)?.[1];
  const notice = js.match(NOTICE_HASH_RE)?.[1];
  if (!check("anchors parse in live bundle", Boolean(input && wrap && notice))) {
    return false;
  }
  console.log(`  messageInput=${input}  inputWrapper=${wrap}  notice=${notice}`);
  check(
    "wrapper shares the composer module hash",
    input === wrap,
    `${input} vs ${wrap}`,
  );
  const wrapDecl = rule(css, `inputWrapper_${wrap}`);
  const boxDecl = rule(css, `inputContainer_${input}`);
  const noticeDecl = rule(css, `banner_${notice}`);
  check("wrapper rule found", Boolean(wrapDecl), wrapDecl);
  check("box rule found", Boolean(boxDecl));
  check("notice rule found", Boolean(noticeDecl));
  // position:relative on the wrapper has to be additive, and any padding or
  // border there would move the buttons in the no-banner case.
  check(
    "wrapper is unpositioned and unpadded",
    Boolean(wrapDecl) &&
      !/(^|;)\s*position:/.test(wrapDecl) &&
      !/(^|;)\s*(padding|border)/.test(wrapDecl),
  );
  check(
    "box is position:relative (today's host)",
    /position:relative/.test(boxDecl || ""),
  );
  check(
    "notice banner tucks into the box top",
    /margin-bottom:-8px/.test(noticeDecl || ""),
  );
  // The box host's containing block is its PADDING box, so its border sits
  // between the host edge and the button: the visual gap and inset each come
  // out one border narrower than the CSS numbers say.
  const border = Number(
    boxDecl?.match(/(?:^|;)border:(\d+(?:\.\d+)?)px solid/)?.[1],
  );
  check("box border width parses", Number.isFinite(border), `${border}px`);
  // The permission-popup host (see btnHostsJs) is already an unbordered,
  // unpadded block, so the wrapper host makes the two agree exactly.
  const permWrap = js.match(PERM_WRAP_HASH_RE)?.[1];
  const permDecl = permWrap ? rule(css, `permissionsContainer_${permWrap}`) : undefined;
  check(
    "popup host is unbordered and unpadded",
    Boolean(permDecl) && !/(^|;)\s*(padding|border)/.test(permDecl),
    permDecl,
  );

  // --- geometry in the replica -------------------------------------------
  await ctx.navigate(`file://${ctx.dir}/banner-overlap.html`);
  await ctx.evaluate(`(() => {
    const s = document.createElement('style');
    s.textContent =
      '.ccup-btn{box-sizing:border-box;position:absolute;top:${TOP}px;right:5px;' +
      'display:flex;align-items:center;justify-content:center;width:${BTN}px;height:${BTN}px;' +
      'margin:0;padding:0;border:1px solid var(--app-input-border);border-radius:5px;' +
      'background:var(--app-input-secondary-background);color:var(--app-primary-foreground);' +
      'box-shadow:0 1px 3px #00000033;z-index:21}' +
      '.ccup-btn-host{position:relative}';
    document.head.appendChild(s);
    return true;
  })()`);

  // host: 'box' = today's fieldset mount, 'wrap' = the proposed wrapper mount
  const measure = (host, banner) =>
    ctx.evaluate(`(() => {
      document.querySelectorAll('.ccup-btn').forEach((b) => b.remove());
      document.getElementById('wrap').classList.remove('ccup-btn-host');
      window.setBanner(${banner});
      const h = document.getElementById(${JSON.stringify(host)});
      if (h.id === 'wrap') h.classList.add('ccup-btn-host');
      const b = document.createElement('button');
      b.className = 'ccup-btn';
      b.textContent = '↓';
      h.appendChild(b);
      const r = b.getBoundingClientRect();
      const box = document.getElementById('box').getBoundingClientRect();
      const bn = document.getElementById('banner')?.getBoundingClientRect();
      const over = bn
        ? Math.min(r.bottom, bn.bottom) - Math.max(r.top, bn.top)
        : null;
      return {
        inset: +(box.right - r.right).toFixed(2),
        gapToBox: +(box.top - r.bottom).toFixed(2),
        gapToStackTop: bn ? +(bn.top - r.bottom).toFixed(2) : null,
        overlap: over === null ? null : +Math.max(0, over).toFixed(2),
      };
    })()`);

  // Pass 1: today's host, banner up. Expect the button sunk into the banner.
  const nativeBanner = await measure("box", true);
  await ctx.shot("banner-overlap-box-host");
  console.log(`  box host, banner up: ${JSON.stringify(nativeBanner)}`);
  check(
    "box host: button buried in the banner",
    nativeBanner.overlap === BTN,
    `overlap=${nativeBanner.overlap}px of ${BTN}px`,
  );

  // Pass 2: wrapper host, banner up. Expect it clear, one gap above the stack.
  const fixedBanner = await measure("wrap", true);
  await ctx.shot("banner-overlap-wrap-host");
  console.log(`  wrap host, banner up: ${JSON.stringify(fixedBanner)}`);
  check(
    "wrap host: button clears the banner",
    fixedBanner.overlap === 0,
    `overlap=${fixedBanner.overlap}px`,
  );
  check(
    `wrap host: the same ${GAP}px gap, now above the banner`,
    fixedBanner.gapToStackTop === GAP,
    `gapToStackTop=${fixedBanner.gapToStackTop}px`,
  );

  // Pass 3: no banner. The two hosts must agree to within the box border, so
  // the move is invisible in the common case.
  const nativePlain = await measure("box", false);
  const fixedPlain = await measure("wrap", false);
  console.log(
    `  no banner: box=${JSON.stringify(nativePlain)} wrap=${JSON.stringify(fixedPlain)}`,
  );
  check(
    "no banner: box host sits one border inside the CSS numbers",
    nativePlain.gapToBox === GAP - border && nativePlain.inset === 5 + border,
    `gap=${nativePlain.gapToBox} inset=${nativePlain.inset}`,
  );
  check(
    "no banner: wrap host sits exactly on the CSS numbers",
    fixedPlain.gapToBox === GAP && fixedPlain.inset === 5,
    `gap=${fixedPlain.gapToBox} inset=${fixedPlain.inset}`,
  );
  check(
    `no banner: the move shifts the button by the ${border}px border only`,
    fixedPlain.gapToBox - nativePlain.gapToBox === border &&
      nativePlain.inset - fixedPlain.inset === border,
  );
  return ok;
}
