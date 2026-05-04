const path = require('node:path');

const { createFinding, readJson, toPosix } = require('./_shared');

function run(context) {
  const planningDir = context.planningDir;
  const projectRoot = context.projectRoot;
  const loopPath = path.join(planningDir, 'planning-loop-verdict.json');
  const controlPath = path.join(planningDir, 'planning-control-map.json');
  const signaturePath = path.join(planningDir, 'planning-evidence-signature.json');
  const loopVerdict = readJson(loopPath);
  const controlMap = readJson(controlPath);
  const signature = readJson(signaturePath);
  const findings = [];

  if (loopVerdict?.status === 'blocked') {
    findings.push(
      createFinding({
        classId: 'G3',
        severity: 'critical',
        artifact: toPosix(path.relative(projectRoot, loopPath)),
        evidence: {
          status: loopVerdict.status,
          primaryBlocker: loopVerdict.blockingReasons?.[0] || null,
          recoveryCommand: loopVerdict.recoveryCommands?.[0] || null,
        },
        remediationHint: loopVerdict.recoveryCommands?.[0] || 'Run node tools/index.js doctor plan',
        detectorId: 'vnext-control-ingest',
        title: 'Plan vNext close authority blocked',
      }),
    );
  } else if (loopVerdict?.status === 'advisory') {
    findings.push(
      createFinding({
        classId: 'G3',
        severity: 'advisory',
        artifact: toPosix(path.relative(projectRoot, loopPath)),
        evidence: {
          status: loopVerdict.status,
          primaryAdvisory: loopVerdict.advisoryReasons?.[0] || null,
        },
        remediationHint: loopVerdict.recoveryCommands?.[0] || 'Review planning-loop-verdict.json advisories',
        detectorId: 'vnext-control-ingest',
        title: 'Plan vNext close authority advisory',
      }),
    );
  }

  const unmappedStrict = (controlMap?.controls || []).filter(
    (control) => control.tier === 'strict' && control.status !== 'mapped',
  );
  if (unmappedStrict.length > 0) {
    findings.push(
      createFinding({
        classId: 'G3',
        severity: 'critical',
        artifact: toPosix(path.relative(projectRoot, controlPath)),
        evidence: {
          unmappedStrictControls: unmappedStrict.map((control) => control.id),
        },
        remediationHint:
          'Run node tools/index.js planning-control-map generate --json after refreshing plan-close evidence',
        detectorId: 'vnext-control-ingest',
        title: 'Plan vNext strict controls are unmapped',
      }),
    );
  }

  if (signature && signature.summary?.status === 'blocked') {
    findings.push(
      createFinding({
        classId: 'G3',
        severity: 'critical',
        artifact: toPosix(path.relative(projectRoot, signaturePath)),
        evidence: {
          status: signature.summary.status,
          firstFinding: signature.findings?.[0] || null,
        },
        remediationHint:
          'Run node tools/index.js planning-evidence-signature generate --json after refreshing authority inputs',
        detectorId: 'vnext-control-ingest',
        title: 'Plan vNext evidence signature blocked',
      }),
    );
  }

  return { detectorId: 'vnext-control-ingest', findings };
}

module.exports = { run };
