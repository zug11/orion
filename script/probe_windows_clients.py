commit f1266905266eddad3351cbf6c15f2e9ac70a91a5
Merge: e76ceb9 2aebecd
Author: zug11 <mchvllan@gmail.com>
Date:   Mon Nov 9 17:19:05 2026 +1100

    Check the Windows plugin with the official Codex app-server

diff --cc .github/workflows/windows-appdata-probe.yml
index 0000000,b6ac485..30d6180
mode 000000,100644..100644
--- a/.github/workflows/windows-appdata-probe.yml
+++ b/.github/workflows/windows-appdata-probe.yml
@@@ -1,0 -1,17 +1,25 @@@
 -name: Orion connector MSIX probe
++name: Orion Windows client compatibility probe
+ on:
+   push:
+     branches: [codex/orion-windows-appdata-probe]
+ permissions:
+   contents: read
+ jobs:
 -  probe:
++  clients:
+     runs-on: windows-2025
+     timeout-minutes: 12
+     steps:
+       - uses: actions/checkout@v6
 -      - name: Build the Windows MCP server
 -        run: cargo build --locked --release --manifest-path src-tauri/mcp-server/Cargo.toml
 -      - name: Probe a full-trust packaged client's access to the ordinary Orion vault
++      - uses: actions/setup-node@v6
++        with:
++          node-version: '24'
++          cache: npm
++      - run: npm ci
++      - run: node script/stage_windows_connectors.mjs
++      - name: Verify Claude bundle and launch the Windows Codex plugin
+         shell: pwsh
 -        run: ./script/probe_windows_appdata.ps1
++        run: |
++          $tools = Join-Path $env:RUNNER_TEMP 'Orion Codex Probe Tools'
++          npm install --prefix $tools --no-save --package-lock=false @openai/codex@0.167.0
++          if ($LASTEXITCODE -ne 0) { throw 'The Codex probe could not install the official client.' }
++          python script/probe_windows_clients.py $tools
diff --cc script/probe_windows_clients.py
index 0000000,0000000..f1708e4
new file mode 100644
--- /dev/null
+++ b/script/probe_windows_clients.py
@@@ -1,0 -1,0 +1,66 @@@
++import json
++import os
++from pathlib import Path
++from queue import Queue
++import shutil
++import subprocess
++import sys
++import tempfile
++from threading import Thread
++import zipfile
++
++repo = Path.cwd()
++packages = repo / "src-tauri" / "resources" / "windows-connectors"
++tools = Path(sys.argv[1])
++codex = [str(next((tools / "node_modules" / "@openai").rglob("codex.exe")))]
++with tempfile.TemporaryDirectory(prefix="Orion Client Probe ", dir=os.environ["RUNNER_TEMP"], ignore_cleanup_errors=True) as temp:
++    isolated = Path(temp)
++    with zipfile.ZipFile(packages / "Orion-Claude-Connector.mcpb") as archive:
++        for name in ["manifest.json", "icon.png"]:
++            (isolated / name).write_bytes(archive.read(name))
++    npm = shutil.which("npm.cmd")
++    subprocess.run([npm, "exec", "--yes", "--package=@anthropic-ai/mcpb@2.1.2", "--",
++                    "mcpb", "validate", str(isolated / "manifest.json")], check=True, timeout=90)
++    fixture = repo / "src-tauri" / "tests" / "fixtures" / "mcp-vault.json"
++    vault = Path(os.environ["APPDATA"]) / "app.orion.knowledge" / "vault.json"
++    vault.parent.mkdir(parents=True, exist_ok=True)
++    shutil.copyfile(fixture, vault)
++    env = {**os.environ, "CODEX_HOME": str(isolated / "codex-home")}
++    env.pop("ORION_VAULT_PATH", None)
++    Path(env["CODEX_HOME"]).mkdir()
++    subprocess.run(codex + ["plugin", "marketplace", "add", str(packages / "Orion-Codex-Plugin"), "--json"],
++                   env=env, check=True, timeout=45)
++    subprocess.run(codex + ["plugin", "add", "orion@orion-desktop", "--json"], env=env, check=True, timeout=45)
++    child = subprocess.Popen(codex + ["app-server"], env=env, cwd=isolated, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
++    received = Queue()
++    def read_stdout():
++        for line in child.stdout:
++            received.put(json.loads(line))
++    Thread(target=read_stdout, daemon=True).start()
++    def send(message):
++        child.stdin.write(json.dumps(message) + "\n")
++        child.stdin.flush()
++    def response(wanted):
++        while True:
++            message = received.get(timeout=30)
++            if message.get("id") == wanted:
++                return message
++    try:
++        send({"id":1,"method":"initialize","params":{"clientInfo":{"name":"orion-windows-plugin-probe","version":"1"}}})
++        assert "result" in response(1)
++        send({"method":"initialized"})
++        send({"id":2,"method":"mcpServerStatus/list","params":{"serverName":"orion"}})
++        reply = response(2)
++        assert "result" in reply, reply
++        server, = reply["result"]["data"]
++        expected = {tool["name"] for tool in json.loads((isolated / "manifest.json").read_text(encoding="utf8"))["tools"]}
++        assert server["name"] == "orion"
++        assert set(server["tools"]) == expected, [len(server["tools"]), len(expected)]
++        print(f"The Windows Codex app-server launched Orion from the installed plugin cache and listed {len(expected)} tools.")
++    finally:
++        child.stdin.close()
++        try:
++            child.wait(timeout=10)
++        except subprocess.TimeoutExpired:
++            child.kill()
++            child.wait()
