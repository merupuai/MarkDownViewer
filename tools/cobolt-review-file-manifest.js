#!/usr/bin/env node

const path = require('node:path');
const {
  defaultReviewManifestPath,
  formatReviewGroundingPacket,
  writeReviewFileManifest,
} = require('../lib/cobolt-file-manifest');

const USAGE = `Usage: node tools/cobolt-review-file-manifest.js build [--dir <path>] [--output <path>] [--json] [--prompt-packet]

Commands:
  build    Build deterministic source file manifest + grounding packet for review dispatch

Flags:
  --dir <path>      Project root (default: cwd)
  --output <path>   Override output path
  --json            Emit machine-readable JSON
  --prompt-packet   Emit grounding packet (markdown) instead of JSON
  --help, -h        Show this help and exit
`;

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const command = args[0] || 'build';
  const dirIdx = args.indexOf('--dir');
  const projectRoot = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : process.cwd();
  const outputIdx = args.indexOf('--output');
  const outputPath =
    outputIdx !== -1 && args[outputIdx + 1]
      ? path.resolve(args[outputIdx + 1])
      : defaultReviewManifestPath(projectRoot);
  const jsonMode = args.includes('--json');
  const packetMode = args.includes('--prompt-packet');

  if (command !== 'build') {
    console.log('CoBolt Review File Manifest');
    console.log('');
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const result = writeReviewFileManifest(projectRoot, { outputPath });

  if (packetMode) {
    console.log(
      formatReviewGroundingPacket(result.manifest, {
        projectRoot,
        manifestPath: result.outputPath,
      }),
    );
    return;
  }

  if (jsonMode) {
    console.log(JSON.stringify({ outputPath: result.outputPath, manifest: result.manifest }, null, 2));
    return;
  }

  console.log('[cobolt-review-file-manifest] Source File Manifest');
  console.log(`  Project root: ${projectRoot}`);
  console.log(`  Output: ${result.outputPath}`);
  console.log(`  Files: ${result.manifest.totalFiles}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  formatReviewGroundingPacket,
  writeReviewFileManifest,
};
