import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outfile = resolve(root, 'dist/server.js');

await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(resolve(root, 'dist'), { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire as __talkieCreateRequire } from 'node:module'; const require = __talkieCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
});

console.log(`built ${outfile}`);
