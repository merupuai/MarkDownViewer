#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteJSON } = require('../lib/cobolt-atomic-write');

function argValue(args, name, fallback = null) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] || fallback : fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function labelsFrom(issue) {
  const labels = issue.labels || issue.fields?.labels || [];
  return labels.map((label) => (typeof label === 'string' ? label : label.name || label.value)).filter(Boolean);
}

function inferWorkflow(issue) {
  const text = `${issue.title || issue.summary || ''} ${labelsFrom(issue).join(' ')}`.toLowerCase();
  if (/\bbug|incident|error|failure|fix\b/.test(text)) return 'fix';
  if (/\breview|audit\b/.test(text)) return 'review';
  if (/\bbuild|implement\b/.test(text)) return 'build';
  return 'plan-feature';
}

function createWorkflowPacket(provider, issue) {
  const id = String(issue.number || issue.iid || issue.key || issue.id || 'unknown');
  return {
    schema: 'cobolt-workflow-packet@1',
    provider,
    source: {
      id,
      url: issue.html_url || issue.web_url || issue.url || issue.permalink || null,
    },
    workItem: {
      title: issue.title || issue.summary || issue.name || id,
      body: issue.body || issue.description || '',
      labels: labelsFrom(issue),
    },
    cobolt: {
      recommendedWorkflow: inferWorkflow(issue),
      sourceLinkRetained: Boolean(issue.html_url || issue.web_url || issue.url || issue.permalink),
      approvalKind: null,
    },
  };
}

function createApprovalRequest(kind, packet, options = {}) {
  return {
    schema: 'cobolt-workflow-approval@1',
    generatedAt: new Date().toISOString(),
    kind,
    provider: options.provider || packet.provider,
    source: packet.source,
    requestedApprovers: options.approvers || [],
    command: options.command || null,
    reason: options.reason || null,
  };
}

function cmdIssuePacket(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const provider = argValue(args, '--provider', 'github');
  const input = path.resolve(root, argValue(args, '--input', args[0] || 'issue.json'));
  const output = path.resolve(root, argValue(args, '--output', '_cobolt-output/integrations/workflow-packet.json'));
  const packet = createWorkflowPacket(provider, readJson(input));
  atomicWriteJSON(output, packet, { mode: 0o600 });
  console.log(JSON.stringify({ output, packet }, null, 2));
  return 0;
}

function cmdApproval(args) {
  const root = path.resolve(argValue(args, '--root', process.cwd()));
  const input = path.resolve(
    root,
    argValue(args, '--packet', args[0] || '_cobolt-output/integrations/workflow-packet.json'),
  );
  const output = path.resolve(root, argValue(args, '--output', '_cobolt-output/integrations/approval-request.json'));
  const approvers = String(argValue(args, '--approvers', ''))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const request = createApprovalRequest(argValue(args, '--kind', 'gate-bypass'), readJson(input), {
    approvers,
    command: argValue(args, '--command'),
    reason: argValue(args, '--reason'),
  });
  atomicWriteJSON(output, request, { mode: 0o600 });
  console.log(JSON.stringify({ output, request }, null, 2));
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] || 'issue-packet';
  const args = argv.slice(1);
  if (cmd === 'issue-packet') return cmdIssuePacket(args);
  if (cmd === 'approval-request') return cmdApproval(args);
  console.log('Usage: node tools/cobolt-workflow-integration.js issue-packet|approval-request');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { main, createWorkflowPacket, createApprovalRequest };
