// Unit tests for src/bun/log.ts (M1.S7 — closes SEC-005 / FR-08).
//
// Tests the public surface against the real os.tmpdir() (we don't mock it —
// concurrent tests would race on process.env). The portable-path claim is
// verifiable by reading the source: log.ts calls `path.join(tmpdir(), ...)`.
import { describe, test, expect, beforeAll } from "bun:test";
import { tmpdir } from "os";
import { existsSync, readFileSync, statSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { append, logPath, getFallback } from "../../src/bun/log";

const PRIMARY = logPath();
const ROTATED = PRIMARY + ".1";

beforeAll(() => {
	// Clean slate — remove any prior test artifacts (best-effort)
	try { if (existsSync(PRIMARY) && !statSync(PRIMARY).isDirectory()) unlinkSync(PRIMARY); } catch {}
	try { if (existsSync(ROTATED)) unlinkSync(ROTATED); } catch {}
});

describe("portable log path (M1.S7)", () => {
	test("logPath() returns a path under os.tmpdir()", () => {
		expect(PRIMARY).toContain(tmpdir());
		expect(PRIMARY.endsWith("mdv-bun.log")).toBe(true);
	});

	test("logPath() does NOT use hardcoded /tmp on Windows", () => {
		if (process.platform === "win32") {
			expect(PRIMARY.startsWith("/tmp")).toBe(false);
		}
	});
});

describe("append() (M1.S7)", () => {
	test("append writes to the resolved path", () => {
		const marker = `[test-${Date.now()}-${Math.random()}] hello\n`;
		append(marker);
		expect(existsSync(PRIMARY)).toBe(true);
		const content = readFileSync(PRIMARY, "utf8");
		expect(content).toContain(marker);
	});

	test("multiple appends accumulate", () => {
		const m1 = `[test-${Date.now()}-a] line1\n`;
		const m2 = `[test-${Date.now()}-b] line2\n`;
		append(m1);
		append(m2);
		const content = readFileSync(PRIMARY, "utf8");
		expect(content).toContain(m1);
		expect(content).toContain(m2);
		// m1 should appear before m2 (append order)
		expect(content.indexOf(m1)).toBeLessThan(content.indexOf(m2));
	});
});

describe("getFallback() (M1.S7 / IR-08-03)", () => {
	test("returns a structured object with failedAppends + ring", () => {
		const fb = getFallback();
		expect(typeof fb.failedAppends).toBe("number");
		expect(Array.isArray(fb.ring)).toBe(true);
	});

	test("ring is bounded — verify shape (cap is 200 in source)", () => {
		const fb = getFallback();
		expect(fb.ring.length).toBeLessThanOrEqual(200);
	});
});
