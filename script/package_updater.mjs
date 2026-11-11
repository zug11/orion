#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManifest, hashFile, parsePublicKey, UPDATE_ENDPOINT, verifyUpdaterSignature } from './updater_manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function command(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024, ...options });
}

function verifyApp(app, version) {
  const plist = join(app, 'Contents/Info.plist');
  const field = (name) => command('/usr/bin/plutil', ['-extract', name, 'raw', '-o', '-', plist]).trim();
  if (basename(app) !== 'Orion.app' || field('CFBundleIdentifier') !== 'app.orion.knowledge' || field('CFBundleShortVersionString') !== version) {
    throw new Error('Updater app identity/version does not match the release configuration');
  }
  if (command('/usr/bin/lipo', ['-archs', join(app, 'Contents/MacOS/orion')]).trim() !== 'arm64') {
    throw new Error('This release feed supports Apple Silicon only');
  }
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  // codesign writes its identity metadata to stderr, even on success.
  const info = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' });
  if (info.status !== 0 || !info.stderr.includes('Authority=Developer ID Application:') || !info.stderr.includes('(runtime)')) {
    throw new Error('Updater app requires Developer ID signing and Hardened Runtime');
  }
  command('/usr/bin/xcrun', ['stapler', 'validate', app]);
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
}

async function sign(archive, version) {
  const env = { ...process.env };
  const supplied = env.TAURI_SIGNING_PRIVATE_KEY;
  if (!supplied && !env.TAURI_SIGNING_PRIVATE_KEY_PATH) throw new Error('Set TAURI_SIGNING_PRIVATE_KEY to the private key path');
  if (supplied) {
    let isFile = false;
    try { isFile = (await stat(supplied)).isFile(); } catch { /* A key may also be supplied directly through the environment. */ }
    if (isFile) {
      delete env.TAURI_SIGNING_PRIVATE_KEY;
      env.TAURI_SIGNING_PRIVATE_KEY_PATH = resolve(supplied);
    } else {
      delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
    }
  }
  // Never pass key material or its password through command-line arguments or
  // print a signer environment/error dump. The CLI reads credentials itself.
  try {
    command(join(root, 'node_modules/.bin/tauri'), ['signer', 'sign', '--app-version', version, archive], { env });
  } catch {
    throw new Error('Tauri updater signing failed. Check the private key/password and use Tauri CLI 2.12.4 or newer.');
  }
}

async function main() {
  const [appArg, dmgArg, notesArg, outputArg] = process.argv.slice(2);
  if (!appArg || !dmgArg || !notesArg || process.argv.length > 6) {
    throw new Error('Usage: node script/package_updater.mjs <notarized-Orion.app> <notarized-DMG> <release-notes.md> [output-directory]');
  }
  if (process.platform !== 'darwin') throw new Error('Package the macOS updater on macOS');
  const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const version = config.version;
  const updater = config.plugins?.updater;
  if (updater?.endpoints?.length !== 1 || updater.endpoints[0] !== UPDATE_ENDPOINT || updater.requireSignedVersion !== true) {
    throw new Error('Updater must use the official GitHub endpoint and requireSignedVersion');
  }
  parsePublicKey(updater.pubkey);
  const app = resolve(appArg);
  const dmg = resolve(dmgArg);
  const notes = await readFile(resolve(notesArg), 'utf8');
  const output = resolve(outputArg ?? join(root, 'outputs/releases', `v${version}`));
  const archiveName = `Orion-${version}-Apple-Silicon.app.tar.gz`;
  const outputNames = [archiveName, `${archiveName}.sig`, 'latest.json', `Orion-${version}-SHA256SUMS.txt`];
  await mkdir(output, { recursive: true });
  for (const name of outputNames) {
    try {
      await access(join(output, name));
      throw new Error(`Refusing to replace existing release artifact: ${join(output, name)}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  verifyApp(app, version);
  command('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
  command('/usr/bin/codesign', ['--verify', '--strict', dmg]);
  command('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);
  const model = join(app, 'Contents/Resources/models/ggml-model.bin');
  if ((await stat(model)).size !== 1533763059 || (await hashFile(model)).toString('hex') !== '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208') {
    throw new Error('Public darwin-aarch64 updates must contain the verified Whisper Medium edition');
  }
  const staging = await mkdtemp(join(output, '.updater-'));
  try {
    const archive = join(staging, archiveName);
    console.log('Creating updater archive from the signed, stapled Orion.app…');
    command('/usr/bin/tar', ['--format', 'pax', '--no-xattrs', '--no-mac-metadata', '-czf', archive, '-C', dirname(app), 'Orion.app'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const extracted = join(staging, 'verify');
    await mkdir(extracted);
    command('/usr/bin/tar', ['-xzf', archive, '-C', extracted]);
    verifyApp(join(extracted, 'Orion.app'), version);
    await rm(extracted, { recursive: true });
    await sign(archive, version);
    const signature = (await readFile(`${archive}.sig`, 'utf8')).trim();
    await verifyUpdaterSignature(archive, signature, updater.pubkey, version);
    const manifest = createManifest({ version, notes, signature });
    await writeFile(join(staging, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const checksums = [];
    for (const file of [dmg, archive, `${archive}.sig`, join(staging, 'latest.json')]) {
      checksums.push(`${(await hashFile(file)).toString('hex')}  ${basename(file)}`);
    }
    await writeFile(join(staging, `Orion-${version}-SHA256SUMS.txt`), `${checksums.join('\n')}\n`);
    // Publish complete validated files, never a partially written archive/feed.
    for (const name of outputNames) await rename(join(staging, name), join(output, name));
    console.log(`Verified updater release: ${output}`);
    console.log(`Upload the DMG plus ${outputNames.join(', ')} to GitHub release v${version}.`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
