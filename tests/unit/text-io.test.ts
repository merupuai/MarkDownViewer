import { describe, expect, test } from "bun:test";
import { readText, writeText } from "../../src/bun/text-io";
import { readFileSync, unlinkSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("readText — encoding & EOL detection", () => {
	test("UTF-8, LF, no BOM", async () => {
		const r = await readText("tests/unit/text-io.fixtures/utf8-lf.txt");
		expect(r.encoding).toBe("utf-8");
		expect(r.bom).toBe(false);
		expect(r.eol).toBe("lf");
		expect(r.content).toBe("hello\nworld\n");
	});

	test("UTF-8 with BOM, LF", async () => {
		const r = await readText("tests/unit/text-io.fixtures/utf8bom-lf.txt");
		expect(r.encoding).toBe("utf-8");
		expect(r.bom).toBe(true);
		expect(r.eol).toBe("lf");
		expect(r.content).toBe("hello\nworld\n");
	});

	test("UTF-16 LE with BOM, CRLF", async () => {
		const r = await readText("tests/unit/text-io.fixtures/utf16le-bom-crlf.txt");
		expect(r.encoding).toBe("utf-16le");
		expect(r.bom).toBe(true);
		expect(r.eol).toBe("crlf");
		expect(r.content).toBe("hi\r\n");
	});

	test("UTF-16 BE with BOM, LF", async () => {
		const r = await readText("tests/unit/text-io.fixtures/utf16be-bom-lf.txt");
		expect(r.encoding).toBe("utf-16be");
		expect(r.bom).toBe(true);
		expect(r.eol).toBe("lf");
		expect(r.content).toBe("hi\n");
	});

	test("non-UTF-8 8-bit text auto-detects as windows-1252 (was latin-1)", async () => {
		// Fixture is bytes `68 E9 6C 6C 6F 0D 0A`. 0xE9 alone is invalid UTF-8,
		// so the strict-UTF-8 path falls back to the 8-bit branch. The fallback
		// label flipped from "latin-1" to "windows-1252" because every Windows
		// authoring tool emits CP1252 for "ANSI" text — see the rationale block
		// in src/bun/text-io.ts. 0xE9 maps to é (U+00E9) in both encodings,
		// so the user-visible content is unchanged.
		const r = await readText("tests/unit/text-io.fixtures/latin1-crlf.txt");
		expect(r.encoding).toBe("windows-1252");
		expect(r.bom).toBe(false);
		expect(r.eol).toBe("crlf");
		expect(r.content).toBe("héllo\r\n");
	});

	// Regression for the en-dash/em-dash mojibake: a Notepad-saved markdown
	// file with §1–§12 + §5b — used to come back with U+0096 / U+0097 (C1
	// control codepoints with no glyph) under the old latin-1 fallback. Pin
	// that those bytes now decode to U+2013 / U+2014 (the real en/em-dash).
	test("CP1252 typography (0x96/0x97) decodes to en-dash/em-dash, not C1 controls", async () => {
		const r = await readText("tests/unit/text-io.fixtures/cp1252-typography-crlf.txt");
		expect(r.encoding).toBe("windows-1252");
		expect(r.eol).toBe("crlf");
		expect(r.content).toBe("§1–§12 + §5b —\r\n");
		// Belt-and-braces: the actual codepoints, not just the visible string.
		const codepoints = [...r.content].map((c) => c.charCodeAt(0));
		expect(codepoints).toContain(0x2013); // EN DASH
		expect(codepoints).toContain(0x2014); // EM DASH
		expect(codepoints).not.toContain(0x0096); // C1 control we used to emit
		expect(codepoints).not.toContain(0x0097);
	});

	test("binary file is flagged", async () => {
		const r = await readText("tests/unit/text-io.fixtures/binary.bin");
		expect(r.binary).toBe(true);
	});

	// F1 regression guards — UTF-16 fixtures contain NUL bytes that the
	// binary detector would otherwise flag. Encoding detection MUST run
	// before binary detection; these tests fail loudly if someone reorders.
	test("UTF-16 LE is NOT misclassified as binary", async () => {
		const r = await readText("tests/unit/text-io.fixtures/utf16le-bom-crlf.txt");
		expect(r.binary).toBeUndefined();
		expect(r.encoding).toBe("utf-16le");
	});

	test("UTF-16 BE is NOT misclassified as binary", async () => {
		const r = await readText("tests/unit/text-io.fixtures/utf16be-bom-lf.txt");
		expect(r.binary).toBeUndefined();
		expect(r.encoding).toBe("utf-16be");
	});
});

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

	test("Windows-1252 round-trip preserves typography characters", async () => {
		const p = join(tmpDir, "cp1252-rt.txt");
		const original = "§1–§12 + §5b —\r\n";
		const w = await writeText(p, original, { encoding: "windows-1252", eol: "crlf", bom: false });
		expect(w.ok).toBe(true);
		const buf = readFileSync(p);
		// 0x96 (en-dash) and 0x97 (em-dash) must be in the on-disk bytes, not
		// 0x3F (?) — that would mean we silently truncated.
		expect(buf.includes(0x96)).toBe(true);
		expect(buf.includes(0x97)).toBe(true);
		const r = await readText(p);
		expect(r.encoding).toBe("windows-1252");
		expect(r.content).toBe(original);
		unlinkSync(p);
	});

	test("Windows-1252 lossy refusal: emoji is unrepresentable, allowLossy bypass works", async () => {
		const p = join(tmpDir, "cp1252-lossy.txt");
		// Pizza (U+1F355) is not in CP1252.
		const refused = await writeText(p, "lunch: 🍕", { encoding: "windows-1252", eol: "lf", bom: false });
		expect(refused.ok).toBe(false);
		if (refused.ok === false) {
			expect(refused.lossy.encoding).toBe("windows-1252");
			expect(refused.lossy.lossyCharCount).toBeGreaterThan(0);
		}
		expect(() => readFileSync(p)).toThrow();

		const allowed = await writeText(p, "lunch: 🍕", { encoding: "windows-1252", eol: "lf", bom: false }, { allowLossy: true });
		expect(allowed.ok).toBe(true);
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
		expect(buf.length).toBeGreaterThan(0);
		unlinkSync(p);
	});
});
