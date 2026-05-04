#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const TRACKS_DIRNAME = 'tracks';
const REQUIRED_FIELDS = ['id', 'name', 'summary', 'stages', 'entrypoints', 'skills', 'tools', 'outputs'];

function getTracksDir(projectDir = process.cwd()) {
  return path.join(projectDir, 'source', TRACKS_DIRNAME);
}

function validateTrackManifest(manifest, filePath) {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in manifest)) {
      throw new Error(`Track manifest is missing "${field}": ${filePath}`);
    }
  }

  for (const field of ['stages', 'entrypoints', 'skills', 'tools', 'outputs']) {
    if (!Array.isArray(manifest[field])) {
      throw new Error(`Track manifest field "${field}" must be an array: ${filePath}`);
    }
  }

  return manifest;
}

function loadTrackManifest(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const manifest = JSON.parse(raw);
  const track = validateTrackManifest(manifest, filePath);
  return { ...track, filePath };
}

function loadTracks(projectDir = process.cwd()) {
  const tracksDir = getTracksDir(projectDir);
  if (!fs.existsSync(tracksDir)) return [];

  return fs
    .readdirSync(tracksDir)
    .filter((entry) => entry.toLowerCase().endsWith('.json'))
    .map((entry) => loadTrackManifest(path.join(tracksDir, entry)))
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
}

function listTracks(projectDir = process.cwd()) {
  return loadTracks(projectDir).map((track) => ({
    id: track.id,
    name: track.name,
    summary: track.summary,
    stages: track.stages,
    entrypointCount: track.entrypoints.length,
    toolCount: track.tools.length,
    skillCount: track.skills.length,
  }));
}

function getTrack(trackId, projectDir = process.cwd()) {
  return loadTracks(projectDir).find((track) => track.id === trackId) || null;
}

function renderTrackMarkdown(track) {
  if (!track) return '';

  const lines = [
    `# ${track.name}`,
    '',
    `**Track ID:** ${track.id}`,
    '',
    track.summary,
    '',
    '## Stage Span',
    '',
    `- ${track.stages.join(', ')}`,
    '',
    '## Entry Points',
    '',
    ...track.entrypoints.map((entry) => `- ${entry}`),
    '',
    '## Internal Skills',
    '',
    ...track.skills.map((skill) => `- ${skill}`),
    '',
    '## Deterministic Tools',
    '',
    ...track.tools.map((tool) => `- ${tool}`),
    '',
    '## Expected Outputs',
    '',
    ...track.outputs.map((output) => `- ${output}`),
    '',
  ];

  return lines.join('\n');
}

function printUsage() {
  console.log('Usage: node tools/cobolt-track.js <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  list [--json]        List all CoBolt tracks');
  console.log('  show <track-id>      Show one track in Markdown');
  console.log('  show <track-id> --json');
  console.log('');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';
  const jsonMode = args.includes('--json');

  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    process.exit(0);
  }

  if (command === 'list') {
    const result = listTracks();
    console.log(
      jsonMode ? JSON.stringify(result, null, 2) : result.map((track) => `${track.id}: ${track.summary}`).join('\n'),
    );
    process.exit(0);
  }

  if (command === 'show') {
    const trackId = args[1];
    if (!trackId) {
      printUsage();
      process.exit(2);
    }

    const track = getTrack(trackId);
    if (!track) {
      console.error(`Unknown track: ${trackId}`);
      process.exit(1);
    }

    console.log(jsonMode ? JSON.stringify(track, null, 2) : renderTrackMarkdown(track));
    process.exit(0);
  }

  printUsage();
  process.exit(2);
}

module.exports = {
  TRACKS_DIRNAME,
  getTracksDir,
  loadTrackManifest,
  loadTracks,
  listTracks,
  getTrack,
  renderTrackMarkdown,
};
