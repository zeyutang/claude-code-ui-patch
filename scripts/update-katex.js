// Refresh the vendored KaTeX assets in assets/katex/ from the installed
// node_modules/katex (a devDependency). Run with `npm run update-katex` after
// bumping the katex devDependency. Only the pieces the chat-math patch ships
// are copied: the minified UMD bundle, the minified stylesheet, the woff2
// fonts (the stylesheet lists woff/ttf fallbacks, but Chromium-based webviews
// always take the woff2 source, so the fallbacks are not shipped), and the
// MIT license. FONTS-LICENSE.txt (the fonts' SIL OFL 1.1 notice, matching the
// license metadata embedded in the font files) is maintained by hand and
// preserved across refreshes; re-check it against the new fonts' name-table
// entries when bumping.
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = path.join(root, "node_modules", "katex");
const dist = path.join(src, "dist");
const dest = path.join(root, "assets", "katex");

const version = JSON.parse(
  fs.readFileSync(path.join(src, "package.json"), "utf8"),
).version;

// Selective refresh: replace only what this script owns, so the hand-written
// FONTS-LICENSE.txt survives.
for (const f of ["katex.min.js", "katex.min.css", "LICENSE", "VERSION"]) {
  fs.rmSync(path.join(dest, f), { force: true });
}
fs.rmSync(path.join(dest, "fonts"), { recursive: true, force: true });
fs.mkdirSync(path.join(dest, "fonts"), { recursive: true });

fs.copyFileSync(
  path.join(dist, "katex.min.js"),
  path.join(dest, "katex.min.js"),
);
fs.copyFileSync(
  path.join(dist, "katex.min.css"),
  path.join(dest, "katex.min.css"),
);
fs.copyFileSync(path.join(src, "LICENSE"), path.join(dest, "LICENSE"));

let fonts = 0;
for (const f of fs.readdirSync(path.join(dist, "fonts"))) {
  if (!f.endsWith(".woff2")) continue;
  fs.copyFileSync(
    path.join(dist, "fonts", f),
    path.join(dest, "fonts", f),
  );
  fonts++;
}

fs.writeFileSync(
  path.join(dest, "VERSION"),
  `${version}\n`,
  "utf8",
);

console.log(`Vendored KaTeX ${version}: katex.min.js, katex.min.css, ${fonts} woff2 fonts.`);
