import svgPanZoom from "svg-pan-zoom";

export type Lightbox = {
	open: (svg: SVGElement, title?: string) => void;
	close: () => void;
};

export function createLightbox(opts: {
	rootEl: HTMLElement;
	closeBtn: HTMLButtonElement;
	titleEl: HTMLElement;
	stageEl: HTMLElement;
}): Lightbox {
	const { rootEl, closeBtn, titleEl, stageEl } = opts;
	let panZoomInstance: ReturnType<typeof svgPanZoom> | null = null;

	function close() {
		rootEl.hidden = true;
		stageEl.innerHTML = "";
		try { panZoomInstance?.destroy(); } catch {}
		panZoomInstance = null;
	}

	function open(svg: SVGElement, title = "Diagram") {
		stageEl.innerHTML = "";
		titleEl.textContent = title;
		const clone = svg.cloneNode(true) as SVGElement;
		clone.removeAttribute("style");
		clone.setAttribute("width", "100%");
		clone.setAttribute("height", "100%");
		stageEl.appendChild(clone);
		rootEl.hidden = false;
		requestAnimationFrame(() => {
			try {
				panZoomInstance = svgPanZoom(clone, {
					zoomEnabled: true,
					controlIconsEnabled: true,
					fit: true,
					center: true,
					minZoom: 0.2,
					maxZoom: 20,
					zoomScaleSensitivity: 0.4,
				});
			} catch (err) {
				console.warn("svg-pan-zoom failed", err);
			}
		});
	}

	closeBtn.addEventListener("click", close);
	rootEl.addEventListener("click", (e) => {
		if (e.target === rootEl) close();
	});
	document.addEventListener("keydown", (e) => {
		if (!rootEl.hidden && e.key === "Escape") { e.preventDefault(); close(); }
	});

	return { open, close };
}
