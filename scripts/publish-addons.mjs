import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * Generates an HS256 JWT token for Mozilla AMO / Thunderbird ATN API authentication.
 */
function createMozillaJwt(jwtIssuer, jwtSecret) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: jwtIssuer,
    jti: crypto.randomUUID(),
    iat: issuedAt,
    exp: issuedAt + 300, // 5 minute expiration (max allowed by AMO/ATN)
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

async function publishToMarketplace() {
  const jwtIssuer = process.env.AMO_JWT_ISSUER || process.env.MOZILLA_API_KEY;
  const jwtSecret = process.env.AMO_JWT_SECRET || process.env.MOZILLA_API_SECRET;
  const channel = process.env.AMO_CHANNEL || 'listed';
  // Default to Thunderbird Add-ons (ATN), or override with https://addons.mozilla.org
  const serverBase = (
    process.env.ADDONS_SERVER_URL || 'https://addons.thunderbird.net'
  ).replace(/\/+$/, '');

  if (!jwtIssuer || !jwtSecret) {
    console.error(
      '✗ Missing AMO_JWT_ISSUER or AMO_JWT_SECRET environment variables.'
    );
    process.exit(1);
  }

  const manifest = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8')
  );
  const addonId =
    manifest?.browser_specific_settings?.gecko?.id ||
    manifest?.applications?.gecko?.id;
  const version = manifest.version;
  const xpiPath = path.join(rootDir, 'kestrel.xpi');

  if (!fs.existsSync(xpiPath)) {
    console.error(`✗ XPI package not found at ${xpiPath}. Run npm run build first.`);
    process.exit(1);
  }

  console.log(`📦 Publishing ${addonId} v${version} (${channel}) to ${serverBase}...`);

  const token = createMozillaJwt(jwtIssuer, jwtSecret);
  const xpiBytes = fs.readFileSync(xpiPath);
  const xpiBlob = new Blob([xpiBytes], { type: 'application/x-xpinstall' });

  const form = new FormData();
  form.append('upload', xpiBlob, 'kestrel.xpi');
  form.append('channel', channel);

  // Thunderbird ATN & AMO v4 version upload endpoint
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
  if (!response.ok) {
    console.error(
      `✗ Marketplace upload failed (HTTP ${response.status}): ${bodyText}`
    );
    process.exit(1);
  }

  console.log(`✓ Successfully submitted ${addonId} v${version} to ${serverBase}!`);
  console.log(bodyText);
}

publishToMarketplace().catch((err) => {
  console.error('✗ Fatal publish error:', err);
  process.exit(1);
});
