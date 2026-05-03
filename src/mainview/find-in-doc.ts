// In-document text search with highlight + navigation.

export type FindController = {
	open: () => void;
	close: () => void;
	toggle: () => void;
	next: () => void;
	prev: () => void;
	setQuery: (q: string) => void;
};

export function createFindController(opts: {
	contentEl: HTMLElement;
	contentScroller: HTMLElement;
	barEl: HTMLElement;
	inputEl: HTMLInputElement;
	countEl: HTMLElement;
	prevBtn: HTMLButtonElement;
	nextBtn: HTMLButtonElement;
	closeBtn: HTMLButtonElement;
}): FindController {
	const { contentEl, contentScroller, barEl, inputEl, countEl, prevBtn, nextBtn, closeBtn } = opts;
	let matches: HTMLElement[] = [];
	let activeIdx = -1;
	let openState = false;

	function clearMarks() {
		const marks = contentEl.querySelectorAll<HTMLElement>("mark[data-find]");
		marks.forEach((m) => {
			const parent = m.parentNode;
			if (!parent) return;
			parent.replaceChild(document.createTextNode(m.textContent || ""), m);
			parent.normalize();
		});
		matches = [];
		activeIdx = -1;
		updateCount();
	}

	function escapeRegex(s: string) {
		return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
	}

	function applyMarks(query: string) {
		clearMarks();
		if (!query) return;
		const regex = new RegExp(escapeRegex(query), "gi");
		const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, {
			acceptNode(node) {
				const parent = node.parentElement;
				if (!parent) return NodeFilter.FILTER_REJECT;
				if (parent.closest("script, style, .mermaid-wrap, .find-bar, .code-block-tools")) return NodeFilter.FILTER_REJECT;
				if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
				return NodeFilter.FILTER_ACCEPT;
			},
		});
		const targets: Text[] = [];
		let n: Node | null;
		while ((n = walker.nextNode())) targets.push(n as Text);
		for (const t of targets) {
			const text = t.nodeValue || "";
			if (!regex.test(text)) { regex.lastIndex = 0; continue; }
			regex.lastIndex = 0;
			const frag = document.createDocumentFragment();
			let lastIdx = 0;
			let m: RegExpExecArray | null;
			while ((m = regex.exec(text))) {
				if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
				const mark = document.createElement("mark");
				mark.dataset.find = "1";
				mark.textContent = m[0];
				frag.appendChild(mark);
				matches.push(mark);
				lastIdx = m.index + m[0].length;
				if (m.index === regex.lastIndex) regex.lastIndex++;
			}
			if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
			t.parentNode?.replaceChild(frag, t);
		}
		updateCount();
		if (matches.length > 0) setActive(0);
	}

	function setActive(i: number) {
		if (matches.length === 0) { activeIdx = -1; updateCount(); return; }
		matches.forEach((m) => m.classList.remove("active"));
		activeIdx = ((i % matches.length) + matches.length) % matches.length;
		const el = matches[activeIdx];
		el.classList.add("active");
		const r = el.getBoundingClientRect();
		const sr = contentScroller.getBoundingClientRect();
		if (r.top < sr.top + 80 || r.bottom > sr.bottom - 40) {
			el.scrollIntoView({ block: "center", behavior: "smooth" });
		}
		updateCount();
	}

	function updateCount() {
		countEl.textContent = matches.length === 0
			? (inputEl.value ? "0/0" : "")
			: `${activeIdx + 1}/${matches.length}`;
	}

	function open() {
		openState = true;
		barEl.hidden = false;
		inputEl.focus();
		inputEl.select();
		if (inputEl.value) applyMarks(inputEl.value);
	}
	function close() {
		openState = false;
		barEl.hidden = true;
		clearMarks();
	}
	function toggle() { openState ? close() : open(); }
	function next() { if (matches.length) setActive(activeIdx + 1); }
	function prev() { if (matches.length) setActive(activeIdx - 1); }
	function setQuery(q: string) { inputEl.value = q; applyMarks(q); }

	let debounce: ReturnType<typeof setTimeout> | null = null;
	inputEl.addEventListener("input", () => {
		if (debounce) clearTimeout(debounce);
		debounce = setTimeout(() => applyMarks(inputEl.value), 100);
	});
	inputEl.addEventListener("keydown", (e) => {
		if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? prev() : next(); }
		else if (e.key === "Escape") { e.preventDefault(); close(); }
	});
	prevBtn.addEventListener("click", prev);
	nextBtn.addEventListener("click", next);
	closeBtn.addEventListener("click", close);

	return { open, close, toggle, next, prev, setQuery };
}
