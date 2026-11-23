// End-to-end behaviour checks against a built site.
//   npm run build && node tests/e2e.cjs        (starts `astro preview` itself)
// Needs Playwright with Chromium available (`npx playwright install chromium`).
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { total } = require('../src/sources.generated.json');

const PORT = 4399;
const BASE = `http://localhost:${PORT}`;
const results = [];
const check = (ok, name, detail = '') => results.push({ ok: !!ok, name, detail });

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('preview server did not start');
}

const TOTAL_LABEL = `${total.toLocaleString('en-US')} results`;
const param = (p, k) => new URL(p.url()).searchParams.get(k);
const nextFrame = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
const rowsReady = (p) => p.waitForSelector('.result:not(.result-skel), .empty', { timeout: 20000 });

async function run(browser) {
  let ctx = await browser.newContext();
  let p = await ctx.newPage();
  const moduleUrls = [];
  p.on('request', (r) => r.url().includes('/data/') && moduleUrls.push(r.url()));
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  // Search across all sources, open the top hit with the keyboard.
  await p.goto(BASE);
  await rowsReady(p);
  check((await p.textContent('.count')) === TOTAL_LABEL, 'loads every source', await p.textContent('.count'));
  await p.fill('input[type=search]', 'getmguser');
  await p.waitForFunction(() => document.querySelector('.result .result-name')?.textContent === 'Get-MgUser');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.detail .code-syntax');
  check((await p.textContent('.detail-title code')) === 'Get-MgUser', 'hyphenless query ranks Get-MgUser first');
  check((await p.locator('.params tbody tr').count()) > 3, 'syntax parsed into parameters');
  check(param(p, 'c') === 'graph:Get-MgUser', 'open entry is in the URL');
  check(moduleUrls.length > 0 && moduleUrls.every((u) => u.includes('?v=')), 'module files fetched at versioned URLs', moduleUrls[0]);

  // Descriptions arriving late refresh the rows in place: the scroll position survives.
  {
    const c2 = await browser.newContext();
    let release;
    const gate = new Promise((r) => (release = r));
    await c2.route('**/idx/graph.desc.json*', async (r) => { await gate; r.continue(); });
    const p2 = await c2.newPage();
    await p2.goto(`${BASE}/?s=graph&q=mguser`);
    await p2.waitForFunction(() => document.querySelectorAll('.result:not(.result-skel)').length > 5);
    await p2.evaluate(() => (document.querySelector('.results').scrollTop = 6400));
    const descArrived = p2.waitForResponse(/graph\.desc\.json/);
    release();
    await descArrived;
    await p2.waitForFunction(() => [...document.querySelectorAll('.result .result-desc')].some((d) => d.textContent && !d.querySelector('.result-module')));
    const top = await p2.evaluate(() => document.querySelector('.results').scrollTop);
    check(top >= 6000, 'late descriptions keep the scroll position', `scrollTop ${top}`);
    await c2.close();
  }

  // With no stored override, the background field follows the OS theme as it changes.
  {
    const c3 = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce' });
    const p3 = await c3.newPage();
    await p3.goto(BASE);
    await rowsReady(p3);
    // Brightest glyph channel in the top band of the canvas: light theme draws darker glyphs.
    await p3.evaluate(() => {
      window.__brightest = () => {
        const c = document.querySelector('canvas.field');
        const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 300)).data;
        let max = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
        return max;
      };
    });
    const brightest = () => p3.evaluate(() => window.__brightest());
    const dark = await brightest();
    await p3.emulateMedia({ colorScheme: 'light' });
    await p3.waitForFunction((was) => {
      const max = window.__brightest();
      return max > 0 && max < was * 0.8;
    }, dark, { timeout: 5000 }).then(() => true, () => false).then(async (ok) => {
      check(ok, 'field re-tints when the OS theme changes', `brightest channel ${dark} -> ${await brightest()}`);
    });
    await c3.close();
  }

  // The theme toggle applies and remembers an explicit theme.
  const before = await p.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  await p.click('button[aria-label="Toggle light or dark theme"]');
  const after = await p.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('psindex-theme')]);
  check(after[0] && after[0] !== before && after[0] === after[1], 'theme toggle applies and stores the theme', after.join(' / '));

  // MECM documents its parameters; their descriptions render.
  await p.goto(`${BASE}/?c=mecm:Invoke-CMClientAction`);
  await p.waitForSelector('.detail .param-desc');
  check((await p.textContent('.detail-title code')) === 'Invoke-CMClientAction', 'documented parameters render');

  // Duplicate names: distinct rows, labelled, each opening its own module.
  await p.goto(`${BASE}/?s=exchange&q=Get-CsExternalAccessPolicy`);
  await rowsReady(p);
  const metas = await p.locator('.result .result-meta').allTextContents();
  check(metas.length === 2 && metas[0] !== metas[1] && metas.every(Boolean), 'duplicate rows are labelled by module', metas.join(' / '));
  const opened = [];
  for (let i = 0; i < 2; i++) {
    const before = param(p, 'c');
    await p.click(`.result >> nth=${i}`);
    // The pane may already show the previous entry; wait for this click's key to reach the URL.
    await p.waitForFunction((prev) => { const c = new URLSearchParams(location.search).get('c'); return c && c !== prev; }, before);
    opened.push(param(p, 'c'));
  }
  check(opened[0] !== opened[1] && opened.every((k) => k.includes('@')), 'each duplicate has its own key', opened.join(' | '));
  await p.goto(`${BASE}/?c=${encodeURIComponent(opened[1])}`);
  await p.waitForSelector('.detail .code');
  check((await p.locator('.detail .tags .tag >> nth=1').textContent()) === opened[1].split('@')[1], 'qualified deep link opens that module');

  // A legacy unqualified link adopts the canonical key and highlights the row.
  await p.goto(`${BASE}/?s=entra&q=Connect-Entra&c=entra:Connect-Entra`);
  await p.waitForFunction(() => new URLSearchParams(location.search).get('c')?.includes('@'));
  const c = param(p, 'c');
  check(c.includes('@') && (await p.locator('.result.is-open').count()) === 1, 'legacy link is canonicalised', c);

  // Switching source keeps the verb filter and drops source-specific ones (module, API).
  await p.goto(`${BASE}/?s=graph&verb=Remove&ver=beta`);
  await rowsReady(p);
  await p.click('.source:has-text("Az")');
  await p.waitForFunction(() => document.querySelector('.result .result-name')?.textContent?.includes('-Az'));
  const u = new URL(p.url()).searchParams;
  check(u.get('s') === 'az' && u.get('verb') === 'Remove' && !u.get('ver'), 'source switch keeps verb, drops API filter', u.toString());
  check((await p.locator('.result .result-name').first().textContent()).startsWith('Remove-Az'), 'verb filter applies to the new source');

  // Filters round-trip through the URL; Reset clears them but keeps the source.
  await p.goto(`${BASE}/?s=graph&verb=Get&ex=1`);
  await rowsReady(p);
  await p.click('button[aria-controls=filters]');
  check((await p.inputValue('.filters select >> nth=0')) === 'Get' && (await p.isChecked('.filters input[type=checkbox]')), 'filters restored from the URL');
  await p.click('.filters .link-btn');
  await p.waitForFunction(() => location.search === '?s=graph');
  check(param(p, 's') === 'graph' && !param(p, 'verb') && !param(p, 'ex'), 'Reset clears filters, keeps the source', new URL(p.url()).search);

  // Scrolling deep through "All" never leaves the viewport as skeletons.
  await p.goto(BASE);
  await rowsReady(p);
  for (let k = 1; k <= 80; k++) {
    await p.evaluate((y) => (document.querySelector('.results').scrollTop = y), k * 3200);
    await nextFrame(p);
  }
  const settled = await p.waitForFunction(() => !document.querySelector('.result-skel'), null, { timeout: 5000 }).then(() => true, () => false);
  check(settled, 'deep scroll keeps rows rendered');
  check(!errors.length, 'no page errors', errors.join('; '));
  await ctx.close();

  // Each shard is fetched exactly once, at its build-versioned URL.
  ctx = await browser.newContext();
  const graphReqs = [];
  ctx.on('request', (r) => /\/idx\/graph\.json/.test(r.url()) && graphReqs.push(r.url()));
  p = await ctx.newPage();
  await p.goto(BASE);
  await rowsReady(p);
  check(graphReqs.length === 1 && graphReqs[0].includes('?v='), 'shard fetched once, versioned', graphReqs.join(', '));
  await ctx.close();

  // A failed shard surfaces an error instead of loading forever.
  ctx = await browser.newContext();
  await ctx.route('**/idx/az.json*', (r) => r.fulfill({ status: 500, body: 'boom' }));
  p = await ctx.newPage();
  await p.goto(BASE);
  await p.waitForSelector('[role=alert]', { timeout: 10000 }).catch(() => {});
  check((await p.locator('[role=alert]').count()) > 0, 'failed index load shows an error');
  await ctx.close();

  // A description shard that doesn't match its index is ignored.
  ctx = await browser.newContext();
  await ctx.route('**/idx/mecm.desc.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '["x"]' }));
  p = await ctx.newPage();
  const werr = [];
  p.on('console', (m) => m.type() === 'error' && werr.push(m.text()));
  const descLoaded = p.waitForResponse(/\/idx\/mecm\.desc\.json/);
  await p.goto(`${BASE}/?s=mecm`);
  await rowsReady(p);
  await descLoaded;
  await p.fill('input[type=search]', 'device collection');
  const searched = await p.waitForFunction(() => /Collection/.test(document.querySelector('.result .result-name')?.textContent ?? ''), null, { timeout: 5000 }).then(() => true, () => false);
  check(searched && !werr.length, 'mismatched description shard is ignored', werr.join('; '));
  await ctx.close();

  // Closing a deep-linked entry before the index loads keeps it closed.
  ctx = await browser.newContext();
  {
    let release;
    const gate = new Promise((r) => (release = r));
    await ctx.route('**/idx/graph.json*', async (r) => { await gate; r.continue(); });
    p = await ctx.newPage();
    await p.goto(`${BASE}/?c=graph:Get-MgUser`);
    // Wait for the interactive session (not the static server-rendered shell), then click Home
    // while the held shard keeps the deep-link lookup pending.
    await p.waitForSelector('.app:not([aria-busy])', { state: 'attached' });
    await p.evaluate(() => { window.__sameDocument = true; });
    await p.click('.wordmark');
    release();
  }
  await rowsReady(p);
  // A search issued now is answered after the pending lookup (the worker replies in order).
  await p.fill('input[type=search]', 'get-mguser');
  await p.waitForFunction(() => document.querySelector('.result .result-name')?.textContent === 'Get-MgUser');
  const sameDocument = await p.evaluate(() => window.__sameDocument === true);
  check(sameDocument && !param(p, 'c') && !(await p.locator('.detail-title').count()), 'dismissed deep link stays closed', sameDocument ? '' : 'page navigated');
  await ctx.close();
}

// `astro preview --background` starts a single daemon and returns: stop any running one, start ours, stop it after.
const astro = (...args) => new Promise((res) => spawn('npx', ['astro', 'preview', ...args], { stdio: 'ignore' }).on('exit', res));

(async () => {
  await astro('stop');
  await astro('--port', String(PORT), '--background');
  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch();
    await run(browser);
  } catch (e) {
    check(false, 'harness', e.message);
  } finally {
    await browser?.close();
    await astro('stop');
  }
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
