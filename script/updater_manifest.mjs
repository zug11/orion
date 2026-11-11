import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const UPDATE_ENDPOINT = 'https://github.com/zug11/orion/releases/latest/download/latest.json';

function decodeBase64(value, description) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) {
    throw new Error(`Invalid ${description} encoding`);
  }
  const result = Buffer.from(value.trim(), 'base64');
  if (result.toString('base64') !== value.trim()) throw new Error(`Invalid ${description} encoding`);
  return result;
}

export function parsePublicKey(encoded) {
  const lines = decodeBase64(encoded, 'public key').toString('utf8').trim().split(/\r?\n/);
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment: ')) throw new Error('Invalid updater public key');
  const bytes = decodeBase64(lines[1], 'public key');
  if (bytes.length !== 42 || !['Ed', 'ED'].includes(bytes.subarray(0, 2).toString())) throw new Error('Invalid updater public key');
  return {
    id: bytes.subarray(2, 10),
    key: createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes.subarray(10)]), format: 'der', type: 'spki' }),
  };
}

export function parseSignature(encoded, expectedVersion) {
  const lines = decodeBase64(encoded, 'signature').toString('utf8').trim().split(/\r?\n/);
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: ')) {
    throw new Error('Invalid updater signature');
  }
  const bytes = decodeBase64(lines[1], 'signature');
  const global = decodeBase64(lines[3], 'trusted comment signature');
  if (bytes.length !== 74 || bytes.subarray(0, 2).toString() !== 'ED' || global.length !== 64) {
    throw new Error('Updater requires a prehashed Minisign signature');
  }
  const comment = lines[2].slice('trusted comment: '.length);
  const versions = comment.split('\t').filter((field) => field.startsWith('version:'));
  if (versions.length !== 1 || versions[0] !== `version:${expectedVersion}`) {
    throw new Error('Updater signature is not bound to the release version');
  }
  return { id: bytes.subarray(2, 10), signature: bytes.subarray(10), global, comment };
}

export async function hashFile(path, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest();
}

// Tauri's updater uses Minisign's prehashed Ed25519 format. Verify both the
// archive and the trusted comment independently of the CLI that signed them.
export async function verifyUpdaterSignature(path, encodedSignature, encodedPublicKey, version) {
  const pub = parsePublicKey(encodedPublicKey);
  const sig = parseSignature(encodedSignature, version);
  if (!pub.id.equals(sig.id)) throw new Error('Updater signing key differs from the key embedded in Orion');
  const digest = await hashFile(path, 'blake2b512');
  if (!verify(null, digest, pub.key, sig.signature)
    || !verify(null, Buffer.concat([sig.signature, Buffer.from(sig.comment)]), pub.key, sig.global)) {
    throw new Error('Updater signature verification failed');
  }
}

export function createManifest({ version, notes, signature, publishedAt = new Date().toISOString() }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Public updater releases require a stable semantic version');
  if (typeof notes !== 'string' || notes.length > 16000) throw new Error('Release notes must be at most 16000 characters');
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('Invalid release date');
  parseSignature(signature, version);
  return {
    version,
    notes: notes.trim(),
    pub_date: new Date(publishedAt).toISOString(),
    platforms: {
      'darwin-aarch64': {
        signature: signature.trim(),
        url: `https://github.com/zug11/orion/releases/download/v${version}/Orion-${version}-Apple-Silicon.app.tar.gz`,
      },
    },
  };
}
