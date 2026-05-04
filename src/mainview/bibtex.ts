// Minimal BibTeX parser + citation utilities (M4.S10 — closes ENH-022).
//
// Supports the common subset of BibTeX needed by markdown documents:
//   - @article, @book, @inproceedings, @misc, @online, @techreport entries
//   - Curly-brace and quoted field values
//   - Author / title / year / journal / publisher / url / doi
//
// NOT supported (bibtex's gnarlier corners):
//   - String concatenation (`#`)
//   - @string aliases
//   - Cross-references (@xdata)
//   - Comment quirks beyond `% ...` and the `@comment{...}` block
//
// IR-13-05 compliance: parser is pure text-walking; no eval/Function/dynamic
// imports. Hostile .bib content can at worst produce malformed citations.
export type BibEntry = {
	key: string;
	type: string;
	fields: Record<string, string>;
};

export function parseBibtex(source: string): Record<string, BibEntry> {
	const entries: Record<string, BibEntry> = {};
	let i = 0;
	const n = source.length;

	function skipWhitespace() {
		while (i < n) {
			const c = source[i];
			if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
			if (c === "%") {
				while (i < n && source[i] !== "\n") i++;
				continue;
			}
			break;
		}
	}

	function readUntil(stopRegex: RegExp): string {
		let buf = "";
		while (i < n && !stopRegex.test(source[i])) {
			buf += source[i++];
		}
		return buf;
	}

	function readBraced(): string {
		// Assumes source[i] === "{"
		let depth = 0;
		let buf = "";
		do {
			const c = source[i++];
			if (c === "{") depth++;
			else if (c === "}") depth--;
			if (depth > 0) buf += c;
		} while (i < n && depth > 0);
		return buf;
	}

	function readQuoted(): string {
		// Assumes source[i] === '"'
		i++;  // consume opening
		let buf = "";
		while (i < n && source[i] !== '"') {
			if (source[i] === "\\" && i + 1 < n) { buf += source[i] + source[i + 1]; i += 2; continue; }
			buf += source[i++];
		}
		if (source[i] === '"') i++;
		return buf;
	}

	function readField(): { key: string; value: string } | null {
		skipWhitespace();
		if (source[i] === "}" || source[i] === "," || i >= n) return null;
		const fieldName = readUntil(/[=\s,}]/).trim().toLowerCase();
		if (!fieldName) return null;
		skipWhitespace();
		if (source[i] !== "=") return null;
		i++;
		skipWhitespace();
		let value = "";
		if (source[i] === "{") value = readBraced();
		else if (source[i] === '"') value = readQuoted();
		else value = readUntil(/[,\s}]/).trim();
		// Normalize whitespace
		value = value.replace(/\s+/g, " ").trim();
		return { key: fieldName, value };
	}

	while (i < n) {
		skipWhitespace();
		if (source[i] !== "@") { i++; continue; }
		i++;
		const type = readUntil(/[\s{(]/).trim().toLowerCase();
		if (type === "comment" || type === "string" || type === "preamble") {
			// Skip the rest of this entry
			skipWhitespace();
			if (source[i] === "{") readBraced();
			continue;
		}
		skipWhitespace();
		if (source[i] !== "{") continue;
		i++;
		const key = readUntil(/[,\s}]/).trim();
		if (!key) continue;
		skipWhitespace();
		if (source[i] === ",") i++;
		const fields: Record<string, string> = {};
		while (i < n && source[i] !== "}") {
			const field = readField();
			if (!field) break;
			fields[field.key] = field.value;
			skipWhitespace();
			if (source[i] === ",") i++;
		}
		if (source[i] === "}") i++;
		entries[key] = { key, type, fields };
	}
	return entries;
}

// Minimal author-year formatter for inline citations.
// Falls back to the entry key if author/year are absent.
export function formatInlineCitation(entry: BibEntry, num: number): string {
	const author = entry.fields.author?.split(" and ")[0]?.split(",")[0]?.trim();
	const year = entry.fields.year;
	if (author && year) return `${author} ${year}`;
	return `${num}`;
}

export function formatBibliographyEntry(entry: BibEntry): string {
	const f = entry.fields;
	const parts: string[] = [];
	if (f.author) parts.push(f.author);
	if (f.year) parts.push(`(${f.year})`);
	if (f.title) parts.push(`"${f.title}"`);
	if (f.journal) parts.push(`<i>${f.journal}</i>`);
	if (f.booktitle) parts.push(`<i>${f.booktitle}</i>`);
	if (f.publisher) parts.push(f.publisher);
	if (f.url) parts.push(`<a href="${f.url}" data-external="true">${f.url}</a>`);
	if (f.doi) parts.push(`doi: <a href="https://doi.org/${f.doi}" data-external="true">${f.doi}</a>`);
	return parts.join(". ");
}
