const { createFinding, dedupeFindings } = require('./_shared');

function run(context) {
  const previous = context.previousReport?.sources || {};
  const current = context.currentFingerprints || {};
  const findings = [];

  if (
    previous.inputFingerprint &&
    current.inputFingerprint &&
    previous.inputFingerprint === current.inputFingerprint &&
    previous.planningFingerprint &&
    current.planningFingerprint &&
    previous.planningFingerprint !== current.planningFingerprint
  ) {
    findings.push(
      createFinding({
        classId: 'E3',
        severity: 'advisory',
        artifact: 'planning packet',
        evidence: {
          previousPlanningFingerprint: previous.planningFingerprint,
          currentPlanningFingerprint: current.planningFingerprint,
          inputFingerprint: current.inputFingerprint,
        },
        remediationHint: 'Investigate why equivalent planning inputs generated a different packet fingerprint.',
        detectorId: 'determinism-check',
      }),
    );
  }

  return {
    detectorId: 'determinism-check',
    findings: dedupeFindings(findings),
  };
}

module.exports = { id: 'determinism-check', run };
