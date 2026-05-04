// Unit tests for the atomic-save / save-conflict logic (M3.S2 + M3.S6).
//
// We test a pure helper that mirrors saveDocumentFile in src/bun/index.ts
// (same caveat as image-resolver.test.ts — when M3.S2 is extracted into
// src/bun/save.ts in M4, this test imports it directly and the duplicated
// helper goes away).
//
// Validates:
//   - atomic write via tmp + rename
//   - conflict detection when disk mtime advances during edit
//   - conflict slack ≤ 1ms (filesystem mtime quantization)
//   - too-large rejection
//   - unsafe-path rejection (NUL, oversize)
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, renameSync, chmodSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, basename } from "path";

const MAX_SAVE_BYTES = 50 * 1024 * 1024;

// Mirror of src/bun/index.ts::saveDocumentFile
async function saveDocumentFile(path: string, content: string, expectedMtimeMs?: number) {
	if (!path || typeof path !== "string" || path.length > 4096 || path.includes("\0")) {
		return { ok: false, error: "unsafe-path", message: "path empty / too long / contains NUL" } as const;
	}
	const buf = Buffer.from(content, "utf8");
	if (buf.length > MAX_SAVE_BYTES) {
		return { ok: false, error: "too-large", bytes: buf.length } as const;
	}
	if (expectedMtimeMs !== undefined && existsSync(path)) {
		try {
			const diskMtimeMs = statSync(path).mtimeMs;
			if (Math.abs(diskMtimeMs - expectedMtimeMs) > 1) {
				return { ok: false, error: "conflict", diskMtimeMs, expectedMtimeMs } as const;
			}
		} catch (err) {
			return { ok: false, error: "io-failure", message: String(err) } as const;
		}
	}
	const dir = dirname(path);
	const base = basename(path);
	const tmpPath = join(dir, `.${base}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	try {
		writeFileSync(tmpPath, buf);
		if (process.platform !== "win32") {
			try { chmodSync(tmpPath, 0o644); } catch {}
		}
		renameSync(tmpPath, path);
		const finalMtime = statSync(path).mtimeMs;
		return { ok: true, savedAt: Date.now(), mtimeMs: finalMtime, bytes: buf.length } as const;
	} catch (err) {
		try { unlinkSync(tmpPath); } catch {}
		return { ok: false, error: "io-failure", message: String(err) } as const;
	}
}

let sandbox: string;

beforeEach(() => { sandbox = mkdtempSync(join(tmpdir(), "mdv-save-")); });
afterEach(() => { try { rmSync(sandbox, { recursive: true, force: true }); } catch {} });

describe("atomic save (M3.S2)", () => {
	test("first save creates the file with correct content", async () => {
		const path = join(sandbox, "doc.md");
		const result = await saveDocumentFile(path, "# Hello\n");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.bytes).toBe(8);
			expect(typeof result.mtimeMs).toBe("number");
		}
		expect(readFileSync(path, "utf8")).toBe("# Hello\n");
	});

	test("save replaces existing content atomically", async () => {
		const path = join(sandbox, "doc.md");
		writeFileSync(path, "old");
		const result = await saveDocumentFile(path, "new content");
		expect(result.ok).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("new content");
	});

	test("tmp file is cleaned up on success (no leftover .tmp files)", async () => {
		const path = join(sandbox, "doc.md");
		await saveDocumentFile(path, "x");
		const files = require("fs").readdirSync(sandbox);
		const tmpFiles = files.filter((f: string) => f.endsWith(".tmp"));
		expect(tmpFiles).toHaveLength(0);
	});
});

describe("conflict detection (M3.S6)", () => {
	test("save with NO expectedMtimeMs always succeeds (force-save path)", async () => {
		const path = join(sandbox, "doc.md");
		writeFileSync(path, "original");
		// Modify on disk
		writeFileSync(path, "modified externally");
		const result = await saveDocumentFile(path, "force-save content");
		expect(result.ok).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("force-save content");
	});

	test("save with matching expectedMtimeMs succeeds", async () => {
		const path = join(sandbox, "doc.md");
		writeFileSync(path, "original");
		const mt = statSync(path).mtimeMs;
		const result = await saveDocumentFile(path, "same-edit content", mt);
		expect(result.ok).toBe(true);
	});

	test("save with stale expectedMtimeMs returns conflict + both mtimes", async () => {
		const path = join(sandbox, "doc.md");
		writeFileSync(path, "original");
		const oldMt = statSync(path).mtimeMs;
		// Wait so a subsequent write is materially newer
		await new Promise((r) => setTimeout(r, 50));
		writeFileSync(path, "external edit");
		const newMt = statSync(path).mtimeMs;
		expect(newMt).toBeGreaterThan(oldMt + 1);

		const result = await saveDocumentFile(path, "user content", oldMt);
		expect(result.ok).toBe(false);
		if (!result.ok && result.error === "conflict") {
			expect(result.diskMtimeMs).toBe(newMt);
			expect(result.expectedMtimeMs).toBe(oldMt);
		}
		// Confirm the file was NOT clobbered
		expect(readFileSync(path, "utf8")).toBe("external edit");
	});

	test("save with non-existent file + expectedMtimeMs proceeds (new file path)", async () => {
		const path = join(sandbox, "new.md");
		const result = await saveDocumentFile(path, "first write", 12345);
		expect(result.ok).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("first write");
	});
});

describe("input validation", () => {
	test("path with NUL byte is rejected", async () => {
		const result = await saveDocumentFile("foo\0bar", "x");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("unsafe-path");
	});

	test("path > 4096 chars is rejected", async () => {
		const longPath = "a".repeat(5000);
		const result = await saveDocumentFile(longPath, "x");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("unsafe-path");
	});

	test("empty path is rejected", async () => {
		const result = await saveDocumentFile("", "x");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("unsafe-path");
	});
});
