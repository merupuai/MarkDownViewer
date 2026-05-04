import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Markdown Viewer",
		identifier: "com.local.markdownviewer",
		version: "1.0.0",
		description: "Native markdown viewer with mermaid/C4 diagram support — by CoBolt",
		// Bundle icon (macOS). Read by Electrobun if its beta runtime honors the
		// field; otherwise scripts/postwrap.ts copies icon.icns into the .app's
		// Contents/Resources and patches Info.plist's CFBundleIconFile. The field
		// is not yet declared in Electrobun's beta types, hence the directive.
		// @ts-expect-error forward-compat field for Electrobun runtime
		icon: "assets/brand/icon.icns",
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
			// Brand assets — favicon set served from views/mainview/brand/
			"assets/brand/MarkDownViewerLogo.svg": "views/mainview/brand/MarkDownViewerLogo.svg",
			"assets/brand/icon-16.png":  "views/mainview/brand/icon-16.png",
			"assets/brand/icon-32.png":  "views/mainview/brand/icon-32.png",
			"assets/brand/icon-180.png": "views/mainview/brand/icon-180.png",
			// CoBolt attribution mark — shown in the status-bar footer
			"assets/CoBolt_Name_Logo.png": "views/mainview/brand/CoBolt_Name_Logo.png",
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
