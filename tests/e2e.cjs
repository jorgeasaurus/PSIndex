// End-to-end behaviour checks against a built site.
//   npm run build && node tests/e2e.cjs        (starts `astro preview` itself)
// Needs Playwright with Chromium available (`npx playwright install chromium`).
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

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

const rowsReady = (p) => p.waitForSelector('.result:not(.result-skel), .empty', { timeout: 20000 });

async function run(browser) {
  let ctx = await browser.newContext();
  let p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  // Search across all sources, open the top hit with the keyboard.
  await p.goto(BASE);
  await rowsReady(p);
  check(/40,9\d\d results/.test(await p.textContent('.count')), 'loads every source', await p.textContent('.count'));
  await p.fill('input[type=search]', 'getmguser');
  await p.waitForFunction(() => document.querySelector('.result .result-name')?.textContent === 'Get-MgUser');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.detail .code-syntax');
  check((await p.textContent('.detail-title code')) === 'Get-MgUser', 'hyphenless query ranks Get-MgUser first');
  check((await p.locator('.params tbody tr').count()) > 3, 'syntax parsed into parameters');
  check(new URL(p.url()).searchParams.get('c') === 'graph:Get-MgUser', 'open entry is in the URL');

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
    await p.click(`.result >> nth=${i}`);
    await p.waitForSelector('.detail .code');
    opened.push(new URL(p.url()).searchParams.get('c'));
  }
  check(opened[0] !== opened[1] && opened.every((k) => k.includes('@')), 'each duplicate has its own key', opened.join(' | '));
  await p.goto(`${BASE}/?c=${encodeURIComponent(opened[1])}`);
  await p.waitForSelector('.detail .code');
  check((await p.locator('.detail .tags .tag >> nth=1').textContent()) === opened[1].split('@')[1], 'qualified deep link opens that module');

  // A legacy unqualified link adopts the canonical key and highlights the row.
  await p.goto(`${BASE}/?s=entra&q=Connect-Entra&c=entra:Connect-Entra`);
  await p.waitForSelector('.detail .code');
  await p.waitForTimeout(300);
  const c = new URL(p.url()).searchParams.get('c');
  check(c.includes('@') && (await p.locator('.result.is-open').count()) === 1, 'legacy link is canonicalised', c);

  // Switching source keeps the verb filter and drops source-specific ones (module, API).
  await p.goto(`${BASE}/?s=graph&verb=Remove&ver=beta`);
  await rowsReady(p);
  await p.click('.source:has-text("Az")');
  await p.waitForTimeout(400);
  const u = new URL(p.url()).searchParams;
  check(u.get('s') === 'az' && u.get('verb') === 'Remove' && !u.get('ver'), 'source switch keeps verb, drops API filter', u.toString());
  check((await p.locator('.result .result-name').first().textContent()).startsWith('Remove-Az'), 'verb filter applies to the new source');

  // Scrolling deep through "All" never leaves the viewport as skeletons.
  await p.goto(BASE);
  await rowsReady(p);
  for (let k = 1; k <= 80; k++) {
    await p.evaluate((y) => (document.querySelector('.results').scrollTop = y), k * 3200);
    await p.waitForTimeout(20);
  }
  await p.waitForTimeout(500);
  check((await p.locator('.result-skel').count()) === 0, 'deep scroll keeps rows rendered');
  check(!errors.length, 'no page errors', errors.join('; '));
  await ctx.close();

  // The largest shard is fetched once, at its versioned URL.
  ctx = await browser.newContext();
  const graphUrls = new Set();
  ctx.on('request', (r) => /\/idx\/graph\.json/.test(r.url()) && graphUrls.add(r.url()));
  p = await ctx.newPage();
  await p.goto(BASE);
  await rowsReady(p);
  check(graphUrls.size === 1 && [...graphUrls][0].includes('?v='), 'graph shard requested once, versioned', [...graphUrls].join(', '));
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
  await p.goto(`${BASE}/?s=mecm`);
  await rowsReady(p);
  await p.waitForTimeout(600);
  await p.fill('input[type=search]', 'device collection');
  await p.waitForTimeout(400);
  check(/results? ·/.test(await p.textContent('.count')) && !werr.length, 'mismatched description shard is ignored', werr.join('; '));
  await ctx.close();

  // Closing a deep-linked entry before the index loads keeps it closed.
  ctx = await browser.newContext();
  await ctx.route('**/idx/graph.json*', async (r) => { await new Promise((res) => setTimeout(res, 2000)); r.continue(); });
  p = await ctx.newPage();
  await p.goto(`${BASE}/?c=graph:Get-MgUser`);
  await p.waitForTimeout(500);
  await p.click('.wordmark');
  await rowsReady(p);
  await p.waitForTimeout(600);
  check(!new URL(p.url()).searchParams.get('c') && !(await p.locator('.detail-title').count()), 'dismissed deep link stays closed');
  await ctx.close();
}

// `astro preview` runs as a single background daemon: stop any running one, start ours, stop it after.
const astro = (...args) => new Promise((res) => spawn('npx', ['astro', 'preview', ...args], { stdio: 'ignore' }).on('exit', res));

(async () => {
  await astro('stop');
  await astro('--port', String(PORT));
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
