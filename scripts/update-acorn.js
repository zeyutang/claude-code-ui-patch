// Refresh the vendored acorn parser in assets/acorn/ from the installed
// node_modules/acorn (a devDependency). Run with `npm run update-acorn` after
// bumping the acorn devDependency. The patcher loads assets/acorn/acorn.js at
// runtime to locate patch sites by their structure (src/derive.ts), and the
// VSIX ships no node_modules, so the UMD build is copied in with its MIT
// license. The devDependency itself only supplies the TypeScript types.
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = path.join(root, "node_modules", "acorn");
const dest = path.join(root, "assets", "acorn");

const version = JSON.parse(
  fs.readFileSync(path.join(src, "package.json"), "utf8"),
).version;

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

fs.copyFileSync(
  path.join(src, "dist", "acorn.js"),
  path.join(dest, "acorn.js"),
);
fs.copyFileSync(path.join(src, "LICENSE"), path.join(dest, "LICENSE"));
fs.writeFileSync(path.join(dest, "VERSION"), `${version}\n`, "utf8");

console.log(`Vendored acorn ${version}: acorn.js.`);
