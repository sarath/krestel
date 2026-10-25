import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOZILLA_VERSION_REGEX } from './resolve-version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Generates an HS256 JWT token for Thunderbird ATN / Mozilla AMO API authentication.
 */
export function createMozillaJwt(jwtIssuer, jwtSecret) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: jwtIssuer,
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + 300, // 5 minute expiration (max allowed by ATN/AMO)
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(payload)
  )}`;
  const signature = crypto
    .createHmac('sha256', jwtSecret)
    .update(signingInput)
    .digest();

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUploadValidation(statusUrl, jwtIssuer, jwtSecret) {
  const maxAttempts = 24; // up to ~2 minutes
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(5000);
    const token = createMozillaJwt(jwtIssuer, jwtSecret);
    const res = await fetch(statusUrl, {
      headers: { Authorization: `JWT ${token}` },
    });
    if (!res.ok) continue;
    const statusData = await res.json().catch(() => null);
    if (!statusData) continue;

    if (statusData.processed) {
      if (statusData.valid === false) {
        const errDetails = JSON.stringify(
          statusData.validation || statusData,
          null,
          2
        );
        throw new Error(`Marketplace validation failed:\n${errDetails}`);
      }
      console.log('✓ Marketplace package validation succeeded.');
      return statusData;
    }
    console.log(
      `⏳ Waiting for Marketplace validation (${attempt}/${maxAttempts})...`
    );
  }
  console.warn(
    '⚠️ Validation polling timed out; submission is still processing on the server.'
  );
  return null;
}

async function submitTwoStepV5({
  serverBase,
  addonId,
  channel,
  xpiBlob,
  jwtIssuer,
  jwtSecret,
  releaseNotes,
}) {
  const uploadForm = new FormData();
  uploadForm.append('upload', xpiBlob, 'kestrel.xpi');
  uploadForm.append('channel', channel);

  const token1 = createMozillaJwt(jwtIssuer, jwtSecret);
  const uploadUrl = `${serverBase}/api/v5/addons/upload/`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `JWT ${token1}` },
    body: uploadForm,
  });

  const uploadText = await uploadRes.text();
  if (!uploadRes.ok) {
    throw new Error(
      `Marketplace upload step failed (HTTP ${uploadRes.status}): ${uploadText}`
    );
  }

  const uploadJson = JSON.parse(uploadText);
  const uuid = uploadJson.uuid;
  const statusUrl =
    uploadJson.url || `${serverBase}/api/v5/addons/upload/${uuid}/`;

  if (!uploadJson.processed) {
    await pollUploadValidation(statusUrl, jwtIssuer, jwtSecret);
  } else if (uploadJson.valid === false) {
    throw new Error(
      `Marketplace validation failed: ${JSON.stringify(uploadJson.validation)}`
    );
  }

  const token2 = createMozillaJwt(jwtIssuer, jwtSecret);
  const versionUrl = `${serverBase}/api/v5/addons/addon/${encodeURIComponent(
    addonId
  )}/versions/`;
  const payload = { upload: uuid };
  if (releaseNotes) {
    payload.release_notes = { 'en-US': releaseNotes };
  }

  const versionRes = await fetch(versionUrl, {
    method: 'POST',
    headers: {
      Authorization: `JWT ${token2}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const versionText = await versionRes.text();
  if (!versionRes.ok && versionRes.status !== 409) {
    throw new Error(
      `Marketplace version creation failed (HTTP ${versionRes.status}): ${versionText}`
    );
  }
  return versionText;
}

export async function publishToMarketplace() {
  const args = new Set(process.argv.slice(2));
  const isPrerelease =
    args.has('--prerelease') ||
    process.env.PRERELEASE === 'true' ||
    process.env.IS_PRERELEASE === 'true';

  const jwtIssuer =
    process.env.AMO_JWT_ISSUER ||
    process.env.ATN_API_KEY ||
    process.env.AMO_SIGN_KEY ||
    process.env.MOZILLA_API_KEY;
  const jwtSecret =
    process.env.AMO_JWT_SECRET ||
    process.env.ATN_API_SECRET ||
    process.env.AMO_SIGN_SECRET ||
    process.env.MOZILLA_API_SECRET;

  const channel =
    process.env.AMO_CHANNEL ||
    (isPrerelease
      ? process.env.AMO_PRERELEASE_CHANNEL || 'unlisted'
      : 'listed');

  // Default to Thunderbird Add-ons (ATN), or override with https://addons.mozilla.org
  const serverBase = (
    process.env.ADDONS_SERVER_URL || 'https://addons.thunderbird.net'
  ).replace(/\/+$/, '');
  const releaseNotes = process.env.RELEASE_NOTES || '';

  if (!jwtIssuer || !jwtSecret) {
    console.error(
      '✗ Missing Thunderbird / Mozilla API credentials (set AMO_JWT_ISSUER and AMO_JWT_SECRET).'
    );
    process.exit(1);
  }

  const manifestPath = path.join(rootDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const addonId =
    manifest?.browser_specific_settings?.gecko?.id ||
    manifest?.applications?.gecko?.id;
  const version = String(manifest.version || '').trim();
  const xpiPath = path.join(rootDir, 'kestrel.xpi');

  if (!MOZILLA_VERSION_REGEX.test(version)) {
    console.error(
      `✗ Invalid Mozilla manifest version "${version}". Must be 1-4 dot-separated numbers (e.g. 1.0.0 or 1.0.0.1).`
    );
    process.exit(1);
  }

  if (!fs.existsSync(xpiPath)) {
    console.error(
      `✗ XPI package not found at ${xpiPath}. Run npm run build first.`
    );
    process.exit(1);
  }

  console.log(
    `📦 Publishing ${addonId} v${version} (${
      isPrerelease ? 'pre-release' : 'release'
    }, channel=${channel}) to ${serverBase}...`
  );

  const token = createMozillaJwt(jwtIssuer, jwtSecret);
  const xpiBytes = fs.readFileSync(xpiPath);
  const xpiBlob = new Blob([xpiBytes], { type: 'application/x-xpinstall' });

  const form = new FormData();
  form.append('upload', xpiBlob, 'kestrel.xpi');
  form.append('channel', channel);

  // Thunderbird ATN v4 version upload endpoint
  const uploadUrl = `${serverBase}/api/v4/addons/${encodeURIComponent(
    addonId
  )}/versions/${encodeURIComponent(version)}/`;

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      Authorization: `JWT ${token}`,
    },
    body: form,
  });

  const bodyText = await response.text();

  // Fallback to 2-step v5 upload if server uses v5 endpoints
  if (response.status === 404 || response.status === 405) {
    console.log(
      `ℹ️ v4 direct version endpoint returned HTTP ${response.status}; trying v5 2-step upload flow...`
    );
    const v5Result = await submitTwoStepV5({
      serverBase,
      addonId,
      channel,
      xpiBlob,
      jwtIssuer,
      jwtSecret,
      releaseNotes,
    });
    console.log(
      `✓ Successfully submitted ${addonId} v${version} to ${serverBase}!`
    );
    console.log(v5Result);
    return;
  }

  if (response.status === 409) {
    console.warn(
      `⚠️ Version ${version} already exists on ${serverBase} (HTTP 409): ${bodyText}`
    );
    return;
  }

  if (!response.ok) {
    console.error(
      `✗ Marketplace upload failed (HTTP ${response.status}): ${bodyText}`
    );
    process.exit(1);
  }

  const parsed = (() => {
    try {
      return JSON.parse(bodyText);
    } catch {
      return null;
    }
  })();

  if (parsed && parsed.processed === false && parsed.url) {
    await pollUploadValidation(parsed.url, jwtIssuer, jwtSecret);
  }

  console.log(
    `✓ Successfully submitted ${addonId} v${version} (${channel}) to ${serverBase}!`
  );
  console.log(bodyText);
}

const isMainModule =
  process.argv[1] &&
  path.basename(process.argv[1]) === 'publish-addons.mjs' &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  publishToMarketplace().catch((err) => {
    console.error('✗ Fatal publish error:', err);
    process.exit(1);
  });
}
