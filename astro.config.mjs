import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, passthroughImageService } from 'astro/config';
import node from '@astrojs/node';
import preact from '@astrojs/preact';
import vercel from '@astrojs/vercel';

const root = fileURLToPath(new URL('.', import.meta.url));
// The build layout, declared once: the config below uses it, and src/server/catalog.ts reads it
// back through astro:config/server.
const outDir = 'dist';
const clientDir = 'client';

// includeFiles does not expand globs, and it is read when the function is bundled, after Astro
// has copied public/ into build.client (<outDir>/<clientDir>/). The /mcp function reads this build's
// artifacts from that copy, so it carries them at the same place relative to its server folder
// as a Node build does (src/server/catalog.ts artifactRoot).
function artifactFiles() {
  const build = JSON.parse(readFileSync(join(root, 'src', 'sources.generated.json'), 'utf8')).build;
  const dir = join(root, 'public', 'a', build);
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push([outDir, clientDir, ...relative(join(root, 'public'), p).split(sep)].join('/'));
    }
  };
  walk(dir);
  return out;
}

export default defineConfig({
  site: 'https://psindex.vercel.app',
  output: 'static',
  outDir,
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
  build: { client: clientDir, inlineStylesheets: 'auto' },
  security: {
    // The CSRF check guards form posts. The site has no forms, and its one on-demand route, /mcp,
    // takes only application/json and answers any other content type itself with a CORS 415.
    checkOrigin: false,
    // Trust the Host (and a proxy's X-Forwarded-*) the client used, so /mcp result urls point at
    // the origin that was called: a preview port, a LAN host, or the production domain. Without
    // this the Node adapter rewrites every request to localhost and its configured port. The
    // origin only shapes links in the caller's own no-store response.
    allowedDomains: [{}],
  },
  vite: {
    ssr: {
      // Bundle the SDK so the function does not trace unused Express and Hono trees.
      noExternal: ['@modelcontextprotocol/sdk', 'zod'],
    },
  },
});
