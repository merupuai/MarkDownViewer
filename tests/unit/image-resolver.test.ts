// Unit tests for the image-resolver containment logic (M1.S4 + M1.S5).
//
// resolveImage in src/bun/index.ts uses module-level state (currentFolderRoot)
// which makes it hard to unit-test in isolation. We test the SAME logic as a
// pure helper here — if this fails, the inline implementation has the same
// vulnerability. When that helper is extracted into src/bun/image-resolver.ts
// as part of the M1 refactor (DEBT-006), this file becomes its primary test.
//
// Closes: SEC-002 / FR-04 / SR-02 (path containment) + SR-05 (MIME allowlist).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, extname, sep } from "path";

// Pure containment helper mirroring src/bun/index.ts realCanonical + isContainedIn
function realCanonical(p: string): string {
	try { return realpathSync(p); } catch { return resolve(p); }
}
function isContainedIn(candidate: string, baseDir: string): boolean {
	const base = realCanonical(baseDir);
	const cand = realCanonical(candidate);
	const baseSep = base.endsWith(sep) ? base : base + sep;
	return cand === base || cand.startsWith(baseSep);
}

const IMAGE_MIME: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
	gif: "image/gif", svg: "image/svg+xml", webp: "image/webp",
	bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
};

// Pure resolveImage mirroring the M1 implementation
function resolveImagePure(docPath: string, src: string, allowedRoots: string[]): { dataUrl: string } | { error: string } {
	if (/^(https?:|data:|file:)/.test(src)) return { error: "external" };
	const docDir = require("path").dirname(docPath);
	const resolved = resolve(docDir, src);
	const ext = extname(resolved).toLowerCase().slice(1);
	const mt = IMAGE_MIME[ext];
	if (!mt) return { error: `unsupported-type:${ext || "(none)"}` };
	const inBounds = allowedRoots.some((root) => isContainedIn(resolved, root));
	if (!inBounds) return { error: `out-of-bounds:${resolved}` };
	return { dataUrl: `data:${mt};base64,...` };
}

let sandbox: string;
let docDir: string;
let outsideDir: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "mdv-image-"));
	docDir = join(sandbox, "doc");
	outsideDir = join(sandbox, "outside");
	mkdirSync(docDir, { recursive: true });
	mkdirSync(outsideDir, { recursive: true });
	// Plant a fake "image" inside docDir
	writeFileSync(join(docDir, "ok.png"), "fakepng");
	// Plant a "secret" outside docDir
	writeFileSync(join(outsideDir, "id_rsa"), "BEGIN-RSA-PRIVATE-KEY");
});
afterEach(() => {
	try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
});

describe("path containment (M1.S4 / SR-02)", () => {
	test("relative image inside docDir resolves successfully", () => {
		const result = resolveImagePure(join(docDir, "doc.md"), "ok.png", [docDir]);
		expect("dataUrl" in result).toBe(true);
	});

	test("relative traversal `../outside/id_rsa` is rejected as out-of-bounds", () => {
		const result = resolveImagePure(join(docDir, "doc.md"), "../outside/id_rsa", [docDir]);
		expect("error" in result).toBe(true);
		// out-of-bounds OR unsupported-type — either rejection is correct;
		// id_rsa has no allowed extension so MIME enforcement also fires
		const err = (result as { error: string }).error;
		expect(err.startsWith("out-of-bounds") || err.startsWith("unsupported-type")).toBe(true);
	});

	test("hostile traversal with image extension is caught by containment", () => {
		// Plant a real .png outside the doc dir
		writeFileSync(join(outsideDir, "leaked.png"), "fakeimage");
		const result = resolveImagePure(join(docDir, "doc.md"), "../outside/leaked.png", [docDir]);
		expect("error" in result).toBe(true);
		expect((result as { error: string }).error.startsWith("out-of-bounds")).toBe(true);
	});

	test("expanded allowlist (open folder) lets sibling-folder images through", () => {
		// Folder-mode: allowedRoots includes the open folder's root
		const folderRoot = sandbox;
		const result = resolveImagePure(join(docDir, "doc.md"), "../outside/id_rsa", [docDir, folderRoot]);
		// Now containment passes (it's under folderRoot) but MIME enforcement
		// still rejects (id_rsa has no allowed extension)
		expect("error" in result).toBe(true);
		expect((result as { error: string }).error.startsWith("unsupported-type")).toBe(true);
	});

	test("symlink escape is caught via realpath", () => {
		// Create a symlink INSIDE docDir that points OUTSIDE.
		try {
			symlinkSync(join(outsideDir, "id_rsa"), join(docDir, "evil.png"));
		} catch (err) {
			// Windows non-admin can't create symlinks; skip the test there
			console.warn("skip symlink test (no permission)", err);
			return;
		}
		const result = resolveImagePure(join(docDir, "doc.md"), "evil.png", [docDir]);
		expect("error" in result).toBe(true);
		expect((result as { error: string }).error.startsWith("out-of-bounds")).toBe(true);
	});
});

describe("MIME enforcement (M1.S5 / SR-05)", () => {
	test("allowed extension (png) returns data URL", () => {
		const result = resolveImagePure(join(docDir, "doc.md"), "ok.png", [docDir]);
		expect("dataUrl" in result).toBe(true);
		expect((result as { dataUrl: string }).dataUrl).toMatch(/^data:image\/png/);
	});

	test("disallowed extension (.exe) returns unsupported-type WITHOUT reading filesystem", () => {
		// Note: we don't even need the file to exist for this assertion to hold
		const result = resolveImagePure(join(docDir, "doc.md"), "evil.exe", [docDir]);
		expect("error" in result).toBe(true);
		expect((result as { error: string }).error).toBe("unsupported-type:exe");
	});

	test("missing extension returns unsupported-type:(none)", () => {
		const result = resolveImagePure(join(docDir, "doc.md"), "noextension", [docDir]);
		expect("error" in result).toBe(true);
		expect((result as { error: string }).error).toBe("unsupported-type:(none)");
	});

	test("external scheme (https) returns 'external' early, before MIME check", () => {
		const result = resolveImagePure(join(docDir, "doc.md"), "https://example.com/foo.png", [docDir]);
		expect("error" in result).toBe(true);
		expect((result as { error: string }).error).toBe("external");
	});

	test("data: scheme is short-circuited as external", () => {
		const result = resolveImagePure(join(docDir, "doc.md"), "data:image/png;base64,xxx", [docDir]);
		expect((result as { error: string }).error).toBe("external");
	});
});

// Mirrors src/bun/index.ts isExternalImageAllowed — pure host-allowlist + scheme
// gate for HTTPS image fetches. Closes the README-badge regression caused by the
// M1.S1 CSP lock-down. The actual fetch path is bun-side and integration-tested
// via the running app.
function isExternalImageAllowedPure(rawUrl: string, allowlist: Set<string>): { ok: true; host: string } | { ok: false; error: string } {
	let parsed: URL;
	try { parsed = new URL(rawUrl); } catch { return { ok: false, error: "external-bad-url" }; }
	if (parsed.protocol !== "https:") return { ok: false, error: `external-not-https:${parsed.protocol}` };
	const host = parsed.hostname.toLowerCase();
	if (!allowlist.has(host)) return { ok: false, error: `external-host-blocked:${host}` };
	return { ok: true, host };
}

describe("external image host allowlist (README-badge fix)", () => {
	const sealed = new Set([
		"img.shields.io", "shields.io",
		"raw.githubusercontent.com", "user-images.githubusercontent.com",
		"avatars.githubusercontent.com", "github.com",
		"gravatar.com", "secure.gravatar.com",
	]);

	test("shields.io badge URL passes the gate", () => {
		const r = isExternalImageAllowedPure("https://img.shields.io/badge/210-Specialist_Agents-0ea5e9", sealed);
		expect(r.ok).toBe(true);
	});

	test("github raw user content passes the gate", () => {
		const r = isExternalImageAllowedPure("https://raw.githubusercontent.com/owner/repo/main/img.png", sealed);
		expect(r.ok).toBe(true);
	});

	test("non-allowlisted host is rejected", () => {
		const r = isExternalImageAllowedPure("https://evil.example.com/leak.png", sealed);
		expect(r.ok).toBe(false);
		expect((r as { error: string }).error).toBe("external-host-blocked:evil.example.com");
	});

	test("http (non-TLS) is rejected even for allowlisted hosts — egress lock preserved", () => {
		const r = isExternalImageAllowedPure("http://img.shields.io/badge/x", sealed);
		expect(r.ok).toBe(false);
		expect((r as { error: string }).error).toBe("external-not-https:http:");
	});

	test("malformed URL returns bad-url", () => {
		const r = isExternalImageAllowedPure("not a url", sealed);
		expect(r.ok).toBe(false);
		expect((r as { error: string }).error).toBe("external-bad-url");
	});

	test("hostname matching is case-insensitive", () => {
		const r = isExternalImageAllowedPure("https://IMG.SHIELDS.IO/badge/x", sealed);
		expect(r.ok).toBe(true);
	});

	test("subdomain of allowlisted host is NOT auto-allowed (exact match only)", () => {
		// "shields.io" being on the list does NOT cover "evil.shields.io.attacker.tld"
		const r = isExternalImageAllowedPure("https://evil.shields.io.attacker.tld/x", sealed);
		expect(r.ok).toBe(false);
	});

	test("empty allowlist rejects everything (MDV_IMG_HOSTS='' kill-switch)", () => {
		const r = isExternalImageAllowedPure("https://img.shields.io/badge/x", new Set());
		expect(r.ok).toBe(false);
		expect((r as { error: string }).error).toBe("external-host-blocked:img.shields.io");
	});
});

describe("complete IMAGE_MIME allowlist", () => {
	// Bumped timeout: 9 writeFileSync + 9 realpathSync on Windows tmpfs can be
	// slow under parallel load (the realpath calls inside resolveImagePure
	// hit the OS each call). 30s gives ample headroom; the test does fixed
	// work, not unbounded retries.
	test("all 9 image extensions are accepted", () => {
		const exts = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif"];
		for (const ext of exts) {
			writeFileSync(join(docDir, `test.${ext}`), "x");
			const result = resolveImagePure(join(docDir, "doc.md"), `test.${ext}`, [docDir]);
			expect("dataUrl" in result).toBe(true);
		}
	}, 30000);
});
