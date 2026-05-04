#!/usr/bin/env node

const { chromium } = require('playwright');
const path = require('node:path');

(async () => {
  const htmlFile = process.argv[2] || 'docs/CoBolt-Planning-Pipeline-Architecture.html';
  const outFile = process.argv[3] || htmlFile.replace(/\.html$/, '.pdf');

  const htmlPath = path.resolve(htmlFile).replace(/\\/g, '/');
  const outPath = path.resolve(outFile);

  console.log('Launching browser...');
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`file:///${htmlPath}`, { waitUntil: 'networkidle', timeout: 30000 });

  console.log('Waiting for Mermaid diagrams to render...');
  await page.waitForTimeout(5000);

  console.log('Generating PDF...');
  await page.pdf({
    path: outPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    scale: 0.82,
  });

  await browser.close();
  console.log('PDF saved to:', outPath);
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
