const { createFinding, dedupeFindings } = require('./_shared');
const { collectAuditTaxonomyFindings } = require('../cobolt-plan-output-audit');

function run(context) {
  const auditTaxonomy =
    context.auditReport?.taxonomy?.findings && Array.isArray(context.auditReport.taxonomy.findings)
      ? context.auditReport.taxonomy
      : collectAuditTaxonomyFindings(context.auditReport?.results || []);
  const findings = [];

  for (const finding of auditTaxonomy.findings || []) {
    const classMeta = context.taxonomy.classById.get(finding.classId);
    if (!classMeta?.detectors?.includes('audit-bridge')) continue;
    findings.push(
      createFinding({
        ...finding,
        detectorId: 'audit-bridge',
        remediationHint:
          finding.remediationHint || 'Resolve the underlying plan-output-audit finding before build handoff continues.',
      }),
    );
  }

  return {
    detectorId: 'audit-bridge',
    findings: dedupeFindings(findings),
  };
}

module.exports = { id: 'audit-bridge', run };
