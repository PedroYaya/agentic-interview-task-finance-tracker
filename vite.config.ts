import { defineConfig } from "vitest/config";
import { devtools } from "@tanstack/devtools-vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";

import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    // Vite 8 auto-enables console forwarding when it detects an AI coding
    // agent (e.g. CLAUDECODE=1). While the dev server is down, its sends
    // reject unhandled and it forwards that rejection again — an infinite
    // loop of "send was called before connect". The devtools plugin already
    // pipes browser logs to the terminal.
    forwardConsole: false,
  },
  plugins: [
    devtools(),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      strategy: ["url", "baseLocale"],
    }),
    tailwindcss(),
    // Unit tests import *.server.ts modules directly (in-memory DB); import
    // protection would mock those imports away under vitest's client
    // environment. Dev and build keep full protection.
    tanstackStart(
      process.env.VITEST ? { importProtection: { enabled: false } } : undefined,
    ),
    // Note: nitro's vite builder hardcodes noExternal for prod server builds,
    // so PGlite gets inlined and loses its wasm/data assets — restored by
    // scripts/copy-pglite-assets.mjs as a postbuild step (see package.json).
    nitro(),
    viteReact(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
  test: {
    include: ["tests/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["tests/e2e/**"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
  },
});

export default config;
