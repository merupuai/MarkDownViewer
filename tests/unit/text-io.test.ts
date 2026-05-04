import { describe, expect, test } from "bun:test";
import { readText } from "../../src/bun/text-io";

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

	test("Latin-1, CRLF", async () => {
		const r = await readText("tests/unit/text-io.fixtures/latin1-crlf.txt");
		expect(r.encoding).toBe("latin-1");
		expect(r.bom).toBe(false);
		expect(r.eol).toBe("crlf");
		expect(r.content).toBe("héllo\r\n");
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
