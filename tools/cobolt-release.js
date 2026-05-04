#!/usr/bin/env node

// CoBolt Release Manager - version bump, sync, commit, tag, push
//
// Usage:
//   node tools/cobolt-release.js release --bump patch --milestone M1 --push
//   node tools/cobolt-release.js release --bump minor --push
//   node tools/cobolt-release.js release --bump major --dry-run
//   node tools/cobolt-release.js current                          # Show current version
//   node tools/cobolt-release.js next [--bump patch|minor|major]  # Preview next version
//   node tools/cobolt-release.js preflight                        # Run safety checks
//   node tools/cobolt-release.js log                              # Show release history
//
// Safety:
//   - Preflight validates clean tree, valid semver, tag uniqueness
//   - Rollback on commit failure (restores package.json + sync)
//   - Push failure returns a failed release status (commit+tag may exist locally)
//   - Never force-pushes

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const configDrift = require('../lib/cobolt-config-drift');
const reliabilityGuard = require('../lib/cobolt-reliability-guard');
const { SBOMGenerator } = require('./cobolt-sbom');
// History-preserving writer for .cobolt/project-version.json — central-mode
// writes must keep the append-only ledger intact so release history is auditable.
let projectVersionTool = null;
try {
  projectVersionTool = require('./cobolt-project-version');
} catch {
  // Back-compat: cobolt-release must continue to work even if the central
  // version tool is absent (old deployments). Falls back to regex writer.
}

// -- Release log path ----------------------------------------
const OUTPUT_DIR = '_cobolt-output';
const RELEASE_LOG = 'release-log.json';
const PROJECT_VERSION_FILE = path.join('.cobolt', 'project-version.json');

function evaluateReleaseSbomEvidence(generator, bom) {
  if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== '1.5') {
    return {
      pass: false,
      message: `Invalid SBOM shape: ${bom.bomFormat}@${bom.specVersion}`,
    };
  }

  const manifestCount = Array.isArray(generator.discoveredManifests) ? generator.discoveredManifests.length : 0;
  if (generator.components.length === 0 && manifestCount === 0) {
    return {
      pass: false,
      message: 'SBOM scan found no package manifests or dependency components',
    };
  }

  const appName = bom.metadata?.component?.name || path.basename(generator.projectDir || process.cwd());
  return {
    pass: true,
    message:
      generator.components.length === 0
        ? `application ${appName} has no runtime dependency components, CycloneDX 1.5`
        : `${generator.components.length} component(s) scanned, CycloneDX 1.5`,
  };
}

function normalizeGitPath(file) {
  return String(file || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
}

function isIgnoredReleaseDirtyFile(file) {
  const normalized = normalizeGitPath(file);
  return (
    normalized.startsWith('_cobolt-output/') ||
    normalized.includes('cobolt/cache/') ||
    normalized.startsWith('node_modules/') ||
    normalized.startsWith('.cobolt/')
  );
}

function releaseDirtyLines(statusOutput) {
  return String(statusOutput || '')
    .split('\n')
    .filter(Boolean)
    .filter((line) => !isIgnoredReleaseDirtyFile(line.slice(3).trim()));
}

function collectReleaseStageFiles({ diffOutput = '', cachedOutput = '', versionSource = null, mirrors = [] } = {}) {
  const allowed = new Set(
    ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'VERSION', versionSource, ...mirrors]
      .filter(Boolean)
      .map(normalizeGitPath),
  );
  const files = new Set(['package.json']);
  for (const output of [diffOutput, cachedOutput]) {
    for (const file of String(output || '')
      .split('\n')
      .filter(Boolean)) {
      const normalized = normalizeGitPath(file);
      if (allowed.has(normalized)) files.add(normalized);
    }
  }
  if (versionSource) files.add(normalizeGitPath(versionSource));
  return [...files];
}

function normalizeGitOutput(args, output) {
  const raw = String(output || '');
  if (args?.[0] === 'status' && args.includes('--porcelain')) {
    return raw.replace(/(?:\r?\n)+$/g, '');
  }
  return raw.trim();
}

/**
 * Resolve the authoritative version source for a project. Prefers the CoBolt
 * central file registered by init (greenfield) and falls back to package.json
 * (brownfield/inflight or legacy projects initialized before v0.18).
 *
 * @param {string} projectDir
 * @returns {{ mode: 'central'|'native', sourcePath: string, mirrors: string[], state: object|null }}
 */
function resolveVersionSource(projectDir) {
  const statePath = path.join(projectDir, 'cobolt-state.json');
  let state = null;
  if (fs.existsSync(statePath)) {
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch {
      state = null;
    }
  }

  const record = state?.projectVersion;
  const centralAbs = path.join(projectDir, PROJECT_VERSION_FILE);
  const centralExists = fs.existsSync(centralAbs);

  if (record && record.mode === 'central' && centralExists) {
    const mirrors = Array.isArray(record.mirrors) ? record.mirrors.slice() : [];
    if (!mirrors.includes('package.json') && fs.existsSync(path.join(projectDir, 'package.json'))) {
      mirrors.push('package.json');
    }
    return { mode: 'central', sourcePath: PROJECT_VERSION_FILE, mirrors, state };
  }

  if (record && record.mode === 'native' && record.source) {
    return { mode: 'native', sourcePath: record.source, mirrors: [], state };
  }

  // Fallback: legacy project without projectVersion state. Prefer central file
  // if it happens to exist, otherwise use package.json to preserve old behavior.
  if (centralExists) {
    const mirrors = fs.existsSync(path.join(projectDir, 'package.json')) ? ['package.json'] : [];
    return { mode: 'central', sourcePath: PROJECT_VERSION_FILE, mirrors, state };
  }
  return { mode: 'native', sourcePath: 'package.json', mirrors: [], state };
}

function readVersionFromFile(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    if (absPath.endsWith('.json')) {
      const parsed = JSON.parse(raw);
      return typeof parsed.version === 'string' ? parsed.version : null;
    }
    if (absPath.endsWith('.toml')) {
      const m = raw.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
      return m ? m[1] : null;
    }
    if (absPath.endsWith('.exs')) {
      const m = raw.match(/version:\s*["']([^"']+)["']/);
      return m ? m[1] : null;
    }
    if (absPath.endsWith('.xml')) {
      const m = raw.match(/<version>([^<]+)<\/version>/);
      return m ? m[1].trim() : null;
    }
    if (absPath.endsWith('.gradle') || absPath.endsWith('.gradle.kts')) {
      const m = raw.match(/^\s*version\s*=?\s*["']([^"']+)["']/m);
      return m ? m[1] : null;
    }
    return null;
  } catch {
    return null;
  }
}

function writeVersionToFile(absPath, newVersion) {
  const raw = fs.readFileSync(absPath, 'utf8');
  if (absPath.endsWith('.json')) {
    // Preserve formatting — swap the version string via targeted replace first,
    // falling back to parse+stringify only when the pattern is absent.
    const swapped = raw.replace(/"version"\s*:\s*"\d+\.\d+\.\d+([-+][^"]+)?"/, `"version": "${newVersion}"`);
    if (swapped !== raw) {
      fs.writeFileSync(absPath, swapped, 'utf8');
      return;
    }
    const parsed = JSON.parse(raw);
    parsed.version = newVersion;
    fs.writeFileSync(absPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return;
  }
  if (absPath.endsWith('.toml')) {
    const next = raw.replace(/^(\s*version\s*=\s*)["'][^"']+["']/m, `$1"${newVersion}"`);
    fs.writeFileSync(absPath, next, 'utf8');
    return;
  }
  if (absPath.endsWith('.exs')) {
    const next = raw.replace(/(version:\s*)["'][^"']+["']/, `$1"${newVersion}"`);
    fs.writeFileSync(absPath, next, 'utf8');
    return;
  }
  if (absPath.endsWith('.xml')) {
    const next = raw.replace(/<version>[^<]+<\/version>/, `<version>${newVersion}</version>`);
    fs.writeFileSync(absPath, next, 'utf8');
    return;
  }
  if (absPath.endsWith('.gradle') || absPath.endsWith('.gradle.kts')) {
    const next = raw.replace(/^(\s*version\s*=?\s*)["'][^"']+["']/m, `$1"${newVersion}"`);
    fs.writeFileSync(absPath, next, 'utf8');
    return;
  }
  throw new Error(`Unsupported version manifest: ${absPath}`);
}

function resolveReleaseTargetVersion(currentVersion, bump = 'patch', options = {}) {
  const { greenfieldInitialized = false, previousVersion = null } = options;

  if (greenfieldInitialized) {
    return {
      success: true,
      version: currentVersion,
      from: previousVersion || 'unversioned',
      type: 'initialize-greenfield',
    };
  }

  const parts = (currentVersion || '').split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return { success: false, error: `Invalid semver: ${currentVersion}` };
  }

  const [major, minor, patchVersion] = parts;
  switch (bump) {
    case 'major':
      return { success: true, version: `${major + 1}.0.0`, from: currentVersion, type: bump };
    case 'minor':
      return { success: true, version: `${major}.${minor + 1}.0`, from: currentVersion, type: bump };
    case 'patch':
      return { success: true, version: `${major}.${minor}.${patchVersion + 1}`, from: currentVersion, type: bump };
    default:
      return { success: false, error: `Unknown bump type: ${bump}. Use patch, minor, or major.` };
  }
}

class ReleaseManager {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this.packageJsonPath = path.join(this.projectDir, 'package.json');
    this._refreshVersionSource();
  }

  _refreshVersionSource() {
    const resolved = resolveVersionSource(this.projectDir);
    this.versionSource = resolved;
    this.primaryVersionPath = path.join(this.projectDir, resolved.sourcePath);
    this.versionMirrors = resolved.mirrors.map((rel) => path.join(this.projectDir, rel));
  }

  // -- Git wrapper ------------------------------------------

  _git(args, opts = {}) {
    try {
      return {
        success: true,
        output: normalizeGitOutput(
          args,
          execFileSync('git', args, {
            cwd: this.projectDir,
            encoding: 'utf8',
            timeout: opts.timeout || 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
        ),
      };
    } catch (err) {
      return { success: false, output: (err.stderr || err.stdout || '').trim(), code: err.status };
    }
  }

  // -- Version helpers --------------------------------------

  /**
   * Read current version from the authoritative source (central file for
   * greenfield, native manifest for brownfield/inflight). Falls back to
   * package.json for backward compatibility.
   * @returns {string|null}
   */
  currentVersion() {
    if (fs.existsSync(this.primaryVersionPath)) {
      const version = readVersionFromFile(this.primaryVersionPath);
      if (version) return version;
    }
    try {
      const pkg = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf8'));
      return pkg.version || null;
    } catch {
      return null;
    }
  }

  /**
   * Write a new version to the primary source + all mirrors. When the primary
   * source is the central .cobolt/project-version.json file, delegate to the
   * cobolt-project-version tool so the append-only history ledger, bumpedAt,
   * bumpedBy, and planHash fields are preserved across release bumps.
   */
  _writeVersion(newVersion, bumpContext = {}) {
    const isCentral =
      projectVersionTool &&
      this.versionSource.mode === 'central' &&
      this.primaryVersionPath.endsWith(path.join('.cobolt', 'project-version.json'));

    if (isCentral) {
      // Read current, compute a 'set' bump through the history-preserving path.
      try {
        const current = readVersionFromFile(this.primaryVersionPath);
        if (current !== newVersion) {
          projectVersionTool.applyBump(this.projectDir, 'set', {
            to: newVersion,
            milestone: bumpContext.milestone || null,
            reason: bumpContext.reason || `cobolt-release ${current || '?'} → ${newVersion}`,
            by: 'cobolt-release',
            stage: 'release',
          });
        }
      } catch {
        // Fall through to regex writer on any ledger failure so release is
        // never blocked by history bookkeeping.
        writeVersionToFile(this.primaryVersionPath, newVersion);
      }
    } else {
      writeVersionToFile(this.primaryVersionPath, newVersion);
    }

    for (const mirror of this.versionMirrors) {
      if (fs.existsSync(mirror)) {
        try {
          writeVersionToFile(mirror, newVersion);
        } catch {
          // Non-fatal: mirror-side failures are surfaced via git diff downstream
        }
      }
    }
  }

  /**
   * Calculate next version by bump type.
   * @param {string} current - Current semver string (e.g. "1.2.3")
   * @param {'patch'|'minor'|'major'} type - Bump type
   * @returns {{ success: boolean, version?: string, error?: string }}
   */
  bumpVersion(current, type = 'patch') {
    return resolveReleaseTargetVersion(current, type);
  }

  // -- Preflight checks ------------------------------------

  /**
   * Validate all preconditions before release.
   * @returns {{ pass: boolean, checks: object[], currentVersion?: string }}
   */
  preflight() {
    const checks = [];
    let greenfieldInitialized = false;
    let previousVersion = null;

    // 1. Primary version source exists
    if (!fs.existsSync(this.primaryVersionPath) && !fs.existsSync(this.packageJsonPath)) {
      checks.push({
        check: 'version-source',
        pass: false,
        message: `No version source found (expected ${this.versionSource.sourcePath} or package.json). Run /cobolt-init first.`,
      });
      return { pass: false, checks };
    }
    checks.push({
      check: 'version-source',
      pass: true,
      source: this.versionSource.sourcePath,
      mode: this.versionSource.mode,
    });

    // 2. Version is valid semver (auto-init greenfield projects)
    let version = this.currentVersion();
    if (!version || !/^\d+\.\d+\.\d+([-+].+)?$/.test(version) || version === '0.0.0') {
      previousVersion = version || null;
      try {
        // Greenfield: initialize to 0.0.1 in the primary source (and mirror)
        if (!fs.existsSync(this.primaryVersionPath)) {
          fs.mkdirSync(path.dirname(this.primaryVersionPath), { recursive: true });
          if (this.primaryVersionPath.endsWith(PROJECT_VERSION_FILE.replace(/\\/g, '/').split('/').pop())) {
            fs.writeFileSync(
              this.primaryVersionPath,
              `${JSON.stringify({ $schema: 'cobolt-project-version/v1', version: '0.0.1', mode: 'central', source: 'cobolt', initializedAt: new Date().toISOString() }, null, 2)}\n`,
              'utf8',
            );
          }
        }
        this._writeVersion('0.0.1');
        version = '0.0.1';
        greenfieldInitialized = true;
        checks.push({ check: 'version', pass: true, version, greenfield: true, message: 'Initialized to 0.0.1' });
      } catch (err) {
        checks.push({
          check: 'version',
          pass: false,
          message: `Invalid version: ${version || 'none'} (${err.message})`,
        });
        return { pass: false, checks };
      }
    } else {
      checks.push({ check: 'version', pass: true, version });
    }

    // 2a. Project-version mirror drift (Tier 1) — every mirror listed in
    // .cobolt/project-version.json AND cobolt-state.projectVersion.mirrors
    // must match the authoritative version. Catches package.json/central-file
    // drift before it taints the release commit. Skipped in native mode and
    // on fresh greenfield bootstraps that have nothing to mirror yet.
    if (projectVersionTool && !greenfieldInitialized) {
      try {
        const driftResult = projectVersionTool.checkDrift(this.projectDir);
        if (driftResult.mode === 'central' && !driftResult.ok) {
          checks.push({
            check: 'project-version-drift',
            pass: false,
            message: `${driftResult.drifts.length} mirror(s) out of sync with ${driftResult.version}`,
            drifts: driftResult.drifts,
          });
          return { pass: false, checks, currentVersion: version };
        }
        checks.push({
          check: 'project-version-drift',
          pass: true,
          mode: driftResult.mode,
          mirrors: (driftResult.mirrors || []).length,
        });
      } catch (err) {
        // Drift tool failure is advisory — never block release on its own bug.
        checks.push({
          check: 'project-version-drift',
          pass: true,
          advisory: true,
          message: `drift-check skipped: ${err.message}`,
        });
      }
    }

    // 2b. Deploy-marker audit (audit P1-5, v0.66+) — Tier 1 source-only check.
    // Verifies the three CommonJS-pinning markers (source/hooks/package.json,
    // lib/package.json, tools/package.json) exist with `"type":"commonjs"`
    // BEFORE the release commit hashes the tree. Without these markers, every
    // CoBolt hook crashes with `ReferenceError: require is not defined` on
    // ESM-first consumer projects (Vite/Astro/Next.js with type:module). See
    // CLAUDE.md Architectural Invariants and source/hooks/CLAUDE.md.
    //
    // Exit-code contract (per tools/cobolt-deploy-marker-audit.js):
    //   0 — markers present + correct → pass
    //   1 — marker missing or wrong   → block release
    //   3 — infra error               → advisory (don't block on tool bug)
    //
    // Source-only mode: never returns exit 2 because there's no consumer install
    // tree to scan in this context.
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(this.projectDir, 'tools', 'cobolt-deploy-marker-audit.js'), '--source-only', '--json'],
        { cwd: this.projectDir, encoding: 'utf8' },
      );
      const exit = result.status;
      if (exit === 0) {
        checks.push({ check: 'deploy-markers', pass: true, mode: 'source-only' });
      } else if (exit === 1) {
        let detail = result.stderr || result.stdout || '(no detail)';
        try {
          const parsed = JSON.parse(result.stdout || '{}');
          if (parsed?.violations) detail = `violations: ${parsed.violations.length}`;
        } catch {
          /* stdout was not JSON; keep raw */
        }
        checks.push({
          check: 'deploy-markers',
          pass: false,
          message: `CommonJS marker audit failed (exit 1) — ${detail}. Fix source/hooks/package.json, lib/package.json, tools/package.json before release.`,
        });
        return { pass: false, checks, currentVersion: version };
      } else {
        // Exit 3 (infra) — advisory, never block release on tool bug.
        checks.push({
          check: 'deploy-markers',
          pass: true,
          advisory: true,
          message: `marker-audit skipped (exit ${exit}): ${result.stderr?.trim() || 'tool error'}`,
        });
      }
    } catch (err) {
      checks.push({
        check: 'deploy-markers',
        pass: true,
        advisory: true,
        message: `marker-audit dispatch failed: ${err.message}`,
      });
    }

    // 3. Inside a git repo
    const gitCheck = this._git(['rev-parse', '--is-inside-work-tree']);
    if (!gitCheck.success) {
      checks.push({ check: 'git-repo', pass: false, message: 'Not a git repository' });
      return { pass: false, checks };
    }
    checks.push({ check: 'git-repo', pass: true });

    // 4. Working tree is clean (ignoring pipeline output, cache, and build artifacts)
    const status = this._git(['status', '--porcelain', '--ignore-submodules']);
    if (status.success && status.output) {
      const dirty = releaseDirtyLines(status.output);
      if (dirty.length > 0) {
        // Auto-commit dirty files before release (security-filtered)
        // This handles the common case where merge-to-main leaves pipeline files uncommitted
        try {
          const { isSensitiveFile } = require('./cobolt-git-workflow');
          const safeFiles = dirty.map((l) => l.slice(3).trim()).filter((f) => !isSensitiveFile(f));
          if (safeFiles.length > 0) {
            const addR = this._git(['add', '--', ...safeFiles]);
            if (!addR.success) {
              checks.push({
                check: 'clean-tree',
                pass: false,
                message: `Unable to stage release files: ${addR.output}`,
              });
              return { pass: false, checks };
            }
            const commitR = this._git(['commit', '-m', 'chore: stage pipeline artifacts for release']);
            if (!commitR.success) {
              checks.push({
                check: 'clean-tree',
                pass: false,
                message: `Unable to auto-commit release files: ${commitR.output}`,
              });
              return { pass: false, checks };
            }
            const afterCommit = this._git(['status', '--porcelain', '--ignore-submodules']);
            const remaining = afterCommit.success ? releaseDirtyLines(afterCommit.output) : dirty;
            if (remaining.length > 0) {
              checks.push({
                check: 'clean-tree',
                pass: false,
                message: `${remaining.length} release-tracked change(s) remain after auto-commit`,
                files: remaining.slice(0, 10),
              });
              return { pass: false, checks };
            }
            checks.push({ check: 'clean-tree', pass: true, autoCommitted: safeFiles.length });
          } else {
            checks.push({ check: 'clean-tree', pass: true, message: 'Only sensitive files remain untracked' });
          }
        } catch {
          checks.push({
            check: 'clean-tree',
            pass: false,
            message: `${dirty.length} uncommitted change(s)`,
            files: dirty.slice(0, 10),
          });
          return { pass: false, checks };
        }
      } else {
        checks.push({ check: 'clean-tree', pass: true });
      }
    } else {
      checks.push({ check: 'clean-tree', pass: true });
    }

    // 5. Generated/runtime config is in sync with source-of-truth assets
    try {
      const driftReport = configDrift.evaluateConfigDrift(this.projectDir);
      configDrift.writeConfigDriftReport(this.projectDir, driftReport);
      checks.push({
        check: 'config-drift',
        pass: driftReport.summary.pass,
        message: driftReport.summary.pass
          ? `score ${driftReport.summary.score}%`
          : `${driftReport.summary.findings} drift finding(s) detected`,
      });
      if (!driftReport.summary.pass) {
        return { pass: false, checks };
      }
    } catch (err) {
      checks.push({ check: 'config-drift', pass: false, message: err.message });
      return { pass: false, checks };
    }

    // 6. Reliability guard before versioned release
    try {
      const reliabilityReport = reliabilityGuard.evaluateReliabilityGuard(this.projectDir);
      reliabilityGuard.writeReliabilityGuardReport(this.projectDir, reliabilityReport);
      checks.push({
        check: 'reliability-guard',
        pass: reliabilityReport.summary.pass,
        message: reliabilityReport.summary.pass
          ? `score ${reliabilityReport.summary.score}%`
          : `${reliabilityReport.summary.failures} blocking reliability issue(s)`,
      });
      if (!reliabilityReport.summary.pass) {
        return { pass: false, checks };
      }
    } catch (err) {
      checks.push({ check: 'reliability-guard', pass: false, message: err.message });
      return { pass: false, checks };
    }

    // 7. Release-evidence preflight: verify SBOM generator produces a non-empty
    //    CycloneDX 1.5 document. Blocks local release when supply-chain evidence
    //    cannot be produced — the published release workflow relies on this file.
    try {
      const gen = new SBOMGenerator(this.projectDir);
      gen.scan({ includeDev: false });
      if (
        gen.components.length === 0 &&
        (!Array.isArray(gen.discoveredManifests) || gen.discoveredManifests.length === 0)
      ) {
        checks.push({
          check: 'release-evidence',
          pass: false,
          message: 'SBOM scan returned zero components — cannot produce release evidence',
        });
        return { pass: false, checks };
      }
      const bom = gen.toBOM();
      if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== '1.5') {
        checks.push({
          check: 'release-evidence',
          pass: false,
          message: `Invalid SBOM shape: ${bom.bomFormat}@${bom.specVersion}`,
        });
        return { pass: false, checks };
      }
      checks.push({
        check: 'release-evidence',
        pass: true,
        message:
          gen.components.length === 0
            ? `application ${bom.metadata?.component?.name || path.basename(this.projectDir)} has no runtime dependency components, CycloneDX 1.5`
            : `${gen.components.length} component(s) scanned, CycloneDX 1.5`,
      });
    } catch (err) {
      checks.push({
        check: 'release-evidence',
        pass: false,
        message: `SBOM generator failed: ${err.message}`,
      });
      return { pass: false, checks };
    }

    // 8. UAT evidence (v0.35.0) — block release when the milestone being
    //    released has UI but no passing UAT verdict on disk. Closes the
    //    "v0.1.0 tagged without UAT" class. Bypass via COBOLT_RELEASE_UAT=0
    //    for emergencies; honored only with an audit log entry.
    try {
      const uatCheck = this._checkUATEvidence();
      checks.push(uatCheck);
      if (!uatCheck.pass) {
        return { pass: false, checks, currentVersion: version };
      }
    } catch (err) {
      // UAT check must never hard-fail on its own bug — but surface as advisory.
      checks.push({ check: 'uat-evidence', pass: true, advisory: true, message: err.message });
    }

    // 9. Current branch check (warn if not main, don't block)
    const branch = this._git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch.success && branch.output !== 'main' && branch.output !== 'master') {
      checks.push({
        check: 'branch',
        pass: true,
        warning: `On branch "${branch.output}" (not main) - release will still proceed`,
      });
    } else {
      checks.push({ check: 'branch', pass: true, branch: branch.output });
    }

    return { pass: true, checks, currentVersion: version, greenfieldInitialized, previousVersion };
  }

  /**
   * UAT evidence preflight (v0.35.0). Resolves the target milestone, then
   * requires either (a) a passing UAT verdict artifact for a UI milestone, or
   * (b) an explicit non-UI marker (L4 skipped-no-ui in validation-results).
   *
   * Resolution order for the target milestone:
   *   1. cobolt-state.json → pipeline.currentMilestone / build.currentMilestone
   *   2. Highest M{n} directory in _cobolt-output/reports/
   *   3. Fallback: skip with advisory (fresh project, nothing to validate)
   *
   * @returns {{check:'uat-evidence', pass:boolean, message:string, advisory?:boolean}}
   */
  _checkUATEvidence() {
    if (process.env.COBOLT_RELEASE_UAT === '0') {
      this._auditBypass('uat-evidence', 'COBOLT_RELEASE_UAT=0');
      return { check: 'uat-evidence', pass: true, message: 'bypassed via COBOLT_RELEASE_UAT=0 (audited)' };
    }

    const milestone = this._resolveTargetMilestone();
    if (!milestone) {
      return {
        check: 'uat-evidence',
        pass: true,
        advisory: true,
        message: 'no milestone context (fresh project / no reports yet)',
      };
    }

    const uatVerdictPath = path.join(
      this.projectDir,
      '_cobolt-output',
      'latest',
      'uat',
      `${milestone}-uat-verdict.json`,
    );
    const validationPath = path.join(
      this.projectDir,
      '_cobolt-output',
      'latest',
      'build',
      milestone,
      `${milestone}-validation-results.json`,
    );

    // Detect whether this milestone has UI. If validation-results indicates
    // L4 was skipped-no-ui, waive UAT. Otherwise UAT is mandatory.
    let hasUI = true;
    try {
      if (fs.existsSync(validationPath)) {
        const v = JSON.parse(fs.readFileSync(validationPath, 'utf8'));
        const L4 = v?.layers?.L4_playwright_ui || v?.layers?.L4 || null;
        if (L4 && L4.status === 'skipped-no-ui') hasUI = false;
      }
    } catch {
      /* treat as UI-present to fail-closed */
    }

    if (!hasUI) {
      return {
        check: 'uat-evidence',
        pass: true,
        message: `${milestone} declared non-UI (L4 skipped-no-ui) — UAT not required`,
      };
    }

    if (!fs.existsSync(uatVerdictPath)) {
      return {
        check: 'uat-evidence',
        pass: false,
        message:
          `${milestone} UAT verdict missing at ${uatVerdictPath}. Release blocked: ` +
          'UI milestones must ship with passing persona-driven UAT evidence. ' +
          'Run /cobolt-uat ' +
          milestone +
          ' --mode final, or set COBOLT_RELEASE_UAT=0 to bypass (audited).',
      };
    }
    try {
      const v = JSON.parse(fs.readFileSync(uatVerdictPath, 'utf8'));
      const outcome = String(v.verdict || v.outcome || '').toUpperCase();
      if (outcome !== 'EXIT_SUCCESS' && outcome !== 'PASS' && outcome !== 'PASSED') {
        return {
          check: 'uat-evidence',
          pass: false,
          message: `${milestone} UAT verdict exists but outcome=${outcome || '(empty)'} (need EXIT_SUCCESS).`,
        };
      }
      return {
        check: 'uat-evidence',
        pass: true,
        message: `${milestone} UAT ${outcome} (verdict present)`,
      };
    } catch (err) {
      return {
        check: 'uat-evidence',
        pass: false,
        message: `${milestone} UAT verdict unparseable: ${err.message}`,
      };
    }
  }

  _resolveTargetMilestone() {
    try {
      const stateFile = path.join(this.projectDir, 'cobolt-state.json');
      if (fs.existsSync(stateFile)) {
        const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const m = s?.pipeline?.currentMilestone || s?.build?.currentMilestone || s?.currentMilestone || null;
        if (m && /^M?\d+$/.test(String(m))) {
          return String(m).startsWith('M') ? m : `M${m}`;
        }
      }
    } catch {
      /* fall through */
    }
    try {
      const reportsDir = path.join(this.projectDir, '_cobolt-output', 'reports');
      if (!fs.existsSync(reportsDir)) return null;
      const nums = fs
        .readdirSync(reportsDir)
        .map((d) => {
          const m = d.match(/^M(\d+)$/);
          return m ? parseInt(m[1], 10) : null;
        })
        .filter((n) => Number.isInteger(n))
        .sort((a, b) => b - a);
      return nums.length > 0 ? `M${nums[0]}` : null;
    } catch {
      return null;
    }
  }

  _auditBypass(gate, env) {
    try {
      const dir = path.join(this.projectDir, '_cobolt-output', 'audit');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(
        path.join(dir, 'gate-skip-log.jsonl'),
        `${JSON.stringify({
          at: new Date().toISOString(),
          gate,
          tier: 1,
          outcome: 'bypassed',
          env,
          skill: 'cobolt-release',
        })}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* best effort */
    }
  }

  // -- Release execution -----------------------------------

  /**
   * Execute a versioned release.
   * @param {object} options
   * @param {'patch'|'minor'|'major'} options.bump - Bump type (default: 'patch')
   * @param {boolean} options.push - Push to remote (default: false)
   * @param {string|null} options.milestone - Milestone label (e.g. 'M1')
   * @param {boolean} options.dryRun - Preview only (default: false)
   * @returns {{ success: boolean, steps: object[], newVersion?: string, tag?: string, error?: string }}
   */
  release(options = {}) {
    const { bump = 'patch', push = false, milestone = null, dryRun = false } = options;
    const steps = [];

    // Step 1 - Preflight
    const pre = this.preflight();
    steps.push({ step: 'preflight', pass: pre.pass, checks: pre.checks });
    if (!pre.pass) {
      return { success: false, steps, error: 'Preflight checks failed' };
    }
    const currentVersion = pre.currentVersion;

    // Step 2 - Calculate new version
    const bumped = resolveReleaseTargetVersion(currentVersion, bump, {
      greenfieldInitialized: pre.greenfieldInitialized,
      previousVersion: pre.previousVersion,
    });
    if (!bumped.success) {
      steps.push({ step: 'bump-calc', success: false, error: bumped.error });
      return { success: false, steps, error: bumped.error };
    }
    const newVersion = bumped.version;
    steps.push({ step: 'bump-calc', success: true, from: bumped.from, to: newVersion, type: bumped.type });

    // Step 3 - Verify tag doesn't exist
    const tagList = this._git(['tag', '--list', `v${newVersion}`]);
    if (tagList.success && tagList.output === `v${newVersion}`) {
      steps.push({ step: 'tag-check', success: false, error: `Tag v${newVersion} already exists` });
      return { success: false, steps, error: `Tag v${newVersion} already exists - bump already done?` };
    }
    steps.push({ step: 'tag-check', success: true });

    // Dry run stops here
    if (dryRun) {
      steps.push({ step: 'dry-run', success: true, message: `Would release ${currentVersion} - ${newVersion}` });
      return { success: true, steps, dryRun: true, currentVersion, newVersion: newVersion, tag: `v${newVersion}` };
    }

    // Step 4 - Update the authoritative version source (+ mirrors)
    try {
      this._writeVersion(newVersion, { milestone, reason: `release ${currentVersion} → ${newVersion}` });
      steps.push({
        step: 'update-version',
        success: true,
        source: this.versionSource.sourcePath,
        mode: this.versionSource.mode,
        mirrors: this.versionMirrors.length,
      });
    } catch (err) {
      steps.push({ step: 'update-version', success: false, error: err.message });
      return { success: false, steps, error: `Failed to update version source (${this.versionSource.sourcePath})` };
    }

    // Step 5 - Run sync-version to propagate to all files
    const syncScript = path.join(this.projectDir, 'scripts', 'sync-version.js');
    if (fs.existsSync(syncScript)) {
      try {
        execFileSync('node', [syncScript], {
          cwd: this.projectDir,
          encoding: 'utf8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        steps.push({ step: 'sync-version', success: true });
      } catch (err) {
        steps.push({ step: 'sync-version', success: false, error: err.message, fatal: true });
        this._rollbackVersion(currentVersion);
        return { success: false, steps, error: 'Failed to sync version across release files' };
      }
    }

    // Step 6 - Stage only files changed by version bump
    const diffR = this._git(['diff', '--name-only']);
    // Also pick up untracked files from sync (e.g. package-lock.json changes)
    const untrackedR = this._git(['diff', '--name-only', '--cached']);
    const filesToStage = collectReleaseStageFiles({
      diffOutput: diffR.success ? diffR.output : '',
      cachedOutput: untrackedR.success ? untrackedR.output : '',
      versionSource: this.versionSource.sourcePath,
      mirrors: this.versionMirrors,
    });
    const stageR = this._git(['add', '--', ...filesToStage]);
    steps.push({ step: 'stage', success: stageR.success, files: filesToStage.length });
    if (!stageR.success) {
      this._rollbackVersion(currentVersion);
      return { success: false, steps, error: 'Failed to stage release version files' };
    }

    // v0.40.4 — Step 6.5: generate release notes from git log (prior-tag..HEAD).
    // Filters out internal CoBolt chore commits, lifecycle commits, and merge
    // commits. Writes to _cobolt-output/latest/release/release-notes-v{v}.md
    // for cobolt-dream + GitHub release consumption. Best-effort — never blocks
    // release if git log is unreadable.
    try {
      const notes = this._generateReleaseNotes(currentVersion, newVersion, milestone);
      if (notes) {
        const notesDir = path.join(this.projectDir, '_cobolt-output', 'latest', 'release');
        fs.mkdirSync(notesDir, { recursive: true });
        const notesPath = path.join(notesDir, `release-notes-v${newVersion}.md`);
        fs.writeFileSync(notesPath, notes);
        steps.push({ step: 'release-notes', success: true, path: notesPath, bytes: notes.length });
      } else {
        steps.push({ step: 'release-notes', success: true, skipped: 'no user-facing commits' });
      }
    } catch (err) {
      steps.push({ step: 'release-notes', success: false, error: err.message?.slice(0, 200) });
    }

    // Step 7 - Commit
    const commitMsg = milestone
      ? `chore: release v${newVersion} - ${milestone} complete`
      : `chore: release v${newVersion}`;
    const commitR = this._git(['commit', '-m', commitMsg]);
    if (!commitR.success) {
      steps.push({ step: 'commit', success: false, error: commitR.output });
      this._rollbackVersion(currentVersion);
      return { success: false, steps, error: 'Commit failed - version rolled back' };
    }
    steps.push({ step: 'commit', success: true, message: commitMsg });

    // Step 8 - Tag
    const tagAnnotation = milestone ? `Release v${newVersion} - ${milestone}` : `Release v${newVersion}`;
    const tagR = this._git(['tag', '-a', `v${newVersion}`, '-m', tagAnnotation]);
    steps.push({
      step: 'tag',
      success: tagR.success,
      tag: `v${newVersion}`,
      error: tagR.success ? undefined : tagR.output,
    });

    // Step 9 - Push (only if explicitly requested)
    if (push) {
      const pushCommit = this._git(['push', 'origin', 'HEAD'], { timeout: 60000 });
      steps.push({
        step: 'push-commit',
        success: pushCommit.success,
        error: pushCommit.success ? undefined : pushCommit.output,
      });

      const pushTag = this._git(['push', 'origin', `v${newVersion}`], { timeout: 60000 });
      steps.push({ step: 'push-tag', success: pushTag.success, error: pushTag.success ? undefined : pushTag.output });

      if (!pushCommit.success || !pushTag.success) {
        steps.push({
          step: 'push',
          success: false,
          error:
            'Push failed. Commit+tag may exist locally; run git push --tags origin HEAD after fixing remote access.',
        });
        return {
          success: false,
          steps,
          error: 'Release push failed',
          currentVersion,
          newVersion,
          tag: `v${newVersion}`,
          pushed: false,
        };
      }
    } else {
      steps.push({
        step: 'push-skipped',
        success: true,
        message: 'Push skipped. To publish: git push --tags origin HEAD',
      });
    }

    // Step 10 - Log the release
    this._logRelease(currentVersion, newVersion, bump, milestone);

    const result = {
      success: true,
      steps,
      currentVersion,
      newVersion,
      tag: `v${newVersion}`,
      pushed: push,
    };
    return result;
  }

  // -- Release notes (v0.40.4) ---------------------------------

  /**
   * Generate user-facing release notes from git log between the last tag and
   * HEAD. Excludes internal CoBolt lifecycle commits (chore/release,
   * chore/stage, chore/pipeline, chore/sync, chore/format), merge commits, and
   * commits matching the staging-artifact pattern.
   *
   * Returns a markdown string, or null if there are no user-facing commits.
   */
  _generateReleaseNotes(currentVersion, newVersion, milestone) {
    // Find the most recent tag preceding HEAD to serve as the range start.
    const lastTagR = this._git(['describe', '--tags', '--abbrev=0', 'HEAD^']);
    const range = lastTagR.success && lastTagR.output ? `${lastTagR.output}..HEAD` : 'HEAD~50..HEAD';
    // --no-merges filters merge commits; %H for sha, %s for subject line.
    const logR = this._git(['log', range, '--no-merges', '--pretty=format:%H|%s']);
    if (!logR.success || !logR.output) return null;

    const INTERNAL_RX =
      /^(chore\(release\)|chore\(stage\)|chore\(pipeline\)|chore\(sync\)|chore\(format\)|chore: stage|chore: sync|chore: format|chore: release)/i;
    const STAGING_RX = /^(stage pipeline artifacts|pipeline-artifacts-only|sync version|sync agents|sync readme)/i;

    const groups = { feat: [], fix: [], perf: [], security: [], breaking: [], other: [] };
    for (const line of logR.output.split('\n')) {
      const [, subject] = line.split('|');
      if (!subject) continue;
      if (INTERNAL_RX.test(subject)) continue;
      if (STAGING_RX.test(subject)) continue;
      let bucket = 'other';
      if (/^feat\b/i.test(subject)) bucket = 'feat';
      else if (/^fix\b/i.test(subject)) bucket = 'fix';
      else if (/^perf\b/i.test(subject)) bucket = 'perf';
      else if (/BREAKING CHANGE|^!/.test(subject)) bucket = 'breaking';
      else if (/^security\b/i.test(subject)) bucket = 'security';
      groups[bucket].push(subject.trim());
    }

    const total =
      groups.feat.length +
      groups.fix.length +
      groups.perf.length +
      groups.security.length +
      groups.breaking.length +
      groups.other.length;
    if (total === 0) return null;

    const lines = [];
    const header = milestone ? `# Release v${newVersion} — ${milestone}` : `# Release v${newVersion}`;
    lines.push(header, '');
    lines.push(`Released ${new Date().toISOString().slice(0, 10)} — upgraded from v${currentVersion || '?'}`);
    lines.push('');
    const section = (title, items) => {
      if (!items.length) return;
      lines.push(`## ${title}`, '');
      for (const s of items) lines.push(`- ${s}`);
      lines.push('');
    };
    section('Breaking changes', groups.breaking);
    section('Features', groups.feat);
    section('Fixes', groups.fix);
    section('Performance', groups.perf);
    section('Security', groups.security);
    if (groups.other.length) section('Other', groups.other);
    lines.push('---', '');
    lines.push(`_Generated by cobolt-release from \`${range}\` on ${new Date().toISOString()}._`);
    return lines.join('\n');
  }

  // -- Rollback ---------------------------------------------

  _rollbackVersion(originalVersion) {
    try {
      if (originalVersion && /^\d+\.\d+\.\d+/.test(originalVersion)) {
        try {
          this._writeVersion(originalVersion);
        } catch {
          // Fall through to git-level rollback
        }
      }
      // Re-sync to restore all files
      const syncScript = path.join(this.projectDir, 'scripts', 'sync-version.js');
      if (fs.existsSync(syncScript)) {
        execFileSync('node', [syncScript], {
          cwd: this.projectDir,
          encoding: 'utf8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
      // Unstage changes
      this._git(['reset', 'HEAD', '--', '.']);
      this._git(['checkout', '--', '.']);
    } catch {
      // Best-effort rollback
    }
  }

  // -- Release log ------------------------------------------

  _releaseLogPath() {
    return path.join(this.projectDir, OUTPUT_DIR, RELEASE_LOG);
  }

  _logRelease(fromVersion, toVersion, bumpType, milestone) {
    const logPath = this._releaseLogPath();
    const logDir = path.dirname(logPath);

    let entries = [];
    try {
      if (fs.existsSync(logPath)) {
        entries = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      }
    } catch {
      entries = [];
    }

    entries.push({
      from: fromVersion,
      to: toVersion,
      tag: `v${toVersion}`,
      bump: bumpType,
      milestone: milestone || null,
      timestamp: new Date().toISOString(),
    });

    try {
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      fs.writeFileSync(logPath, JSON.stringify(entries, null, 2), 'utf8');
    } catch {
      // Non-fatal - release succeeded even if log fails
    }
  }

  /**
   * Read release log.
   * @returns {object[]}
   */
  releaseLog() {
    try {
      const logPath = this._releaseLogPath();
      if (!fs.existsSync(logPath)) return [];
      return JSON.parse(fs.readFileSync(logPath, 'utf8'));
    } catch {
      return [];
    }
  }
}

// -- Module exports -----------------------------------------

module.exports = {
  ReleaseManager,
  evaluateReleaseSbomEvidence,
  collectReleaseStageFiles,
  isIgnoredReleaseDirtyFile,
  normalizeGitOutput,
  releaseDirtyLines,
  resolveReleaseTargetVersion,
  resolveVersionSource,
  readVersionFromFile,
  writeVersionToFile,
  PROJECT_VERSION_FILE,
};

// -- CLI ----------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log();
    console.log('  CoBolt Release Manager');
    console.log('  ----------------------------------------');
    console.log();
    console.log('  Usage: node tools/cobolt-release.js <command> [options]');
    console.log();
    console.log('  Commands:');
    console.log('    release     Execute a versioned release');
    console.log('    current     Show current version');
    console.log('    next        Preview next version');
    console.log('    preflight   Run safety checks');
    console.log('    log         Show release history');
    console.log();
    console.log('  Release options:');
    console.log('    --bump <patch|minor|major>  Bump type (default: patch)');
    console.log('    --milestone <M1>            Milestone label for commit message');
    console.log('    --push                      Push commit + tag to remote');
    console.log('    --dry-run                   Preview only, no changes');
    console.log();
    process.exit(0);
  }

  const mgr = new ReleaseManager();

  // Parse flags
  const hasFlag = (flag) => args.includes(flag);
  const getFlagValue = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  switch (cmd) {
    case 'current': {
      const v = mgr.currentVersion();
      console.log(v ? `  v${v}` : '  (no version found)');
      break;
    }

    case 'next': {
      const v = mgr.currentVersion();
      if (!v) {
        console.error('  Cannot read current version');
        process.exit(1);
      }
      const bump = getFlagValue('--bump') || 'patch';
      const result = mgr.bumpVersion(v, bump);
      if (result.success) {
        console.log(`  ${v} - ${result.version} (${bump})`);
      } else {
        console.error(`  ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'preflight': {
      const result = mgr.preflight();
      for (const c of result.checks) {
        const icon = c.pass ? '\u2713' : '\u2717';
        const extra = c.warning ? ` (${c.warning})` : c.message ? ` - ${c.message}` : '';
        console.log(`  ${icon} ${c.check}${extra}`);
      }
      console.log();
      console.log(result.pass ? '  Ready to release.' : '  Not ready - fix issues above.');
      process.exit(result.pass ? 0 : 1);
      break;
    }

    case 'release': {
      const bump = getFlagValue('--bump') || 'patch';
      const milestone = getFlagValue('--milestone') || null;
      const push = hasFlag('--push');
      const dryRun = hasFlag('--dry-run');

      console.log();
      console.log('  CoBolt Release');
      console.log('  --------------');

      // v0.65.3 (audit S1-I): idempotent milestone release. When build Step 8.6
      // already released this milestone, dream's release call (step 122-126)
      // would either double-bump or fail mid-stream. Check the release log: if
      // an entry exists for this milestone, no-op with exit 0.
      if (milestone && !dryRun) {
        try {
          const log = mgr.releaseLog ? mgr.releaseLog() : [];
          const priorRelease = log.find((e) => e.milestone === milestone);
          if (priorRelease) {
            console.log(`  ✓ idempotent-noop: ${milestone} already released as ${priorRelease.tag}`);
            console.log(`    First release at ${priorRelease.timestamp} (${priorRelease.from} - ${priorRelease.to}).`);
            console.log('    Subsequent callers (cobolt-dream after build Step 8.6) skip cleanly.');
            process.exit(0);
          }
        } catch {
          /* If releaseLog read fails, fall through to normal release path (fail-open is correct here). */
        }
      }

      const result = mgr.release({ bump, push, milestone, dryRun });

      for (const s of result.steps) {
        if (s.step === 'preflight') continue; // Already shown via checks
        const icon = s.success !== false ? '\u2713' : '\u2717';
        let detail = '';
        if (s.step === 'bump-calc') detail = `${s.from} - ${s.to} (${s.type})`;
        else if (s.step === 'commit') detail = s.message || '';
        else if (s.step === 'tag') detail = s.tag || '';
        else if (s.step === 'stage') detail = `${s.files} file(s)`;
        else if (s.message) detail = s.message;
        else if (s.error) detail = s.error;
        console.log(`  ${icon} ${s.step}${detail ? `: ${detail}` : ''}`);
      }

      console.log();
      if (result.success) {
        if (result.dryRun) {
          console.log(`  Dry run: ${result.currentVersion} - ${result.newVersion} (no changes made)`);
        } else {
          console.log(`  Released v${result.newVersion} (tag: ${result.tag})`);
          if (!push) console.log('  To publish: git push --tags origin HEAD');
        }
      } else {
        console.error(`  Release failed: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'log': {
      const entries = mgr.releaseLog();
      if (entries.length === 0) {
        console.log('  No releases logged yet.');
      } else {
        console.log();
        console.log('  Release History');
        console.log('  ---------------');
        for (const e of entries) {
          const ms = e.milestone ? ` (${e.milestone})` : '';
          console.log(`  ${e.tag}  ${e.from} - ${e.to}  [${e.bump}]${ms}  ${e.timestamp}`);
        }
      }
      break;
    }

    default:
      console.error(`  Unknown command: ${cmd}`);
      console.error('  Run with --help for usage.');
      process.exit(1);
  }
}
