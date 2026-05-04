# Multi-format Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Notepad++-class inline editing and multi-format text-file support to Markdown Viewer, with tabs, encoding-aware save, and session restore — without breaking the existing "double-click any `.md` → renders instantly" behavior.

**Architecture:** Bun main process gains encoding-aware read/write and self-write-aware watcher. Renderer gains a CodeMirror 6 editor surface, a tab strip, and a per-tab `Doc` state model. Markdown opens to preview by default with `⌘E` to toggle to editor; non-markdown opens to editor directly.

**Tech Stack:** Bun + Electrobun (existing), CodeMirror 6 (new — `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/search`, `@codemirror/language` + lazy-loaded language packs), `bun:test` for unit tests.

**Reference:** [Spec — `docs/superpowers/specs/2026-05-04-multi-format-editor-design.md`](../specs/2026-05-04-multi-format-editor-design.md)

---

## File Structure

### New files
```
src/bun/text-io.ts                      Encoding-aware read/write (BOM, EOL detect)
src/bun/session-store.ts                Persist/load ~/.MarkdownViewer/session.json
src/mainview/editor.ts                  CodeMirror 6 wrapper, lazy language loader
src/mainview/tabs.ts                    Tab strip UI + per-tab Doc state
src/mainview/session.ts                 Renderer-side session save/restore (RPC wrapper)
tests/text-io.test.ts                   Encoding/EOL detection round-trip tests
tests/text-io.fixtures/                 Small fixture files per encoding/EOL
tests/session-store.test.ts             Session persist/load tests
tests/tabs-state.test.ts                Tab state machine unit tests
docs/superpowers/test-checklists/editor-smoke.md   Manual smoke test list
```

### Modified files
```
src/bun/index.ts                        + writeFile/getFileMeta/saveSession/loadSession
                                        + recentSelfWrites map (1s TTL) in watcher
                                        + drop MD_EXT_RE filter on file ops
src/mainview/index.ts                   Active-doc routing replaces single-doc model
                                        + tab strip wiring + editor mount + save flow
src/mainview/index.html                 + tab strip element + editor host + chips
src/mainview/index.css                  + tab/dirty/chip/modal styles
src/mainview/find-in-doc.ts             Delegate to CM6 search when active is editor
src/shared/rpc.ts                       Extend types: encoding, eol, session, write
package.json                            Add CodeMirror deps + "test" script
README.md                               Document editor features
```

### Untouched (deliberately)
```
src/mainview/markdown.ts                Preview pipeline stays as-is
src/mainview/lightbox.ts                Image/diagram zoom stays as-is
electrobun.config.ts                    File associations stay markdown-only on install
scripts/*                               Install/wrap unchanged
```

---

## Phase 0 — Foundations (no user-visible change)

### Task 1: Add CodeMirror 6 + test runner deps

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add CodeMirror dependencies and test script**

Edit `package.json` — add the listed entries to `dependencies`, add `"test": "bun test"` to `scripts`. Final file:

```json
{
  "name": "markdown-viewer",
  "version": "1.0.0",
  "description": "Native macOS markdown viewer with mermaid/C4 diagram support",
  "scripts": {
    "dev": "electrobun dev --watch",
    "start": "electrobun dev",
    "build": "electrobun build",
    "build:release": "electrobun build --release",
    "test": "bun test"
  },
  "dependencies": {
    "@codemirror/autocomplete": "^6.18.0",
    "@codemirror/commands": "^6.7.0",
    "@codemirror/lang-css": "^6.3.0",
    "@codemirror/lang-html": "^6.4.9",
    "@codemirror/lang-javascript": "^6.2.2",
    "@codemirror/lang-json": "^6.0.1",
    "@codemirror/lang-markdown": "^6.3.0",
    "@codemirror/lang-python": "^6.1.6",
    "@codemirror/lang-sql": "^6.8.0",
    "@codemirror/lang-xml": "^6.1.0",
    "@codemirror/lang-yaml": "^6.1.1",
    "@codemirror/language": "^6.10.3",
    "@codemirror/legacy-modes": "^6.4.1",
    "@codemirror/lint": "^6.8.4",
    "@codemirror/search": "^6.5.6",
    "@codemirror/state": "^6.4.1",
    "@codemirror/view": "^6.34.1",
    "codemirror": "^6.0.1",
    "electrobun": "^1.17.3-beta.12",
    "gray-matter": "^4.0.3",
    "highlight.js": "^11.10.0",
    "isomorphic-dompurify": "^2.16.0",
    "katex": "^0.16.11",
    "markdown-it": "^14.1.0",
    "markdown-it-anchor": "^9.2.0",
    "markdown-it-attrs": "^4.3.1",
    "markdown-it-emoji": "^3.0.0",
    "markdown-it-footnote": "^4.0.0",
    "markdown-it-task-lists": "^2.1.1",
    "markdown-it-texmath": "^1.0.0",
    "mermaid": "^11.4.0",
    "svg-pan-zoom": "^3.6.2"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/markdown-it": "^14.1.2"
  }
}
```

- [ ] **Step 2: Install**

Run: `bun install`
Expected: completes with "X packages installed".

- [ ] **Step 3: Sanity check the test runner**

Run: `bun test`
Expected: "0 pass, 0 fail" — no tests yet, exit code 0. Confirms `bun test` is wired.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock
git commit -m "deps: add CodeMirror 6 packages + bun test script"
```

---

### Task 2: Implement `text-io.readText()` (encoding + EOL detection)

**Files:**
- Create: `src/bun/text-io.ts`
- Create: `tests/text-io.test.ts`
- Create: `tests/text-io.fixtures/utf8-lf.txt`, `utf8bom-lf.txt`, `utf16le-bom-crlf.txt`, `utf16be-bom-lf.txt`, `latin1-crlf.txt`, `binary.bin`

- [ ] **Step 1: Create encoding fixture files**

Use Bun in a one-off script. Run from repo root:

```bash
bun -e '
import { writeFileSync, mkdirSync } from "fs";
mkdirSync("tests/text-io.fixtures", { recursive: true });

// UTF-8, LF, no BOM
writeFileSync("tests/text-io.fixtures/utf8-lf.txt", "hello\nworld\n", "utf8");

// UTF-8 with BOM, LF
writeFileSync("tests/text-io.fixtures/utf8bom-lf.txt",
  Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("hello\nworld\n", "utf8")]));

// UTF-16 LE with BOM, CRLF
const utf16leBuf = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from("hi\r\n", "utf16le")]);
writeFileSync("tests/text-io.fixtures/utf16le-bom-crlf.txt", utf16leBuf);

// UTF-16 BE with BOM, LF — manually swap bytes
const utf16le2 = Buffer.from("hi\n", "utf16le");
const utf16be = Buffer.alloc(utf16le2.length);
for (let i = 0; i < utf16le2.length; i += 2) { utf16be[i] = utf16le2[i+1]; utf16be[i+1] = utf16le2[i]; }
writeFileSync("tests/text-io.fixtures/utf16be-bom-lf.txt",
  Buffer.concat([Buffer.from([0xFE, 0xFF]), utf16be]));

// Latin-1 (e.g. Windows file with é = 0xE9), CRLF
writeFileSync("tests/text-io.fixtures/latin1-crlf.txt",
  Buffer.from([0x68, 0xE9, 0x6C, 0x6C, 0x6F, 0x0D, 0x0A]));  // hÉllo\r\n

// Binary file (a tiny PNG header)
writeFileSync("tests/text-io.fixtures/binary.bin",
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]));

console.log("fixtures written");
'
```

Expected: prints `fixtures written`. Six files exist in `tests/text-io.fixtures/`.

- [ ] **Step 2: Write the failing tests**

Create `tests/text-io.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readText } from "../src/bun/text-io";

describe("readText — encoding & EOL detection", () => {
	test("UTF-8, LF, no BOM", async () => {
		const r = await readText("tests/text-io.fixtures/utf8-lf.txt");
		expect(r.encoding).toBe("utf-8");
		expect(r.bom).toBe(false);
		expect(r.eol).toBe("lf");
		expect(r.content).toBe("hello\nworld\n");
	});

	test("UTF-8 with BOM, LF", async () => {
		const r = await readText("tests/text-io.fixtures/utf8bom-lf.txt");
		expect(r.encoding).toBe("utf-8");
		expect(r.bom).toBe(true);
		expect(r.eol).toBe("lf");
		expect(r.content).toBe("hello\nworld\n");
	});

	test("UTF-16 LE with BOM, CRLF", async () => {
		const r = await readText("tests/text-io.fixtures/utf16le-bom-crlf.txt");
		expect(r.encoding).toBe("utf-16le");
		expect(r.bom).toBe(true);
		expect(r.eol).toBe("crlf");
		expect(r.content).toBe("hi\r\n");
	});

	test("UTF-16 BE with BOM, LF", async () => {
		const r = await readText("tests/text-io.fixtures/utf16be-bom-lf.txt");
		expect(r.encoding).toBe("utf-16be");
		expect(r.bom).toBe(true);
		expect(r.eol).toBe("lf");
		expect(r.content).toBe("hi\n");
	});

	test("Latin-1, CRLF", async () => {
		const r = await readText("tests/text-io.fixtures/latin1-crlf.txt");
		expect(r.encoding).toBe("latin-1");
		expect(r.bom).toBe(false);
		expect(r.eol).toBe("crlf");
		expect(r.content).toBe("héllo\r\n");
	});

	test("binary file is flagged", async () => {
		const r = await readText("tests/text-io.fixtures/binary.bin");
		expect(r.binary).toBe(true);
	});

	// Regression guard for F1 — UTF-16 fixtures contain NUL bytes that the
	// binary detector would otherwise flag. Encoding detection MUST run
	// before binary detection; this test fails loudly if someone reorders.
	test("UTF-16 LE is NOT misclassified as binary", async () => {
		const r = await readText("tests/text-io.fixtures/utf16le-bom-crlf.txt");
		expect(r.binary).toBeUndefined();
		expect(r.encoding).toBe("utf-16le");
	});

	test("UTF-16 BE is NOT misclassified as binary", async () => {
		const r = await readText("tests/text-io.fixtures/utf16be-bom-lf.txt");
		expect(r.binary).toBeUndefined();
		expect(r.encoding).toBe("utf-16be");
	});
});
```

- [ ] **Step 3: Run tests — expect failure**

Run: `bun test tests/text-io.test.ts`
Expected: All 6 tests fail with "Cannot find module ../src/bun/text-io".

- [ ] **Step 4: Implement `readText`**

Create `src/bun/text-io.ts`:

```ts
import { readFileSync } from "fs";

export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "latin-1";
export type EOL = "lf" | "crlf";

export type ReadResult = {
	content: string;
	encoding: Encoding;
	eol: EOL;
	bom: boolean;
	binary?: boolean;
};

const NUL_SCAN_BYTES = 8 * 1024;
const BINARY_NUL_THRESHOLD = 1; // a single NUL byte in first 8KB → binary

function detectEncoding(buf: Buffer): { encoding: Encoding; bom: boolean; bomLen: number } {
	if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
		return { encoding: "utf-8", bom: true, bomLen: 3 };
	}
	if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
		return { encoding: "utf-16le", bom: true, bomLen: 2 };
	}
	if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
		return { encoding: "utf-16be", bom: true, bomLen: 2 };
	}
	// Heuristic: try UTF-8 strict; if it fails, fall back to latin-1
	try {
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
		void decoded; // succeeded → it's valid UTF-8
		return { encoding: "utf-8", bom: false, bomLen: 0 };
	} catch {
		return { encoding: "latin-1", bom: false, bomLen: 0 };
	}
}

function detectEOL(text: string): EOL {
	// Count first 64 line breaks
	let crlf = 0, lf = 0;
	for (let i = 0; i < text.length && (crlf + lf) < 64; i++) {
		if (text[i] === "\n") {
			if (i > 0 && text[i - 1] === "\r") crlf++;
			else lf++;
		}
	}
	return crlf > lf ? "crlf" : "lf";
}

function isBinary(buf: Buffer): boolean {
	const limit = Math.min(buf.length, NUL_SCAN_BYTES);
	let nuls = 0;
	for (let i = 0; i < limit; i++) {
		if (buf[i] === 0x00) nuls++;
	}
	return nuls >= BINARY_NUL_THRESHOLD;
}

function decode(buf: Buffer, encoding: Encoding, bomLen: number): string {
	const slice = bomLen ? buf.subarray(bomLen) : buf;
	if (encoding === "utf-16be") {
		// Swap bytes then decode as utf-16le
		const swapped = Buffer.alloc(slice.length);
		for (let i = 0; i + 1 < slice.length; i += 2) { swapped[i] = slice[i + 1]; swapped[i + 1] = slice[i]; }
		return swapped.toString("utf16le");
	}
	if (encoding === "utf-16le") return slice.toString("utf16le");
	if (encoding === "latin-1") return slice.toString("latin1");
	return slice.toString("utf8");
}

export async function readText(path: string): Promise<ReadResult> {
	const buf = readFileSync(path);
	// IMPORTANT: detect encoding FIRST. UTF-16 LE/BE files contain NUL bytes
	// in normal ASCII text (e.g. "hi" → 0x68 0x00 0x69 0x00) and would be
	// misclassified as binary if isBinary() ran first. We also strip the BOM
	// before NUL scanning so a file that *just* starts with a UTF-16-style BOM
	// but is otherwise valid text reads cleanly.
	const { encoding, bom, bomLen } = detectEncoding(buf);
	if (encoding !== "utf-16le" && encoding !== "utf-16be" && isBinary(buf.subarray(bomLen))) {
		return { content: "", encoding: "utf-8", eol: "lf", bom: false, binary: true };
	}
	const content = decode(buf, encoding, bomLen);
	const eol = detectEOL(content);
	return { content, encoding, eol, bom };
}
```

- [ ] **Step 5: Run tests — expect pass**

Run: `bun test tests/text-io.test.ts`
Expected: 8 pass, 0 fail (6 base cases + 2 F1 regression guards for UTF-16 not-misclassified-as-binary).

- [ ] **Step 6: Commit**

```bash
git add src/bun/text-io.ts tests/text-io.test.ts tests/text-io.fixtures/
git commit -m "feat(text-io): readText with encoding (utf-8/16le/16be/latin-1) and EOL detect"
```

---

### Task 3: Implement `text-io.writeText()` with round-trip preservation

**Files:**
- Modify: `src/bun/text-io.ts`
- Modify: `tests/text-io.test.ts`

- [ ] **Step 1: Add round-trip tests**

Append to `tests/text-io.test.ts`:

```ts
import { writeText } from "../src/bun/text-io";
import { readFileSync, unlinkSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("writeText — round-trip preservation", () => {
	const tmpDir = join(tmpdir(), `mdv-text-io-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });

	test("UTF-8 LF round-trip", async () => {
		const p = join(tmpDir, "u8lf.txt");
		const r = await writeText(p, "abc\ndef\n", { encoding: "utf-8", eol: "lf", bom: false });
		expect(r.ok).toBe(true);
		const buf = readFileSync(p);
		expect(buf[0]).not.toBe(0xEF);
		expect(buf.toString("utf8")).toBe("abc\ndef\n");
		unlinkSync(p);
	});

	test("UTF-8 BOM CRLF round-trip", async () => {
		const p = join(tmpDir, "u8bomcrlf.txt");
		const r = await writeText(p, "abc\r\ndef\r\n", { encoding: "utf-8", eol: "crlf", bom: true });
		expect(r.ok).toBe(true);
		const buf = readFileSync(p);
		expect(buf[0]).toBe(0xEF);
		expect(buf[1]).toBe(0xBB);
		expect(buf[2]).toBe(0xBF);
		expect(buf.subarray(3).toString("utf8")).toBe("abc\r\ndef\r\n");
		unlinkSync(p);
	});

	test("UTF-16 LE BOM round-trip", async () => {
		const p = join(tmpDir, "u16le.txt");
		const r0 = await writeText(p, "hi\n", { encoding: "utf-16le", eol: "lf", bom: true });
		expect(r0.ok).toBe(true);
		const r = await readText(p);
		expect(r.encoding).toBe("utf-16le");
		expect(r.bom).toBe(true);
		expect(r.content).toBe("hi\n");
		unlinkSync(p);
	});

	test("LF content gets CRLF on write when eol='crlf'", async () => {
		const p = join(tmpDir, "eol-convert.txt");
		const r = await writeText(p, "a\nb\n", { encoding: "utf-8", eol: "crlf", bom: false });
		expect(r.ok).toBe(true);
		const text = readFileSync(p, "utf8");
		expect(text).toBe("a\r\nb\r\n");
		unlinkSync(p);
	});

	test("CRLF content stays CRLF when eol='crlf'", async () => {
		const p = join(tmpDir, "eol-keep.txt");
		const r = await writeText(p, "a\r\nb\r\n", { encoding: "utf-8", eol: "crlf", bom: false });
		expect(r.ok).toBe(true);
		const text = readFileSync(p, "utf8");
		expect(text).toBe("a\r\nb\r\n");
		unlinkSync(p);
	});

	// F2 — Latin-1 lossy save returns diagnostic info instead of corrupting silently
	test("Latin-1 save with non-Latin-1 chars returns lossy info; allowLossy bypass works", async () => {
		const p = join(tmpDir, "lossy.txt");
		// Em-dash (U+2014) is unrepresentable in Latin-1
		const refused = await writeText(p, "hello — world", { encoding: "latin-1", eol: "lf", bom: false });
		expect(refused.ok).toBe(false);
		if (refused.ok === false) {
			expect(refused.lossy.encoding).toBe("latin-1");
			expect(refused.lossy.lossyCharCount).toBe(1);
			expect(refused.lossy.firstIndex).toBe(6);
			expect(refused.lossy.sample).toContain("—");
		}

		// File should NOT exist yet — the refused write didn't touch disk
		expect(() => readFileSync(p)).toThrow();

		// Caller opts in to lossy save
		const allowed = await writeText(p, "hello — world", { encoding: "latin-1", eol: "lf", bom: false }, { allowLossy: true });
		expect(allowed.ok).toBe(true);
		if (allowed.ok === true) expect(allowed.lossyChars).toBe(1);
		const buf = readFileSync(p);
		// The em-dash got truncated to its low byte (0x14) — that's expected once
		// the user explicitly opted in. We just assert no throw and right length.
		expect(buf.length).toBeGreaterThan(0);
		unlinkSync(p);
	});
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `bun test tests/text-io.test.ts`
Expected: 5 new tests fail with "writeText is not a function" or similar import error.

- [ ] **Step 3: Implement `writeText`**

Append to `src/bun/text-io.ts`:

```ts
import { writeFileSync } from "fs";

export type WriteMeta = { encoding: Encoding; eol: EOL; bom: boolean };

/** F2: When the target encoding can't represent some chars, refuse the write
 *  and return diagnostic info so the caller can show a confirm modal. The
 *  caller can opt in to the lossy save by passing `{ allowLossy: true }`. */
export type WriteResult =
	| { ok: true; lossyChars?: number }
	| { ok: false; lossy: { encoding: Encoding; lossyCharCount: number; firstIndex: number; sample: string } };

function scanLossyForLatin1(content: string): { count: number; firstIndex: number } {
	let count = 0;
	let firstIndex = -1;
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) > 255) {
			count++;
			if (firstIndex < 0) firstIndex = i;
		}
	}
	return { count, firstIndex };
}

export async function writeText(
	path: string,
	content: string,
	meta: WriteMeta,
	opts?: { allowLossy?: boolean },
): Promise<WriteResult> {
	// F2: Lossy-encoding precheck. UTF-8 / UTF-16 LE / UTF-16 BE round-trip
	// every JS string. Latin-1 only covers code points 0–255 — any char
	// above (em-dash 0x2014, emoji 0x1F600, etc.) gets silently truncated
	// to 0x3F by Buffer.from(str, "latin1"). Refuse unless caller opts in.
	if (meta.encoding === "latin-1") {
		const { count, firstIndex } = scanLossyForLatin1(content);
		if (count > 0 && !opts?.allowLossy) {
			const sampleStart = Math.max(0, firstIndex - 10);
			const sampleEnd = Math.min(content.length, firstIndex + 11);
			return {
				ok: false,
				lossy: {
					encoding: "latin-1",
					lossyCharCount: count,
					firstIndex,
					sample: content.slice(sampleStart, sampleEnd),
				},
			};
		}
	}

	// Normalize EOL: collapse to \n first, then expand to target
	const normalized = content.replace(/\r\n/g, "\n");
	const withEol = meta.eol === "crlf" ? normalized.replace(/\n/g, "\r\n") : normalized;

	const bomBytes = meta.bom
		? meta.encoding === "utf-8"   ? Buffer.from([0xEF, 0xBB, 0xBF])
		: meta.encoding === "utf-16le" ? Buffer.from([0xFF, 0xFE])
		: meta.encoding === "utf-16be" ? Buffer.from([0xFE, 0xFF])
		: Buffer.alloc(0)
		: Buffer.alloc(0);

	let bodyBytes: Buffer;
	if (meta.encoding === "utf-16le") {
		bodyBytes = Buffer.from(withEol, "utf16le");
	} else if (meta.encoding === "utf-16be") {
		const le = Buffer.from(withEol, "utf16le");
		bodyBytes = Buffer.alloc(le.length);
		for (let i = 0; i + 1 < le.length; i += 2) { bodyBytes[i] = le[i + 1]; bodyBytes[i + 1] = le[i]; }
	} else if (meta.encoding === "latin-1") {
		bodyBytes = Buffer.from(withEol, "latin1");
	} else {
		bodyBytes = Buffer.from(withEol, "utf8");
	}

	writeFileSync(path, Buffer.concat([bomBytes, bodyBytes]));

	// If we got here with latin-1 and allowLossy=true, surface the count for callers.
	if (meta.encoding === "latin-1" && opts?.allowLossy) {
		const { count } = scanLossyForLatin1(content);
		return count > 0 ? { ok: true, lossyChars: count } : { ok: true };
	}
	return { ok: true };
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test tests/text-io.test.ts`
Expected: 14 pass total (8 read + 6 write — read includes 2 F1 regression guards; write includes 1 F2 lossy-encoding test).

- [ ] **Step 5: Commit**

```bash
git add src/bun/text-io.ts tests/text-io.test.ts
git commit -m "feat(text-io): writeText with encoding/EOL/BOM preservation"
```

---

### Task 4: Extend RPC schema with text I/O + session types

**Files:**
- Modify: `src/shared/rpc.ts`

- [ ] **Step 1: Extend the schema**

Replace the body of `src/shared/rpc.ts`:

```ts
import type { RPCSchema } from "electrobun/bun";

export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "latin-1";
export type EOL = "lf" | "crlf";

export type FilePayload = {
	path: string;
	content: string;
	error?: string;
	encoding?: Encoding;
	eol?: EOL;
	bom?: boolean;
	binary?: boolean;
	tooLarge?: boolean;
	size?: number;
};

// F2: Lossy-encoding diagnostic returned when target encoding can't represent
// some characters. Renderer surfaces a confirm modal before retrying with
// allowLossy: true. Errors stay as a separate 'error' branch.
export type LossyInfo = { encoding: Encoding; lossyCharCount: number; firstIndex: number; sample: string };

export type WriteResult =
	| { ok: true; lossyChars?: number }
	| { ok: false; lossy: LossyInfo }
	| { ok: false; error: string };

export type TreeNode =
	| { type: "dir"; name: string; path: string; children: TreeNode[] }
	| { type: "file"; name: string; path: string };

export type FolderPayload = {
	root: string;
	tree: TreeNode[];
	truncated: boolean;
	count: number;
};

export type RecentEntry = { path: string; name: string; openedAt: number };

export type SearchHit = {
	path: string;
	name: string;
	matches: { line: number; preview: string; column: number; length: number }[];
};

export type SearchResults = {
	query: string;
	hits: SearchHit[];
	truncated: boolean;
	scanned: number;
	matched: number;
};

export type ImageResolveResult = { dataUrl: string } | { error: string };

export type SessionTab = {
	id: string;
	path: string | null;
	name: string;
	encoding: Encoding;
	eol: EOL;
	bom: boolean;
	language: string;
	viewMode: "preview" | "editor";
	// Inline content only when path === null (untitled), capped at 1 MB
	untitledContent?: string;
};

export type SessionState = {
	tabs: SessionTab[];
	activeTabId: string | null;
};

export type AppRPC = {
	bun: RPCSchema<{
		requests: {
			openDialog: { params: {}; response: FilePayload | null };
			openFolderDialog: { params: {}; response: FolderPayload | null };
			readFile: { params: { path: string }; response: FilePayload };
			writeFile: { params: { path: string; content: string; encoding: Encoding; eol: EOL; bom: boolean; allowLossy?: boolean }; response: WriteResult };
			saveAsDialog: { params: { defaultName: string; content: string; encoding: Encoding; eol: EOL; bom: boolean; allowLossy?: boolean }; response: { ok: true; path: string; lossyChars?: number } | { ok: false; lossy?: LossyInfo } };
			resolveImage: { params: { docPath: string; src: string }; response: ImageResolveResult };
			getInitialFile: { params: {}; response: FilePayload | null };
			openExternal: { params: { url: string }; response: { ok: boolean } };
			revealInFinder: { params: { path: string }; response: { ok: boolean } };
			getRecent: { params: {}; response: RecentEntry[] };
			clearRecent: { params: {}; response: { ok: boolean } };
			searchFolder: { params: { root: string; query: string; caseSensitive?: boolean; wholeWord?: boolean }; response: SearchResults };
			exportHtml: { params: { html: string; title: string; defaultName: string }; response: { ok: boolean; path?: string } };
			loadSession: { params: {}; response: SessionState };
			saveSession: { params: { state: SessionState }; response: { ok: boolean } };
		};
		messages: {
			ready: {};
			print: {};
			log: { level: "info" | "warn" | "error"; msg: string };
		};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			fileOpened: FilePayload;
			fileChanged: FilePayload;
			folderOpened: FolderPayload;
			folderUpdated: FolderPayload;
			menuAction: { action: string };
		};
	}>;
};
```

- [ ] **Step 2: Type-check the project**

Run: `bunx tsc --noEmit`
Expected: type errors only in `src/bun/index.ts` and `src/mainview/index.ts` referencing missing handlers — that's expected, we'll add them in Task 5+. No errors in `rpc.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add src/shared/rpc.ts
git commit -m "feat(rpc): extend schema with text I/O, save-as, and session types"
```

---

### Task 5: Wire `readFile`, `writeFile`, `saveAsDialog` RPC handlers in Bun

**Files:**
- Modify: `src/bun/index.ts`

- [ ] **Step 1: Replace `readMarkdownFile` with encoding-aware reader**

In `src/bun/index.ts`:

(a) Add the import for `readText`/`writeText` near the top imports:

```ts
import { readText, writeText, type Encoding, type EOL } from "./text-io";
```

(b) Replace `MD_EXT_RE` use in `readMarkdownFile` — rename it and drop the markdown-only restriction. Replace the existing `readMarkdownFile` (around lines 44–55) with:

```ts
const MAX_OPEN_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

async function readAnyTextFile(path: string): Promise<FilePayload> {
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			return { path, content: "", error: `File not found: ${path}` };
		}
		const size = file.size;
		if (size > MAX_OPEN_FILE_SIZE) {
			return { path, content: "", error: `File too large (${(size / 1048576).toFixed(1)} MB)`, tooLarge: true, size };
		}
		const r = await readText(path);
		if (r.binary) {
			return { path, content: "", error: "Binary file refused", binary: true, size };
		}
		return { path, content: r.content, encoding: r.encoding, eol: r.eol, bom: r.bom, size };
	} catch (err) {
		return { path, content: "", error: err instanceof Error ? err.message : String(err) };
	}
}
```

(c) Replace every internal call to `readMarkdownFile` with `readAnyTextFile` (in `dispatchFile`, `openDialog`, `readFile` handler, `getInitialFile`).

- [ ] **Step 2: Add `recentSelfWrites` map + write handlers**

After the `currentFolderRoot` declaration (~line 22), add:

```ts
const SELF_WRITE_TTL_MS = 1000;
const recentSelfWrites = new Map<string, number>();

function stampSelfWrite(path: string) {
	recentSelfWrites.set(path, Date.now());
	// Cleanup
	for (const [p, t] of recentSelfWrites) {
		if (Date.now() - t > SELF_WRITE_TTL_MS) recentSelfWrites.delete(p);
	}
}

function isRecentSelfWrite(path: string): boolean {
	const t = recentSelfWrites.get(path);
	if (!t) return false;
	if (Date.now() - t > SELF_WRITE_TTL_MS) {
		recentSelfWrites.delete(path);
		return false;
	}
	return true;
}
```

(d) In the existing `watchFile` function, inside the `setTimeout` callback, replace the body with:

```ts
debounce = setTimeout(async () => {
	if (path !== currentWatchedPath) return;
	if (isRecentSelfWrite(path)) {
		dbg("[mv] watcher: ignoring self-write echo on", path);
		return;
	}
	const payload = await readAnyTextFile(path);
	if (mainWindow) mainWindow.webview.rpc?.send.fileChanged(payload);
}, 80);
```

- [ ] **Step 3: Add `writeFile` and `saveAsDialog` RPC handlers**

In the `requests` block of `BrowserView.defineRPC<AppRPC>` (around line 263), add:

```ts
writeFile: async ({ path, content, encoding, eol, bom, allowLossy }) => {
	try {
		stampSelfWrite(path);
		const r = await writeText(path, content, { encoding, eol, bom }, { allowLossy: !!allowLossy });
		if (r.ok === false) {
			// F2: lossy refusal — bubble up the diagnostic so the renderer can confirm
			return { ok: false, lossy: r.lossy } as const;
		}
		return { ok: true, lossyChars: r.lossyChars } as const;
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) } as const;
	}
},
saveAsDialog: async ({ defaultName, content, encoding, eol, bom, allowLossy }) => {
	const folder = await Utils.openFileDialog({
		startingFolder: PLATFORM_HOME,
		canChooseFiles: false,
		canChooseDirectory: true,
		allowsMultipleSelection: false,
	});
	const dir = folder?.[0];
	if (!dir) return { ok: false } as const;
	const safeName = defaultName.replace(/[^A-Za-z0-9._\- ]/g, "_") || "untitled.txt";
	const target = join(dir, safeName);
	try {
		stampSelfWrite(target);
		const r = await writeText(target, content, { encoding, eol, bom }, { allowLossy: !!allowLossy });
		if (r.ok === false) {
			return { ok: false, lossy: r.lossy } as const;
		}
		return { ok: true, path: target, lossyChars: r.lossyChars } as const;
	} catch {
		return { ok: false } as const;
	}
},
```

- [ ] **Step 4: Drop `MD_EXT_RE` filter for the open-file path**

Find the `if (initialFile && MD_EXT_RE.test(initialFile))` near the bottom (~line 416). Replace with:

```ts
if (initialFile) {
	dbg("[mv] dispatching initial file:", initialFile);
	dispatchFile(initialFile);
}
```

(`MD_EXT_RE` stays — it's still used for the folder tree filter so `.md` files surface in the file tree. Non-md files are still openable via Open / drag-drop.)

- [ ] **Step 5: Type-check + run existing tests**

Run: `bunx tsc --noEmit`
Expected: no errors in `src/bun/index.ts` or `src/shared/rpc.ts`. (Renderer errors are still acceptable until Task 9.)

Run: `bun test`
Expected: 14 pass (no regressions in text-io tests).

- [ ] **Step 6: Commit**

```bash
git add src/bun/index.ts
git commit -m "feat(bun): writeFile/saveAsDialog RPC + watcher self-write suppression"
```

---

## Phase 1 — Editor on the single document (no tabs yet)

### Task 6: Create the CodeMirror 6 wrapper (`editor.ts`)

**Files:**
- Create: `src/mainview/editor.ts`

- [ ] **Step 1: Implement the wrapper**

Create `src/mainview/editor.ts`:

```ts
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { defaultKeymap, historyKeymap, history, indentWithTab } from "@codemirror/commands";
import { searchKeymap, search, highlightSelectionMatches } from "@codemirror/search";
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle, LanguageSupport } from "@codemirror/language";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";

export type LanguageId =
	| "plain" | "markdown" | "json" | "yaml" | "toml" | "xml" | "html" | "css"
	| "javascript" | "typescript" | "python" | "shell" | "powershell" | "sql"
	| "ruby" | "rust" | "go" | "java" | "c" | "cpp" | "ini";

export type EditorChangeListener = (content: string) => void;

export type EditorHandle = {
	view: EditorView;
	setDoc(content: string, opts?: { language?: LanguageId; eol?: "lf" | "crlf"; tabSize?: number; useTabs?: boolean; wordWrap?: boolean }): void;
	getDoc(): string;
	focus(): void;
	destroy(): void;
	setLanguage(id: LanguageId): Promise<void>;
	setWordWrap(on: boolean): void;
	setIndent(useTabs: boolean, tabSize: number): void;
	onChange(listener: EditorChangeListener): () => void;
};

const languageCompartment = new Compartment();
const wrapCompartment = new Compartment();
const indentCompartment = new Compartment();

async function loadLanguage(id: LanguageId): Promise<LanguageSupport | null> {
	switch (id) {
		case "markdown":   return (await import("@codemirror/lang-markdown")).markdown();
		case "json":       return (await import("@codemirror/lang-json")).json();
		case "yaml":       return (await import("@codemirror/lang-yaml")).yaml();
		case "html":       return (await import("@codemirror/lang-html")).html();
		case "css":        return (await import("@codemirror/lang-css")).css();
		case "javascript": return (await import("@codemirror/lang-javascript")).javascript();
		case "typescript": return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
		case "python":     return (await import("@codemirror/lang-python")).python();
		case "xml":        return (await import("@codemirror/lang-xml")).xml();
		case "sql":        return (await import("@codemirror/lang-sql")).sql();
		case "shell": {
			const m = await import("@codemirror/legacy-modes/mode/shell");
			const { StreamLanguage } = await import("@codemirror/language");
			return new LanguageSupport(StreamLanguage.define(m.shell));
		}
		case "powershell": {
			const m = await import("@codemirror/legacy-modes/mode/powershell");
			const { StreamLanguage } = await import("@codemirror/language");
			return new LanguageSupport(StreamLanguage.define(m.powerShell));
		}
		case "toml": {
			const m = await import("@codemirror/legacy-modes/mode/toml");
			const { StreamLanguage } = await import("@codemirror/language");
			return new LanguageSupport(StreamLanguage.define(m.toml));
		}
		case "ini": {
			const m = await import("@codemirror/legacy-modes/mode/properties");
			const { StreamLanguage } = await import("@codemirror/language");
			return new LanguageSupport(StreamLanguage.define(m.properties));
		}
		case "ruby": {
			const m = await import("@codemirror/legacy-modes/mode/ruby");
			const { StreamLanguage } = await import("@codemirror/language");
			return new LanguageSupport(StreamLanguage.define(m.ruby));
		}
		case "rust": {
			const m = await import("@codemirror/legacy-modes/mode/rust");
			const { StreamLanguage } = await import("@codemirror/language");
			return new LanguageSupport(StreamLanguage.define(m.rust));
		}
		case "go": {
			const m = await import("@codemirror/legacy-modes/mode/go");
			const { StreamLanguage } = await import("@codemirror/language");
			return new LanguageSupport(StreamLanguage.define(m.go));
		}
		case "java": {
			const m = await import("@codemirror/legacy-modes/mode/clike");
			const { StreamLanguage } = await import("@codemirror/language");
			return new LanguageSupport(StreamLanguage.define(m.java));
		}
		case "c": case "cpp": {
			const m = await import("@codemirror/legacy-modes/mode/clike");
			const { StreamLanguage } = await import("@codemirror/language");
			return new LanguageSupport(StreamLanguage.define(id === "c" ? m.c : m.cpp));
		}
		default: return null;
	}
}

export function languageForExtension(ext: string, name: string): LanguageId {
	const e = ext.toLowerCase().replace(/^\./, "");
	if (["md","markdown","mdown","mkd","mkdn","mdx"].includes(e)) return "markdown";
	if (e === "json") return "json";
	if (e === "yml" || e === "yaml") return "yaml";
	if (e === "toml") return "toml";
	if (e === "xml") return "xml";
	if (e === "html" || e === "htm") return "html";
	if (e === "css" || e === "scss") return "css";
	if (e === "js" || e === "jsx" || e === "mjs" || e === "cjs") return "javascript";
	if (e === "ts" || e === "tsx") return "typescript";
	if (e === "py") return "python";
	if (e === "sh" || e === "bash" || e === "zsh") return "shell";
	if (e === "ps1" || e === "psm1") return "powershell";
	if (e === "sql") return "sql";
	if (e === "rb") return "ruby";
	if (e === "rs") return "rust";
	if (e === "go") return "go";
	if (e === "java") return "java";
	if (e === "c" || e === "h") return "c";
	if (e === "cpp" || e === "cc" || e === "hpp" || e === "hxx") return "cpp";
	if (e === "ini" || e === "conf" || e === "env" || e === "properties") return "ini";
	// Files with no extension that look like config
	const lower = name.toLowerCase();
	if (lower === ".gitignore" || lower === ".editorconfig" || lower === "dockerfile") return "ini";
	return "plain";
}

export function createEditor(host: HTMLElement, opts: { content: string; language: LanguageId; useTabs?: boolean; tabSize?: number; wordWrap?: boolean }): EditorHandle {
	const listeners = new Set<EditorChangeListener>();
	const updateListener = EditorView.updateListener.of((u) => {
		if (u.docChanged) {
			const v = u.state.doc.toString();
			for (const l of listeners) l(v);
		}
	});

	const baseExtensions = [
		lineNumbers(),
		highlightActiveLine(),
		highlightSelectionMatches(),
		history(),
		drawSelection(),
		rectangularSelection(),
		crosshairCursor(),
		foldGutter(),
		indentOnInput(),
		bracketMatching(),
		closeBrackets(),
		autocompletion(),
		search({ top: true }),
		syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
		keymap.of([
			...closeBracketsKeymap,
			...defaultKeymap,
			...searchKeymap,
			...historyKeymap,
			...foldKeymap,
			...completionKeymap,
			...lintKeymap,
			indentWithTab,
		]),
		updateListener,
	];

	const state = EditorState.create({
		doc: opts.content,
		extensions: [
			languageCompartment.of([]),
			wrapCompartment.of(opts.wordWrap ? EditorView.lineWrapping : []),
			indentCompartment.of(EditorState.tabSize.of(opts.tabSize ?? 4)),
			...baseExtensions,
		],
	});

	const view = new EditorView({ state, parent: host });

	const handle: EditorHandle = {
		view,
		setDoc(content, dopts) {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
			if (dopts?.language) handle.setLanguage(dopts.language);
			if (dopts?.wordWrap !== undefined) handle.setWordWrap(dopts.wordWrap);
			if (dopts?.useTabs !== undefined || dopts?.tabSize !== undefined) {
				handle.setIndent(dopts.useTabs ?? false, dopts.tabSize ?? 4);
			}
		},
		getDoc() {
			return view.state.doc.toString();
		},
		focus() { view.focus(); },
		destroy() { view.destroy(); listeners.clear(); },
		async setLanguage(id) {
			const lang = await loadLanguage(id);
			view.dispatch({ effects: languageCompartment.reconfigure(lang ? [lang] : []) });
		},
		setWordWrap(on) {
			view.dispatch({ effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []) });
		},
		setIndent(useTabs, tabSize) {
			view.dispatch({ effects: indentCompartment.reconfigure(EditorState.tabSize.of(tabSize)) });
			void useTabs; // tabs vs spaces inserted by user keystrokes; controlled via indentWithTab + IME default
		},
		onChange(listener) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};

	// Apply initial language async
	void handle.setLanguage(opts.language);
	return handle;
}
```

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors in `editor.ts`. Errors in `index.ts` are still expected (we haven't wired it yet).

- [ ] **Step 3: Commit**

```bash
git add src/mainview/editor.ts
git commit -m "feat(editor): CodeMirror 6 wrapper with lazy language loading"
```

---

### Task 7: Add editor host element + status bar chips

**Files:**
- Modify: `src/mainview/index.html`
- Modify: `src/mainview/index.css`

- [ ] **Step 1: Add editor host markup + external-change banner**

In `src/mainview/index.html`, find the `<main class="content" id="content-pane">` block (line ~80). Inside `<main>`, after the existing `<div id="find-bar">` block and before `<article id="content">`, insert the banner; after `</article>` (line ~108) add the editor host. Final `<main>` block:

```html
		<main class="content" id="content-pane">
			<div id="dropzone" class="dropzone" aria-hidden="true">
				<div class="dropzone-msg">Drop a file to open</div>
			</div>

			<div id="find-bar" class="find-bar" hidden>
				<input id="find-input" class="find-input" placeholder="Find in document…" />
				<span id="find-count" class="find-count"></span>
				<button id="find-prev" class="btn btn-icon btn-small" title="Previous (⇧↩)">↑</button>
				<button id="find-next" class="btn btn-icon btn-small" title="Next (↩)">↓</button>
				<button id="find-close" class="btn btn-icon btn-small" title="Close (Esc)">✕</button>
			</div>

			<div id="external-change-banner" class="banner" hidden>
				<span>File changed on disk.</span>
				<button id="banner-reload" class="btn btn-small">Reload</button>
				<button id="banner-keep" class="btn btn-small btn-ghost">Keep my changes</button>
			</div>

			<article id="content" class="markdown-body welcome">
				<div class="welcome-card">
					<h1>Markdown Viewer</h1>
					<p class="welcome-sub">Open a file with <kbd>⌘</kbd> <kbd>O</kbd>, a folder with <kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>O</kbd>, or drop a file here.</p>
					<div class="welcome-features">
						<div class="feature"><div class="feature-title">Markdown + GFM + Math</div><div class="feature-desc">Tables, tasks, footnotes, KaTeX, GitHub alerts, wikilinks</div></div>
						<div class="feature"><div class="feature-title">Mermaid &amp; C4</div><div class="feature-desc">Click any diagram to zoom + pan</div></div>
						<div class="feature"><div class="feature-title">Editor (⌘E)</div><div class="feature-desc">Notepad++-class editing with line numbers, search, multi-cursor</div></div>
						<div class="feature"><div class="feature-title">Find &amp; Search</div><div class="feature-desc"><kbd>⌘F</kbd> in doc, <kbd>⌘⇧F</kbd> across folder</div></div>
					</div>
					<div id="welcome-recent" class="welcome-recent" hidden>
						<div class="welcome-recent-title">Recent</div>
						<div id="welcome-recent-list"></div>
					</div>
				</div>
			</article>

			<div id="editor-host" class="editor-host" hidden></div>
		</main>
```

Replace the existing `<div id="statusbar">` block with chips:

```html
	<div id="statusbar" class="statusbar">
		<span id="status-path" class="status-path"></span>
		<span id="status-stats" class="status-stats"></span>
		<span id="status-mode" class="status-chip" title="Toggle (⌘E)">PREVIEW</span>
		<span id="status-lang" class="status-chip" title="Language">plain</span>
		<span id="status-encoding" class="status-chip" title="Encoding — click to reopen">UTF-8</span>
		<span id="status-eol" class="status-chip" title="Line endings">LF</span>
		<span id="status-zoom" class="status-zoom">100%</span>
	</div>
```

- [ ] **Step 2: Add CSS**

Append to `src/mainview/index.css`:

```css
/* ============== Editor host ============== */
.editor-host {
	position: absolute;
	inset: 0;
	background: var(--bg);
	overflow: auto;
}
.editor-host[hidden] { display: none; }
.editor-host .cm-editor { height: 100%; font-family: var(--font-mono, ui-monospace, "SF Mono", Consolas, "Roboto Mono", monospace); font-size: 13px; }
.editor-host .cm-scroller { font-family: inherit; }
.editor-host .cm-gutters { background: var(--bg-soft, #f6f8fa); border-right: 1px solid var(--border); color: var(--text-faint); }
[data-theme="dark"] .editor-host .cm-gutters { background: #161b22; }
.editor-host .cm-activeLine { background: rgba(120, 120, 120, 0.06); }
.editor-host .cm-activeLineGutter { background: rgba(120, 120, 120, 0.10); }

/* ============== Banner ============== */
.banner {
	position: sticky;
	top: 0;
	z-index: 10;
	display: flex;
	gap: 8px;
	align-items: center;
	padding: 8px 12px;
	background: #fff8c5;
	color: #59431e;
	border-bottom: 1px solid #d4a72c;
	font-size: 13px;
}
[data-theme="dark"] .banner { background: #3b2e0d; color: #f0e3a0; border-color: #8b6f1c; }

/* ============== Status bar chips ============== */
.status-chip {
	margin-left: 8px;
	padding: 1px 8px;
	border-radius: 4px;
	background: var(--bg-soft, #f6f8fa);
	color: var(--text-faint);
	border: 1px solid var(--border);
	font-size: 11px;
	cursor: pointer;
	user-select: none;
}
.status-chip:hover { background: var(--bg-hover, #eaeef2); color: var(--text); }
[data-theme="dark"] .status-chip { background: #161b22; }
[data-theme="dark"] .status-chip:hover { background: #21262d; }
```

- [ ] **Step 3: Run dev build, verify nothing broke**

Run: `bun run dev`
Expected: app launches, welcome screen shows, no console errors. Status bar shows the new chips. `editor-host` is hidden.

Stop dev (Ctrl+C).

- [ ] **Step 4: Commit**

```bash
git add src/mainview/index.html src/mainview/index.css
git commit -m "feat(ui): add editor host, external-change banner, status-bar chips"
```

---

### Task 8: Wire `⌘E` toggle for the current single-doc model

**Files:**
- Modify: `src/mainview/index.ts`
- Modify: `src/bun/index.ts` (menu)

- [ ] **Step 1: Add the menu entries in Bun**

In `src/bun/index.ts`, find `ApplicationMenu.setApplicationMenu([...])`. Replace the `View` and `File` submenu blocks:

```ts
{
	label: "File",
	submenu: [
		{ label: "Open File…", action: "open-file", accelerator: "cmd+o" },
		{ label: "Open Folder…", action: "open-folder", accelerator: "cmd+shift+o" },
		{ type: "separator" },
		{ label: "Save", action: "save", accelerator: "cmd+s" },
		{ label: "Save As…", action: "save-as", accelerator: "cmd+shift+s" },
		{ type: "separator" },
		{ label: "Reveal in Finder", action: "reveal-in-finder", accelerator: "cmd+shift+r" },
		{ type: "separator" },
		{ label: "Print…", action: "print", accelerator: "cmd+p" },
		{ label: "Export to HTML…", action: "export-html" },
		{ type: "separator" },
		{ role: "close" },
	],
},
{
	label: "Edit",
	submenu: [
		{ role: "undo" },
		{ role: "redo" },
		{ type: "separator" },
		{ role: "cut" },
		{ role: "copy" },
		{ role: "paste" },
		{ role: "selectAll" },
		{ type: "separator" },
		{ label: "Find in Document", action: "find", accelerator: "cmd+f" },
		{ label: "Find in Folder", action: "find-in-folder", accelerator: "cmd+shift+f" },
		{ label: "Goto Line…", action: "goto-line", accelerator: "cmd+g" },
	],
},
{
	label: "View",
	submenu: [
		{ label: "Reload", action: "reload", accelerator: "cmd+r" },
		{ type: "separator" },
		{ label: "Toggle Editor / Preview", action: "toggle-mode", accelerator: "cmd+e" },
		{ label: "Toggle Sidebar", action: "toggle-sidebar", accelerator: "cmd+\\" },
		{ label: "Toggle Word Wrap", action: "toggle-wrap", accelerator: "alt+z" },
		{ label: "Toggle Theme", action: "toggle-theme", accelerator: "cmd+shift+l" },
		{ type: "separator" },
		{ label: "Zoom In", action: "zoom-in", accelerator: "cmd+=" },
		{ label: "Zoom Out", action: "zoom-out", accelerator: "cmd+-" },
		{ label: "Reset Zoom", action: "zoom-reset", accelerator: "cmd+0" },
		{ type: "separator" },
		{ role: "togglefullscreen" },
	],
},
```

- [ ] **Step 2: Wire mode state in the renderer**

In `src/mainview/index.ts`, near the top imports:

```ts
import { createEditor, languageForExtension, type EditorHandle, type LanguageId } from "./editor";
import { setEditorView } from "./find-in-doc";
```

Near existing state (around line 119):

```ts
type ViewMode = "preview" | "editor";
let viewMode: ViewMode = "preview";
let editor: EditorHandle | null = null;
```

DOM refs (near other `getElementById`):

```ts
const editorHost = document.getElementById("editor-host") as HTMLElement;
const statusMode = document.getElementById("status-mode") as HTMLElement;
const statusLang = document.getElementById("status-lang") as HTMLElement;
const statusEncoding = document.getElementById("status-encoding") as HTMLElement;
const statusEol = document.getElementById("status-eol") as HTMLElement;
const externalBanner = document.getElementById("external-change-banner") as HTMLElement;
const bannerReload = document.getElementById("banner-reload") as HTMLButtonElement;
const bannerKeep = document.getElementById("banner-keep") as HTMLButtonElement;
```

Helpers (below `setZoom`):

```ts
function inferLanguage(path: string): LanguageId {
	const m = path.match(/[^/\\]+$/);
	const name = m ? m[0] : "";
	const dot = name.lastIndexOf(".");
	const ext = dot >= 0 ? name.slice(dot) : "";
	return languageForExtension(ext, name);
}

function isMarkdownPath(path: string): boolean {
	return /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i.test(path);
}

function ensureEditor() {
	if (editor) return;
	editor = createEditor(editorHost, {
		content: "", language: "plain",
		useTabs: true, tabSize: 4, wordWrap: false,
	});
	editor.onChange((newContent) => {
		if (lastPayload) {
			lastPayload = { ...lastPayload, content: newContent };
			updateDirtyIndicator();
		}
	});
	setEditorView(editor.view);
}

function applyMode(mode: ViewMode) {
	viewMode = mode;
	statusMode.textContent = mode === "preview" ? "PREVIEW" : "EDITOR";
	if (mode === "editor") {
		contentEl.hidden = true;
		editorHost.hidden = false;
		ensureEditor();
		if (editor && lastPayload) {
			editor.setDoc(lastPayload.content, { language: inferLanguage(lastPayload.path) });
			editor.focus();
		}
	} else {
		editorHost.hidden = true;
		contentEl.hidden = false;
		if (lastPayload) renderPreview(lastPayload, { preserveScroll: true });
	}
}

function toggleMode() {
	if (!lastPayload) return;
	if (!isMarkdownPath(lastPayload.path)) {
		if (viewMode !== "editor") applyMode("editor");
		return;
	}
	applyMode(viewMode === "preview" ? "editor" : "preview");
}
```

- [ ] **Step 3: Split the existing `renderFile` into preview vs entry**

Rename the existing `renderFile` to `renderPreview` (it stays exactly as-is). Add a new entry point that decides mode:

```ts
async function renderFile(payload: FilePayload, opts: { preserveScroll?: boolean } = {}) {
	lastPayload = payload;
	statusEncoding.textContent = (payload.encoding || "utf-8").toUpperCase();
	statusEol.textContent = (payload.eol || "lf").toUpperCase();
	statusLang.textContent = inferLanguage(payload.path);
	if (payload.error) {
		// Existing inline-error path (preserve from renderPreview)
		contentEl.classList.remove("welcome");
		contentEl.textContent = "";
		const h = document.createElement("h1"); h.textContent = "Cannot open file"; contentEl.appendChild(h);
		const p1 = document.createElement("p"); p1.textContent = payload.error; contentEl.appendChild(p1);
		const p2 = document.createElement("p"); const code = document.createElement("code"); code.textContent = payload.path; p2.appendChild(code); contentEl.appendChild(p2);
		statusPath.textContent = payload.path;
		statusStats.textContent = "";
		applyMode("preview");
		return;
	}
	if (isMarkdownPath(payload.path)) {
		applyMode("preview");
		await renderPreview(payload, opts);
	} else {
		applyMode("editor");
		statusPath.textContent = payload.path;
		statusStats.textContent = `${payload.content.length.toLocaleString()} chars`;
		document.title = payload.path.split(/[\\/]/).pop() || "Markdown Viewer";
	}
}
```

(Update the RPC handler block — `fileOpened` and the menu/dialog flows already call `renderFile`, so they automatically route through the new entry. `fileChanged` keeps calling `renderFile`. The renamed `renderPreview` is only invoked from the new `renderFile` and from `applyMode("preview")`.)

- [ ] **Step 4: Wire menu actions and shortcuts**

In `handleMenuAction()`, add:

```ts
case "toggle-mode": toggleMode(); break;
```

Replace the keyboard handler `else if (k === "d")` block with:

```ts
	else if (k === "e") { e.preventDefault(); toggleMode(); }
	else if (k === "l" && e.shiftKey) { e.preventDefault(); toggleTheme(); }
```

(Remove the old `k === "d"` theme toggle. `Ctrl+D` is now free for CM6's "duplicate line / select-next" — provided automatically by the CM6 keymap when the editor has focus.)

Add a placeholder `updateDirtyIndicator` for now (Task 9 fills it):

```ts
function updateDirtyIndicator() { /* Task 9 fills this in */ }
```

- [ ] **Step 5: Manually verify**

Run: `bun run dev`. Tests:
1. Open `README.md` → preview (existing behavior).
2. `⌘E` → editor with line numbers + markdown source.
3. `⌘E` again → preview.
4. Drag-drop a `.txt`, `.json`, or `.js` file → opens in editor.
5. Status chips show `EDITOR` / language / `UTF-8` / `LF`.
6. `⌘⇧L` toggles theme.

Stop dev.

- [ ] **Step 6: Commit**

```bash
git add src/bun/index.ts src/mainview/index.ts
git commit -m "feat(editor): ⌘E toggle preview↔editor; non-md opens in editor; rebind theme to ⌘⇧L"
```

---

### Task 9: Wire `⌘S` save (no dirty-modal yet) + dirty indicator

**Files:**
- Modify: `src/mainview/index.ts`

- [ ] **Step 1: Add save state**

Near the existing state additions from Task 8:

```ts
let savedContent: string | null = null;
let docMeta: { encoding: import("../shared/rpc").Encoding; eol: import("../shared/rpc").EOL; bom: boolean } = {
	encoding: "utf-8", eol: "lf", bom: false,
};
```

Inside `renderFile`, just after `lastPayload = payload;`:

```ts
	savedContent = payload.content;
	docMeta = { encoding: payload.encoding || "utf-8", eol: payload.eol || "lf", bom: payload.bom || false };
```

- [ ] **Step 2: Implement save / saveAs / dirty indicator**

Below `toggleMode`:

```ts
// F2: surface the lossy-encoding refusal to the user with a confirm modal.
// Returns true if the user wants to proceed with the lossy save anyway.
async function confirmLossy(lossy: { encoding: import("../shared/rpc").Encoding; lossyCharCount: number; firstIndex: number; sample: string }): Promise<boolean> {
	const msg =
		`Saving as ${lossy.encoding.toUpperCase()} will lose ${lossy.lossyCharCount} character` +
		`${lossy.lossyCharCount === 1 ? "" : "s"} that ${lossy.lossyCharCount === 1 ? "isn't" : "aren't"} ` +
		`representable in ${lossy.encoding}.\n\n` +
		`First lossy char at index ${lossy.firstIndex}. Surrounding text: "${lossy.sample}"\n\n` +
		`Save anyway?`;
	return Promise.resolve(window.confirm(msg));
}

async function save(): Promise<boolean> {
	if (!lastPayload) return false;
	const content = viewMode === "editor" && editor ? editor.getDoc() : lastPayload.content;
	const onlyName = lastPayload.path === lastPayload.path.split(/[\\/]/).pop();
	if (!lastPayload.path || onlyName) {
		return saveAs(content);
	}
	let allowLossy = false;
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await electroview.rpc!.request.writeFile({
			path: lastPayload.path,
			content,
			encoding: docMeta.encoding,
			eol: docMeta.eol,
			bom: docMeta.bom,
			allowLossy,
		});
		if (r.ok) {
			savedContent = content;
			updateDirtyIndicator();
			statusStats.textContent = r.lossyChars ? `Saved (${r.lossyChars} char${r.lossyChars === 1 ? "" : "s"} lost)` : "Saved";
			setTimeout(() => { if (lastPayload) statusStats.textContent = `${lastPayload.content.length.toLocaleString()} chars`; }, 1500);
			return true;
		}
		// F2: refused for lossy reasons → confirm and retry once
		if ("lossy" in r && r.lossy) {
			const proceed = await confirmLossy(r.lossy);
			if (!proceed) {
				statusStats.textContent = "Save cancelled (would have lost characters)";
				return false;
			}
			allowLossy = true;
			continue;
		}
		statusStats.textContent = `Save failed: ${(r as any).error || "?"}`;
		return false;
	}
	return false;
}

async function saveAs(content?: string): Promise<boolean> {
	if (!lastPayload) return false;
	const body = content ?? (viewMode === "editor" && editor ? editor.getDoc() : lastPayload.content);
	const defaultName = (lastPayload.path.split(/[\\/]/).pop() || "untitled.txt");
	let allowLossy = false;
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await electroview.rpc!.request.saveAsDialog({
			defaultName, content: body,
			encoding: docMeta.encoding, eol: docMeta.eol, bom: docMeta.bom,
			allowLossy,
		});
		if (r.ok) {
			lastPayload = { ...lastPayload, path: r.path, content: body };
			savedContent = body;
			document.title = r.path.split(/[\\/]/).pop() || "Markdown Viewer";
			statusPath.textContent = r.path;
			updateDirtyIndicator();
			return true;
		}
		// F2: refused for lossy reasons (only happens before the dialog returns; so dialog WAS shown and user picked a folder; we just refused on encoding)
		if ("lossy" in r && r.lossy) {
			const proceed = await confirmLossy(r.lossy);
			if (!proceed) return false;
			allowLossy = true;
			continue;
		}
		return false;
	}
	return false;
}
```

Replace the placeholder `updateDirtyIndicator`:

```ts
function updateDirtyIndicator() {
	const live = viewMode === "editor" && editor ? editor.getDoc() : lastPayload?.content;
	const dirty = lastPayload != null && savedContent != null && live !== savedContent;
	const baseTitle = lastPayload?.path?.split(/[\\/]/).pop() || "Markdown Viewer";
	document.title = (dirty ? "● " : "") + baseTitle;
}
```

- [ ] **Step 3: Wire menu + keys**

In `handleMenuAction`:

```ts
case "save": save(); break;
case "save-as": saveAs(); break;
```

In the keyboard handler:

```ts
	else if (k === "s") { e.preventDefault(); if (e.shiftKey) saveAs(); else save(); }
```

- [ ] **Step 4: Manually verify**

Run: `bun run dev`. Open a small `.txt` file. Edit it. Window title shows `● filename.txt`. `⌘S` clears the dot, status shows "Saved".

- [ ] **Step 5: Commit**

```bash
git add src/mainview/index.ts
git commit -m "feat(editor): ⌘S save, ⌘⇧S save-as, dirty indicator in window title"
```

---

### Task 10: External-change banner + beforeunload guard

**Files:**
- Modify: `src/mainview/index.ts`

- [ ] **Step 1: beforeunload guard**

Near the bottom of `index.ts`:

```ts
window.addEventListener("beforeunload", (e) => {
	const live = viewMode === "editor" && editor ? editor.getDoc() : lastPayload?.content;
	const dirty = lastPayload != null && savedContent != null && live !== savedContent;
	if (dirty) {
		e.preventDefault();
		e.returnValue = "";
	}
});
```

- [ ] **Step 2: Route fileChanged through banner when dirty**

In the existing `messages` block of the RPC definition (around line 14), replace `fileChanged: (data) => renderFile(data, { preserveScroll: true })` with:

```ts
fileChanged: (data) => onExternalChange(data),
```

Add `onExternalChange` near `applyMode`:

```ts
let pendingExternal: FilePayload | null = null;

function onExternalChange(data: FilePayload) {
	const live = viewMode === "editor" && editor ? editor.getDoc() : lastPayload?.content;
	const dirty = lastPayload != null && savedContent != null && live !== savedContent;
	if (!dirty) {
		renderFile(data, { preserveScroll: true });
		return;
	}
	pendingExternal = data;
	externalBanner.hidden = false;
}

bannerReload.addEventListener("click", () => {
	if (pendingExternal) renderFile(pendingExternal, { preserveScroll: true });
	pendingExternal = null;
	externalBanner.hidden = true;
});
bannerKeep.addEventListener("click", () => {
	pendingExternal = null;
	externalBanner.hidden = true;
});
```

- [ ] **Step 3: Manually verify**

Run: `bun run dev`. Open `README.md`. `⌘E`. Edit. From another terminal: append a line to the file. Banner appears. Click "Keep my changes" → banner gone, edits intact. Save (`⌘S`) → no echo banner.

- [ ] **Step 4: Commit**

```bash
git add src/mainview/index.ts
git commit -m "feat(editor): external-change banner + beforeunload dirty guard"
```

---

### Task 11: Encoding chip — click to change next-save encoding

**Files:**
- Modify: `src/mainview/index.ts`
- Modify: `src/mainview/index.css`

- [ ] **Step 1: Add chip menu logic**

In `src/mainview/index.ts`, below `updateDirtyIndicator`:

```ts
function showEncodingMenu(anchor: HTMLElement) {
	const menu = document.createElement("div");
	menu.className = "chip-menu";
	const choices: Array<{ label: string; encoding: import("../shared/rpc").Encoding }> = [
		{ label: "UTF-8",     encoding: "utf-8" },
		{ label: "UTF-16 LE", encoding: "utf-16le" },
		{ label: "UTF-16 BE", encoding: "utf-16be" },
		{ label: "Latin-1",   encoding: "latin-1" },
	];
	for (const c of choices) {
		const item = document.createElement("button");
		item.className = "chip-menu-item";
		item.textContent = `Save next time as ${c.label}`;
		item.addEventListener("click", () => {
			closeMenu();
			docMeta = { ...docMeta, encoding: c.encoding };
			statusEncoding.textContent = c.encoding.toUpperCase();
		});
		menu.appendChild(item);
	}
	const r = anchor.getBoundingClientRect();
	menu.style.left = `${r.left}px`;
	menu.style.bottom = `${window.innerHeight - r.top + 4}px`;
	document.body.appendChild(menu);
	function closeMenu() { menu.remove(); document.removeEventListener("click", outside); }
	function outside(e: MouseEvent) { if (!menu.contains(e.target as Node)) closeMenu(); }
	setTimeout(() => document.addEventListener("click", outside), 0);
}

statusEncoding.addEventListener("click", () => showEncodingMenu(statusEncoding));
statusMode.addEventListener("click", () => toggleMode());
statusEol.addEventListener("click", () => {
	docMeta = { ...docMeta, eol: docMeta.eol === "lf" ? "crlf" : "lf" };
	statusEol.textContent = docMeta.eol.toUpperCase();
});
```

- [ ] **Step 2: Add chip-menu styles**

Append to `src/mainview/index.css`:

```css
.chip-menu {
	position: fixed;
	z-index: 100;
	background: var(--bg);
	border: 1px solid var(--border);
	border-radius: 6px;
	box-shadow: 0 4px 16px rgba(0,0,0,0.15);
	padding: 4px;
	min-width: 200px;
}
.chip-menu-item {
	display: block;
	width: 100%;
	padding: 6px 10px;
	text-align: left;
	background: transparent;
	border: 0;
	color: var(--text);
	font-size: 12px;
	cursor: pointer;
	border-radius: 4px;
}
.chip-menu-item:hover { background: var(--bg-hover, #eaeef2); }
[data-theme="dark"] .chip-menu-item:hover { background: #21262d; }
```

- [ ] **Step 3: Manually verify**

Run: `bun run dev`. Open a `.txt` file. Click encoding chip → "Save next time as UTF-16 LE". Save. Verify on disk: first 2 bytes are `0xFF 0xFE`.

- [ ] **Step 4: Commit**

```bash
git add src/mainview/index.ts src/mainview/index.css
git commit -m "feat(editor): encoding/EOL chips choose next-save format"
```

---

### Task 12: Goto Line modal (`⌘G`)

**Files:**
- Modify: `src/mainview/index.html`
- Modify: `src/mainview/index.css`
- Modify: `src/mainview/index.ts`

- [ ] **Step 1: Add modal markup**

In `src/mainview/index.html`, just before `<script src="index.js">`:

```html
	<div id="goto-modal" class="modal" hidden>
		<div class="modal-card">
			<label for="goto-input">Go to line</label>
			<input id="goto-input" class="modal-input" type="number" min="1" placeholder="Line number" />
			<div class="modal-actions">
				<button id="goto-cancel" class="btn btn-ghost btn-small">Cancel</button>
				<button id="goto-go" class="btn btn-primary btn-small">Go</button>
			</div>
		</div>
	</div>
```

- [ ] **Step 2: Add modal CSS**

Append to `src/mainview/index.css`:

```css
.modal {
	position: fixed;
	inset: 0;
	background: rgba(0,0,0,0.4);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 200;
}
.modal[hidden] { display: none; }
.modal-card {
	background: var(--bg);
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 16px;
	min-width: 280px;
	box-shadow: 0 8px 32px rgba(0,0,0,0.25);
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.modal-input {
	padding: 6px 10px;
	background: var(--bg-soft, #f6f8fa);
	border: 1px solid var(--border);
	border-radius: 4px;
	color: var(--text);
	font-size: 13px;
}
.modal-msg { font-size: 13px; color: var(--text); }
.modal-actions { display: flex; gap: 6px; justify-content: flex-end; }
```

- [ ] **Step 3: Wire goto in TS**

DOM refs near the others:

```ts
const gotoModal = document.getElementById("goto-modal") as HTMLElement;
const gotoInput = document.getElementById("goto-input") as HTMLInputElement;
const gotoGo = document.getElementById("goto-go") as HTMLButtonElement;
const gotoCancel = document.getElementById("goto-cancel") as HTMLButtonElement;
```

Functions near `toggleMode`:

```ts
function openGoto() {
	if (viewMode !== "editor" || !editor) return;
	gotoModal.hidden = false;
	gotoInput.value = "";
	setTimeout(() => gotoInput.focus(), 0);
}
function closeGoto() { gotoModal.hidden = true; }
function performGoto() {
	if (!editor) return closeGoto();
	const line = parseInt(gotoInput.value, 10);
	if (Number.isFinite(line) && line >= 1) {
		const pos = editor.view.state.doc.line(Math.min(line, editor.view.state.doc.lines)).from;
		editor.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
		editor.focus();
	}
	closeGoto();
}
gotoGo.addEventListener("click", performGoto);
gotoCancel.addEventListener("click", closeGoto);
gotoInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") performGoto();
	if (e.key === "Escape") closeGoto();
});
```

`handleMenuAction`:

```ts
case "goto-line": openGoto(); break;
```

Keyboard handler:

```ts
	else if (k === "g") { e.preventDefault(); openGoto(); }
```

- [ ] **Step 4: Manually verify**

Run: `bun run dev`. Editor mode. `⌘G` → modal. Type `5`, Enter. Cursor jumps to line 5.

- [ ] **Step 5: Commit**

```bash
git add src/mainview/index.html src/mainview/index.css src/mainview/index.ts
git commit -m "feat(editor): Goto Line modal (⌘G)"
```

---

### Task 13: Word-wrap toggle + delegate Find to CM6 search

**Files:**
- Modify: `src/mainview/index.ts`
- Modify: `src/mainview/find-in-doc.ts`

- [ ] **Step 1: Word wrap state**

In `src/mainview/index.ts`, near `viewMode`:

```ts
let wordWrap = false;

function toggleWrap() {
	wordWrap = !wordWrap;
	if (editor) editor.setWordWrap(wordWrap);
}
```

`handleMenuAction`:

```ts
case "toggle-wrap": toggleWrap(); break;
```

Keyboard handler — add **before** the `if (!cmd) return;` line (since Alt is not cmd/ctrl):

```ts
	if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === "z") {
		e.preventDefault(); toggleWrap(); return;
	}
```

- [ ] **Step 2: Delegate Find to CM6 in editor mode**

Read the current `src/mainview/find-in-doc.ts` first, then add at the top:

```ts
import { openSearchPanel, closeSearchPanel, setSearchQuery, SearchQuery } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";

let editorViewRef: EditorView | null = null;
export function setEditorView(v: EditorView | null) { editorViewRef = v; }
```

In `open()`, at the very top:

```ts
function open() {
	if (editorViewRef) { openSearchPanel(editorViewRef); return; }
	// ... existing DOM-find body unchanged ...
}
```

In `setQuery(q)`, top:

```ts
function setQuery(q: string) {
	if (editorViewRef) {
		editorViewRef.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: q })) });
		return;
	}
	// ... existing body ...
}
```

In `close()`, top:

```ts
function close() {
	if (editorViewRef) { closeSearchPanel(editorViewRef); return; }
	// ... existing body ...
}
```

- [ ] **Step 3: Manually verify**

Run: `bun run dev`. Preview mode + `⌘F` → existing find bar. Editor mode + `⌘F` → CM6 search panel. `Alt+Z` toggles wrap.

- [ ] **Step 4: Commit**

```bash
git add src/mainview/index.ts src/mainview/find-in-doc.ts
git commit -m "feat(editor): word wrap (Alt+Z) and ⌘F delegates to CM6 search in editor mode"
```

---

### Task 14: Phase 1 manual smoke checklist

**Files:**
- Create: `docs/superpowers/test-checklists/editor-smoke.md`

- [ ] **Step 1: Write the checklist**

Create `docs/superpowers/test-checklists/editor-smoke.md`:

```markdown
# Editor smoke checklist (Phase 1)

Run on dev build (`bun run dev`). Tick each item.

## Open & view
- [ ] Open a `.md` file — renders to preview (existing behavior preserved)
- [ ] `⌘E` / `Ctrl+E` switches to editor with line numbers + syntax colors
- [ ] `⌘E` again returns to preview (with any edits intact in source)
- [ ] Drag-drop `.txt`, `.json`, `.js`, `.py` files — open directly in editor with correct language
- [ ] Status bar shows correct mode chip, language, encoding, EOL
- [ ] File with no extension (e.g. a Dockerfile copy) opens in editor as plain text

## Edit
- [ ] Type into editor — title gains leading `●`
- [ ] `⌘D` selects next match (CM6 default — duplicate-line via add to selection multi-cursor)
- [ ] `Alt+↑` / `Alt+↓` moves the line up/down
- [ ] Multi-cursor: `Alt+Click` adds cursor
- [ ] Rectangular select: `Alt+Drag` works
- [ ] Bracket matching highlights pair when cursor is on one

## Find / Goto
- [ ] In preview: `⌘F` opens existing DOM find bar
- [ ] In editor: `⌘F` opens CM6 search panel; regex toggle works
- [ ] `⌘G` opens Goto Line modal; entering a number jumps to that line

## Save
- [ ] `⌘S` saves; status bar shows "Saved"; title loses `●`
- [ ] Edit + reload (`⌘R`) without save — banner offers Reload / Keep
- [ ] Saving while file is being watched — no flicker / no echo loop
- [ ] `⌘⇧S` opens Save As dialog → choose folder → file written, title updates

## Encoding round-trip
- [ ] Open a UTF-16 LE file (e.g. exported from Notepad). Status chip shows `UTF-16LE`.
- [ ] Save. File on disk still has UTF-16 LE BOM.
- [ ] Click encoding chip → "Save next time as UTF-8". Save. File is now UTF-8.

## Theme & word wrap
- [ ] `⌘⇧L` toggles light / dark; editor + preview both update
- [ ] `Alt+Z` toggles word wrap in editor

## Edge cases
- [ ] Open a binary file (e.g. `.png`) — shows "Binary file refused" error, no crash
- [ ] Open a file >10 MB — error in status bar; does not crash
- [ ] Saving to a path that no longer exists — error in status, dirty stays

## Existing flows still work
- [ ] Folder open + file tree navigation
- [ ] `⌘⇧F` folder search
- [ ] Recent files
- [ ] Mermaid lightbox
- [ ] Print / Export HTML
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/test-checklists/editor-smoke.md
git commit -m "docs(test): editor Phase 1 manual smoke checklist"
```

---

## Phase 2 — Multi-tab

### Task 15: `tabs.ts` state machine — pure-data unit

**Files:**
- Create: `src/mainview/tabs.ts`
- Create: `tests/tabs-state.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/tabs-state.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { TabStore, type Tab } from "../src/mainview/tabs";

const baseTab = (path: string | null, content: string): Omit<Tab, "id"> => ({
	path,
	name: path?.split(/[\\/]/).pop() || "untitled",
	content,
	savedContent: content,
	encoding: "utf-8",
	eol: "lf",
	bom: false,
	language: "plain",
	viewMode: "editor",
});

describe("TabStore — state transitions", () => {
	test("openDoc adds a tab and makes it active", () => {
		const s = new TabStore();
		const id = s.openDoc(baseTab("/a.txt", "hi"));
		expect(s.list().length).toBe(1);
		expect(s.activeId()).toBe(id);
	});

	test("openDoc on already-open path returns existing id (no dupe)", () => {
		const s = new TabStore();
		const id1 = s.openDoc(baseTab("/a.txt", "hi"));
		const id2 = s.openDoc(baseTab("/a.txt", "hi"));
		expect(id1).toBe(id2);
		expect(s.list().length).toBe(1);
	});

	test("untitled tabs are always distinct", () => {
		const s = new TabStore();
		const id1 = s.openDoc(baseTab(null, ""));
		const id2 = s.openDoc(baseTab(null, ""));
		expect(id1).not.toBe(id2);
		expect(s.list().length).toBe(2);
	});

	test("dirty is derived from content vs savedContent", () => {
		const s = new TabStore();
		const id = s.openDoc(baseTab("/a.txt", "hi"));
		expect(s.isDirty(id)).toBe(false);
		s.setContent(id, "hi!");
		expect(s.isDirty(id)).toBe(true);
		s.markSaved(id);
		expect(s.isDirty(id)).toBe(false);
	});

	test("close removes tab; activeId moves to neighbor", () => {
		const s = new TabStore();
		s.openDoc(baseTab("/a.txt", "a"));
		const b = s.openDoc(baseTab("/b.txt", "b"));
		const c = s.openDoc(baseTab("/c.txt", "c"));
		s.setActive(b);
		s.close(b);
		expect(s.list().length).toBe(2);
		expect(s.activeId()).toBe(c);
	});

	test("close last tab leaves activeId null", () => {
		const s = new TabStore();
		const a = s.openDoc(baseTab("/a.txt", "a"));
		s.close(a);
		expect(s.list().length).toBe(0);
		expect(s.activeId()).toBe(null);
	});

	test("setContent fires change listener with id", () => {
		const s = new TabStore();
		const id = s.openDoc(baseTab("/a.txt", "a"));
		let observed: string | null = null;
		s.onChange((tab) => { if (tab.id === id) observed = tab.content; });
		s.setContent(id, "z");
		expect(observed).toBe("z");
	});

	// F3 regression guard — openDoc unconditionally sets active to the new id,
	// so callers like the session-restore loop must re-assert their intended
	// active tab afterwards. This test pins that contract: setActive after a
	// chain of openDoc calls overrides the implicit last-active.
	test("setActive after multiple openDoc calls overrides last-active", () => {
		const s = new TabStore();
		const a = s.openDoc(baseTab("/a.txt", "a"));
		s.openDoc(baseTab("/b.txt", "b"));
		const c = s.openDoc(baseTab("/c.txt", "c"));
		expect(s.activeId()).toBe(c);
		s.setActive(a);
		expect(s.activeId()).toBe(a);
	});
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/tabs-state.test.ts`
Expected: 7 fail (module not found).

- [ ] **Step 3: Implement**

Create `src/mainview/tabs.ts`:

```ts
import type { Encoding, EOL } from "../shared/rpc";

export type Tab = {
	id: string;
	path: string | null;
	name: string;
	content: string;
	savedContent: string;
	encoding: Encoding;
	eol: EOL;
	bom: boolean;
	language: string;
	viewMode: "preview" | "editor";
};

type ChangeListener = (tab: Tab) => void;

function uuid(): string {
	return "t-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
}

export class TabStore {
	private tabs: Tab[] = [];
	private active: string | null = null;
	private listeners = new Set<ChangeListener>();

	list(): Tab[] { return [...this.tabs]; }
	activeId(): string | null { return this.active; }
	get(id: string): Tab | undefined { return this.tabs.find((t) => t.id === id); }

	openDoc(input: Omit<Tab, "id">): string {
		if (input.path) {
			const existing = this.tabs.find((t) => t.path === input.path);
			if (existing) {
				this.active = existing.id;
				return existing.id;
			}
		}
		const id = uuid();
		const tab: Tab = { ...input, id };
		this.tabs.push(tab);
		this.active = id;
		this.emit(tab);
		return id;
	}

	setActive(id: string) {
		if (this.tabs.some((t) => t.id === id)) this.active = id;
	}

	close(id: string): void {
		const idx = this.tabs.findIndex((t) => t.id === id);
		if (idx < 0) return;
		this.tabs.splice(idx, 1);
		if (this.active === id) {
			this.active = this.tabs[idx]?.id || this.tabs[idx - 1]?.id || null;
		}
	}

	setContent(id: string, content: string): void {
		const tab = this.get(id);
		if (!tab) return;
		tab.content = content;
		this.emit(tab);
	}

	markSaved(id: string, newPath?: string): void {
		const tab = this.get(id);
		if (!tab) return;
		tab.savedContent = tab.content;
		if (newPath) {
			tab.path = newPath;
			tab.name = newPath.split(/[\\/]/).pop() || tab.name;
		}
		this.emit(tab);
	}

	isDirty(id: string): boolean {
		const tab = this.get(id);
		if (!tab) return false;
		return tab.content !== tab.savedContent;
	}

	onChange(fn: ChangeListener): () => void {
		this.listeners.add(fn);
		return () => { this.listeners.delete(fn); };
	}

	private emit(tab: Tab) {
		for (const l of this.listeners) l(tab);
	}
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test`
Expected: 22 pass total (14 text-io + 8 tabs — tabs includes 1 F3 setActive-after-openDoc regression guard).

- [ ] **Step 5: Commit**

```bash
git add src/mainview/tabs.ts tests/tabs-state.test.ts
git commit -m "feat(tabs): TabStore state machine with derived dirty flag"
```

---

### Task 16: Tab strip UI + active-tab routing replaces single-doc model

**Files:**
- Modify: `src/mainview/index.html`
- Modify: `src/mainview/index.css`
- Modify: `src/mainview/index.ts`

This is the largest single task. The current `lastPayload`/`savedContent`/`docMeta`/`viewMode`/`editor` global state becomes per-tab. We replace those globals with helpers that read the active tab.

- [ ] **Step 1: Add tab strip markup**

In `src/mainview/index.html`, wrap the existing `<main class="content">` and a new tab strip inside a `.content-wrap`. Replace the section starting at `<div class="resize-handle">` and ending at `</main>` with:

```html
		<div class="resize-handle" id="resize-handle" aria-hidden="true"></div>

		<div class="content-wrap">
			<div id="tab-strip" class="tab-strip">
				<div id="tab-list" class="tab-list"></div>
				<button id="tab-new" class="btn btn-icon btn-small" title="New tab (⌘T)">+</button>
			</div>
			<main class="content" id="content-pane">
				<!-- KEEP existing dropzone, find-bar, banner, content article, editor-host inside here -->
				<div id="dropzone" class="dropzone" aria-hidden="true">
					<div class="dropzone-msg">Drop a file to open</div>
				</div>
				<div id="find-bar" class="find-bar" hidden>
					<input id="find-input" class="find-input" placeholder="Find in document…" />
					<span id="find-count" class="find-count"></span>
					<button id="find-prev" class="btn btn-icon btn-small" title="Previous (⇧↩)">↑</button>
					<button id="find-next" class="btn btn-icon btn-small" title="Next (↩)">↓</button>
					<button id="find-close" class="btn btn-icon btn-small" title="Close (Esc)">✕</button>
				</div>
				<div id="external-change-banner" class="banner" hidden>
					<span>File changed on disk.</span>
					<button id="banner-reload" class="btn btn-small">Reload</button>
					<button id="banner-keep" class="btn btn-small btn-ghost">Keep my changes</button>
				</div>
				<article id="content" class="markdown-body welcome">
					<!-- existing welcome card unchanged -->
				</article>
				<div id="editor-host" class="editor-host" hidden></div>
			</main>
		</div>
```

Also add the discard modal next to the goto modal, before `<script>`:

```html
	<div id="discard-modal" class="modal" hidden>
		<div class="modal-card">
			<div id="discard-msg" class="modal-msg">Save changes?</div>
			<div class="modal-actions">
				<button id="discard-cancel" class="btn btn-ghost btn-small">Cancel</button>
				<button id="discard-discard" class="btn btn-small">Discard</button>
				<button id="discard-save" class="btn btn-primary btn-small">Save</button>
			</div>
		</div>
	</div>
```

- [ ] **Step 2: Add CSS**

Append to `src/mainview/index.css`:

```css
.content-wrap {
	display: flex;
	flex-direction: column;
	flex: 1;
	min-width: 0;
	position: relative;
}
.tab-strip {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 4px 4px 0 4px;
	background: var(--bg-soft, #f6f8fa);
	border-bottom: 1px solid var(--border);
	overflow-x: auto;
	scrollbar-width: thin;
}
[data-theme="dark"] .tab-strip { background: #161b22; }
.tab-list { display: flex; gap: 2px; flex: 1; min-width: 0; }
.tab {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 4px 8px 6px 10px;
	border-radius: 6px 6px 0 0;
	background: transparent;
	color: var(--text-faint);
	font-size: 12px;
	cursor: pointer;
	white-space: nowrap;
	max-width: 200px;
	overflow: hidden;
	text-overflow: ellipsis;
	border: 1px solid transparent;
	border-bottom: none;
}
.tab.active {
	background: var(--bg);
	color: var(--text);
	border-color: var(--border);
}
.tab .tab-name { overflow: hidden; text-overflow: ellipsis; }
.tab .tab-dirty { color: var(--accent, #1f6feb); margin-right: 2px; }
.tab .tab-close {
	background: transparent; border: 0; color: var(--text-faint);
	cursor: pointer; padding: 0 2px; font-size: 13px; line-height: 1;
}
.tab .tab-close:hover { color: var(--text); }
```

- [ ] **Step 3: Replace single-doc state with TabStore**

This is the biggest single edit. In `src/mainview/index.ts`:

(a) Imports — add:

```ts
import { TabStore, type Tab } from "./tabs";
```

(b) Replace the existing globals (`lastPayload`, `savedContent`, `docMeta`, `viewMode`, `editor`, `wordWrap`) with:

```ts
const tabs = new TabStore();
const editorByTab = new Map<string, EditorHandle>();
let wordWrap = false;

function activeTab(): Tab | null {
	const id = tabs.activeId();
	return id ? tabs.get(id) || null : null;
}
```

DOM refs:

```ts
const tabListEl = document.getElementById("tab-list") as HTMLElement;
const tabNewBtn = document.getElementById("tab-new") as HTMLButtonElement;
const discardModal = document.getElementById("discard-modal") as HTMLElement;
const discardMsg = document.getElementById("discard-msg") as HTMLElement;
const discardSave = document.getElementById("discard-save") as HTMLButtonElement;
const discardDiscard = document.getElementById("discard-discard") as HTMLButtonElement;
const discardCancel = document.getElementById("discard-cancel") as HTMLButtonElement;
```

(c) Replace `renderFile` with a new entry point that opens-or-activates a tab. Keep `renderPreview` (the old `renderFile` body) as-is, but make it accept a `Tab` instead of a `FilePayload`:

```ts
async function openOrActivate(payload: FilePayload): Promise<string | null> {
	if (payload.error) {
		// inline error
		contentEl.classList.remove("welcome");
		contentEl.textContent = "";
		const h = document.createElement("h1"); h.textContent = "Cannot open file"; contentEl.appendChild(h);
		const p1 = document.createElement("p"); p1.textContent = payload.error; contentEl.appendChild(p1);
		const p2 = document.createElement("p"); const code = document.createElement("code"); code.textContent = payload.path; p2.appendChild(code); contentEl.appendChild(p2);
		statusPath.textContent = payload.path;
		return null;
	}
	const language = inferLanguage(payload.path);
	const id = tabs.openDoc({
		path: payload.path,
		name: payload.path.split(/[\\/]/).pop() || "untitled",
		content: payload.content,
		savedContent: payload.content,
		encoding: payload.encoding || "utf-8",
		eol: payload.eol || "lf",
		bom: payload.bom || false,
		language,
		viewMode: isMarkdownPath(payload.path) ? "preview" : "editor",
	});
	tabs.setActive(id);
	renderTabs();
	await renderActive();
	return id;
}

async function renderActive() {
	const t = activeTab();
	if (!t) return;
	statusPath.textContent = t.path || t.name;
	statusEncoding.textContent = t.encoding.toUpperCase();
	statusEol.textContent = t.eol.toUpperCase();
	statusLang.textContent = t.language;
	statusMode.textContent = t.viewMode === "preview" ? "PREVIEW" : "EDITOR";
	if (t.viewMode === "preview") {
		editorHost.hidden = true;
		contentEl.hidden = false;
		await renderPreview({ path: t.path || t.name, content: t.content, encoding: t.encoding, eol: t.eol, bom: t.bom });
	} else {
		contentEl.hidden = true;
		editorHost.hidden = false;
		await mountEditorForTab(t);
	}
	updateDirtyIndicator();
}

async function mountEditorForTab(t: Tab) {
	// Hide all editor instances, show only this tab's
	for (const [tid, eh] of editorByTab) {
		eh.view.dom.style.display = tid === t.id ? "" : "none";
	}
	let ed = editorByTab.get(t.id);
	if (!ed) {
		// Each tab gets its own host child element so CM6 instances don't fight
		const host = document.createElement("div");
		host.style.cssText = "position:absolute;inset:0;";
		editorHost.appendChild(host);
		ed = createEditor(host, {
			content: t.content,
			language: t.language as LanguageId,
			useTabs: true, tabSize: 4, wordWrap,
		});
		ed.onChange((newContent) => tabs.setContent(t.id, newContent));
		editorByTab.set(t.id, ed);
	} else {
		// Sync content if it diverged (e.g. external reload)
		if (ed.getDoc() !== t.content) {
			ed.setDoc(t.content, { language: t.language as LanguageId, wordWrap });
		}
	}
	setEditorView(ed.view);
	ed.focus();
}
```

(d) Replace any remaining direct references to `lastPayload` / `savedContent` / `docMeta` / `viewMode` with reads off `activeTab()`:

```ts
function liveContent(): string | null {
	const t = activeTab();
	if (!t) return null;
	const ed = editorByTab.get(t.id);
	return ed ? ed.getDoc() : t.content;
}

function isDirty(): boolean {
	const t = activeTab();
	if (!t) return false;
	return liveContent() !== t.savedContent;
}

function updateDirtyIndicator() {
	const t = activeTab();
	const dirty = isDirty();
	const baseTitle = t?.name || "Markdown Viewer";
	document.title = (dirty ? "● " : "") + baseTitle;
	renderTabs();  // tab dirty dots
}
```

(e) Rewrite `save`/`saveAs` against the active tab:

```ts
async function save(): Promise<boolean> {
	const t = activeTab();
	if (!t) return false;
	const content = liveContent() || "";
	if (!t.path) return saveAs();
	let allowLossy = false;
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await electroview.rpc!.request.writeFile({
			path: t.path, content,
			encoding: t.encoding, eol: t.eol, bom: t.bom,
			allowLossy,
		});
		if (r.ok) {
			tabs.setContent(t.id, content);
			tabs.markSaved(t.id);
			updateDirtyIndicator();
			statusStats.textContent = r.lossyChars ? `Saved (${r.lossyChars} char${r.lossyChars === 1 ? "" : "s"} lost)` : "Saved";
			setTimeout(() => { statusStats.textContent = `${content.length.toLocaleString()} chars`; }, 1500);
			return true;
		}
		// F2: refused for lossy reasons → confirm and retry once
		if ("lossy" in r && r.lossy) {
			const proceed = await confirmLossy(r.lossy);
			if (!proceed) {
				statusStats.textContent = "Save cancelled (would have lost characters)";
				return false;
			}
			allowLossy = true;
			continue;
		}
		statusStats.textContent = `Save failed: ${(r as any).error || "?"}`;
		return false;
	}
	return false;
}

async function saveAs(): Promise<boolean> {
	const t = activeTab();
	if (!t) return false;
	const body = liveContent() || "";
	let allowLossy = false;
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await electroview.rpc!.request.saveAsDialog({
			defaultName: t.name,
			content: body,
			encoding: t.encoding, eol: t.eol, bom: t.bom,
			allowLossy,
		});
		if (r.ok) {
			tabs.setContent(t.id, body);
			tabs.markSaved(t.id, r.path);
			updateDirtyIndicator();
			return true;
		}
		if ("lossy" in r && r.lossy) {
			const proceed = await confirmLossy(r.lossy);
			if (!proceed) return false;
			allowLossy = true;
			continue;
		}
		return false;
	}
	return false;
}
```

(f) Rewrite `toggleMode` to mutate the tab:

```ts
function toggleMode() {
	const t = activeTab();
	if (!t) return;
	if (t.path && !isMarkdownPath(t.path)) {
		t.viewMode = "editor";
	} else {
		t.viewMode = t.viewMode === "preview" ? "editor" : "preview";
	}
	renderActive();
}
```

(g) Rewrite `onExternalChange`:

```ts
function onExternalChange(data: FilePayload) {
	const t = tabs.list().find((tt) => tt.path === data.path);
	if (!t) return;
	const live = editorByTab.get(t.id)?.getDoc() ?? t.content;
	const dirty = live !== t.savedContent;
	if (!dirty) {
		// silent reload
		t.content = data.content;
		t.savedContent = data.content;
		const ed = editorByTab.get(t.id);
		if (ed) ed.setDoc(data.content);
		else if (t.id === tabs.activeId()) renderActive();
		return;
	}
	pendingExternal = data;
	externalBanner.hidden = false;
}
```

`bannerReload` handler:

```ts
bannerReload.addEventListener("click", () => {
	if (pendingExternal) {
		const data = pendingExternal;
		const t = tabs.list().find((tt) => tt.path === data.path);
		if (t) {
			t.content = data.content;
			t.savedContent = data.content;
			const ed = editorByTab.get(t.id);
			if (ed) ed.setDoc(data.content);
		}
	}
	pendingExternal = null;
	externalBanner.hidden = true;
	updateDirtyIndicator();
});
```

- [ ] **Step 4: Render the tab strip (safe DOM, no innerHTML)**

```ts
function renderTabs() {
	tabListEl.textContent = "";
	for (const t of tabs.list()) {
		const tabEl = document.createElement("div");
		tabEl.className = "tab" + (t.id === tabs.activeId() ? " active" : "");
		tabEl.title = t.path || "untitled";
		tabEl.addEventListener("click", () => { tabs.setActive(t.id); renderTabs(); renderActive(); });

		if (tabs.isDirty(t.id)) {
			const dot = document.createElement("span");
			dot.className = "tab-dirty";
			dot.textContent = "●";
			tabEl.appendChild(dot);
		}
		const nameEl = document.createElement("span");
		nameEl.className = "tab-name";
		nameEl.textContent = t.name;
		tabEl.appendChild(nameEl);

		const closeBtn = document.createElement("button");
		closeBtn.className = "tab-close";
		closeBtn.textContent = "✕";
		closeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			closeTab(t.id);
		});
		tabEl.appendChild(closeBtn);

		tabListEl.appendChild(tabEl);
	}
}

async function closeTab(id: string) {
	if (tabs.isDirty(id)) {
		const choice = await confirmDiscard(tabs.get(id)!.name);
		if (choice === "cancel") return;
		if (choice === "save") {
			tabs.setActive(id);
			const ok = await save();
			if (!ok) return;
		}
	}
	const ed = editorByTab.get(id);
	if (ed) { ed.destroy(); editorByTab.delete(id); }
	tabs.close(id);
	renderTabs();
	if (tabs.activeId()) renderActive();
	else {
		contentEl.classList.add("welcome");
		editorHost.hidden = true;
		contentEl.hidden = false;
	}
}

function newUntitled() {
	const id = tabs.openDoc({
		path: null, name: "untitled.txt",
		content: "", savedContent: "",
		encoding: "utf-8", eol: "lf", bom: false,
		language: "plain", viewMode: "editor",
	});
	tabs.setActive(id);
	renderTabs();
	renderActive();
}

tabNewBtn.addEventListener("click", newUntitled);
tabs.onChange(() => { renderTabs(); updateDirtyIndicator(); });
```

- [ ] **Step 5: Discard-confirm modal**

```ts
function confirmDiscard(name: string): Promise<"save" | "discard" | "cancel"> {
	return new Promise((resolve) => {
		discardMsg.textContent = `Save changes to ${name}?`;
		discardModal.hidden = false;
		const cleanup = () => {
			discardModal.hidden = true;
			discardSave.removeEventListener("click", onSave);
			discardDiscard.removeEventListener("click", onDiscard);
			discardCancel.removeEventListener("click", onCancel);
		};
		const onSave = () => { cleanup(); resolve("save"); };
		const onDiscard = () => { cleanup(); resolve("discard"); };
		const onCancel = () => { cleanup(); resolve("cancel"); };
		discardSave.addEventListener("click", onSave);
		discardDiscard.addEventListener("click", onDiscard);
		discardCancel.addEventListener("click", onCancel);
	});
}
```

- [ ] **Step 6: Tab keyboard shortcuts**

In the keyboard handler:

```ts
	else if (k === "t") { e.preventDefault(); newUntitled(); }
	else if (k === "w") { e.preventDefault(); const id = tabs.activeId(); if (id) closeTab(id); }
	else if (e.key === "Tab" && cmd) {
		e.preventDefault();
		const list = tabs.list();
		if (list.length === 0) return;
		const cur = list.findIndex((t) => t.id === tabs.activeId());
		const next = (cur + (e.shiftKey ? -1 : 1) + list.length) % list.length;
		tabs.setActive(list[next].id);
		renderTabs();
		renderActive();
	}
```

- [ ] **Step 7: Update entry points to use `openOrActivate`**

Replace the existing `renderFile(...)` calls in:
- `pickFile` → `openOrActivate(result)`
- the file-tree click handler in `renderTreeNode` → `openOrActivate(result)`
- the recent-list item click handler → `openOrActivate(r)`
- the search-result click handlers → `openOrActivate(r)`
- the drag-drop handler → `openOrActivate(payload)`
- the boot block → `openOrActivate(initial)`
- the RPC `fileOpened` message → `openOrActivate(data)`

(Keep `renderPreview` private — only `renderActive` calls it.)

- [ ] **Step 8: Update `toggleWrap` to write to all editors**

```ts
function toggleWrap() {
	wordWrap = !wordWrap;
	for (const ed of editorByTab.values()) ed.setWordWrap(wordWrap);
}
```

- [ ] **Step 9: Type-check**

Run: `bunx tsc --noEmit`
Expected: 0 errors. (If you missed a stale `lastPayload`/`savedContent`/`docMeta`/`viewMode` reference, the compiler flags it; replace each per the patterns above.)

- [ ] **Step 10: Manually verify**

Run: `bun run dev`. Tests:
1. Open 3 different files (`.md`, `.txt`, `.json`) — 3 tabs appear, last one active.
2. Click each tab — view switches, mode chip updates.
3. Edit one — `●` on its tab and in title.
4. `✕` on dirty tab → modal Save / Discard / Cancel — each path works.
5. `⌘T` → new untitled tab in editor.
6. `⌘W` closes active tab.
7. `⌘Tab` cycles forward, `⌘⇧Tab` back.
8. Open the same path twice — focus moves to existing tab, no dupe.

- [ ] **Step 11: Commit**

```bash
git add src/mainview/index.html src/mainview/index.css src/mainview/index.ts
git commit -m "feat(tabs): tab strip + per-tab editor + discard-confirm + ⌘T/⌘W/⌘Tab"
```

---

## Phase 3 — Session restore & polish

### Task 17: `session-store.ts` (Bun) with tests

**Files:**
- Create: `src/bun/session-store.ts`
- Create: `tests/session-store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/session-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSessionStore } from "../src/bun/session-store";

describe("SessionStore", () => {
	test("save+load round-trips", () => {
		const dir = mkdtempSync(join(tmpdir(), "mdv-sess-"));
		const store = createSessionStore(dir);
		store.save({
			tabs: [{ id: "t1", path: "/a.txt", name: "a.txt", encoding: "utf-8", eol: "lf", bom: false, language: "plain", viewMode: "editor" }],
			activeTabId: "t1",
		});
		const loaded = store.load();
		expect(loaded.tabs.length).toBe(1);
		expect(loaded.activeTabId).toBe("t1");
		expect(loaded.tabs[0].path).toBe("/a.txt");
		rmSync(dir, { recursive: true, force: true });
	});

	test("load returns empty state when file missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "mdv-sess-"));
		const store = createSessionStore(dir);
		const loaded = store.load();
		expect(loaded.tabs).toEqual([]);
		expect(loaded.activeTabId).toBe(null);
		rmSync(dir, { recursive: true, force: true });
	});

	test("untitled content is capped at 1 MB", () => {
		const dir = mkdtempSync(join(tmpdir(), "mdv-sess-"));
		const store = createSessionStore(dir);
		const big = "x".repeat(2 * 1024 * 1024);
		store.save({
			tabs: [{ id: "u1", path: null, name: "untitled.txt", encoding: "utf-8", eol: "lf", bom: false, language: "plain", viewMode: "editor", untitledContent: big }],
			activeTabId: "u1",
		});
		const loaded = store.load();
		const tab = loaded.tabs[0];
		if (tab) {
			expect(tab.untitledContent?.length ?? 0).toBeLessThanOrEqual(1024 * 1024);
		}
		rmSync(dir, { recursive: true, force: true });
	});
});
```

- [ ] **Step 2: Run — expect failure**

Run: `bun test tests/session-store.test.ts`
Expected: 3 fail.

- [ ] **Step 3: Implement**

Create `src/bun/session-store.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { SessionState } from "../shared/rpc";

const FILE_NAME = "session.json";
const UNTITLED_CAP = 1024 * 1024; // 1 MB

export function createSessionStore(dir: string) {
	try { mkdirSync(dir, { recursive: true }); } catch {}
	const path = join(dir, FILE_NAME);

	function load(): SessionState {
		if (!existsSync(path)) return { tabs: [], activeTabId: null };
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(raw);
			if (!parsed || !Array.isArray(parsed.tabs)) return { tabs: [], activeTabId: null };
			return parsed as SessionState;
		} catch {
			return { tabs: [], activeTabId: null };
		}
	}

	function save(state: SessionState) {
		const tabs = state.tabs.map((t) => {
			if (t.path === null && t.untitledContent && t.untitledContent.length > UNTITLED_CAP) {
				return { ...t, untitledContent: t.untitledContent.slice(0, UNTITLED_CAP) };
			}
			return t;
		});
		try {
			writeFileSync(path, JSON.stringify({ tabs, activeTabId: state.activeTabId }, null, 2), "utf8");
		} catch {}
	}

	return { load, save };
}
```

- [ ] **Step 4: Run — expect pass**

Run: `bun test`
Expected: 25 pass total (14 text-io + 8 tabs + 3 session-store).

- [ ] **Step 5: Commit**

```bash
git add src/bun/session-store.ts tests/session-store.test.ts
git commit -m "feat(session): persistence store with 1MB untitled-content cap"
```

---

### Task 18: Wire `loadSession`/`saveSession` RPC + boot-time restore

**Files:**
- Modify: `src/bun/index.ts`
- Modify: `src/mainview/index.ts`
- Create: `src/mainview/session.ts`

- [ ] **Step 1: Wire Bun handlers**

In `src/bun/index.ts`, top imports:

```ts
import { createSessionStore } from "./session-store";
```

In the boot block, after the recent-files setup:

```ts
const sessionStore = createSessionStore((Utils as any).paths?.userData || join(PLATFORM_HOME, `.${APP_NAME}`));
```

In the `requests` block:

```ts
loadSession: async () => sessionStore.load(),
saveSession: async ({ state }) => { sessionStore.save(state); return { ok: true }; },
```

- [ ] **Step 2: Renderer-side wrapper**

Create `src/mainview/session.ts`:

```ts
import type { Electroview } from "electrobun/view";
import type { AppRPC, SessionState, SessionTab } from "../shared/rpc";
import type { TabStore } from "./tabs";

export function createSession(electroview: Electroview<AppRPC>) {
	async function load(): Promise<SessionState> {
		return electroview.rpc!.request.loadSession({});
	}
	async function save(state: SessionState): Promise<void> {
		await electroview.rpc!.request.saveSession({ state });
	}
	function snapshot(tabs: TabStore): SessionState {
		const list = tabs.list();
		return {
			activeTabId: tabs.activeId(),
			tabs: list.map<SessionTab>((t) => ({
				id: t.id,
				path: t.path,
				name: t.name,
				encoding: t.encoding,
				eol: t.eol,
				bom: t.bom,
				language: t.language,
				viewMode: t.viewMode,
				untitledContent: t.path === null ? t.content : undefined,
			})),
		};
	}
	return { load, save, snapshot };
}
```

- [ ] **Step 3: Restore on boot**

In `src/mainview/index.ts`, top imports:

```ts
import { createSession } from "./session";
```

Replace the existing boot IIFE at the bottom:

```ts
(async () => {
	electroview.rpc!.send.ready({});
	await refreshRecent();
	const session = createSession(electroview as any);
	const sessionState = await session.load();

	// Honor double-click open first; capture the resulting tab id so we can
	// re-assert it as active AFTER the session-restore loop (F3 fix — the
	// loop's openDoc calls would otherwise override the active tab to the
	// last-restored session entry).
	const initial = await electroview.rpc!.request.getInitialFile({});
	let initialTabId: string | null = null;
	if (initial && !initial.error) {
		initialTabId = await openOrActivate(initial);
	}

	// Restore tabs that still resolve on disk; untitled tabs always restore.
	// Skip the path the user double-clicked (already opened above) so we
	// don't dedup-collide with it.
	for (const t of sessionState.tabs) {
		if (initial && t.path && t.path === initial.path) continue;
		if (t.path === null && t.untitledContent !== undefined) {
			tabs.openDoc({
				path: null, name: t.name,
				content: t.untitledContent, savedContent: t.untitledContent,
				encoding: t.encoding, eol: t.eol, bom: t.bom,
				language: t.language, viewMode: t.viewMode,
			});
			continue;
		}
		if (t.path) {
			const r = await electroview.rpc!.request.readFile({ path: t.path });
			if (!r.error) {
				tabs.openDoc({
					path: r.path, name: t.name,
					content: r.content, savedContent: r.content,
					encoding: r.encoding || t.encoding,
					eol: r.eol || t.eol,
					bom: r.bom ?? t.bom,
					language: t.language,
					viewMode: t.viewMode,
				});
			}
		}
	}

	// F3 fix: re-assert active tab AFTER the restore loop, so openDoc's
	// implicit "set active to new tab" doesn't override the user's intent.
	if (initialTabId) {
		// Double-click takes priority over previously-active session tab
		tabs.setActive(initialTabId);
	} else if (sessionState.activeTabId) {
		const list = tabs.list();
		const sess = sessionState.tabs.find((s) => s.id === sessionState.activeTabId);
		const match = sess ? list.find((tt) => tt.path === sess.path) : null;
		if (match) tabs.setActive(match.id);
	}
	renderTabs();
	if (tabs.activeId()) await renderActive();

	// Persist on every change (debounced)
	let saveDebounce: ReturnType<typeof setTimeout> | null = null;
	tabs.onChange(() => {
		if (saveDebounce) clearTimeout(saveDebounce);
		saveDebounce = setTimeout(() => session.save(session.snapshot(tabs)), 300);
	});
	window.addEventListener("beforeunload", () => session.save(session.snapshot(tabs)));
})();
```

- [ ] **Step 4: Manually verify**

Run: `bun run dev`. Open 3 files, edit one (don't save). Quit. Relaunch. Three tabs reappear; the previously-edited one is back to its on-disk content (saved tabs only restore from disk). Untitled tab content restores from in-memory blob.

- [ ] **Step 5: Commit**

```bash
git add src/bun/index.ts src/mainview/index.ts src/mainview/session.ts
git commit -m "feat(session): persist+restore open tabs across launches"
```

---

### Task 19: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append three bullets to "App features"**

In `README.md`, find the `### App features` block (~line 54). Append:

```markdown
- ✏️ **Inline editor (⌘E)** — toggle preview ↔ Notepad++-class editor
- 📑 **Tabs** — open multiple files, ⌘T new, ⌘W close, ⌘Tab cycle
- 💾 **Encoding-aware save** — UTF-8 / UTF-16 LE/BE / Latin-1, LF/CRLF preserved
```

- [ ] **Step 2: Update Roadmap**

Replace the existing roadmap items:

```markdown
- [x] Tabs (multiple files per window) — shipped
- [x] Inline editor with multi-format support — shipped
- [ ] Per-document custom CSS injection
- [ ] Spell check
- [ ] Linux build (Electrobun supports it; needs a `.desktop` file + xdg-mime registration)
- [ ] Code-signed/notarized macOS build
- [ ] Auto-updater channel
- [ ] PDF export with internal anchor links preserved (currently flattens)
```

- [ ] **Step 3: Add editor rows to Keyboard shortcuts table**

Find the `## Keyboard shortcuts` table. Replace the "Toggle theme" row's accelerators (was `⌘D` / `Ctrl+D`) and append new editor rows:

```html
<tr><td>Toggle Editor / Preview</td><td><kbd>⌘</kbd> <kbd>E</kbd></td><td><kbd>Ctrl</kbd> <kbd>E</kbd></td></tr>
<tr><td>Save</td><td><kbd>⌘</kbd> <kbd>S</kbd></td><td><kbd>Ctrl</kbd> <kbd>S</kbd></td></tr>
<tr><td>Save As…</td><td><kbd>⌘</kbd> <kbd>⇧</kbd> <kbd>S</kbd></td><td><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>S</kbd></td></tr>
<tr><td>New tab</td><td><kbd>⌘</kbd> <kbd>T</kbd></td><td><kbd>Ctrl</kbd> <kbd>T</kbd></td></tr>
<tr><td>Close tab</td><td><kbd>⌘</kbd> <kbd>W</kbd></td><td><kbd>Ctrl</kbd> <kbd>W</kbd></td></tr>
<tr><td>Cycle tabs</td><td><kbd>⌘</kbd> <kbd>⇥</kbd></td><td><kbd>Ctrl</kbd> <kbd>Tab</kbd></td></tr>
<tr><td>Goto line</td><td><kbd>⌘</kbd> <kbd>G</kbd></td><td><kbd>Ctrl</kbd> <kbd>G</kbd></td></tr>
<tr><td>Toggle word wrap</td><td><kbd>⌥</kbd> <kbd>Z</kbd></td><td><kbd>Alt</kbd> <kbd>Z</kbd></td></tr>
```

Update the existing "Toggle theme" row to use `⌘⇧L` / `Ctrl+Shift+L`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): document editor + tabs + new keyboard shortcuts"
```

---

### Task 19a: Bundle-size guard (F5)

**Files:**
- Create: `tests/bundle-size.test.ts`
- Modify: `package.json` (add `test:bundle` script)

**Why:** Spec §11.1 risk says "CM6 bundle bloat from language packs — Lazy-load per language; **measure final bundle in CI**." The plan implements lazy-loading correctly but until now had only a manual smoke checkbox. This task adds a hard test that fails if the bundled renderer exceeds a calibrated ceiling, so a future contributor adding `@codemirror/lang-cpp` to the eager bundle (instead of legacy-modes lazy-load) gets caught at PR time.

- [ ] **Step 1: Establish a baseline**

Run a release build:

```bash
bun run build:release
```

Then measure the renderer bundle size. The artifact path varies by platform — pick the right one:

```bash
# macOS arm64
ls -la "build/stable-macos-arm64/Markdown Viewer.app/Contents/Resources/app/views/mainview/index.js"

# macOS x64
ls -la "build/stable-macos-x64/Markdown Viewer.app/Contents/Resources/app/views/mainview/index.js"

# Windows x64
ls -la "build/stable-windows-x64/views/mainview/index.js"
```

Expected: a number in bytes. Record it as **`POST_FEATURE_BUNDLE_SIZE`**. The ceiling is `POST_FEATURE_BUNDLE_SIZE × 1.15` (15% slack for normal evolution). If the post-feature size is e.g. 1.05 MB, the ceiling is ~1.21 MB.

If you have access to the pre-feature baseline (the size before this plan started), confirm the delta is < 5 MB total — that's the spec §11.1 budget.

- [ ] **Step 2: Add the test runner**

Create `tests/bundle-size.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "fs";
import { join } from "path";

// F5 — bundle-size guard. Set the ceiling to your measured POST_FEATURE_BUNDLE_SIZE × 1.15
// (in bytes). Update CEILING when you intentionally take a budget hit.
const CEILING = 1_500_000; // 1.5 MB — tune to your measurement

// All known build target paths. The test passes if at least one exists and is under
// the ceiling — covers macOS arm64/x64, Windows x64, and dev builds.
const candidates = [
	"build/stable-macos-arm64/Markdown Viewer.app/Contents/Resources/app/views/mainview/index.js",
	"build/stable-macos-x64/Markdown Viewer.app/Contents/Resources/app/views/mainview/index.js",
	"build/stable-windows-x64/views/mainview/index.js",
	"build/dev-macos-arm64/Markdown Viewer-dev.app/Contents/Resources/app/views/mainview/index.js",
	"build/dev-macos-x64/Markdown Viewer-dev.app/Contents/Resources/app/views/mainview/index.js",
	"build/dev-windows-x64/views/mainview/index.js",
];

describe("bundle size (F5)", () => {
	test("renderer bundle is under ceiling", () => {
		const found = candidates
			.map((rel) => join(process.cwd(), rel))
			.filter((p) => existsSync(p))
			.map((p) => ({ path: p, size: statSync(p).size }));

		if (found.length === 0) {
			// No build artifacts on disk yet. Skip with a clear message — running
			// `bun run build:release` first is required for this test to be useful.
			console.warn("[bundle-size] no build artifact found; run `bun run build:release` first. Skipping.");
			return;
		}

		for (const { path, size } of found) {
			expect(size, `${path} is ${size} bytes; ceiling is ${CEILING}`).toBeLessThan(CEILING);
		}
	});
});
```

- [ ] **Step 3: Add the CI script**

Edit `package.json` `scripts`:

```json
"test": "bun test",
"test:bundle": "bun run build:release && bun test tests/bundle-size.test.ts"
```

(`test:bundle` builds a release bundle then measures. Plain `bun test` includes the bundle test too — but if no build is on disk, it skips gracefully via the no-artifact branch.)

- [ ] **Step 4: Run it**

```bash
bun run test:bundle
```

Expected: 1 pass.

- [ ] **Step 5: Commit**

```bash
git add tests/bundle-size.test.ts package.json
git commit -m "feat(ci): bundle-size guard (F5) — assert renderer bundle under ceiling"
```

---

### Task 20: Final smoke pass

**Files:**
- Modify: `docs/superpowers/test-checklists/editor-smoke.md`

- [ ] **Step 1: Append Phase 2/3 cases**

```markdown

## Tabs (Phase 2)
- [ ] Open 3 files — 3 tabs appear; clicking each switches view
- [ ] Edit one tab — `●` on its tab and in window title
- [ ] Close `✕` on dirty tab → modal Save/Discard/Cancel — each path works
- [ ] `⌘T` opens untitled tab in editor
- [ ] `⌘W` closes active tab; focus moves to neighbor
- [ ] `⌘Tab` / `⌘⇧Tab` cycles forward/backward
- [ ] Opening the same path twice activates existing tab (no dupe)

## Session restore (Phase 3)
- [ ] Open 3 files, quit, relaunch — same 3 tabs reappear
- [ ] Untitled tab with content survives quit + relaunch
- [ ] Previously-open file deleted between launches — that tab silently drops
- [ ] Session restore happens AFTER a double-click open (the double-clicked file is foremost)

## Bundle size sanity
- [ ] `bun run build:release` completes; bundle size delta vs pre-feature baseline < +5 MB
```

- [ ] **Step 2: Walk the full checklist**

Run: `bun run dev`. Tick every box. File any failures as follow-up issues if non-trivial.

- [ ] **Step 3: Final test pass**

Run: `bun test`
Expected: 25 pass (14 text-io + 8 tabs + 3 session-store).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/test-checklists/editor-smoke.md
git commit -m "docs(test): extend smoke checklist with tabs + session-restore + bundle"
```

---

## Spec coverage check

| Spec section | Plan task(s) |
|---|---|
| §2 View modes | 8 |
| §3 Architecture | 1, 2, 3, 4, 5, 6, 15 |
| §3.1 New files | 2, 6, 15, 17, 18 |
| §3.2 Touched files | 4, 5, 7, 16 |
| §3.4 Components & boundaries | 6, 15, 17 |
| §3.5 Doc type | 15, 16 |
| §4 Supported file types (Tier 1/2/3) | 6 (lazy language loader) |
| §4 File associations on install | unchanged (no task — existing config left alone) |
| §5 Daily features | 6, 8, 9, 12, 13, 16 |
| §5.1 Ctrl+D rebind | 8 |
| §6 Out of scope | n/a (deliberately no tasks) |
| §7.1 Open file | 5, 16 |
| §7.2 Edit | 6 |
| §7.3 Save | 9, 16 |
| §7.4 External change | 10, 16 |
| §7.5 Close tab | 16 |
| §7.6 App quit / restore | 18 |
| §8 Error & edge cases | 5 (binary, large), 9 (errors, F2 lossy), 10 (external), 16 (dirty close, F2 lossy per-tab), 18 (deleted on relaunch) |
| §8 (updated) Lossy encoding save | 3 (writeText), 9 (single-doc save flow), 16 (per-tab save flow) — all gated by `confirmLossy` modal |
| §8 (updated) Duplicate-path tab | 15 (TabStore.openDoc dedup) |
| §9 Testing | 2, 3, 15, 17 (units), 14, 20 (manual), 19a (bundle-size) |
| §10 Migration | 19 |
| §11 Risks | 1 (bundle), 5 (echo), 2/3 (encoding round-trip), 19a (automated bundle guard for §11.1) |

No spec sections are unmapped.

---

## Plan self-review notes

- **Placeholder scan:** No "TBD", "TODO", "implement later", or unaccompanied test references.
- **Type consistency:** `Tab.viewMode` matches `Doc.viewMode` from spec; `Encoding`/`EOL` exported from `text-io.ts` and re-exported in `rpc.ts`. `WriteResult` and `LossyInfo` types added in Task 4 (F2) match the runtime returns from `writeText` (Task 3) and the RPC handlers (Task 5).
- **Function name consistency:** `readText`/`writeText` (text-io); `openDoc`/`close`/`setActive`/`isDirty`/`markSaved` (TabStore); `createEditor` (editor.ts); `createSessionStore`/`createSession` (session); `confirmLossy` (used in Task 9 single-doc save and Task 16 per-tab save). No drift between definition and consumer.
- **Compartment correctness:** `languageCompartment.reconfigure(lang ? [lang] : [])` accepts an array (CM6 idiom).
- **Watcher echo:** `recentSelfWrites` stamped *before* `writeText` (Task 5 step 3) so the watcher's debounced fire (~80 ms after) reliably sees the stamp.
- **Boot order in Task 18 (F3 fix applied):** double-click file dispatches *before* session restore loop AND `tabs.setActive(initialTabId)` is re-asserted *after* the loop, so the implicit "openDoc sets active" doesn't silently override the user's clicked file.
- **No `innerHTML` with user data:** Tab strip rendering uses `createElement` + `textContent` per Task 16 step 4 — no XSS exposure from filenames.
- **F1 (binary detector ordering):** Task 2 implementation calls `detectEncoding` *before* `isBinary`, and skips NUL detection for `utf-16le`/`utf-16be`. Two regression tests in Task 2 lock this in.
- **F2 (lossy save):** `writeText` returns `{ ok: true, lossyChars? } | { ok: false, lossy } | { ok: false, error }`. RPC handlers in Task 5 surface the lossy variant; Task 9 (single-doc) and Task 16 (per-tab) save flows confirm with `window.confirm` and retry with `allowLossy: true`. One regression test in Task 3.
- **F3 (session-restore active):** Task 18 boot block captures `initialTabId` from `openOrActivate` (return type changed to `Promise<string | null>` in Task 16), iterates restore loop while skipping the double-clicked path, then re-asserts active. One regression test in Task 15.
- **F4 (dup-tab):** Spec §8 wording updated; plan behavior (dedup) unchanged.
- **F5 (bundle guard):** Task 19a adds `tests/bundle-size.test.ts` with a hard ceiling assertion plus a `test:bundle` npm script.
