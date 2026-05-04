#!/usr/bin/env node

// CoBolt Fix Architecture Approval Summary
//
// Converts arch-mutation-proposal.md into the machine-readable
// architecture-mutation-approval.json contract consumed by RCA/release gates.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_OUTPUT_DIR = path.join('_cobolt-output', 'latest', 'fix');

function readText(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parseValue(raw) {
  const value = String(raw || '').trim();
  if (/^\[.*\]$/u.test(value)) {
    return value
      .slice(1, -1)
      .split(',')
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  if (value === 'null' || value === '') return null;
  return value.replace(/^['"]|['"]$/g, '');
}

function parseProposalMetadata(text) {
  const out = { verdict: 'PENDING', approvedBy: [], appliedAt: null };
  const frontmatter = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  const blocks = [];
  if (frontmatter) blocks.push(frontmatter[1]);
  const verdictBlock = String(text || '').match(/```yaml\s*\n([\s\S]*?verdict:[\s\S]*?)\n```/iu);
  if (verdictBlock) blocks.push(verdictBlock[1]);
  for (const block of blocks) {
    for (const line of block.split(/\r?\n/u)) {
      const match = line.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/u);
      if (match) out[match[1]] = parseValue(match[2]);
    }
  }
  const idMatch = String(text || '').match(/\*\*Proposal ID:\*\*\s*([A-Z]+-[A-Za-z0-9-]+)/u);
  if (idMatch) out.proposalId = idMatch[1];
  if (!Array.isArray(out.approvedBy)) out.approvedBy = out.approvedBy ? [out.approvedBy] : [];
  out.verdict = String(out.verdict || 'PENDING').toUpperCase();
  return out;
}

function summarizeArchitectureApproval(options = {}) {
  const outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
  const proposalPath = options.proposal || path.join(outputDir, 'arch-mutation-proposal.md');
  const text = readText(proposalPath);
  const generatedAt = new Date().toISOString();
  if (!text) {
    return {
      version: '1.0.0',
      generatedAt,
      generatedBy: 'cobolt-fix-architecture-approval',
      required: false,
      status: 'not_requested',
      passed: true,
      proposalPresent: false,
      proposalPath,
      issues: [],
    };
  }
  const metadata = parseProposalMetadata(text);
  const quorumSatisfied =
    metadata.approvedBy.includes('architecture-reviewer') && metadata.approvedBy.includes('security-reviewer');
  const approved = metadata.verdict === 'APPROVE';
  const declined = metadata.verdict === 'DECLINE' || metadata.verdict === 'DECLINE_TO_PROPOSE';
  const issues = [];
  if (!approved) issues.push(`proposal-verdict:${metadata.verdict}`);
  return {
    version: '1.0.0',
    generatedAt,
    generatedBy: 'cobolt-fix-architecture-approval',
    required: true,
    status: approved ? 'approved' : declined ? 'declined' : 'pending',
    passed: approved,
    proposalPresent: true,
    proposalPath,
    proposalId: metadata.proposalId || null,
    verdict: metadata.verdict,
    approvedBy: metadata.approvedBy,
    quorumSatisfied,
    appliedAt: metadata.appliedAt || null,
    issues,
  };
}

function parseArgs(argv) {
  const out = { outputDir: DEFAULT_OUTPUT_DIR, proposal: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir') out.outputDir = argv[++index] || out.outputDir;
    else if (arg === '--proposal') out.proposal = argv[++index] || null;
    else if (arg === '--json') out.json = true;
    else if (arg.startsWith('--')) out.unknown = arg;
  }
  return out;
}

function runSummarize(options = {}) {
  const summary = summarizeArchitectureApproval(options);
  writeJson(path.join(options.outputDir || DEFAULT_OUTPUT_DIR, 'architecture-mutation-approval.json'), summary);
  return summary;
}

function printUsage() {
  console.log(`
CoBolt Fix Architecture Approval

Usage:
  node tools/cobolt-fix-architecture-approval.js summarize [--proposal <path>] [--output-dir <dir>] [--json]
  node tools/cobolt-fix-architecture-approval.js check [--proposal <path>] [--output-dir <dir>] [--json]
`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArgs(rest);
  if (command !== 'summarize' && command !== 'check') {
    printUsage();
    return command ? 2 : 0;
  }
  const result = runSummarize(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[cobolt-fix-architecture-approval] ${result.status}`);
  return command === 'check' && !result.passed ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  parseProposalMetadata,
  runSummarize,
  summarizeArchitectureApproval,
};
