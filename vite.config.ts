import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { build } from "esbuild";
import { resolve } from "node:path";
import process from "node:process";
import type { Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

// A saved file must work over file://, with neither the app bundle nor a server.
// Compile the same viewer into a single classic script for the HTML exporter.
function visualisationExport(): Plugin {
  const moduleId = "virtual:orion-visualisation-export";
  let root: string;
  return {
    name: "orion-visualisation-export",
    configResolved(config) { root = config.root; },
    resolveId(id) { if (id === moduleId) return "\0" + moduleId; },
    async load(id) {
      if (id !== "\0" + moduleId) return;
      const bundle = await build({
        absWorkingDir: root,
        entryPoints: ["src/lib/visualArtifactExportViewer.tsx"],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2020",
        jsx: "automatic",
        minify: true,
        supported: { "inline-script": true },
        define: { "process.env.NODE_ENV": '"production"' },
        loader: { ".css": "empty" }, // Exported HTML includes the viewer stylesheet inline.
        metafile: true,
      });
      for (const input of Object.keys(bundle.metafile.inputs)) {
        if (input.startsWith("src/")) this.addWatchFile(resolve(root, input));
      }
      return "export const viewerScript = " + JSON.stringify(bundle.outputFiles[0].text);
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), visualisationExport()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    exclude: [...configDefaults.exclude, "outputs/**"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
