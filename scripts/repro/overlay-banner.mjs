// Scenario for scripts/cdp-driver.mjs: reproduce the scroll-to-bottom and jump
// buttons burying an OVERLAY banner above the composer (the session feedback
// survey "How is Claude doing this session?", and the marketplace review
// upsell), then verify that the hide rule hands the strip back for as long as
// one is up, without touching the in-flow notice banners the wrapper host
// already rides above.
//
//   node scripts/cdp-driver.mjs scripts/repro/overlay-banner.mjs 760 520
//
// Anchors and CSS mirror btnHideCss in src/patcher.ts; keep the two in sync.
// The live bundle is located under ~/.vscode/extensions (newest Claude Code
// install) or via $CCUP_BUNDLE (the webview directory).
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const INPUT_HASH_RE = /messageInput:"messageInput_([-\w]+)"/;
const WRAP_HASH_RE = /inputWrapper:"inputWrapper_([-\w]+)"/;
// Every CSS-module map that owns a "banner" key, with the sibling keys that
// identify which banner it is: choiceButton is the feedback survey's Bad/Fine/
// Good row, starButton the review upsell's rating stars.
const BANNER_MAP_RE = /\{banner:"banner_([-\w]+)"((?:,[\w]+:"[-\w]+")*)\}/g;

// The buttons' own footprint: 26px tall at top:-34px leaves an 8px gap, which
// is exactly the margin an overlay banner reserves below itself.
const BTN = 26;
const TOP = -34;
const GAP = -TOP - BTN;
// The three slots, right insets as patcher.ts lays them out with both toggles on.
const SLOTS = [
  ["ccup-nav-prev", 65],
  ["ccup-nav-next", 35],
  ["ccup-scroll-btn", 5],
];

function liveBundleDir() {
  if (process.env.CCUP_BUNDLE) return process.env.CCUP_BUNDLE;
  const root = join(homedir(), ".vscode", "extensions");
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("anthropic.claude-code-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!dirs.length) throw new Error(`no Claude Code install under ${root}`);
  return join(root, dirs[dirs.length - 1], "webview");
}

// All declaration blocks for a class selector with no combinator, concatenated:
// the bundle splits a module's rule across several blocks (a base one, then
// theme overrides), and the properties under test can sit in any of them.
function rule(css, cls) {
  const blocks = css.match(new RegExp(`(?<![-\\w.])\\.${cls}\\{([^}]*)\\}`, "g"));
  return blocks?.map((b) => b.slice(b.indexOf("{") + 1, -1)).join(";");
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
  if (!check("composer anchors parse in live bundle", Boolean(input && wrap))) {
    return false;
  }
  console.log(`  messageInput=${input}  inputWrapper=${wrap}`);

  // Sort every banner module by the shape of its own rule: an overlay takes the
  // buttons' strip (absolute, bottom:100%), an in-flow notice tucks onto the
  // box's top edge instead (margin-bottom:-8px), and anything with neither
  // belongs to another surface (the "Prefer the Terminal experience?" band).
  const banners = [];
  for (const [, hash, keys] of js.matchAll(BANNER_MAP_RE)) {
    const decl = rule(css, `banner_${hash}`) ?? "";
    banners.push({
      hash,
      keys: keys.split(",").filter(Boolean).map((k) => k.split(":")[0]),
      overlay: /position:absolute/.test(decl) && /bottom:100%/.test(decl),
      inflow: /margin-bottom:-8px/.test(decl),
      margin: decl.match(/(?:^|;)margin-bottom:(-?\d+)px/)?.[1],
      decl,
    });
  }
  check("banner modules found", banners.length > 0, `${banners.length}`);
  for (const b of banners) {
    const kind = b.overlay ? "overlay" : b.inflow ? "in-flow" : "other";
    console.log(`  banner_${b.hash}  ${kind}  keys: ${b.keys.join(",")}`);
  }
  check(
    "no banner module is both overlay and in-flow",
    banners.every((b) => !(b.overlay && b.inflow)),
  );
  const overlays = banners.filter((b) => b.overlay);
  check(
    "the feedback survey banner is an overlay",
    overlays.some((b) => b.keys.includes("choiceButton")),
    `${overlays.length} overlay module(s)`,
  );
  check(
    "the review upsell banner is an overlay",
    overlays.some((b) => b.keys.includes("starButton")),
  );
  check(
    "every overlay is a known one (survey or upsell)",
    overlays.every(
      (b) => b.keys.includes("choiceButton") || b.keys.includes("starButton"),
    ),
  );
  check(
    "overlays reserve exactly the buttons' gap below themselves",
    overlays.every((b) => b.margin === String(GAP)),
    `margin-bottom: ${overlays.map((b) => b.margin).join(",")} vs ${GAP}px`,
  );
  // The class-substring test has to stay unambiguous: nothing but a banner root
  // may carry "banner_" in its class name (errorBanner_, worktreeBanner_ and
  // bannerVertical_ all miss it, the first two on case and the last on the
  // underscore).
  const tokens = new Set(css.match(/[\w-]*banner_[\w-]*/g) ?? []);
  check(
    "[class*=banner_] matches banner roots only",
    [...tokens].every((t) => /^banner_[-\w]+$/.test(t)),
    [...tokens].join(" "),
  );
  // The overlay is positioned against the FIELDSET, so scoping the hide test to
  // it separates the overlays from the wrapper's in-flow notices.
  const boxDecl = rule(css, `inputContainer_${input}`);
  const wrapDecl = rule(css, `inputWrapper_${wrap}`);
  check(
    "the fieldset is the overlays' containing block",
    /position:relative/.test(boxDecl || ""),
  );
  check(
    "the wrapper is unpositioned natively (the patch adds it)",
    Boolean(wrapDecl) && !/(^|;)\s*position:/.test(wrapDecl),
    wrapDecl,
  );

  // --- geometry and the rule in the replica -------------------------------
  await ctx.navigate(`file://${ctx.dir}/overlay-banner.html`);
  await ctx.evaluate(`(() => {
    const base = document.createElement('style');
    base.textContent =
      '#wrap{position:relative}' +
      '.ccup-btn{box-sizing:border-box;position:absolute;top:${TOP}px;' +
      'display:flex;align-items:center;justify-content:center;width:${BTN}px;height:${BTN}px;' +
      'margin:0;padding:0;border:1px solid var(--app-input-border);border-radius:5px;' +
      'background:var(--app-input-secondary-background);color:var(--app-primary-foreground);' +
      'box-shadow:0 1px 3px #00000033;opacity:0;pointer-events:none;z-index:21}' +
      '.ccup-btn[data-show]{opacity:1;pointer-events:auto}' +
      ${JSON.stringify(SLOTS.map(([c, r]) => `.${c}{right:${r}px}`).join(""))};
    document.head.appendChild(base);
    // The patcher's hide rule, mounted separately so a pass can run without it
    // and reproduce the reported overlap.
    window.setHide = (on) => {
      const had = document.getElementById('hide');
      if (!on) { if (had) had.remove(); return; }
      if (had) return;
      const s = document.createElement('style');
      s.id = 'hide';
      s.textContent =
        '.inputWrapper_${wrap}:has([class*=menuPopup_],.inputContainer_${input} [class*=banner_])' +
        ' .ccup-btn[data-show]{opacity:0;pointer-events:none}';
      document.head.appendChild(s);
    };
    for (const [cls, ] of ${JSON.stringify(SLOTS)}) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ccup-btn ' + cls;
      b.id = cls;
      b.setAttribute('data-show', '');
      b.textContent = '\\u2022';
      document.getElementById('wrap').appendChild(b);
    }
    return true;
  })()`);

  // One pass: set the page's state, then report each button's paint state, its
  // overlap with the overlay banner, and what a click at its center would hit.
  const pass = async ({ notice = false, overlay = false, popup = false, hide = true }) => {
    const r = await ctx.evaluate(`(() => {
      window.setNotice(${notice}); window.setOverlay(${overlay});
      window.setPopup(${popup}); window.setHide(${hide});
      const bn = document.getElementById('overlay')?.getBoundingClientRect();
      const nt = document.getElementById('notice')?.getBoundingClientRect();
      return ${JSON.stringify(SLOTS.map(([c]) => c))}.map((cls) => {
        const b = document.getElementById(cls);
        const s = getComputedStyle(b);
        const q = b.getBoundingClientRect();
        const hitEl = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
        const over = (t) => t ? +Math.max(0, Math.min(q.bottom, t.bottom) - Math.max(q.top, t.top)).toFixed(2) : null;
        return {
          cls,
          opacity: +s.opacity,
          clickable: s.pointerEvents !== 'none',
          overlapOverlay: over(bn),
          overlapNotice: over(nt),
          hit: hitEl ? (hitEl.id || hitEl.className) : null,
          inBanner: Boolean(hitEl && hitEl.closest('#overlay')),
        };
      });
    })()`);
    // The overlay fades in over 200ms; let it settle before the screenshot.
    await ctx.sleep(250);
    return r;
  };

  // Pass 1: the reported state, overlay up and no hide rule. Every button is
  // buried in the banner's box and eats the clicks meant for it.
  const bug = await pass({ overlay: true, hide: false });
  await ctx.shot("overlay-banner-bug");
  console.log(`  overlay up, no hide rule: ${JSON.stringify(bug)}`);
  check(
    "no hide rule: every button is buried in the overlay",
    bug.every((b) => b.overlapOverlay === BTN),
    bug.map((b) => `${b.cls}=${b.overlapOverlay}px`).join(" "),
  );
  check(
    "no hide rule: the buttons take the banner's clicks",
    bug.every((b) => b.clickable && b.hit === b.cls),
    bug.map((b) => b.hit).join(" "),
  );

  // Pass 2: the same state with the rule. The strip goes back to the banner.
  const fixed = await pass({ overlay: true });
  await ctx.shot("overlay-banner-fixed");
  console.log(`  overlay up, hide rule on: ${JSON.stringify(fixed)}`);
  check(
    "hide rule: every button is faded out and inert",
    fixed.every((b) => b.opacity === 0 && !b.clickable),
  );
  check(
    "hide rule: clicks in the strip reach the banner",
    fixed.every((b) => b.inBanner),
    fixed.map((b) => b.hit).join(" "),
  );

  // Pass 3: an in-flow notice instead. The wrapper host already lifts the
  // buttons above it (1.4.6), so they must stay up: a notice can outlast the
  // whole session.
  const notice = await pass({ notice: true });
  await ctx.shot("overlay-banner-notice");
  console.log(`  in-flow notice only: ${JSON.stringify(notice)}`);
  check(
    "in-flow notice: the buttons stay visible and clickable",
    notice.every((b) => b.opacity === 1 && b.clickable && b.hit === b.cls),
  );
  check(
    "in-flow notice: the buttons ride clear of it",
    notice.every((b) => b.overlapNotice === 0),
    notice.map((b) => `${b.cls}=${b.overlapNotice}px`).join(" "),
  );

  // Pass 4: both banners up. The overlay wins, whatever the notice does to the
  // host's top edge.
  const both = await pass({ notice: true, overlay: true });
  console.log(`  notice + overlay: ${JSON.stringify(both)}`);
  check(
    "notice + overlay: the buttons hide",
    both.every((b) => b.opacity === 0 && !b.clickable),
  );

  // Pass 5: a composer dropdown, the rule's other arm, still hides them.
  const dropdown = await pass({ popup: true });
  console.log(`  dropdown only: ${JSON.stringify(dropdown)}`);
  check(
    "composer dropdown: the buttons hide",
    dropdown.every((b) => b.opacity === 0 && !b.clickable),
  );

  // Pass 6: everything dismissed. The hide is only for as long as the overlay
  // is up.
  const after = await pass({});
  await ctx.shot("overlay-banner-dismissed");
  console.log(`  all dismissed: ${JSON.stringify(after)}`);
  check(
    "dismissed: the buttons come back",
    after.every((b) => b.opacity === 1 && b.clickable && b.hit === b.cls),
  );
  return ok;
}
