// Build config for dsh-agy-link (tsdown / rolldown), mirroring the layout
// proven by dsh-lark-link:
//  Host half:  src/index.ts  -> dist/index.js (ESM, node), @deepseek-ai/*
//              stays external (provided by the harness host at runtime).
//  Client half: src/client/index.ts -> dist/client.js in the DSH
//              ModuleLoader closure-factory format.
import { defineConfig } from "tsdown";

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
    entry: { client: "src/client/index.ts" },
    outDir: "dist",
    format: ["cjs"],
    platform: "browser",
    target: "es2024",
    dts: false,
    clean: false,
    fixedExtension: false,
    external: [/^@deepseek-ai\//, "react"],
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: "dsh-agy-link", factory: (require) => {`,
      intro: "var module = { exports: {} }; var exports = module.exports;",
      footer: "return module.exports; } });",
    },
  },
]);
