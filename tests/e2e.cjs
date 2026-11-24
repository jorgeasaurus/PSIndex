// End-to-end behaviour checks against a built site.
//   npm run build && node tests/e2e.cjs
// Serves dist/ itself on its own port (it never touches a running `astro preview`).
// Needs Playwright with Chromium available (`npx playwright install chromium`).
const http = require('node:http');
const { existsSync } = require('node:fs');
const sirv = require('sirv');
const { chromium } = require('playwright');
const { total, build } = require('../src/sources.generated.json');
const BUILD_PATH = `/a/${build}/`;

const PORT = 4399;
const BASE = `http://localhost:${PORT}`;
const results = [];
const check = (ok, name, detail = '') => results.push({ ok: !!ok, name, detail });


const TOTAL_LABEL = `${total.toLocaleString('en-US')} results`;
const param = (p, k) => new URL(p.url()).searchParams.get(k);
const nextFrame = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
const rowsReady = (p) => p.waitForSelector('.result:not(.result-skel), .empty', { timeout: 20000 });
const topIs = (p, name) => p.waitForFunction((n) => document.querySelector('.result .result-name')?.textContent === n, name);
const titleIs = (p, name) => p.waitForFunction((n) => document.querySelector('.detail-title code')?.textContent === n, name);
/** Search and wait for `name` to be the top hit. */
async function search(p, q, name) {
  await p.fill('input[type=search]', q);
  await topIs(p, name);
}
/** Hold matching requests until the returned release() is called. */
async function hold(ctx, pattern) {
  let release;
  const gate = new Promise((r) => (release = r));
  await ctx.route(pattern, async (r) => { await gate; r.continue(); });
  return release;
}

/**
 * Each scenario gets its own browser context and page, so none depends on another's state.
 * A wait that times out fails only its scenario (with the scenario's name); page errors are
 * reported against the scenario that raised them.
 */
const scenarios = [
  {
    name: 'search and open with the keyboard',
    async run(p) {
      const moduleUrls = [];
      p.on('request', (r) => r.url().includes('/data/') && moduleUrls.push(r.url()));
      await p.goto(BASE);
      await rowsReady(p);
      check((await p.textContent('.count')) === TOTAL_LABEL, 'loads every source', await p.textContent('.count'));
      await search(p, 'getmguser', 'Get-MgUser');
      await p.keyboard.press('Enter');
      await p.waitForSelector('.detail .code-syntax');
      check((await p.textContent('.detail-title code')) === 'Get-MgUser', 'hyphenless query ranks Get-MgUser first');
      check((await p.locator('.params tbody tr').count()) > 3, 'syntax parsed into parameters');
      check(param(p, 'c') === 'graph:Get-MgUser', 'open entry is in the URL');
      check(moduleUrls.length > 0 && moduleUrls.every((u) => u.includes(BUILD_PATH)), 'module files fetched at versioned URLs', moduleUrls[0]);
    },
  },
  {
    name: 'focus and Escape',
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      const focused = () => p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
      check((await focused()) === 'Search cmdlets', 'search box has focus once the page is live', await focused());
      await search(p, 'get-mguser', 'Get-MgUser');
      await p.click('.result');
      await titleIs(p, 'Get-MgUser');
      check((await focused()) === 'Search cmdlets', 'clicking a result keeps focus in the search box', await focused());
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !document.querySelector('.detail-title'));
      check((await p.inputValue('input[type=search]')) === 'get-mguser', 'Escape closes the entry and keeps the query', await p.inputValue('input[type=search]'));
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => document.querySelector('input[type=search]').value === '');
      await p.keyboard.type('get/');
      check((await p.inputValue('input[type=search]')) === 'get', '"/" never enters the query', await p.inputValue('input[type=search]'));
    },
  },
  {
    name: 'narrow-screen entry dialog',
    context: { viewport: { width: 390, height: 844 } },
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      await search(p, 'get-mguser', 'Get-MgUser');
      await p.keyboard.press('Enter');
      await titleIs(p, 'Get-MgUser');
      await p.waitForFunction(() => document.activeElement?.id === 'detail-title');
      const state = await p.evaluate(() => ({
        dialog: document.querySelector('.pane-detail')?.getAttribute('role'),
        bandInert: document.querySelector('.band')?.inert,
        resultsInert: document.querySelector('.pane-results')?.inert,
      }));
      check(state.dialog === 'dialog' && state.bandInert && state.resultsInert, 'the open entry is a modal dialog that takes focus', JSON.stringify(state));
      await p.click('.detail-back');
      await p.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Search cmdlets');
      // The phone's Back gesture closes the entry instead of leaving the page.
      await p.keyboard.press('Enter');
      await titleIs(p, 'Get-MgUser');
      await p.goBack();
      await p.waitForFunction(() => !document.querySelector('.detail-title'));
      check(p.url().startsWith(BASE) && (await p.inputValue('input[type=search]')) === 'get-mguser' && !param(p, 'c'), 'Back closes the entry dialog', p.url());
      const width = await p.evaluate(() => document.documentElement.scrollWidth);
      check(width <= 390, 'no sideways page scroll at phone width', String(width));
    },
  },
  {
    name: 'search quality',
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      const count = () => p.$eval('.count', (e) => Number(e.textContent.split(' ')[0].replace(/,/g, '')));
      await search(p, 'get-mgsuer', 'Get-MgUser'); // swapped letters
      check((await count()) < 2000, 'a typo finds the cmdlet without flooding the list', String(await count()));
      await search(p, 'getmguser', 'Get-MgUser');
      const mark = await p.$eval('.result .result-name mark', (m) => m.textContent).catch(() => '');
      check(mark === 'Get-MgUser', 'a hyphenless match is highlighted', mark);
      await p.fill('input[type=search]', '   ');
      await p.waitForFunction((t) => document.querySelector('.count')?.textContent?.startsWith(t), TOTAL_LABEL);
      const label = await p.textContent('.count');
      check(!label.includes('ms') && !param(p, 'q'), 'a blank query is no query (no timing, no q in the URL)', `${label} ${p.url()}`);
      await p.goto(`${BASE}/?s=graph&verb=Frobnicate`);
      await rowsReady(p);
      await p.click('button[aria-controls=filters]');
      const verb = await p.$eval('.filters select', (s) => s.options[s.selectedIndex]?.textContent);
      check(verb === 'Frobnicate (none here)', 'a filter value this scope lacks stays visible and clearable', verb);
    },
  },
  {
    name: 'links and load failures',
    // The deliberately failed module fetch logs its own console error.
    allowErrors: true,
    async run(p, ctx) {
      await p.goto(`${BASE}/?c=graph:Get-MgNoSuchThing`);
      await p.waitForSelector('.notice-link');
      check(!param(p, 'c'), 'a link to a missing cmdlet says so (and leaves the URL)', await p.textContent('.notice-link p'));
      await p.goto(`${BASE}/?c=EXCHANGE:get-csexternalaccesspolicy@microsoftteams`);
      await titleIs(p, 'Get-CsExternalAccessPolicy');
      await p.waitForFunction(() => new URLSearchParams(location.search).get('c') === 'exchange:Get-CsExternalAccessPolicy@MicrosoftTeams');
      // The first load of a module file fails; "Try again" loads it.
      let failed = false;
      await ctx.route(`**${BUILD_PATH}data/graph/**`, (r) => (failed ? r.continue() : ((failed = true), r.fulfill({ status: 500, body: '' }))));
      await p.goto(`${BASE}/?c=graph:Get-MgUser`);
      await p.waitForSelector('.detail .notice-error');
      await p.click('.detail .notice-error button');
      await p.waitForSelector('.detail .code-syntax');
    },
  },
  {
    name: 'arrow keys and Enter',
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      await search(p, 'getmguser', 'Get-MgUser');
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('ArrowDown');
      const third = await p.textContent('.result.is-active .result-name');
      await p.keyboard.press('Enter');
      await titleIs(p, third);
      await search(p, 'get-azvm', 'Get-AzVM');
      const activeTop = await p.evaluate(() => document.querySelector('.result.is-active')?.style.top);
      check(third && third !== 'Get-MgUser' && activeTop === '0px', 'keyboard cursor opens its row and resets per search', `${third}, active at ${activeTop}`);
    },
  },
  {
    name: 'Enter right after typing',
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      await p.fill('input[type=search]', 'get-azvmss');
      await p.keyboard.press('Enter');
      await titleIs(p, 'Get-AzVmss');
    },
  },
  {
    name: 'related entry from a scrolled pane',
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      await search(p, 'get-mguser', 'Get-MgUser');
      await p.click('.result');
      await p.waitForSelector('.related button');
      const scrolled = await p.evaluate(() => { const el = document.querySelector('.pane-detail'); el.scrollTop = el.scrollHeight; return el.scrollTop; });
      const next = await p.textContent('.related button code');
      await p.click('.related button');
      await titleIs(p, next);
      const after = await p.evaluate(() => document.querySelector('.pane-detail').scrollTop);
      check(scrolled > 0 && after === 0, 'related entry opens at the top of the pane', `scrollTop ${scrolled} -> ${after}`);
    },
  },
  {
    name: 'late descriptions',
    async setup(ctx) { this.release = await hold(ctx, `**${BUILD_PATH}idx/graph.desc.json`); },
    async run(p) {
      await p.goto(`${BASE}/?s=graph&q=mguser`);
      await p.waitForFunction(() => document.querySelectorAll('.result:not(.result-skel)').length > 5);
      await p.evaluate(() => (document.querySelector('.results').scrollTop = 6400));
      const descArrived = p.waitForResponse(/graph\.desc\.json/);
      this.release();
      await descArrived;
      await p.waitForFunction(() => [...document.querySelectorAll('.result .result-desc')].some((d) => d.textContent && !d.querySelector('.result-module')));
      const top = await p.evaluate(() => document.querySelector('.results').scrollTop);
      check(top >= 6000, 'late descriptions keep the scroll position', `scrollTop ${top}`);
    },
  },
  {
    name: 'field follows the OS theme',
    context: { colorScheme: 'dark', reducedMotion: 'reduce' },
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      // Brightest glyph channel in the top band of the canvas: light theme draws darker glyphs.
      await p.evaluate(() => {
        window.__brightest = () => {
          const c = document.querySelector('canvas.field');
          const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 300)).data;
          let max = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
          return max;
        };
      });
      const dark = await p.evaluate(() => window.__brightest());
      await p.emulateMedia({ colorScheme: 'light' });
      await p.waitForFunction((was) => { const max = window.__brightest(); return max > 0 && max < was * 0.8; }, dark);
    },
  },
  {
    name: 'theme toggle',
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      const before = await p.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      await p.click('button[aria-label="Dark theme"]');
      const after = await p.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('psindex-theme')]);
      check(after[0] && after[0] !== before && after[0] === after[1], 'theme toggle applies and stores the theme', after.join(' / '));
    },
  },
  {
    name: 'MECM documented parameters',
    async run(p) {
      await p.goto(`${BASE}/?c=mecm:Invoke-CMClientAction`);
      await p.waitForSelector('.detail .param-desc');
      check((await p.textContent('.detail-title code')) === 'Invoke-CMClientAction', 'documented parameters render');
    },
  },
  {
    name: 'duplicate names',
    async run(p) {
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
    },
  },
  {
    name: 'module versions',
    async run(p) {
      const versionTags = () => p.$$eval('.detail .tags .tag[title="Module version"]', (t) => t.map((x) => x.textContent));
      await p.goto(`${BASE}/?c=exchange:Get-CsExternalAccessPolicy@MicrosoftTeams`);
      await p.waitForSelector('.detail .code');
      const teams = await versionTags();
      await p.goto(`${BASE}/?c=exchange:Set-Mailbox`);
      await p.waitForSelector('.detail .code');
      const exo = await versionTags();
      // Teams has its own version under Exchange's; an ExchangePowerShell cmdlet's is the source's, so no tag.
      check(teams.length === 1 && /^v\d/.test(teams[0]) && exo.length === 0, 'a module version shows only where it differs from its source', `${teams} / ${exo}`);
    },
  },
  {
    name: 'legacy link',
    async run(p) {
      await p.goto(`${BASE}/?s=entra&q=Connect-Entra&c=entra:Connect-Entra`);
      await p.waitForFunction(() => new URLSearchParams(location.search).get('c')?.includes('@'));
      const c = param(p, 'c');
      check(c.includes('@') && (await p.locator('.result.is-open').count()) === 1, 'legacy link is canonicalised', c);
    },
  },
  {
    name: 'source switch',
    async run(p) {
      await p.goto(`${BASE}/?s=graph&verb=Remove&ver=beta`);
      await rowsReady(p);
      await p.click('.source:has-text("Az")');
      await p.waitForFunction(() => document.querySelector('.result .result-name')?.textContent?.includes('-Az'));
      const u = new URL(p.url()).searchParams;
      check(u.get('s') === 'az' && u.get('verb') === 'Remove' && !u.get('ver'), 'source switch keeps verb, drops API filter', u.toString());
      check((await p.locator('.result .result-name').first().textContent()).startsWith('Remove-Az'), 'verb filter applies to the new source');
    },
  },
  {
    name: 'filters in the URL',
    async run(p) {
      await p.goto(`${BASE}/?s=graph&verb=Get&ex=1`);
      await rowsReady(p);
      await p.click('button[aria-controls=filters]');
      check((await p.inputValue('.filters select >> nth=0')) === 'Get' && (await p.isChecked('.filters input[type=checkbox]')), 'filters restored from the URL');
      await p.click('.filters .link-btn');
      await p.waitForFunction(() => location.search === '?s=graph');
      check(param(p, 's') === 'graph' && !param(p, 'verb') && !param(p, 'ex'), 'Reset clears filters, keeps the source', new URL(p.url()).search);
    },
  },
  {
    name: 'deep scroll',
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      for (let k = 1; k <= 80; k++) {
        await p.evaluate((y) => (document.querySelector('.results').scrollTop = y), k * 3200);
        await nextFrame(p);
      }
      await p.waitForFunction(() => !document.querySelector('.result-skel'));
    },
  },
  {
    name: 'shard requests',
    async run(p, ctx) {
      const graphReqs = [];
      ctx.on('request', (r) => /\/idx\/graph\.json/.test(r.url()) && graphReqs.push(r.url()));
      await p.goto(BASE);
      await rowsReady(p);
      check(graphReqs.length === 1 && graphReqs[0].includes(BUILD_PATH), 'shard fetched once, versioned', graphReqs.join(', '));
    },
  },
  {
    name: 'failed index load',
    // The page reports the failure; the failed fetch's own console error is expected here.
    allowErrors: true,
    async setup(ctx) { await ctx.route(`**${BUILD_PATH}idx/az.json`, (r) => r.fulfill({ status: 500, body: 'boom' })); },
    async run(p) {
      await p.goto(BASE);
      await p.waitForSelector('[role=alert]');
    },
  },
  {
    name: 'missing description shard',
    // The failed fetch logs its own console error; that is the point of the scenario.
    allowErrors: true,
    async setup(ctx) { await ctx.route(`**${BUILD_PATH}idx/mecm.desc.json`, (r) => r.fulfill({ status: 404, body: '' })); },
    async run(p) {
      const descTried = p.waitForResponse(/\/idx\/mecm\.desc\.json/);
      await p.goto(`${BASE}/?s=mecm`);
      await rowsReady(p);
      await descTried;
      // Names still search without descriptions, and the page says only names are searched.
      await p.fill('input[type=search]', 'device collection');
      await p.waitForFunction(() => /Collection/.test(document.querySelector('.result .result-name')?.textContent ?? ''));
      check(/only cmdlet names/.test(await p.textContent('.pane-results')), 'a failed description file is announced');
      // A query only a description could match reaches the final empty state, not a busy one.
      await p.fill('input[type=search]', 'qqqzzzxx');
      await p.waitForSelector('.empty .chip');
      check(!(await p.locator('.empty[aria-busy]').count()), 'empty state is final once descriptions failed');
    },
  },
  {
    name: 'stale module file offers Reload',
    allowErrors: true,
    async setup(ctx) { await ctx.route(`**${BUILD_PATH}data/**`, (r) => r.fulfill({ status: 404, body: '' })); },
    async run(p) {
      await p.goto(`${BASE}/?c=graph:Get-MgUser`);
      await p.waitForSelector('.detail .notice-error');
      const buttons = await p.locator('.detail .notice-error button').allTextContents();
      check(buttons.join() === 'Reload', 'a 404 offers Reload, not a retry that cannot work', buttons.join());
    },
  },
  {
    name: 'Try again keeps focus',
    allowErrors: true,
    async setup(ctx) {
      let first = true;
      await ctx.route(`**${BUILD_PATH}data/**`, (r) => (first ? ((first = false), r.abort()) : r.continue()));
    },
    async run(p) {
      await p.goto(`${BASE}/?c=graph:Get-MgUser`);
      await p.click('.detail .notice-error button:text("Try again")');
      await p.waitForSelector('.detail .code-syntax');
      const focus = await p.evaluate(() => document.activeElement?.id);
      check(focus === 'detail-title', 'focus moves to the entry title after Try again', focus);
    },
  },
  {
    name: 'link hygiene',
    async run(p) {
      await p.goto(`${BASE}/?s=Graph&q=%20%20get-mguser%20%20&c=%20graph:Get-MgUser%20`);
      await titleIs(p, 'Get-MgUser');
      await p.waitForFunction(() => location.search === '?q=get-mguser&s=graph&c=graph%3AGet-MgUser');
      await p.goto(`${BASE}/?c=%20%20`);
      await rowsReady(p);
      check(!(await p.locator('.notice-link').count()) && !param(p, 'c'), 'a blank link key is no link');
    },
  },
  {
    name: 'dialog history stays on the page',
    context: { viewport: { width: 390, height: 844 } },
    async run(p) {
      // history.length does not shrink on back, so each entry carries a marker. Seed sits behind
      // the page: one Back from the page lands there, and a second Back from the dialog would too.
      await p.goto(`${BASE}/?q=seed-marker`);
      await rowsReady(p);
      await p.evaluate(() => {
        window.__pops = 0;
        addEventListener('popstate', () => { window.__pops++; });
        history.replaceState({ marker: 'seed' }, '', location.href);
        history.pushState({ marker: 'page' }, '', location.pathname);
      });
      await search(p, 'get-mguser', 'Get-MgUser');
      const before = await p.evaluate(() => history.length);
      await p.keyboard.press('Enter');
      await titleIs(p, 'Get-MgUser');
      check(await p.evaluate((n) => history.length === n + 1, before), 'opening the dialog adds one history entry');

      // Both Escapes run before popstate, the way a key repeat does. Target an element: the
      // page handler calls closest() on the event target, which document itself does not have.
      const pops = await p.evaluate(() => window.__pops);
      await p.evaluate(() => {
        const esc = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        esc();
        esc();
      });
      await p.waitForFunction((n) => window.__pops > n && !document.querySelector('.detail-title'), pops);
      await p.waitForTimeout(250); // a second history.back() would land after the first popstate
      const escaped = await p.evaluate(() => ({
        pops: window.__pops,
        marker: history.state?.marker,
        q: document.querySelector('input[type=search]').value,
      }));
      check(
        escaped.pops === pops + 1 && escaped.marker === 'page' && escaped.q === 'get-mguser',
        'a repeated Escape closes the dialog once and stays on the page',
        JSON.stringify(escaped),
      );

      await p.keyboard.press('Enter');
      await titleIs(p, 'Get-MgUser');
      const opened = await p.evaluate(() => window.__pops);
      await p.setViewportSize({ width: 1200, height: 800 });
      await p.waitForFunction(
        (n) => window.__pops > n
          && document.querySelector('.detail-title code')?.textContent === 'Get-MgUser'
          && document.querySelector('.pane-detail')?.getAttribute('role') !== 'dialog',
        opened,
      );
      await p.waitForTimeout(250);
      const widened = await p.evaluate(() => ({ pops: window.__pops, c: new URLSearchParams(location.search).get('c') }));
      check(
        widened.pops === opened + 1 && widened.c === 'graph:Get-MgUser',
        'widening drops the dialog history entry and keeps the open link',
        JSON.stringify(widened),
      );
      await p.goBack();
      await p.waitForFunction(() => history.state?.marker === 'seed');
      check(new URL(p.url()).searchParams.get('q') === 'seed-marker', 'Back after widening returns to the previous page', p.url());
    },
  },
  {
    name: 'Escape cancels a pending Enter',
    async setup(ctx) { this.release = await hold(ctx, `**${BUILD_PATH}idx/graph.json`); },
    async run(p) {
      await p.goto(BASE);
      await p.waitForSelector('.app:not([aria-busy])', { state: 'attached' });
      await p.fill('input[type=search]', 'get-mguser');
      await p.keyboard.press('Enter');
      await p.keyboard.press('Escape');
      this.release();
      await topIs(p, 'Get-MgUser');
      await nextFrame(p);
      check((await p.inputValue('input[type=search]')) === 'get-mguser' && !(await p.locator('.detail-title').count()), 'Escape gives up the Enter and keeps the query');
    },
  },
  {
    name: 'superseded Enter',
    async setup(ctx) { this.release = await hold(ctx, `**${BUILD_PATH}idx/graph.json`); },
    async run(p) {
      await p.goto(BASE);
      await p.waitForSelector('.app:not([aria-busy])', { state: 'attached' });
      await p.fill('input[type=search]', 'get-mguser');
      await p.keyboard.press('Enter');
      await p.fill('input[type=search]', 'get-az'); // a new search supersedes the pending Enter
      this.release();
      await rowsReady(p);
      // The worker answers in order: once a search issued now has rendered, any row fetch the
      // stale Enter could have made has been answered too.
      await search(p, 'get-azvm', 'Get-AzVM');
      check(!(await p.locator('.detail-title').count()) && !param(p, 'c'), 'superseded Enter opens nothing');
    },
  },
  {
    name: 'Enter over a pending deep link',
    async setup(ctx) { this.release = await hold(ctx, `**${BUILD_PATH}idx/graph.json`); },
    async run(p) {
      await p.goto(`${BASE}/?c=graph:Get-MgUser`);
      await p.waitForSelector('.app:not([aria-busy])', { state: 'attached' });
      await p.fill('input[type=search]', 'get-azvm');
      await p.keyboard.press('Enter'); // the later choice: it wins over the link still being looked up
      this.release();
      await titleIs(p, 'Get-AzVM');
      await p.waitForFunction(() => new URLSearchParams(location.search).get('c') === 'az:Get-AzVM');
    },
  },
  {
    name: 'dismissed deep link',
    async setup(ctx) { this.release = await hold(ctx, `**${BUILD_PATH}idx/graph.json`); },
    async run(p) {
      await p.goto(`${BASE}/?c=graph:Get-MgUser`);
      // Wait for the interactive session (not the static server-rendered shell), then click Home
      // while the held shard keeps the deep-link lookup pending.
      await p.waitForSelector('.app:not([aria-busy])', { state: 'attached' });
      await p.evaluate(() => { window.__sameDocument = true; });
      await p.click('.wordmark');
      this.release();
      await rowsReady(p);
      // A search issued now is answered after the pending lookup (the worker replies in order).
      await search(p, 'get-mguser', 'Get-MgUser');
      const sameDocument = await p.evaluate(() => window.__sameDocument === true);
      check(sameDocument && !param(p, 'c') && !(await p.locator('.detail-title').count()), 'dismissed deep link stays closed', sameDocument ? '' : 'page navigated');
    },
  },
];

async function runScenario(browser, sc) {
  const ctx = await browser.newContext(sc.context);
  ctx.setDefaultTimeout(10000);
  const errors = [];
  try {
    await sc.setup?.(ctx);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    if (!sc.allowErrors) p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await sc.run(p, ctx);
    // The scenario itself passes when every wait in it was met and the page raised no errors.
    check(!errors.length, sc.name, errors.length ? `page errors: ${errors.join('; ')}` : '');
  } catch (e) {
    check(false, sc.name, e.message.split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

(async () => {
  // The Node adapter writes the static site to dist/client so /mcp can be a function.
  // A static build writes it to dist/. Serve whichever this build produced.
  const site = existsSync('dist/client/index.html') ? 'dist/client' : 'dist';
  const server = http.createServer(sirv(site, { dev: true }));
  await new Promise((res, rej) => server.once('error', rej).listen(PORT, res));
  let browser;
  try {
    browser = await chromium.launch();
    for (const sc of scenarios) await runScenario(browser, sc);
  } catch (e) {
    check(false, 'harness', e.message);
  } finally {
    await browser?.close();
    server.close();
  }
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
