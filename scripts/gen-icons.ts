// gen-icons.ts — Render the master brand SVG into every raster + container
// the application needs (web favicons, macOS .icns, Windows .ico).
//
// Run with:    bun run gen:icons
// Source:      assets/brand/MarkDownViewerLogo.svg
// Outputs:     assets/brand/icon-{16,32,48,64,128,180,192,256,512,1024}.png
//              assets/brand/favicon.ico    (16, 32, 48)
//              assets/brand/AppIcon.ico    (16, 32, 48, 64, 128, 256)
//              assets/brand/icon.icns      (16, 32, 64, 128, 256, 512, 1024)
//
// All generated artifacts are committed to the repo so consumers can build
// the app without running this script.

import { readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { Resvg } from "@resvg/resvg-js";
import png2icons from "png2icons";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const BRAND_DIR = join(PROJECT_ROOT, "assets", "brand");
const SRC_SVG = join(BRAND_DIR, "MarkDownViewerLogo.svg");

const PNG_SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024] as const;
const FAVICON_ICO_SIZES = new Set([16, 32, 48]);
const APPICON_ICO_SIZES = new Set([16, 32, 48, 64, 128, 256]);
const ICNS_SIZES = new Set([16, 32, 64, 128, 256, 512, 1024]);

function renderPng(svg: string, size: number): Buffer {
	const r = new Resvg(svg, {
		fitTo: { mode: "width", value: size },
		// High-quality resampling for the small sizes
		shapeRendering: 2,   // geometricPrecision
		textRendering: 2,    // geometricPrecision
		imageRendering: 0,   // optimizeQuality
		background: "rgba(0,0,0,0)",
	});
	return r.render().asPng();
}

function main() {
	console.log(`[gen-icons] Source : ${SRC_SVG}`);
	console.log(`[gen-icons] Output : ${BRAND_DIR}`);
	const svg = readFileSync(SRC_SVG, "utf8");

	// 1. Render all PNG sizes
	const pngs = new Map<number, Buffer>();
	for (const size of PNG_SIZES) {
		const buf = renderPng(svg, size);
		const out = join(BRAND_DIR, `icon-${size}.png`);
		writeFileSync(out, buf);
		pngs.set(size, buf);
		console.log(`[gen-icons]   PNG  ${String(size).padStart(4)}  ${buf.length.toString().padStart(7)} bytes`);
	}

	// 2. Pack favicon.ico (browser tab — small sizes only)
	{
		// png2icons.createICO accepts a single PNG buffer and resamples internally
		// for each target size. Feed it the largest source so resampling is sharp.
		const src = pngs.get(256)!;
		const ico = png2icons.createICO(src, png2icons.BICUBIC2, 0, false, true);
		if (!ico) throw new Error("favicon.ico generation failed");
		// Restrict to favicon sizes by re-packing from individual PNGs.
		const sized = Array.from(FAVICON_ICO_SIZES).sort((a, b) => a - b).map(s => pngs.get(s)!);
		const ico2 = packIcoFromPngs(sized);
		writeFileSync(join(BRAND_DIR, "favicon.ico"), ico2);
		console.log(`[gen-icons]   ICO  favicon.ico   ${ico2.length} bytes  (${[...FAVICON_ICO_SIZES].join(", ")})`);
	}

	// 3. Pack AppIcon.ico (Windows app bundle / installer / file-type)
	{
		const sized = Array.from(APPICON_ICO_SIZES).sort((a, b) => a - b).map(s => pngs.get(s)!);
		const ico = packIcoFromPngs(sized);
		writeFileSync(join(BRAND_DIR, "AppIcon.ico"), ico);
		console.log(`[gen-icons]   ICO  AppIcon.ico   ${ico.length} bytes  (${[...APPICON_ICO_SIZES].join(", ")})`);
	}

	// 4. Pack icon.icns (macOS bundle)
	{
		const src = pngs.get(1024)!;
		const icns = png2icons.createICNS(src, png2icons.BICUBIC2, 0);
		if (!icns) throw new Error("icon.icns generation failed");
		writeFileSync(join(BRAND_DIR, "icon.icns"), icns);
		console.log(`[gen-icons]   ICNS icon.icns     ${icns.length} bytes  (resampled by png2icons)`);
	}

	console.log(`[gen-icons] Done.`);
}

// png2icons accepts only a single source PNG and resamples internally. To get
// a multi-resolution ICO containing our hand-rendered (resvg) PNGs at every
// size — which is sharper at 16/32 than any post-hoc resample — we pack the
// ICO ourselves. The Microsoft ICO format is a small, well-defined container.
//
// Format reference: https://learn.microsoft.com/en-us/previous-versions/ms997538(v=msdn.10)
function packIcoFromPngs(pngBuffers: Buffer[]): Buffer {
	// Each entry: ICONDIRENTRY (16 bytes)
	//   width (1 B, 0 == 256+),  height (1 B, 0 == 256+),  colorCount (1 B = 0),
	//   reserved (1 B = 0),  planes (2 B LE = 1),  bpp (2 B LE = 32),
	//   sizeInBytes (4 B LE),  offset (4 B LE)
	const HEADER = 6;       // ICONDIR
	const ENTRY = 16;       // ICONDIRENTRY
	const n = pngBuffers.length;
	let offset = HEADER + n * ENTRY;

	const dir = Buffer.alloc(HEADER + n * ENTRY);
	dir.writeUInt16LE(0, 0);      // reserved
	dir.writeUInt16LE(1, 2);      // type: 1 = ICO
	dir.writeUInt16LE(n, 4);      // count

	const sizesByOrder = pngBuffers.map(buf => readPngSize(buf));
	for (let i = 0; i < n; i++) {
		const buf = pngBuffers[i];
		const { width, height } = sizesByOrder[i];
		const e = HEADER + i * ENTRY;
		dir.writeUInt8(width >= 256 ? 0 : width, e + 0);
		dir.writeUInt8(height >= 256 ? 0 : height, e + 1);
		dir.writeUInt8(0, e + 2);                   // colorCount
		dir.writeUInt8(0, e + 3);                   // reserved
		dir.writeUInt16LE(1, e + 4);                // planes
		dir.writeUInt16LE(32, e + 6);               // bpp
		dir.writeUInt32LE(buf.length, e + 8);       // size
		dir.writeUInt32LE(offset, e + 12);          // offset
		offset += buf.length;
	}

	return Buffer.concat([dir, ...pngBuffers]);
}

function readPngSize(buf: Buffer): { width: number; height: number } {
	// PNG signature is 8 bytes, then IHDR chunk: 4-byte length, "IHDR", 4-byte
	// width, 4-byte height (both big-endian). Width starts at offset 16.
	if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") {
		throw new Error("Not a PNG (missing IHDR)");
	}
	return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

main();
