import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createManifest, parsePublicKey, parseSignature, verifyUpdaterSignature } from './updater_manifest.mjs';

let directory, file, publicKey, signature;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orion-updater-signature-test-'));
  file = join(directory, 'fixture.tar.gz');
  const privateKey = join(directory, 'fixture.key');
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' };
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  const cli = new URL('../node_modules/.bin/tauri', import.meta.url).pathname;
  execFileSync(cli, ['signer', 'generate', '--ci', '--password', '', '--write-keys', privateKey], { env, stdio: 'pipe' });
  await writeFile(file, 'An actual Tauri-signed fixture, not a copied production key.');
  execFileSync(cli, ['signer', 'sign', '--private-key-path', privateKey, '--app-version', '0.6.0', file], { env, stdio: 'pipe' });
  publicKey = await readFile(`${privateKey}.pub`, 'utf8');
  signature = await readFile(`${file}.sig`, 'utf8');
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('independently verifies the actual Tauri CLI signature and signed version', async () => {
  await verifyUpdaterSignature(file, signature, publicKey, '0.6.0');
});

test('rejects a changed update payload', async () => {
  const changed = join(directory, 'changed.tar.gz');
  await writeFile(changed, 'A different application.');
  await assert.rejects(verifyUpdaterSignature(changed, signature, publicKey, '0.6.0'), /signature verification failed/);
});

test('rejects metadata that relabels an older signed app as a newer release', async () => {
  await assert.rejects(verifyUpdaterSignature(file, signature, publicKey, '0.6.1'), /not bound to the release version/);
});

test('rejects a forged trusted comment even when the payload signature is unchanged', async () => {
  const forged = Buffer.from(Buffer.from(signature.trim(), 'base64').toString().replace('version:0.6.0', 'version:0.6.1')).toString('base64');
  await assert.rejects(verifyUpdaterSignature(file, forged, publicKey, '0.6.1'), /signature verification failed/);
});

test('rejects a signature created with a different embedded key id', async () => {
  const lines = Buffer.from(publicKey.trim(), 'base64').toString().trim().split('\n');
  const bytes = Buffer.from(lines[1], 'base64');
  bytes[2] ^= 1;
  lines[1] = bytes.toString('base64');
  const changed = Buffer.from(lines.join('\n')).toString('base64');
  await assert.rejects(verifyUpdaterSignature(file, signature, changed, '0.6.0'), /signing key differs/);
});

test('rejects malformed key and signature encodings', () => {
  assert.throws(() => parsePublicKey(`${publicKey.trim()}!`), /encoding/);
  assert.throws(() => parseSignature('not-a-signature', '0.6.0'), /encoding/);
});

test('generates one complete Medium Apple Silicon target with an immutable release URL', () => {
  const manifest = createManifest({ version: '0.6.0', notes: '  Release notes.  ', signature, publishedAt: '2026-11-11T00:00:00Z' });
  assert.deepEqual(Object.keys(manifest.platforms), ['darwin-aarch64']);
  assert.equal(manifest.platforms['darwin-aarch64'].url, 'https://github.com/zug11/orion/releases/download/v0.6.0/Orion-0.6.0-Apple-Silicon.app.tar.gz');
  assert.equal(manifest.platforms['darwin-aarch64'].signature, signature.trim());
  assert.equal(manifest.notes, 'Release notes.');
  assert.equal(manifest.pub_date, '2026-11-11T00:00:00.000Z');
});

test('refuses previews, path injection, unbounded notes and invalid dates', () => {
  for (const version of ['0.6.0-preview', '../0.6.0', 'v0.6.0', '00.6.0']) {
    assert.throws(() => createManifest({ version, notes: '', signature }), /stable semantic version/);
  }
  assert.throws(() => createManifest({ version: '0.6.0', notes: 'x'.repeat(16001), signature }), /16000/);
  assert.throws(() => createManifest({ version: '0.6.0', notes: '', signature, publishedAt: 'invalid' }), /Invalid release date/);
});
