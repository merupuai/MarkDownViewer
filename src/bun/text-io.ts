import { readFileSync, writeFileSync } from "fs";

export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "latin-1" | "windows-1252";
export type EOL = "lf" | "crlf";

// CP1252 differs from ISO-8859-1 only in 0x80–0x9F. Everything else is identical
// to latin-1, so we keep a 32-entry table for that range and let the rest pass
// through as-is. Five slots (0x81, 0x8D, 0x8F, 0x90, 0x9D) are unmapped in CP1252;
// we round-trip them as the C1 control codepoint of the same numeric value so a
// raw byte → string → raw byte cycle is byte-identical for those positions.
const CP1252_C1: Record<number, number> = {
	0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
	0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
	0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D,
	0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022,
	0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161,
	0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178,
};
const CP1252_C1_REVERSE: Record<number, number> = (() => {
	const out: Record<number, number> = {};
	for (const [byte, cp] of Object.entries(CP1252_C1)) out[cp] = Number(byte);
	return out;
})();

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
	// Heuristic: try UTF-8 strict; if it fails, fall back to Windows-1252.
	// CP1252 (not ISO-8859-1) is the right fallback for unknown 8-bit text:
	// it's what every Windows authoring tool emits, and it covers the C1
	// typography slots (curly quotes, en/em-dash, ellipsis, Euro). The pure
	// ISO-8859-1 fallback we used to emit silently mapped en-dash 0x96 to
	// the C1 control codepoint U+0096, producing unrenderable glyphs in the
	// preview pane for any German/legal markdown authored in Notepad.
	try {
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
		void decoded;
		return { encoding: "utf-8", bom: false, bomLen: 0 };
	} catch {
		return { encoding: "windows-1252", bom: false, bomLen: 0 };
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
	if (encoding === "windows-1252") {
		// CP1252 == ISO-8859-1 outside 0x80–0x9F. Decode as latin-1 first, then
		// rewrite that 32-byte slot using the CP1252 mapping. This is faster
		// than walking byte-by-byte for the (common) ASCII-heavy case.
		let out = "";
		const len = slice.length;
		for (let i = 0; i < len; i++) {
			const byte = slice[i];
			if (byte >= 0x80 && byte <= 0x9F && byte in CP1252_C1) {
				out += String.fromCharCode(CP1252_C1[byte]!);
			} else {
				out += String.fromCharCode(byte);
			}
		}
		return out;
	}
	return slice.toString("utf8");
}

export type WriteMeta = { encoding: Encoding; eol: EOL; bom: boolean };

/** F2: When the target encoding can't represent some chars, refuse the write
 *  and return diagnostic info so the caller can show a confirm modal. The
 *  caller can opt in to the lossy save by passing `{ allowLossy: true }`. */
export type LossyInfo = {
	encoding: Encoding;
	lossyCharCount: number;
	firstIndex: number;
	sample: string;
};

export type WriteResult =
	| { ok: true; lossyChars?: number }
	| { ok: false; lossy: LossyInfo };

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

function scanLossyForCp1252(content: string): { count: number; firstIndex: number } {
	let count = 0;
	let firstIndex = -1;
	for (let i = 0; i < content.length; i++) {
		const cp = content.charCodeAt(i);
		// Representable in CP1252 if: ASCII/latin-1 outside the C1 typography
		// slot, OR a known CP1252 typography codepoint (curly quotes, dashes,
		// Euro, ellipsis, ...). 0x80–0x9F as raw codepoints are NOT
		// representable — those slots are owned by typography in CP1252.
		const inLatin1Body = cp <= 0xFF && !(cp >= 0x80 && cp <= 0x9F);
		const inCp1252Typography = cp in CP1252_C1_REVERSE;
		if (!inLatin1Body && !inCp1252Typography) {
			count++;
			if (firstIndex < 0) firstIndex = i;
		}
	}
	return { count, firstIndex };
}

function encodeCp1252(content: string): Buffer {
	const out = Buffer.alloc(content.length);
	for (let i = 0; i < content.length; i++) {
		const cp = content.charCodeAt(i);
		if (cp in CP1252_C1_REVERSE) {
			out[i] = CP1252_C1_REVERSE[cp]!;
		} else {
			// Latin-1-style truncation for anything else; lossy chars were
			// already counted by scanLossyForCp1252 and the writeText caller
			// gated on opts.allowLossy before reaching here.
			out[i] = cp & 0xFF;
		}
	}
	return out;
}

export async function writeText(
	path: string,
	content: string,
	meta: WriteMeta,
	opts?: { allowLossy?: boolean },
): Promise<WriteResult> {
	// F2: Lossy-encoding precheck. UTF-8 / UTF-16 LE / UTF-16 BE round-trip
	// every JS string. The 8-bit encodings are lossy by construction:
	//  - latin-1 covers exactly U+0000..U+00FF.
	//  - windows-1252 covers latin-1 minus the 0x80–0x9F C1 controls, plus
	//    27 typography codepoints (en-dash, em-dash, curly quotes, ...).
	// Anything outside those sets gets silently truncated to 0x3F unless we
	// refuse here. allowLossy lets the renderer opt in after a confirm modal.
	if (meta.encoding === "latin-1" || meta.encoding === "windows-1252") {
		const { count, firstIndex } = meta.encoding === "latin-1"
			? scanLossyForLatin1(content)
			: scanLossyForCp1252(content);
		if (count > 0 && !opts?.allowLossy) {
			const sampleStart = Math.max(0, firstIndex - 10);
			const sampleEnd = Math.min(content.length, firstIndex + 11);
			return {
				ok: false,
				lossy: {
					encoding: meta.encoding,
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
	} else if (meta.encoding === "windows-1252") {
		bodyBytes = encodeCp1252(withEol);
	} else {
		bodyBytes = Buffer.from(withEol, "utf8");
	}

	writeFileSync(path, Buffer.concat([bomBytes, bodyBytes]));

	// If we got here with an 8-bit encoding and allowLossy=true, surface the count.
	if (opts?.allowLossy && (meta.encoding === "latin-1" || meta.encoding === "windows-1252")) {
		const { count } = meta.encoding === "latin-1"
			? scanLossyForLatin1(content)
			: scanLossyForCp1252(content);
		return count > 0 ? { ok: true, lossyChars: count } : { ok: true };
	}
	return { ok: true };
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
