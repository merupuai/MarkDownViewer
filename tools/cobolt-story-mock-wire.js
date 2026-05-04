#!/usr/bin/env node

// cobolt-story-mock-wire — PR-2 Batch C (v0.53.0).
//
// Reads M{n}-S{y}-story-contracts.json (emitted by cobolt-story-contract-emit
// at Step 01A) and generates stub artifacts under
// _cobolt-output/latest/build/{M}/mocks/{S}/ that satisfy each declared
// contract. Stubs are deterministic JSON descriptors — the actual stub
// scaffolding (server handlers, type aliases, fixture files) lands in PR-4
// when 02a-wire-deps wires this tool into the build pipeline.
//
// Usage:
//   node tools/cobolt-story-mock-wire.js wire --milestone M1 [--story S1] [--cwd PATH] [--json]
//   node tools/cobolt-story-mock-wire.js status --milestone M1 [--cwd PATH] [--json]
//   node tools/cobolt-story-mock-wire.js --help
//
// Exit codes: 0 ok/no contracts, 1 invalid input, 3 unwritable output.

const fs = require('node:fs');
const path = require('node:path');

const MILESTONE_RE = /^M\d+$/;

function buildRoot(cwd, milestone) {
  return path.join(cwd, '_cobolt-output', 'latest', 'build', milestone);
}

function checkpointRoot(cwd) {
  return path.join(cwd, '_cobolt-output', 'latest', 'build', 'checkpoints');
}

function relativePath(cwd, filePath) {
  return path.relative(cwd, filePath).replace(/\\/g, '/');
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function writeWireRecords(cwd, milestone, result) {
  const summaryPath = path.join(buildRoot(cwd, milestone), `${milestone}-02a-wire-deps.json`);
  const checkpointPath = path.join(checkpointRoot(cwd), `${milestone}-02a-wire-deps.json`);
  try {
    writeJson(summaryPath, result);
    writeJson(checkpointPath, {
      checkpoint: 'wire-deps',
      milestone,
      status: result.ok === false ? 'failed' : 'completed',
      verdict: result.verdict,
      generatedAt: result.generatedAt,
      generatedBy: 'cobolt-story-mock-wire',
      artifact: relativePath(cwd, summaryPath),
      metrics: {
        totalContractFiles: result.totalContractFiles || 0,
        declaredContractCount: result.declaredContractCount || 0,
        wiredCount: result.wiredCount || 0,
        pendingCount: result.pendingCount || 0,
        contractsExpected: result.contractsExpected === true,
      },
      nextStep: '03-tdd-green',
    });
    return {
      ...result,
      summaryPath,
      checkpointPath,
    };
  } catch (err) {
    return {
      ...result,
      ok: false,
      verdict: 'unwritable',
      error: `could not write wire-deps records: ${err.message}`,
      _exit: 3,
    };
  }
}

function listContractFiles(cwd, milestone) {
  const dir = buildRoot(cwd, milestone);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(`${milestone}-`) && n.endsWith('-story-contracts.json'))
    .map((n) => path.join(dir, n));
}

function buildApiStub(contract) {
  const { method, path: route } = contract.spec;
  return {
    kind: 'api-stub',
    contractId: contract.id,
    handler: `mock_${contract.providerStory}_${contract.id.replace(/-/g, '_').toLowerCase()}`,
    method,
    path: route,
    response: {
      status: 200,
      body: { __mock: true, contractId: contract.id, providerStory: contract.providerStory },
    },
    note: 'PR-2 stub descriptor — actual handler scaffolding lands in PR-4 step 02a',
  };
}

function buildDataStub(contract) {
  return {
    kind: 'data-stub',
    contractId: contract.id,
    entity: contract.spec.entity,
    fixturePath: `fixtures/${contract.id.toLowerCase()}.json`,
    note: 'PR-2 stub descriptor',
  };
}

function buildEventStub(contract) {
  return {
    kind: 'event-stub',
    contractId: contract.id,
    eventName: contract.spec.eventName,
    channel: contract.spec.channel || 'default',
    note: 'PR-2 stub descriptor',
  };
}

function buildTypeStub(contract) {
  return {
    kind: 'type-stub',
    contractId: contract.id,
    symbol: contract.spec.symbol,
    language: contract.spec.language,
    note: 'PR-2 stub descriptor',
  };
}

function buildStub(contract) {
  switch (contract.type) {
    case 'API':
      return buildApiStub(contract);
    case 'DATA':
      return buildDataStub(contract);
    case 'EVT':
      return buildEventStub(contract);
    case 'TYPE':
      return buildTypeStub(contract);
    default:
      return null;
  }
}

function wire({ cwd, milestone, story } = {}) {
  cwd = cwd || process.cwd();
  if (!MILESTONE_RE.test(milestone || '')) {
    return { ok: false, error: 'milestone must match M\\d+', _exit: 1 };
  }
  const contractFiles = listContractFiles(cwd, milestone);
  if (contractFiles.length === 0) {
    return writeWireRecords(cwd, milestone, {
      schema: 'cobolt-story-mock-wire@1',
      milestone,
      generatedAt: new Date().toISOString(),
      contractsExpected: false,
      totalContractFiles: 0,
      declaredContractCount: 0,
      storiesProcessed: 0,
      wiredCount: 0,
      pendingCount: 0,
      results: [],
      verdict: 'pending',
      ok: true,
      note: 'No story-contracts files were present; greenfield/no inter-story dependency path.',
    });
  }
  const out = [];
  let declaredContractCount = 0;
  for (const file of contractFiles) {
    let contracts;
    try {
      contracts = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      out.push({ file, ok: false, error: err.message });
      continue;
    }
    if (story && contracts.storyId !== story) continue;
    const sid = contracts.storyId;
    const declaredContracts = Array.isArray(contracts.contracts) ? contracts.contracts : [];
    declaredContractCount += declaredContracts.length;
    const stubs = declaredContracts.map(buildStub).filter(Boolean);
    const mocksDir = path.join(buildRoot(cwd, milestone), 'mocks', sid);
    const indexPath = path.join(mocksDir, 'index.json');
    const indexData = {
      schema: 'cobolt-story-mock-wire@1',
      milestoneId: milestone,
      storyId: sid,
      generatedAt: new Date().toISOString(),
      stubs,
      stubCount: stubs.length,
      declaredContractCount: declaredContracts.length,
    };
    try {
      fs.mkdirSync(mocksDir, { recursive: true });
      fs.writeFileSync(indexPath, `${JSON.stringify(indexData, null, 2)}\n`, { mode: 0o600 });
      out.push({
        storyId: sid,
        ok: true,
        stubCount: stubs.length,
        declaredContractCount: declaredContracts.length,
        indexPath,
      });
    } catch (err) {
      out.push({ storyId: sid, ok: false, error: err.message, indexPath });
    }
  }
  const pending = out.filter((entry) => entry.ok === false);
  return writeWireRecords(cwd, milestone, {
    schema: 'cobolt-story-mock-wire@1',
    milestone,
    generatedAt: new Date().toISOString(),
    contractsExpected: true,
    totalContractFiles: contractFiles.length,
    declaredContractCount,
    storiesProcessed: out.length,
    wiredCount: out.length - pending.length,
    pendingCount: pending.length,
    results: out,
    verdict: pending.length === 0 ? 'all-wired' : 'pending',
    ok: pending.length === 0,
  });
}

function status({ cwd, milestone } = {}) {
  cwd = cwd || process.cwd();
  if (!MILESTONE_RE.test(milestone || '')) {
    return { ok: false, error: 'milestone must match M\\d+', _exit: 1 };
  }
  const contractFiles = listContractFiles(cwd, milestone);
  const mocksRoot = path.join(buildRoot(cwd, milestone), 'mocks');
  const wiredStoryDirs = fs.existsSync(mocksRoot) ? fs.readdirSync(mocksRoot) : [];
  const stories = contractFiles.map((f) => {
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    return {
      storyId: c.storyId,
      contractCount: (c.contracts || []).length,
      wired: wiredStoryDirs.includes(c.storyId),
    };
  });
  const allWired = stories.length > 0 && stories.every((s) => s.wired);
  const wiredCount = stories.filter((s) => s.wired).length;
  const pendingCount = stories.length - wiredCount;
  return {
    schema: 'cobolt-story-mock-wire@1',
    milestone,
    contractFiles: contractFiles.length,
    stories,
    wiredCount,
    pendingCount,
    verdict: allWired ? 'all-wired' : 'pending',
    ok: true,
  };
}

function printHelp() {
  process.stdout.write(
    `cobolt-story-mock-wire — generate per-story stub descriptors from story-contracts\n\n` +
      `Usage:\n` +
      `  node tools/cobolt-story-mock-wire.js wire   --milestone M1 [--story S1] [--cwd PATH] [--json]\n` +
      `  node tools/cobolt-story-mock-wire.js status --milestone M1 [--cwd PATH] [--json]\n` +
      `Exit: 0 ok/no contracts, 1 invalid input, 3 unwritable output\n`,
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--milestone') args.milestone = argv[++i];
    else if (a === '--story') args.story = argv[++i];
    else if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  const cmd = argv[0];
  if (!cmd) {
    printHelp();
    return 0;
  }
  const args = parseArgs(argv.slice(1));
  let result;
  if (cmd === 'wire') result = wire(args);
  else if (cmd === 'status') result = status(args);
  else {
    process.stderr.write(`unknown command: ${cmd}\n`);
    return 1;
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok === false) {
    process.stderr.write(`error: ${result.error}\n`);
  } else if (cmd === 'wire') {
    process.stdout.write(`wired ${result.storiesProcessed} stor${result.storiesProcessed === 1 ? 'y' : 'ies'}\n`);
  } else {
    const wiredCount = result.stories.filter((s) => s.wired).length;
    process.stdout.write(
      `mock-wire status: ${wiredCount}/${result.stories.length} stories wired (${result.verdict})\n`,
    );
  }
  if (result._exit) return result._exit;
  return result.ok === false ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { wire, status, buildStub, buildApiStub, buildDataStub, buildEventStub, buildTypeStub };
