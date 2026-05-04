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
		void decoded;
		return { encoding: "utf-8", bom: false, bomLen: 0 };
	} catch {
		return { encoding: "latin-1", bom: false, bomLen: 0 };
	}
}

function detectEOL(text: string): EOL {
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
	// F1: detect encoding FIRST. UTF-16 LE/BE files contain NUL bytes
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
