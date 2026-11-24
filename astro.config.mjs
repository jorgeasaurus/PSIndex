import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, passthroughImageService } from 'astro/config';
import node from '@astrojs/node';
import preact from '@astrojs/preact';
import vercel from '@astrojs/vercel';

const root = fileURLToPath(new URL('.', import.meta.url));

// includeFiles does not expand globs. The index build has already written public/a/<build>/ by
// the time Astro loads this config, and the /mcp function reads those files from disk.
function artifactFiles() {
  const dir = join(root, 'public', 'a');
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

export default defineConfig({
  site: 'https://psindex.vercel.app',
  output: 'static',
  // No session store: the endpoint is stateless, and the session runtime is unused weight.
  session: false,
  // The site has no optimized images. The default Sharp service would ship its binaries
  // inside the /mcp function.
  image: { service: passthroughImageService() },
  // Vercel builds set VERCEL and need the function bundle. Local preview uses the Node
  // adapter because @astrojs/vercel does not implement `astro preview`.
  adapter: process.env.VERCEL
    ? vercel({ includeFiles: artifactFiles() })
    : node({ mode: 'standalone' }),
  integrations: [preact()],
  build: { inlineStylesheets: 'auto' },
  vite: {
    ssr: {
      // Bundle the SDK so the function does not trace unused Express and Hono trees.
      noExternal: ['@modelcontextprotocol/sdk', 'zod'],
    },
  },
});
