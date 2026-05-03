import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Markdown Viewer",
		identifier: "com.local.markdownviewer",
		version: "1.0.0",
		description: "Native markdown viewer with mermaid/C4 diagram support",
		fileAssociations: [
			{
				ext: ["md", "markdown", "mdown", "mkd", "mkdn", "mdx"],
				name: "Markdown Document",
				role: "Viewer",
			},
		],
	},
	build: {
		bun: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			mainview: {
				entrypoint: "src/mainview/index.ts",
			},
		},
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
			"src/mainview/index.css": "views/mainview/index.css",
			"node_modules/katex/dist/katex.min.css": "views/mainview/katex/katex.min.css",
			"node_modules/katex/dist/fonts": "views/mainview/katex/fonts",
		},
		mac: {
			bundleCEF: false,
			createDmg: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
	scripts: {
		postWrap: "scripts/postwrap.ts",
	},
} satisfies ElectrobunConfig;
