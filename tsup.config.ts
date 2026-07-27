import { defineConfig } from 'tsup';

// Bundled: every MCP client spawns this process, so cold start is a UX
// property. The SDK stays external so auditors and npm dedupe both see the
// protocol layer as its own dependency.
export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node20.10',
  platform: 'node',
  clean: true,
  sourcemap: true,
  external: ['@modelcontextprotocol/sdk'],
  banner: { js: '#!/usr/bin/env node' },
});
