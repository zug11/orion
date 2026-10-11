#!/usr/bin/env bash
# Launcher contract only: all app, build, signing and process commands are mocked.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TEST_ROOT="$(mktemp -d /private/tmp/orion-preview-launcher-test.XXXXXX)"
trap 'rm -rf -- "$TEST_ROOT"' EXIT

python3 - "$SCRIPT_DIR/build_and_run.sh" "$TEST_ROOT" <<'PY'
import hashlib, json, os, pathlib, shutil, subprocess, sys

launcher, temporary = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
mock_dir = temporary / 'bin'
mock_dir.mkdir()
mock = mock_dir / 'command-mock'
mock.write_text('''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys, tempfile
name, args = pathlib.Path(sys.argv[0]).name, sys.argv[1:]
test = pathlib.Path(os.environ['ORION_PREVIEW_TEST_DIR'])
repo = test / 'physical-repo'
with (test / 'commands.jsonl').open('a') as log:
    log.write(json.dumps({'command': name, 'args': args, 'cwd': os.getcwd()}) + '\\n')
if name == 'mktemp':
    print(tempfile.mkdtemp(prefix='stage.', dir=test))
elif name == 'mkdir':
    for argument in args:
        if argument.startswith('-'):
            continue
        path = pathlib.Path(argument)
        if path.is_relative_to(test):
            path.mkdir(parents=True, exist_ok=True)
        else:
            # Never create or modify a real user's Preview directory.
            assert path.parent == pathlib.Path.home() / 'Applications/Orion Previews'
            assert not path.exists()
elif name == 'rsync':
    source, destination = map(pathlib.Path, args[-2:])
    shutil.copytree(source, destination, symlinks=True,
                    ignore=shutil.ignore_patterns('target', 'target-*') if '--exclude' in args else None)
elif name == 'git':
    assert args == ['-C', str(repo), 'rev-parse', '--verify', 'HEAD']
    print('f56ffa965cd8f1c63ea71d3dc99769a732ada0c7')
elif name == 'npm':
    assert os.environ['ORION_CODESIGN_IDENTITY'] == '-'
    assert os.environ['ORION_WHISPER_MODEL'] == 'small'
    assert os.environ['VITE_ORION_WHISPER_MODEL'] == 'small'
    assert os.environ['CARGO_PROFILE_RELEASE_STRIP'] == 'false'
    if args == ['run', 'tauri', 'build', '--', '--bundles', 'app']:
        bundle = repo / 'src-tauri/target/release/bundle/macos/Orion Preview.app'
        bundle.mkdir(parents=True)
        (bundle / 'fixture').write_text('mock bundle')
elif name == 'ditto':
    assert args[:2] == ['--norsrc', '--noextattr']
    assert (pathlib.Path(args[2]) / 'fixture').read_text() == 'mock bundle'
    assert not pathlib.Path(args[3]).exists()
elif name == 'codesign':
    assert args[:3] == ['--verify', '--deep', '--strict']
    if os.environ.get('ORION_PREVIEW_TEST_FAILSIGN') == '1':
        sys.exit(1)
elif name == 'osascript':
    state = test / 'running'
    if ' to quit' in args[-1]:
        if os.environ.get('ORION_PREVIEW_TEST_STUCK') != '1':
            state.write_text('false')
    else:
        assert args[-1] == 'application id "app.orion.desktop-preview" is running'
        print(state.read_text())
elif name == 'ps':
    print((repo / 'outputs/native-preview/latest-app.txt').read_text().strip() + '/Contents/MacOS/orion')
elif name in ('open', 'lldb', 'sleep'):
    pass
else:
    raise AssertionError(name)
''')
mock.chmod(0o755)
for command in ('mktemp', 'mkdir', 'rsync', 'git', 'npm', 'ditto', 'codesign', 'osascript', 'ps', 'open', 'lldb', 'sleep'):
    (mock_dir / command).symlink_to(mock.name)

def exercise(name, mode=None, **extra):
    test = temporary / name
    repo = test / 'physical-repo'
    for directory in ('src', 'public', 'script', 'mcp', 'codex', 'src-tauri/src',
                      'src-tauri/target', 'outputs/native-preview'):
        (repo / directory).mkdir(parents=True, exist_ok=True)
    shutil.copy2(launcher, repo / 'script/build_and_run.sh')
    original = 'const KEYCHAIN_SERVICE: &str = "app.orion.knowledge";\n'
    (repo / 'src-tauri/src/lib.rs').write_text(original)
    config = {'identifier': 'app.orion.knowledge', 'productName': 'Orion',
              'build': {'beforeBuildCommand': 'npm run build'},
              'bundle': {'targets': ['app', 'dmg'], 'macOS': {'signingIdentity': None}},
              'plugins': {'deep-link': {'desktop': {'schemes': ['orion']}}}}
    (repo / 'src-tauri/tauri.conf.json').write_text(json.dumps(config))
    for filename in ('package.json', 'package-lock.json', 'index.html', 'tsconfig.json',
                     'tsconfig.node.json', 'vite.config.ts'):
        (repo / filename).write_text('{}\n')
    (repo / 'src/untracked-source.ts').write_text('export const exact = "é😀";\n')
    (repo / 'public/local-link').symlink_to('../src/untracked-source.ts')
    (repo / 'src-tauri/target/not-source').write_text('shared cache')
    (test / 'compatibility-link').symlink_to(repo, target_is_directory=True)
    (test / 'running').write_text('true')
    output = repo / 'outputs/native-preview'
    (output / 'latest-app.txt').write_text('running-preview\n')
    (output / 'latest-built-app.txt').write_text('previous-built-preview\n')
    command = ['bash', str(test / 'compatibility-link/script/build_and_run.sh')]
    if mode is not None:
        command.append(mode)
    result = subprocess.run(command, capture_output=True, text=True, timeout=30,
                            env={**os.environ, 'PATH': str(mock_dir) + ':' + os.environ['PATH'],
                                 'ORION_PREVIEW_TEST_DIR': str(test), **extra})
    records = [json.loads(line) for line in (test / 'commands.jsonl').read_text().splitlines()]
    assert (repo / 'src-tauri/src/lib.rs').read_text() == original
    assert json.loads((repo / 'src-tauri/tauri.conf.json').read_text()) == config
    return result, records, repo, output

def verify_build(result, records, repo, output, mode):
    assert result.returncode == 0, result.stderr
    commands = [entry['command'] for entry in records]
    assert [entry['args'] for entry in records if entry['command'] == 'npm'] == [
        ['ci', '--ignore-scripts'], ['run', 'build:desktop'],
        ['run', 'tauri', 'build', '--', '--bundles', 'app']]
    assert commands.index('ditto') < commands.index('codesign')
    manifests = list(output.glob('*/source-manifest.json'))
    assert len(manifests) == 1
    manifest = json.loads(manifests[0].read_text())
    assert manifest['sourceRoot'] == str(repo), 'source path must resolve the compatibility symlink'
    assert manifest['mode'] == mode
    assert manifest['gitHead'] == 'f56ffa965cd8f1c63ea71d3dc99769a732ada0c7'
    files = {entry['path']: entry for entry in manifest['files']}
    for path in ('src-tauri/src/lib.rs', 'src/untracked-source.ts', 'package-lock.json'):
        assert files[path]['sha256'] == hashlib.sha256((repo / path).read_bytes()).hexdigest()
    assert files['public/local-link']['target'] == '../src/untracked-source.ts'
    assert not any(path.startswith('src-tauri/target') for path in files)
    expected = hashlib.sha256(json.dumps(manifest['files'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    assert manifest['capturedTreeSha256'] == expected
    stage = pathlib.Path(manifest['stageRoot'])
    assert (manifests[0].parent / 'build-source.txt').read_text().strip() == str(stage)
    staged_config = json.loads((stage / 'src-tauri/tauri.conf.json').read_text())
    assert staged_config['identifier'] == 'app.orion.desktop-preview'
    assert staged_config['productName'] == 'Orion Preview'
    assert staged_config['build']['beforeBuildCommand'] == ''
    assert staged_config['bundle']['targets'] == ['app']
    assert staged_config['bundle']['macOS']['signingIdentity'] == '-'
    assert staged_config['plugins']['deep-link']['desktop']['schemes'] == ['orion-desktop-preview']
    assert (stage / 'src-tauri/src/lib.rs').read_text() == 'const KEYCHAIN_SERVICE: &str = "app.orion.desktop-preview";\n'
    for changed in manifest['previewModifiedFiles']:
        assert changed['sha256'] == hashlib.sha256((stage / changed['path']).read_bytes()).hexdigest()
    return commands

result, records, repo, output = exercise('build-only', '--build-only')
commands = verify_build(result, records, repo, output, '--build-only')
assert not set(commands) & {'osascript', 'open', 'lldb', 'ps', 'sleep'}, commands
assert (output / 'latest-app.txt').read_text() == 'running-preview\n'
assert (output / 'latest-built-app.txt').read_text() != 'previous-built-preview\n'
assert (repo.parent / 'running').read_text() == 'true'

for name, mode in (('default', None), ('verify', '--verify'), ('debug', '--debug')):
    result, records, repo, output = exercise(name, mode)
    commands = verify_build(result, records, repo, output, mode or 'run')
    assert commands.index('osascript') < commands.index('npm')
    assert sum(' to quit' in entry['args'][-1] for entry in records if entry['command'] == 'osascript') == 1
    assert (repo.parent / 'running').read_text() == 'false'
    assert (output / 'latest-built-app.txt').read_text() == 'previous-built-preview\n'
    app = (output / 'latest-app.txt').read_text().strip()
    launch = next(entry for entry in records if entry['command'] == ('lldb' if mode == '--debug' else 'open'))
    assert launch['args'] == (['--', app + '/Contents/MacOS/orion'] if mode == '--debug' else ['-n', app])
    assert commands.index('codesign') < commands.index(launch['command'])
    if mode == '--debug':
        assert 'open' not in commands
    if mode == '--verify':
        assert commands.index('open') < commands.index('ps')

result, records, repo, output = exercise('still-saving', ORION_PREVIEW_TEST_STUCK='1')
assert result.returncode == 1 and 'still saving' in result.stderr
assert not any(entry['command'] in ('npm', 'open', 'lldb') for entry in records)
assert (output / 'latest-app.txt').read_text() == 'running-preview\n'

result, records, repo, output = exercise('bad-signature', '--build-only', ORION_PREVIEW_TEST_FAILSIGN='1')
assert result.returncode != 0
assert any(entry['command'] == 'codesign' for entry in records)
assert not any(entry['command'] in ('osascript', 'open', 'lldb') for entry in records)
assert (output / 'latest-app.txt').read_text() == 'running-preview\n'
assert (output / 'latest-built-app.txt').read_text() == 'previous-built-preview\n'

print('Preview launcher: 6 isolated scenarios passed; no native build or app interaction performed.')
PY
