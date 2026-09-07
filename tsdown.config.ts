// Build config for dsh-agy-link (tsdown / rolldown), mirroring the layout
// proven by dsh-lark-link:
//  Host half:  src/index.ts  -> dist/index.js (ESM, node), @deepseek-ai/*
//              stays external (provided by the harness host at runtime).
//  Client half: src/client/index.ts -> dist/client.js in the DSH
//              ModuleLoader closure-factory format.
import { defineConfig } from "tsdown";
import { cpSync } from "node:fs";
import { join } from "node:path";

const hostExternals = [/^@deepseek-ai\//, "qrcode", /^node:/];

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    target: "es2024",
    dts: true,
    clean: true,
    fixedExtension: false,
    external: hostExternals,
  },
  {
    // Standalone zero-dep stdio MCP server shipped as a plain asset; agy
    // launches it with the node binary per the workspace .mcp.json.
    entry: { bridge: "src/host/bridge.mjs" },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    target: "es2024",
    dts: false,
    clean: false,
    fixedExtension: false,
    external: [/^node:/],
    outputOptions: { entryFileNames: "bridge.mjs" },
    onSuccess: () => {
      cpSync(join(import.meta.dirname, "src/host/bridge.mjs"), join(import.meta.dirname, "dist/bridge.mjs"));
    },
  },
  {
    entry: { client: "src/client/index.ts" },
    outDir: "dist",
    format: ["cjs"],
    platform: "browser",
    target: "es2024",
    dts: false,
    clean: false,
    fixedExtension: false,
    external: [/^@deepseek-ai\//, "react", "react-dom", "react/jsx-runtime"],
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: "dsh-agy-link", factory: (require) => {`,
      intro: "var module = { exports: {} }; var exports = module.exports;",
      footer: "return module.exports; } });",
    },
  },
]);
