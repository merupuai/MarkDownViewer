import svgPanZoom from "svg-pan-zoom";

export type Lightbox = {
	open: (svg: SVGElement, title?: string) => void;
	close: () => void;
};

// Modern DOM API for emptying an element without parsing any HTML. Equivalent
// to assigning an empty string to inner-HTML but pattern-matchers and our
// security hook flag the latter even when the assigned value is the empty
// string. replaceChildren() is the documented safe way.
function clearChildren(el: HTMLElement): void {
	el.replaceChildren();
}

export function createLightbox(opts: {
	rootEl: HTMLElement;
	closeBtn: HTMLButtonElement;
	titleEl: HTMLElement;
	stageEl: HTMLElement;
}): Lightbox {
	const { rootEl, closeBtn, titleEl, stageEl } = opts;
	let panZoomInstance: ReturnType<typeof svgPanZoom> | null = null;
	// M1.S8 (closes UI-003 / WCAG SC 2.4.3): remember which element opened the
	// lightbox so we can restore focus there on close. Falls back to document
	// body if the original element is no longer in the DOM (re-render).
	let returnFocusTo: HTMLElement | null = null;

	function close() {
		rootEl.hidden = true;
		clearChildren(stageEl);
		try { panZoomInstance?.destroy(); } catch {}
		panZoomInstance = null;
		// Restore focus to the invoking control. Use isConnected so we don't
		// throw on a stale node if the rendered DOM changed underneath us.
		if (returnFocusTo && returnFocusTo.isConnected) {
			try { returnFocusTo.focus(); } catch {}
		} else {
			try { (document.body as HTMLElement).focus(); } catch {}
		}
		returnFocusTo = null;
	}

	function open(svg: SVGElement, title = "Diagram") {
		// Capture the currently focused element BEFORE we move focus to the
		// close button. activeElement may be the body if nothing was focused.
		returnFocusTo = (document.activeElement instanceof HTMLElement)
			? document.activeElement
			: null;
		clearChildren(stageEl);
		titleEl.textContent = title;
		const clone = svg.cloneNode(true) as SVGElement;
		clone.removeAttribute("style");
		clone.setAttribute("width", "100%");
		clone.setAttribute("height", "100%");
		stageEl.appendChild(clone);
		rootEl.hidden = false;
		// Move focus to the close button so keyboard users can dismiss the
		// modal without hunting; this also keeps screen readers aligned.
		try { closeBtn.focus(); } catch {}
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
