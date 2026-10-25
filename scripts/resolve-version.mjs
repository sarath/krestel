import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

/**
 * Mozilla / Thunderbird manifest.json version regex:
 * 1 to 4 dot-separated integers (up to 9 digits each, no leading zeros).
 */
export const MOZILLA_VERSION_REGEX =
  /^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){0,3}$/;

export function parseSemverTriplet(verStr) {
  const cleaned = String(verStr || '')
    .trim()
    .replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
  };
}

export function compareTriplets(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function getLatestStableTagTriplet(gitTags) {
  let latest = null;
  for (const rawTag of gitTags) {
    const parsed = parseSemverTriplet(rawTag);
    if (!parsed || parsed.prerelease) continue;
    if (!latest || compareTriplets(parsed, latest) > 0) {
      latest = parsed;
    }
  }
  return latest;
}

/**
 * Computes deterministic, Mozilla-valid manifestVersion and GitHub releaseTag
 * across PR pre-releases, main branch merges, tag pushes, and manual dispatches.
 *
 * Invariant for Thunderbird Add-ons Marketplace (ATN):
 *   previous_stable (A.B.C) < PR_prerelease (A.B.C.runNumber) < next_stable (A.B.(C+1) or X.Y.Z)
 */
export function computeReleaseVersion({
  baseVersion,
  gitTags = [],
  eventName = 'push',
  refName = 'main',
  prNumber = '',
  runNumber = '1',
  inputPrerelease = '',
  inputChannel = '',
}) {
  const base = parseSemverTriplet(baseVersion) || {
    major: 1,
    minor: 0,
    patch: 0,
    prerelease: null,
  };
  const latestStable = getLatestStableTagTriplet(gitTags);
  const safeRun = Math.max(1, Number.parseInt(String(runNumber), 10) || 1);
  const safePr = Math.max(1, Number.parseInt(String(prNumber), 10) || 1);
  const explicitChannel =
    inputChannel && inputChannel !== 'auto' ? inputChannel : '';

  // 1. Pull Request -> Pre-release
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const manifestVersion = latestStable
      ? `${latestStable.major}.${latestStable.minor}.${latestStable.patch}.${safeRun}`
      : `0.99.${safePr}.${safeRun}`;
    const nextTarget =
      latestStable && compareTriplets(base, latestStable) <= 0
        ? `${latestStable.major}.${latestStable.minor}.${latestStable.patch + 1}`
        : `${base.major}.${base.minor}.${base.patch}`;
    const releaseTag = `v${nextTarget}-pr.${safePr}.${safeRun}`;
    const channel =
      explicitChannel || process.env.AMO_PRERELEASE_CHANNEL || 'unlisted';
    return {
      isPrerelease: true,
      manifestVersion,
      packageVersion: nextTarget,
      releaseTag,
      channel,
    };
  }

  // 2. Explicit Git tag push (e.g. v1.2.0 or v1.2.0-beta.1)
  if (refName.startsWith('v') && parseSemverTriplet(refName)) {
    const tagParsed = parseSemverTriplet(refName);
    const isPre = Boolean(tagParsed.prerelease) || inputPrerelease === 'true';
    const tripletStr = `${tagParsed.major}.${tagParsed.minor}.${tagParsed.patch}`;
    let manifestVersion = tripletStr;
    if (isPre) {
      const trailingNum = tagParsed.prerelease?.match(/(\d+)$/)?.[1];
      const fourth = Math.max(
        1,
        Number.parseInt(trailingNum || String(safeRun), 10) || safeRun
      );
      manifestVersion = latestStable
        ? `${latestStable.major}.${latestStable.minor}.${latestStable.patch}.${fourth}`
        : `0.99.0.${fourth}`;
    }
    const channel =
      explicitChannel ||
      (isPre
        ? process.env.AMO_PRERELEASE_CHANNEL || 'unlisted'
        : process.env.AMO_CHANNEL || 'listed');
    return {
      isPrerelease: isPre,
      manifestVersion,
      packageVersion: tripletStr,
      releaseTag: refName,
      channel,
    };
  }

  // 3. Manual workflow_dispatch with prerelease=true
  if (inputPrerelease === 'true') {
    const manifestVersion = latestStable
      ? `${latestStable.major}.${latestStable.minor}.${latestStable.patch}.${safeRun}`
      : `0.99.0.${safeRun}`;
    const nextTarget =
      latestStable && compareTriplets(base, latestStable) <= 0
        ? `${latestStable.major}.${latestStable.minor}.${latestStable.patch + 1}`
        : `${base.major}.${base.minor}.${base.patch}`;
    const releaseTag = `v${nextTarget}-pre.${safeRun}`;
    const channel =
      explicitChannel || process.env.AMO_PRERELEASE_CHANNEL || 'unlisted';
    return {
      isPrerelease: true,
      manifestVersion,
      packageVersion: nextTarget,
      releaseTag,
      channel,
    };
  }

  // 4. Merge / push to main (or stable workflow_dispatch) -> Cut stable release
  let releaseTriplet = { ...base };
  if (latestStable && compareTriplets(releaseTriplet, latestStable) <= 0) {
    releaseTriplet = {
      major: latestStable.major,
      minor: latestStable.minor,
      patch: latestStable.patch + 1,
      prerelease: null,
    };
  }
  const versionStr = `${releaseTriplet.major}.${releaseTriplet.minor}.${releaseTriplet.patch}`;
  const channel = explicitChannel || process.env.AMO_CHANNEL || 'listed';
  return {
    isPrerelease: false,
    manifestVersion: versionStr,
    packageVersion: versionStr,
    releaseTag: `v${versionStr}`,
    channel,
  };
}

function readGitTags() {
  try {
    const out = execFileSync('git', ['tag', '--list', 'v*'], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const isMainModule =
  process.argv[1] &&
  path.basename(process.argv[1]) === 'resolve-version.mjs' &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  const pkgPath = path.join(rootDir, 'package.json');
  const manifestPath = path.join(rootDir, 'manifest.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const result = computeReleaseVersion({
    baseVersion: pkg.version || manifest.version || '1.0.0',
    gitTags: readGitTags(),
    eventName: process.env.GITHUB_EVENT_NAME || 'push',
    refName: process.env.GITHUB_REF_NAME || 'main',
    prNumber: process.env.PR_NUMBER || '',
    runNumber: process.env.GITHUB_RUN_NUMBER || '1',
    inputPrerelease: process.env.INPUT_PRERELEASE || '',
    inputChannel: process.env.INPUT_CHANNEL || '',
  });

  manifest.version = result.manifestVersion;
  pkg.version = result.packageVersion;

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  console.log(
    `✓ Resolved version: manifest=${result.manifestVersion}, tag=${result.releaseTag}, prerelease=${result.isPrerelease}, channel=${result.channel}`
  );

  if (process.env.GITHUB_OUTPUT) {
    const lines = [
      `manifest_version=${result.manifestVersion}`,
      `package_version=${result.packageVersion}`,
      `release_tag=${result.releaseTag}`,
      `is_prerelease=${result.isPrerelease}`,
      `channel=${result.channel}`,
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
}
