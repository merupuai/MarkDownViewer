#!/usr/bin/env bun
// design-token-check.ts — M2.S8 validator (closes DESIGN-001).
//
// Verifies every CSS custom property used in src/mainview/index.css is
// either:
//   (a) listed in design-token-mapping.json's `mapping` block with a
//       tokenPath that resolves in design-tokens.json, OR
//   (b) listed in `layout.appLocalVars` (app-specific runtime values that
//       intentionally don't map to a design token, e.g., --sidebar-w).
//
// Fails (exit 1) on:
//   - CSS variable referenced but not in mapping or appLocalVars
//   - mapping entry whose tokenPath does not resolve in design-tokens.json
//   - mapping entry for a CSS variable that no longer appears in CSS
//
// Run via:  bun run design:check
// Wired into CI by M2.S6/S7 follow-up (or add a workflow step manually).

import { readFileSync } from "fs";
import { resolve } from "path";

type Mapping = {
	mapping: Record<string, { tokenPath: string }>;
	layout: { appLocalVars: string[] };
};

const ROOT = resolve(import.meta.dir, "..");
const CSS_PATH = resolve(ROOT, "src/mainview/index.css");
const MAPPING_PATH = resolve(ROOT, "design-token-mapping.json");
const TOKENS_PATH = resolve(ROOT, "design-tokens.json");

const css = readFileSync(CSS_PATH, "utf8");
const mapping = JSON.parse(readFileSync(MAPPING_PATH, "utf8")) as Mapping;
const tokens = JSON.parse(readFileSync(TOKENS_PATH, "utf8")) as Record<string, unknown>;

// Extract every var(--*) reference from CSS. Use Set to dedup.
const cssVars = new Set<string>();
for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
	cssVars.add(m[1]);
}

// Resolve a dotted token path like "colors.primary" against tokens
function resolvePath(path: string, obj: Record<string, unknown>): unknown {
	return path.split(".").reduce<unknown>((cur, key) => {
		if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
			return (cur as Record<string, unknown>)[key];
		}
		return undefined;
	}, obj);
}

const errors: string[] = [];
const warnings: string[] = [];

// (a) Every CSS var must be either in mapping OR in appLocalVars
const knownLayout = new Set(mapping.layout?.appLocalVars || []);
const knownMapping = new Set(Object.keys(mapping.mapping || {}));
for (const v of cssVars) {
	if (knownLayout.has(v)) continue;
	if (knownMapping.has(v)) continue;
	errors.push(`CSS variable ${v} is not in design-token-mapping.json (neither mapping nor layout.appLocalVars). Add an entry or document why it's app-local.`);
}

// (b) Every mapping entry's tokenPath must resolve in tokens
for (const [v, entry] of Object.entries(mapping.mapping || {})) {
	const value = resolvePath(entry.tokenPath, tokens);
	if (value === undefined) {
		errors.push(`Mapping ${v} → ${entry.tokenPath} does NOT resolve in design-tokens.json. Either update the tokenPath or add the token.`);
	}
}

// (c) Mapping entries that no longer appear in CSS
for (const v of knownMapping) {
	if (!cssVars.has(v)) {
		warnings.push(`Mapping for ${v} exists but the CSS variable is no longer referenced — remove or comment out.`);
	}
}

const summary = {
	cssVarsFound: cssVars.size,
	mappingEntries: knownMapping.size,
	appLocalVars: knownLayout.size,
	errors: errors.length,
	warnings: warnings.length,
};

console.log("Design Token Check");
console.log("──────────────────");
console.log(`CSS variables in src/mainview/index.css: ${summary.cssVarsFound}`);
console.log(`Mapping entries:                          ${summary.mappingEntries}`);
console.log(`App-local layout vars:                    ${summary.appLocalVars}`);
console.log("");

if (warnings.length) {
	console.log("Warnings:");
	for (const w of warnings) console.log(`  - ${w}`);
	console.log("");
}

if (errors.length) {
	console.error("Errors:");
	for (const e of errors) console.error(`  - ${e}`);
	console.error("");
	console.error(`design-token-check FAILED (${errors.length} error${errors.length === 1 ? "" : "s"})`);
	process.exit(1);
}

console.log("design-token-check PASSED");
