#!/usr/bin/env node

const path = require('node:path');
const {
  defaultBrownfieldManifestPath,
  formatBrownfieldGroundingPacket,
  writeBrownfieldFileManifest,
} = require('../lib/cobolt-file-manifest');

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'build';
  const dirIdx = args.indexOf('--dir');
  const projectRoot = dirIdx !== -1 && args[dirIdx + 1] ? path.resolve(args[dirIdx + 1]) : process.cwd();
  const outputIdx = args.indexOf('--output');
  const outputPath =
    outputIdx !== -1 && args[outputIdx + 1]
      ? path.resolve(args[outputIdx + 1])
      : defaultBrownfieldManifestPath(projectRoot);
  const jsonMode = args.includes('--json');
  const packetMode = args.includes('--prompt-packet');

  if (command !== 'build') {
    console.log('CoBolt Brownfield File Manifest');
    console.log('');
    console.log('Usage:');
    console.log(
      '  node tools/cobolt-brownfield-file-manifest.js build [--dir <path>] [--output <path>] [--json] [--prompt-packet]',
    );
    process.exit(command ? 2 : 0);
  }

  const result = writeBrownfieldFileManifest(projectRoot, { outputPath });

  if (packetMode) {
    console.log(
      formatBrownfieldGroundingPacket(result.manifest, {
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

  console.log('[cobolt-brownfield-file-manifest] Source File Manifest');
  console.log(`  Project root: ${projectRoot}`);
  console.log(`  Output: ${result.outputPath}`);
  console.log(`  Files: ${result.manifest.totalFiles}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  formatBrownfieldGroundingPacket,
  writeBrownfieldFileManifest,
};
