import json
import os
from pathlib import Path
from queue import Queue
import shutil
import subprocess
import sys
import tempfile
from threading import Thread
import zipfile

repo = Path.cwd()
packages = repo / "src-tauri" / "resources" / "windows-connectors"
tools = Path(sys.argv[1])
codex = [str(next((tools / "node_modules" / "@openai").rglob("codex.exe")))]
with tempfile.TemporaryDirectory(prefix="Orion Client Probe ", dir=os.environ["RUNNER_TEMP"], ignore_cleanup_errors=True) as temp:
    isolated = Path(temp)
    with zipfile.ZipFile(packages / "Orion-Claude-Connector.mcpb") as archive:
        for name in ["manifest.json", "icon.png"]:
            (isolated / name).write_bytes(archive.read(name))
    npm = shutil.which("npm.cmd")
    subprocess.run([npm, "exec", "--yes", "--package=@anthropic-ai/mcpb@2.1.2", "--",
                    "mcpb", "validate", str(isolated / "manifest.json")], check=True, timeout=90)
    fixture = repo / "src-tauri" / "tests" / "fixtures" / "mcp-vault.json"
    vault = Path(os.environ["APPDATA"]) / "app.orion.knowledge" / "vault.json"
    vault.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(fixture, vault)
    env = {**os.environ, "CODEX_HOME": str(isolated / "codex-home")}
    env.pop("ORION_VAULT_PATH", None)
    Path(env["CODEX_HOME"]).mkdir()
    subprocess.run(codex + ["plugin", "marketplace", "add", str(packages / "Orion-Codex-Plugin"), "--json"],
                   env=env, check=True, timeout=45)
    subprocess.run(codex + ["plugin", "add", "orion@orion-desktop", "--json"], env=env, check=True, timeout=45)
    child = subprocess.Popen(codex + ["app-server"], env=env, cwd=isolated, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    received = Queue()
    def read_stdout():
        for line in child.stdout:
            received.put(json.loads(line))
    Thread(target=read_stdout, daemon=True).start()
    def send(message):
        child.stdin.write(json.dumps(message) + "\n")
        child.stdin.flush()
    def response(wanted):
        while True:
            message = received.get(timeout=30)
            if message.get("id") == wanted:
                return message
    try:
        send({"id":1,"method":"initialize","params":{"clientInfo":{"name":"orion-windows-plugin-probe","version":"1"}}})
        assert "result" in response(1)
        send({"method":"initialized"})
        send({"id":2,"method":"mcpServerStatus/list","params":{"serverName":"orion"}})
        reply = response(2)
        assert "result" in reply, reply
        server, = reply["result"]["data"]
        expected = {tool["name"] for tool in json.loads((isolated / "manifest.json").read_text(encoding="utf8"))["tools"]}
        assert server["name"] == "orion"
        assert set(server["tools"]) == expected, [len(server["tools"]), len(expected)]
        print(f"The Windows Codex app-server launched Orion from the installed plugin cache and listed {len(expected)} tools.")
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
