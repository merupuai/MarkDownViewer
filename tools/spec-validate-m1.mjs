#!/usr/bin/env node
// Step 01B deterministic spec validation for M1.
import fs from 'node:fs';
import path from 'node:path';

const MILESTONE = 'M1';
const BUILD_DIR = `_cobolt-output/latest/build/${MILESTONE}`;
const SPECS_DIR = `${BUILD_DIR}/${MILESTONE}-story-specs`;
const SPECS_INDEX = `${BUILD_DIR}/${MILESTONE}-story-specs-index.json`;
const TASK_MANIFEST = `${BUILD_DIR}/${MILESTONE}-task-manifest.json`;

const manifest = JSON.parse(fs.readFileSync(TASK_MANIFEST, 'utf8'));
const index = JSON.parse(fs.readFileSync(SPECS_INDEX, 'utf8'));

// 1B.1 Coverage
const manifestStories = [];
for (const epic of manifest.epics || []) for (const s of epic.stories || []) manifestStories.push(s.id);
const specStories = index.specs.map((s) => s.storyId);
const missing = manifestStories.filter((s) => !specStories.includes(s));

// 1B.2 File ownership — parse File Map table in each spec
const fileMap = {};
const specFiles = fs.readdirSync(SPECS_DIR).filter((f) => f.endsWith('-impl-spec.md'));
for (const sf of specFiles) {
  const storyId = sf.replace('-impl-spec.md', '');
  const content = fs.readFileSync(path.join(SPECS_DIR, sf), 'utf8');
  // Row pattern: | `path` | action | task | purpose |
  const rowRe = /\|\s*`([^`]+)`\s*\|\s*(create|modify)\s*\|/gi;
  let m;
  while ((m = rowRe.exec(content)) !== null) {
    const fp = m[1].trim();
    const action = m[2].toLowerCase();
    (fileMap[fp] = fileMap[fp] || []).push({ storyId, action });
  }
}
const conflicts = [];
const warnings = [];
for (const [fp, entries] of Object.entries(fileMap)) {
  const creates = entries.filter((e) => e.action === 'create');
  if (creates.length > 1) conflicts.push({ file: fp, stories: creates.map((e) => e.storyId), severity: 'high' });
  const mods = entries.filter((e) => e.action === 'modify');
  if (mods.length > 1) warnings.push({ file: fp, stories: mods.map((e) => e.storyId), severity: 'low' });
}

// 1B.3 Interface consistency — Integration Points cross-refs
const mismatches = [];
for (const sf of specFiles) {
  const storyId = sf.replace('-impl-spec.md', '');
  const content = fs.readFileSync(path.join(SPECS_DIR, sf), 'utf8');
  const integ = content.match(/### Integration Points[\s\S]*?(?=\n### |\n## |$)/);
  if (integ) {
    const refs = [...new Set(integ[0].match(/\bE[A-Z0-9_]+-S\d+\b/g) || [])];
    for (const ref of refs) {
      if (ref !== storyId && !specStories.includes(ref)) {
        mismatches.push({ type: 'orphan-reference', from: storyId, to: ref, severity: 'medium' });
      }
    }
  }
}

const conflictCount = conflicts.length;
const warningCount = warnings.length;
const mismatchCount = mismatches.length;
const missingCount = missing.length;
const totalStories = manifestStories.length;
const totalSpecs = index.totalSpecs;
const passed = missingCount === 0 && conflictCount === 0;

// Write validation + report
const validation = {
  milestone: MILESTONE,
  validatedAt: new Date().toISOString(),
  coverage: { totalStories, specsGenerated: totalSpecs, missingSpecs: missingCount, missing },
  fileConflicts: { count: conflictCount, conflicts, warnings: warningCount },
  interfaceConsistency: { mismatchCount, mismatches },
  fixAttempts: 0,
  passed,
};

fs.writeFileSync(`${BUILD_DIR}/${MILESTONE}-spec-validation.json`, JSON.stringify(validation, null, 2));

const report = `# Spec Validation Report — ${MILESTONE}

**Generated**: ${new Date().toISOString()}

## Coverage
- Stories in manifest: ${totalStories}
- Specs generated: ${totalSpecs}
- Missing specs: ${missingCount}${missingCount ? `\n  - ${missing.join(', ')}` : ''}

## File Ownership
- Conflicts (CREATE collisions): ${conflictCount}${conflictCount ? `\n${conflicts.map((c) => `  - \`${c.file}\` claimed by: ${c.stories.join(', ')}`).join('\n')}` : ''}
- Warnings (shared modifications): ${warningCount}

## Interface Consistency
- Cross-story mismatches: ${mismatchCount}${mismatchCount ? `\n${mismatches.map((m) => `  - ${m.from} references ${m.to} (orphan)`).join('\n')}` : ''}

## Verdict
${passed ? '**PASS** — all stories have specs, no file-creation conflicts. Ready for TDD.' : '**FAIL** — spec issues prevent TDD.'}

## Notes
- Total files tracked across all specs: ${Object.keys(fileMap).length}
- Task manifest fileOwnership enforces exclusive ownership at the manifest layer; spec File Map tables derive from the same ownership set.
`;

fs.writeFileSync(`${BUILD_DIR}/${MILESTONE}-spec-consistency-report.md`, report);

console.log(
  JSON.stringify(
    {
      passed,
      totalStories,
      totalSpecs,
      missingCount,
      conflictCount,
      warningCount,
      mismatchCount,
      filesTotal: Object.keys(fileMap).length,
    },
    null,
    2,
  ),
);
