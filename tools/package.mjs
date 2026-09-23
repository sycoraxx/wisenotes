#!/usr/bin/env node
// Packages WiseNotes for release: only the files Chrome needs to run the extension.
//
// The file list is explicit on purpose. A glob would silently ship test/, the hosted player page,
// or the unreferenced 892 KB logo source the moment someone added one next to it. This script also
// fails if a file the manifest points at was left off the list, so an incomplete package cannot be
// published by accident.
//
// Usage: npm run package

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const releaseName = `wisenotes-${manifest.version}`;
const stageRoot = join(root, "releases", ".stage");
const stageDir = join(stageRoot, releaseName);
const zipPath = join(root, "releases", `${releaseName}.zip`);

// Runtime files, plus LICENSE (the MIT terms require the notice to travel with copies) and
// PRIVACY.md (the Chrome Web Store requires an accessible privacy policy).
const ENTRIES = [
  "manifest.json",
  "background.js",
  "db.js",
  "offscreen.html",
  "offscreen.js",
  "options.css",
  "options.html",
  "options.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "yt-content.js",
  "lib",
  "assets/icons/icon-16.png",
  "assets/icons/icon-32.png",
  "assets/icons/icon-48.png",
  "assets/icons/icon-128.png",
  "LICENSE",
  "PRIVACY.md"
];

// Anything matching these must never appear in a published package.
const FORBIDDEN = [/^test\//, /^docs\//, /\.test\.js$/, /logo-source/, /^releases\//, /^tools\//];

function collectReferencedFiles(value, found = new Set()) {
  if (typeof value === "string") {
    if (/\.(js|html|css|png)$/.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectReferencedFiles(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectReferencedFiles(item, found);
  }
  return found;
}

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const entry of ENTRIES) {
  const source = join(root, entry);
  if (!existsSync(source)) {
    throw new Error(`packaging is missing ${entry}, which is on the release file list`);
  }
  cpSync(source, join(stageDir, entry), { recursive: true });
}

// Every file the manifest points at has to be inside the package, or Chrome refuses to load it.
const missing = [...collectReferencedFiles(manifest)].filter(
  (file) => !existsSync(join(stageDir, file))
);
if (missing.length) {
  throw new Error(`the manifest references files that are not packaged: ${missing.join(", ")}`);
}

rmSync(zipPath, { force: true });
execFileSync("zip", ["-r", "-X", "-q", zipPath, releaseName], { cwd: stageRoot });

const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const leaked = listing.filter((entry) => FORBIDDEN.some((pattern) => pattern.test(entry)));
if (leaked.length) {
  throw new Error(`the package contains files it must not: ${leaked.join(", ")}`);
}

const kilobytes = Math.round(statSync(zipPath).size / 1024);
rmSync(stageRoot, { recursive: true, force: true });

console.log(`${releaseName}.zip  ${kilobytes} KB  ${listing.length} files`);
for (const entry of listing) console.log(`  ${entry}`);
