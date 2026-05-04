// Portable rotating bun debug log (M1.S7 — closes SEC-005 / FR-08).
//
// Replaces the previous hardcoded `/tmp/mdv-bun.log` path which silently
// failed on Windows (no `/tmp` directory) and never rotated. The new path
// follows os.tmpdir() so Windows lands in `%TEMP%\mdv-bun.log` and
// Unix-likes land in `/tmp/mdv-bun.log`. Rotation triggers when the file
// crosses MAX_BYTES — the previous file is renamed to `mdv-bun.log.1` and
// a fresh log starts. Only one historical generation is kept; older
// rotations are overwritten. Append errors are recorded once per process
// to a fallback in-memory ring (`getFallback()`), so even if disk writes
// fail the renderer can still surface a "log unavailable" affordance.
import { tmpdir } from "os";
import { join } from "path";
import { appendFileSync, statSync, renameSync, existsSync, unlinkSync } from "fs";

const FILE_NAME = "mdv-bun.log";
const ROTATED_NAME = "mdv-bun.log.1";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

let cachedLogPath: string | null = null;
let cachedRotatedPath: string | null = null;
let appendsFailed = 0;
const fallbackRing: string[] = [];
const FALLBACK_RING_SIZE = 200;

function paths(): { primary: string; rotated: string } {
	if (!cachedLogPath) cachedLogPath = join(tmpdir(), FILE_NAME);
	if (!cachedRotatedPath) cachedRotatedPath = join(tmpdir(), ROTATED_NAME);
	return { primary: cachedLogPath, rotated: cachedRotatedPath };
}

export function logPath(): string {
	return paths().primary;
}

function rotateIfNeeded(): void {
	const { primary, rotated } = paths();
	try {
		if (!existsSync(primary)) return;
		const size = statSync(primary).size;
		if (size < MAX_BYTES) return;
		if (existsSync(rotated)) {
			try { unlinkSync(rotated); } catch (err) { record_failure("unlink-rotated", err); }
		}
		renameSync(primary, rotated);
	} catch (err) {
		record_failure("rotate", err);
	}
}

function record_failure(stage: string, err: unknown): void {
	appendsFailed++;
	const msg = err instanceof Error ? err.message : String(err);
	fallbackRing.push(`[log:${stage}-failed] ${msg}`);
	if (fallbackRing.length > FALLBACK_RING_SIZE) fallbackRing.shift();
}

export function append(line: string): void {
	rotateIfNeeded();
	const { primary } = paths();
	try {
		appendFileSync(primary, line);
	} catch (err) {
		record_failure("append", err);
		fallbackRing.push(line);
		if (fallbackRing.length > FALLBACK_RING_SIZE) fallbackRing.shift();
	}
}

// Diagnostics surface for the renderer. Returns the in-memory ring (last 200
// lines that fell back when disk writes failed) plus a count of failed
// append attempts since process start.
export function getFallback(): { failedAppends: number; ring: ReadonlyArray<string> } {
	return { failedAppends: appendsFailed, ring: [...fallbackRing] };
}
