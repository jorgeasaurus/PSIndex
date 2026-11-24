// End-to-end behaviour checks against a built site.
//   npm run build && node tests/e2e.cjs            (every scenario)
//   node tests/e2e.cjs "narrow dialog"              (scenarios whose name contains the text)
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
    name: 'the first screen says what the site is for',
    context: { viewport: { width: 390, height: 844 } },
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      const h = await p.textContent('.intro-compact h2');
      check(/PowerShell cmdlet/.test(h), 'a phone shows what PSIndex is above the results', h);
      await p.fill('input[type=search]', 'mailbox');
      await p.waitForFunction(() => !document.querySelector('.intro-compact'));
      await p.fill('input[type=search]', '');
      await p.click('.intro-compact .intro-samples button >> nth=0');
      await topIs(p, 'Get-MgUser');
      check(!(await p.locator('.intro-compact').count()), 'a sample search replaces the intro with its results');
      await p.setViewportSize({ width: 1440, height: 900 });
      await p.fill('input[type=search]', '');
      await p.waitForSelector('.pane-detail .intro h2');
      check(!(await p.locator('.intro-compact').count()), 'a wide screen keeps the intro in the detail pane only');
    },
  },
  {
    name: 'no intro over a deep link still loading',
    context: { viewport: { width: 390, height: 844 } },
    async setup(ctx) { this.release = await hold(ctx, `**${BUILD_PATH}idx/graph.json`); },
    async run(p) {
      await p.goto(`${BASE}/?c=graph:Get-MgUser`);
      await p.waitForSelector('.app:not([aria-busy])', { state: 'attached' });
      check(!(await p.locator('.intro-compact').count()), 'a pending deep link shows no intro or sample searches');
      this.release();
      await titleIs(p, 'Get-MgUser');
    },
  },
  {
    name: 'a pasted command line searches its cmdlet',
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      await search(p, 'Get-MgUser -All', 'Get-MgUser');
      const marks = await p.$$eval('.result mark', (m) => m.map((x) => x.textContent));
      check(!marks.some((t) => /^all$/i.test(t)), 'a parameter is not matched inside names', marks.slice(0, 5).join(','));
    },
  },
  {
    name: 'narrowing with an entry open moves focus into the dialog',
    context: { viewport: { width: 1180, height: 820 } },
    async run(p) {
      await p.goto(`${BASE}/?q=user`);
      await rowsReady(p);
      await p.click('#result-0');
      await p.waitForSelector('.detail-title');
      await p.focus('input[type=search]');
      await p.setViewportSize({ width: 820, height: 1180 });
      await p.waitForFunction(() => document.querySelector('.pane-detail')?.getAttribute('role') === 'dialog');
      await p.waitForFunction(() => document.activeElement?.id === 'detail-title');
      check(true, 'the entry title has focus once the open entry becomes the dialog');
    },
  },
  {
    name: 'an entry with no syntax or example',
    async run(p) {
      await p.goto(`${BASE}/?c=exchange:Copy-CsVoicePolicy`);
      await titleIs(p, 'Copy-CsVoicePolicy');
      const note = await p.waitForSelector('.detail p.h-sub').then((e) => e.textContent());
      check(!/above/.test(note), 'the no-example note points to no section the entry lacks', note);
    },
  },
  {
    name: 'filters that hide every match are named as the reason',
    async run(p) {
      await p.goto(`${BASE}/?s=graph&verb=Remove&q=get-mguser`);
      const text = await p.waitForSelector('.empty:not([aria-busy]) .empty-title').then((e) => e.textContent());
      check(/filters hide/.test(text) && !/No match/.test(text), 'the empty state says the filters hide the matches', text);
      check(!(await p.$('.empty button:has-text("Search mguser")')), 'no noun hint when the query does match');
      await p.click('.empty button:has-text("Clear filters")');
      await topIs(p, 'Get-MgUser');
      await p.goto(`${BASE}/?s=graph&verb=Remove&q=zzqqxx`);
      const none = await p.waitForSelector('.empty:not([aria-busy]) .empty-title').then((e) => e.textContent());
      check(/^No match/.test(none), 'a query with no match anywhere still says no match', none);
      // A misspelling found only by typo matching is no claim that the filters hide real matches.
      await p.goto(`${BASE}/?s=graph&verb=Remove&q=get-mgusrr`);
      const typo = await p.waitForSelector('.empty:not([aria-busy]) .empty-title').then((e) => e.textContent());
      check(/^No match/.test(typo), 'near misses are not counted as matches the filters hide', typo);
    },
  },
  {
    name: '404 page icon',
    async run(p) {
      await p.goto(`${BASE}/404.html`);
      check(await p.locator('link[rel=icon][href="/favicon.svg"]').count() === 1, 'the 404 page has the site icon');
    },
  },
  {
    name: 'phone Back from a deep link',
    context: { viewport: { width: 390, height: 844 } },
    async run(p) {
      await p.goto(`${BASE}/?q=get-mguser&c=graph:Get-MgUser`);
      await titleIs(p, 'Get-MgUser');
      await p.waitForFunction(() => document.querySelector('.pane-detail')?.getAttribute('role') === 'dialog');
      await p.goBack();
      await p.waitForFunction(() => !document.querySelector('.detail-title'));
      check(p.url() === `${BASE}/?q=get-mguser`, 'Back from a deep-linked entry lands on its list', p.url());
    },
  },
  {
    name: 'a new search dismisses the broken-link notice',
    async run(p) {
      await p.goto(`${BASE}/?c=graph:No-SuchCmdlet`);
      await p.waitForSelector('.notice-link');
      await p.fill('input[type=search]', 'get-mguser');
      await topIs(p, 'Get-MgUser');
      await p.waitForFunction(() => !document.querySelector('.notice-link'));
    },
  },
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
      // The key resolves before the list's rows arrive (separate worker replies): wait for the row.
      await p.waitForSelector('.result.is-open');
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
      await p.goto(`${BASE}/?q=user&c=graph:Get-MgUser`);
      await p.waitForSelector('[role=alert]');
      const before = new URL(p.url()).search;
      const band = await p.evaluate(() => ({
        clear: !!document.querySelector('.searchbox-clear'),
        kbd: !!document.querySelector('.searchbox-kbd'),
        tabs: [...document.querySelectorAll('.source')].every((b) => b.disabled),
        placeholder: document.querySelector('input[type=search]').placeholder,
      }));
      check(!band.clear && !band.kbd && band.tabs && band.placeholder === 'Index unavailable', 'a failed load offers no search actions in the band', JSON.stringify(band));
      check(!(await p.$('.intro-keys')) && !(await p.$('.intro-samples')), 'a failed load shows no key legend or sample searches in the intro');
      await p.evaluate(() => document.activeElement?.blur());
      await p.keyboard.press('/');
      check(await p.evaluate(() => document.activeElement?.getAttribute('aria-label') !== 'Search cmdlets'), '"/" does not focus the read-only box after a failed load');
      await p.keyboard.press('Escape');
      await p.click('.wordmark');
      await nextFrame(p);
      check(new URL(p.url()).search === before, 'Escape and the wordmark keep the deep link for Reload', p.url());
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
      check(/MECM descriptions didn’t load/.test(await p.textContent('.pane-results')), 'a failed description file is announced, naming its source', await p.textContent('.notice-link p').catch(() => ''));
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
    name: 'MCP info panel',
    context: {
      viewport: { width: 1280, height: 800 },
      permissions: ['clipboard-read', 'clipboard-write'],
    },
    async run(p) {
      const URL = 'https://psindex.vercel.app/mcp';
      const openBtn = 'button[aria-label="Use with AI agents"]';
      await p.addInitScript(() => localStorage.setItem('psindex-theme', 'dark'));
      await p.goto(BASE);
      await rowsReady(p);
      await p.fill('input[type=search]', 'get-mguser');
      const trigger = await p.locator(openBtn).boundingBox();
      check(trigger && trigger.width >= 24 && trigger.height >= 24, 'the info button is a tappable control', JSON.stringify(trigger));

      await p.focus(openBtn);
      await p.keyboard.press('Enter');
      await p.waitForSelector('#mcp-panel[open]');
      const opened = await p.evaluate(() => {
        const d = document.querySelector('#mcp-panel');
        const a = document.activeElement;
        return {
          role: d.getAttribute('role') || d.tagName === 'DIALOG',
          modal: d.getAttribute('aria-modal'),
          labelled: d.getAttribute('aria-labelledby'),
          title: document.getElementById('mcp-title')?.textContent,
          focusInside: d === a || d.contains(a),
        };
      });
      check(opened.role && opened.modal === 'true' && opened.labelled === 'mcp-title' && opened.title === 'Use with AI agents' && opened.focusInside, 'the panel is a named modal and takes focus', JSON.stringify(opened));

      for (let i = 0; i < 12; i++) await p.keyboard.press('Tab');
      const tabStays = await p.evaluate(() => {
        const d = document.querySelector('#mcp-panel');
        const a = document.activeElement;
        return d === a || d.contains(a);
      });
      check(tabStays, 'Tab stays inside the panel');

      const text = await p.locator('#mcp-panel').innerText();
      check(/no authentication/i.test(text) && /read-only/i.test(text), 'says what the endpoint is', text.split('\n')[1]);
      check(text.includes(URL) && text.includes('~/.cursor/mcp.json') && text.includes('.mcp.json at the workspace root') && text.includes('claude mcp add --transport http psindex') && text.includes('Add custom connector') && !text.includes('.vscode/mcp.json'), 'shows the endpoint and each client\'s setup');
      check(['search_cmdlets', 'get_cmdlet', 'list_modules'].every((name) => text.includes(name)), 'names the three tools');

      await p.click('#mcp-panel button[aria-label="Copy endpoint"]');
      await p.waitForFunction(() => document.querySelector('#mcp-panel')?.innerText.includes('Copied'));
      check(await p.evaluate(() => navigator.clipboard.readText()) === URL, 'copy endpoint writes the URL');

      const readConfig = async (label) => {
        await p.click(`#mcp-panel button[aria-label="${label}"]`);
        await p.waitForFunction((name) => document.querySelector(`#mcp-panel button[aria-label="${name}"]`)?.classList.contains('is-done'), label);
        return p.evaluate(() => navigator.clipboard.readText());
      };
      const cursor = JSON.parse(await readConfig('Copy Cursor config'));
      const vscode = JSON.parse(await readConfig('Copy VS Code config'));
      const claude = JSON.parse(await readConfig('Copy Claude Code config'));
      check(cursor.mcpServers?.psindex?.url === URL && !cursor.mcpServers.psindex.type, 'Cursor config is a remote mcpServers url', JSON.stringify(cursor));
      check(vscode.mcpServers?.psindex?.type === 'http' && vscode.mcpServers.psindex.url === URL && !vscode.servers, 'VS Code config is mcpServers with type http', JSON.stringify(vscode));
      check(claude.mcpServers?.psindex?.type === 'http' && claude.mcpServers.psindex.url === URL, 'Claude Code config is mcpServers with type http', JSON.stringify(claude));
      check(!(await p.locator('#mcp-panel section[aria-label="Claude Desktop and claude.ai"] pre').count()), 'Claude Desktop gets connector steps, not a config file');

      await p.keyboard.press('/');
      const slashStays = await p.evaluate(() => {
        const d = document.querySelector('#mcp-panel');
        const a = document.activeElement;
        return d.open && (d === a || d.contains(a));
      });
      check(slashStays, '"/" does not leave the panel');
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !document.querySelector('#mcp-panel')?.open);
      const afterEsc = await p.evaluate(() => ({
        focus: document.activeElement?.getAttribute('aria-label'),
        q: document.querySelector('input[type=search]').value,
      }));
      check(afterEsc.focus === 'Use with AI agents' && afterEsc.q === 'get-mguser', 'Escape closes the panel, restores focus, and keeps the query', JSON.stringify(afterEsc));

      await p.click(openBtn);
      await p.waitForSelector('#mcp-panel[open]');
      // A scrollbar click targets the scroller and lands inside its box. That must not dismiss.
      const insideStays = await p.evaluate(() => {
        const el = document.querySelector('#mcp-panel');
        const scroller = el.querySelector('.mcp-body');
        const r = scroller.getBoundingClientRect();
        scroller.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.right - 3, clientY: r.top + 80 }));
        const box = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: box.right - 3, clientY: box.top + box.height / 2 }));
        return el.open;
      });
      check(insideStays, 'a click inside the dialog, including its scrollbar, keeps it open');
      const box = await p.locator('#mcp-panel').boundingBox();
      await p.mouse.click(box.x - 8, box.y + 24);
      await p.waitForFunction(() => !document.querySelector('#mcp-panel')?.open);
      check(true, 'a backdrop click closes the panel');

      const fits = async (theme) => {
        await p.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await p.click(openBtn);
        await p.waitForSelector('#mcp-panel[open]');
        const laid = await p.evaluate(() => {
          const d = document.querySelector('#mcp-panel');
          const r = d.getBoundingClientRect();
          const cs = getComputedStyle(d);
          return {
            scroll: document.documentElement.scrollWidth,
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            vw: window.innerWidth,
            vh: window.innerHeight,
            bg: cs.backgroundColor,
            color: cs.color,
          };
        });
        check(
          laid.scroll <= laid.vw + 1 && laid.left >= -1 && laid.right <= laid.vw + 1 && laid.top >= -1 && laid.bottom <= laid.vh + 1,
          `panel fits at ${theme}`,
          JSON.stringify(laid),
        );
        await p.keyboard.press('Escape');
        await p.waitForFunction(() => !document.querySelector('#mcp-panel')?.open);
        return laid.bg;
      };

      await p.setViewportSize({ width: 390, height: 844 });
      const phoneBtn = await p.locator(openBtn).boundingBox();
      check(phoneBtn && phoneBtn.x >= 0 && phoneBtn.x + phoneBtn.width <= 390 && phoneBtn.width >= 24, 'the info button fits and stays tappable at 390px', JSON.stringify(phoneBtn));
      await p.click(openBtn);
      await p.waitForSelector('#mcp-panel[open]');
      // Each source line of a config is one rendered line: a long one scrolls sideways instead of wrapping.
      const wraps = await p.evaluate(() => [...document.querySelectorAll('#mcp-panel .code pre')].map((pre) => {
        const lines = pre.textContent.split('\n').length;
        const lh = parseFloat(getComputedStyle(pre).lineHeight);
        const cs = getComputedStyle(pre);
        const inner = pre.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        const panel = document.getElementById('mcp-panel').getBoundingClientRect();
        const r = pre.getBoundingClientRect();
        return { lines, rendered: Math.round(inner / lh), scrolls: pre.scrollWidth > pre.clientWidth, inside: r.right <= panel.right + 1 };
      }));
      check(wraps.length === 3 && wraps.every((w) => w.lines === w.rendered && w.inside) && wraps.some((w) => w.scrolls), 'config lines do not wrap at 390px', JSON.stringify(wraps));
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !document.querySelector('#mcp-panel')?.open);
      const darkBg = await fits('dark');
      const lightBg = await fits('light');
      check(darkBg !== lightBg, 'the panel follows the light and dark themes', `${darkBg} / ${lightBg}`);
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
  {
    name: 'query tokens and highlights',
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      await p.fill('input[type=search]', 'get-mguser');
      await p.waitForFunction(() => new URLSearchParams(location.search).get('q') === 'get-mguser');
      await p.fill('input[type=search]', '--');
      await p.waitForFunction((t) => document.querySelector('.count')?.textContent === t, TOTAL_LABEL);
      // The URL is written after the render that shows the count.
      await p.waitForFunction(() => !new URLSearchParams(location.search).has('q')).catch(() => {});
      check(!param(p, 'q'), 'a query without a token is no query in the URL', p.url());
      await p.goto(`${BASE}/?s=mecm&verb=Zzz&q=--`);
      await p.waitForSelector('.empty .chip');
      check((await p.textContent('.empty-title')) === 'Nothing matches these filters.', 'a query without a token is no query in the empty state', await p.textContent('.empty-title'));
      await p.goto(BASE);
      await rowsReady(p);
      const marks = () => p.evaluate(() => {
        const row = [...document.querySelectorAll('.result')].find((r) => r.querySelector('.result-name')?.textContent === 'Get-MgUser');
        return [...(row?.querySelectorAll('mark') ?? [])].map((m) => m.textContent);
      });
      await search(p, 'get-mg mguser', 'Get-MgUser');
      check((await marks()).join('|') === 'Get-MgUser', 'overlapping marks merge into their union', (await marks()).join('|'));
      await search(p, '"Get-MgUser",', 'Get-MgUser');
      check((await marks()).join('|') === 'Get-MgUser', 'surrounding punctuation is trimmed from a token', (await marks()).join('|'));
      await search(p, 'get-mg-usr', 'Get-MgUser');
      check(true, 'a misplaced hyphen plus a typo still finds the cmdlet');
    },
  },
  {
    name: 'short tokens never mark across the verb',
    async run(p) {
      await p.goto(`${BASE}/?s=exchange&q=${encodeURIComponent('historicalsearch thi')}`);
      await p.waitForFunction(() => [...document.querySelectorAll('.result .result-name')].some((n) => n.textContent === 'Get-HistoricalSearch'));
      const text = await p.evaluate(() => [...[...document.querySelectorAll('.result .result-name')].find((n) => n.textContent === 'Get-HistoricalSearch').querySelectorAll('mark')].map((m) => m.textContent).join('|'));
      check(text === 'HistoricalSearch', 'a description-only short token is not marked in the name', text);
    },
  },
  {
    name: 'empty-state hints from the query',
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      // Parameters are not searched; a value that matches nothing still empties the list.
      await p.fill('input[type=search]', 'Get-MgUser -UserId qqzzqq');
      await p.waitForSelector('.empty .chip');
      check((await p.textContent('.empty .chip')) === 'Search Get-MgUser', 'a pasted command line offers its cmdlet name', await p.textContent('.empty .chip'));
      await p.click('.empty .chip');
      await topIs(p, 'Get-MgUser');
      check((await p.inputValue('input[type=search]')) === 'Get-MgUser', 'the suggestion searches the name alone');
      // A pipeline pasted without spaces offers its first cmdlet, not the whole run.
      await p.goto(`${BASE}/?q=${encodeURIComponent('Get-MgUser|Select-Object Id')}`);
      await p.waitForSelector('.empty .chip');
      check((await p.textContent('.empty .chip')) === 'Search Get-MgUser', 'a pipeline without spaces offers its first cmdlet name', await p.textContent('.empty .chip'));
      await p.goto(`${BASE}/?q=${encodeURIComponent('Get-MgUser|Select-Object')}`);
      await p.waitForSelector('.empty .chip');
      check((await p.textContent('.empty .chip')) === 'Search Get-MgUser', 'a bare pipeline offers its first cmdlet name', await p.textContent('.empty .chip'));
      await p.goto(`${BASE}/?s=mecm&q=Get-MgUser`);
      await p.waitForSelector('.empty .chip');
      const chips = await p.locator('.empty .chip').allTextContents();
      check(chips.join('|') === 'Search MgUser|Search all cmdlets', 'a lone cmdlet name offers its noun', chips.join('|'));
      await p.goto(`${BASE}/?s=mecm&q=xyzq`);
      await p.waitForSelector('.empty .chip');
      check(!(await p.locator('.empty p:not(.empty-title)').count()), 'a single plain word gets no hint');
      // A long pasted name wraps inside the pane: neither the title nor its suggestion runs past it.
      for (const [w, h, name] of [[390, 844, 'Get-MgBetaDeviceManagementWindowsAutopilotDeploymentProfileAssignedDevice'], [1440, 900, 'Get-MgBetaIdentityGovernanceLifecycleWorkflowRunSubjectProcessingResultTaskProcessingResultSubjectServiceProvisioningError -Foo x']]) {
        await p.setViewportSize({ width: w, height: h });
        await p.goto(`${BASE}/?s=mecm&q=${encodeURIComponent(name)}`);
        await p.waitForSelector('.empty .chip');
        const laid = await p.evaluate(() => {
          const pane = document.getElementById('results');
          const right = pane.getBoundingClientRect().right;
          return {
            pane: right,
            overflow: pane.scrollWidth - pane.clientWidth,
            out: [...document.querySelectorAll('.empty, .empty-title, .empty .chip')].map((el) => Math.round(el.getBoundingClientRect().right - right)).filter((d) => d > 0),
          };
        });
        check(laid.overflow <= 0 && !laid.out.length, `a long query's empty state fits its pane at ${w}px`, JSON.stringify(laid));
      }
      // With zero results the combobox has no popup.
      const aria = await p.evaluate(() => { const i = document.querySelector('input[type=search]'); return [i.getAttribute('aria-expanded'), i.getAttribute('aria-controls')]; });
      check(aria[0] === 'false' && aria[1] === null, 'no results: the combobox is collapsed', aria.join());
    },
  },
  {
    name: 'filter links and recovery',
    async run(p) {
      await p.goto(`${BASE}/?verb=get`);
      await rowsReady(p);
      check((await p.locator('.result:not(.result-skel)').count()) > 0, 'a facet value in another case matches');
      await p.click('.chip[aria-controls=filters]');
      const shown = await p.$eval('.filters select', (s) => s.selectedOptions[0]?.textContent);
      check(shown === 'Get', 'the filter bar shows the facet in its own spelling', shown);
      // Matching in any case is no new search: an Enter pressed before the results still opens.
      await p.goto(`${BASE}/?q=get-mguser&verb=get`);
      await p.waitForSelector('.app:not([aria-busy])', { state: 'attached' });
      await p.keyboard.press('Enter');
      await titleIs(p, 'Get-MgUser');
      await p.goto(`${BASE}/?s=az&ver=beta`);
      await rowsReady(p);
      check(!param(p, 'ver') && (await p.locator('.result:not(.result-skel)').count()) > 0, 'a ver filter on a source without one is dropped', p.url());
      await p.goto(`${BASE}/?s=az&verb=Approve`);
      await rowsReady(p);
      await p.click('.source:has-text("Entra")');
      await p.waitForSelector('.empty .chip');
      const chips = await p.locator('.empty .chip').allTextContents();
      check(chips.join('|') === 'Clear filters|Search all cmdlets', 'an empty filtered source offers Clear filters and Search all', chips.join('|'));
      await p.click('.empty .chip:text("Clear filters")');
      await p.waitForFunction(() => location.search === '?s=entra');
      await rowsReady(p);
      await p.goto(`${BASE}/?verb=Zzz`);
      await p.waitForSelector('.empty .chip');
      const all = await p.locator('.empty .chip').allTextContents();
      check(all.join('|') === 'Clear filters', 'across every source there is no Search all', all.join('|'));
    },
  },
  {
    name: 'paging the result list',
    async run(p) {
      await p.goto(BASE);
      await rowsReady(p);
      const active = () => p.getAttribute('input[type=search]', 'aria-activedescendant');
      const waitActive = (id) => p.waitForFunction((x) => document.querySelector('input[type=search]').getAttribute('aria-activedescendant') === x, id);
      await waitActive('result-0');
      await p.keyboard.press('PageDown');
      await p.waitForFunction(() => Number(document.querySelector('input[type=search]').getAttribute('aria-activedescendant')?.split('-')[1]) > 3);
      const paged = await active();
      await p.keyboard.press('PageUp');
      await waitActive('result-0');
      await p.keyboard.press('Control+End');
      await waitActive(`result-${total - 1}`);
      await p.keyboard.press('Home');
      await nextFrame(p);
      check((await active()) === `result-${total - 1}`, 'plain Home stays with the text box', await active());
      await p.keyboard.press('Control+Home');
      await waitActive('result-0');
      check(true, 'PageDown/PageUp and Ctrl+End/Ctrl+Home move the cursor', paged);
    },
  },
  {
    name: 'unprefixed links and the broken-link notice',
    async run(p) {
      await p.goto(`${BASE}/?c=Get-Mailbox`);
      await titleIs(p, 'Get-Mailbox');
      await p.waitForFunction(() => new URLSearchParams(location.search).get('c') === 'exchange:Get-Mailbox');
      await p.goto(`${BASE}/?c=graph:Get-MgNope&q=user`);
      await p.waitForSelector('.notice-link');
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !document.querySelector('.notice-link'));
      check((await p.inputValue('input[type=search]')) === 'user', 'Escape dismisses the notice before clearing the query');
    },
  },
  {
    name: 'long names show their match',
    async run(p) {
      const visible = () => p.evaluate(() => [...document.querySelectorAll('.result:not(.result-skel) .result-name')].map((n) => {
        const m = n.querySelector('mark');
        if (!m) return 'no mark';
        const nr = n.getBoundingClientRect(), mr = m.getBoundingClientRect();
        return mr.right <= nr.right + 1 && mr.right > nr.left ? 'ok' : `${n.textContent} mark ${mr.left}-${mr.right} in ${nr.left}-${nr.right}`;
      }));
      await p.goto(`${BASE}/?q=approvedclientappcount`);
      await p.waitForSelector('.result mark');
      const wide = await visible();
      check(wide.length && wide.every((v) => v === 'ok'), 'a match past the cut is scrolled into view', wide.join('; '));
      await p.setViewportSize({ width: 390, height: 844 });
      await p.goto(`${BASE}/?s=graph&q=Get-MgBetaDeviceManagementWindowsAutopilotDeploymentProfileAssignedDevice`);
      await p.waitForSelector('.result mark');
      await nextFrame(p);
      const narrow = await visible();
      check(narrow.length > 1 && narrow.every((v) => v === 'ok'), 'at phone width the end of a long match shows', narrow.join('; '));
    },
  },
  {
    name: 'narrow dialog and history',
    context: { viewport: { width: 390, height: 844 }, hasTouch: true },
    async run(p) {
      await p.goto(`${BASE}/?q=user`);
      await rowsReady(p);
      await p.click('.result');
      // Read in the same task that sees the dialog: its history entry must name it already.
      const c = await p.evaluate(() => new Promise((done) => {
        const look = () => (document.querySelector('.app[data-open]') ? done(new URLSearchParams(location.search).get('c')) : requestAnimationFrame(look));
        look();
      }));
      check(!!c, 'the dialog history entry names the entry as soon as it shows', String(c));
      await p.goBack();
      await p.waitForFunction(() => !document.querySelector('.app[data-open]'));
      await p.goForward();
      await p.waitForSelector('.app[data-open] .detail-title');
      check(param(p, 'c') === c, 'Forward after closing reopens the entry the URL names', p.url());
      await p.goBack();
      // On a timeout, say which history state the app was left in (seen once in CI, not locally).
      await p.waitForFunction(() => !document.querySelector('.app[data-open]') && !new URLSearchParams(location.search).get('c')).catch(async (e) => {
        const at = await p.evaluate(() => ({ search: location.search, open: !!document.querySelector('.app[data-open]'), state: history.state, length: history.length }));
        throw new Error(`${e.message.split('\n')[0]} after Back from a reopened entry: ${JSON.stringify(at)}`);
      });
      // "/" over the dialog closes it and puts the cursor in the search box.
      await p.click('.result');
      await p.waitForFunction(() => document.activeElement?.id === 'detail-title');
      await p.keyboard.press('/');
      await p.waitForFunction(() => !document.querySelector('.app[data-open]') && document.activeElement?.getAttribute('aria-label') === 'Search cmdlets');
      const sel = await p.evaluate(() => { const i = document.activeElement; return i.selectionEnd - i.selectionStart; });
      check(sel === 4 && !param(p, 'c'), '"/" closes the dialog and selects the query', String(sel));
      // A tap on a tab off-centre selects it (no scroll between press and release).
      for (const name of ['Az', 'Entra', 'Exchange']) {
        await p.tap(`.source:has-text("${name}")`);
        await p.waitForFunction((n) => document.querySelector('.source.is-on')?.textContent?.startsWith(n), name);
      }
      check(true, 'tapping a source tab selects it');
      await p.click('.source:has-text("Graph")');
      await p.waitForFunction(() => document.querySelector('.source.is-on')?.textContent?.startsWith('Graph'));
    },
  },
  {
    name: 'catch-all categories and named common parameters',
    async run(p) {
      await p.goto(`${BASE}/?c=az:Get-AzADDomainService`);
      await p.waitForSelector('.detail .params');
      const tags = await p.locator('.detail .tags .tag').allTextContents();
      check(!tags.includes('Other'), 'a catch-all category gets no tag', tags.join(', '));
      const one = await p.textContent('.detail .params ~ .link-btn');
      check(/^Show 1 common parameter \(-\w+\)$/.test(one), 'one hidden parameter is named, in the singular', one);
      await p.goto(`${BASE}/?c=az:New-AzNatGateway`);
      await p.waitForSelector('.detail .params');
      const btn = p.locator('.detail .params ~ .link-btn');
      const three = await btn.textContent();
      check(/^Show 3 common parameters \(/.test(three) && /-WhatIf/.test(three) && /-Confirm/.test(three) && /-DefaultProfile/.test(three), 'the toggle names what it hides', three);
      await btn.click();
      check(/^Hide 3 common parameters/.test(await btn.textContent()), 'the open toggle says it hides them', await btn.textContent());
      await p.goto(`${BASE}/?c=exchange:Add-ADPermission`);
      await p.waitForSelector('.detail .tags');
      const exo = await p.locator('.detail .tags .tag').allTextContents();
      check(!exo.some((t) => /General$/.test(t)), 'a "<source> General" category gets no tag', exo.join(', '));
    },
  },
  {
    name: 'loading details is announced',
    async setup(ctx) { ctx.release = await hold(ctx, `**${BUILD_PATH}data/**`); },
    async run(p, ctx) {
      await p.goto(`${BASE}/?c=graph:Get-MgUser`);
      const status = await p.waitForSelector('.detail-skel[role=status]');
      check((await status.textContent()).trim() === 'Loading details', 'the skeleton is a status region with readable text', await status.textContent());
      ctx.release();
      await p.waitForSelector('.detail .code-syntax');
    },
  },
  {
    name: 'reopening after a failed load retries',
    allowErrors: true,
    context: { viewport: { width: 1440, height: 900 } },
    async setup(ctx) {
      ctx.requests = 0;
      await ctx.route(`**${BUILD_PATH}data/graph/Microsoft.Graph.Groups.json`, (r) => (ctx.requests++ ? r.continue() : r.abort()));
    },
    async run(p, ctx) {
      await p.goto(BASE);
      await rowsReady(p);
      await search(p, 'Get-MgGroup', 'Get-MgGroup');
      await p.click('.result');
      await p.waitForSelector('.detail .notice-error');
      await p.click('.result');
      await p.waitForSelector('.detail .code-syntax');
      check(ctx.requests === 2, 'opening the same cmdlet again fetches its file afresh', String(ctx.requests));
    },
  },
  {
    name: 'a rejected copy says so',
    async setup(ctx) {
      await ctx.addInitScript(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); });
    },
    async run(p) {
      await p.goto(`${BASE}/?c=graph:Get-MgUser`);
      await p.waitForSelector('.detail .perms');
      const btn = p.locator('button[aria-label="Copy all permissions"]');
      await btn.click();
      await p.waitForFunction(() => document.querySelector('button[aria-label="Copy all permissions"]')?.classList.contains('is-failed'));
      const said = await p.evaluate(() => [...document.querySelectorAll('[role=status]')].map((e) => e.textContent).filter(Boolean));
      check(said.includes('Copy failed'), 'a failed copy is announced', said.join(' / '));
      await p.click('.detail-links button:has-text("Copy link")');
      check(/Copy failed/.test(await p.textContent('.detail-links .btn-quiet')), 'the text button reads "Copy failed"', await p.textContent('.detail-links .btn-quiet'));
    },
  },
  {
    name: 'detail pane fits its width',
    async run(p) {
      for (const width of [390, 901, 1000, 1100]) {
        // Leave the app before resizing: widening an open phone dialog steps back over its history
        // entry, and that asynchronous step would undo the next goto.
        await p.goto('about:blank');
        await p.setViewportSize({ width, height: 900 });
        for (const c of ['exchange:New-CsTeamsVoiceApplicationsPolicy', 'exchange:Set-Mailbox', 'graph:Add-MgBetaBulkDirectoryRecommendationImpactedResourceTag']) {
          await p.goto(`${BASE}/?c=${c}`);
          await p.waitForSelector('.detail .code-syntax');
          await p.waitForSelector('.detail .related');
          const m = await p.evaluate(() => {
            const pane = document.querySelector('.pane-detail');
            const pre = Math.max(...[...document.querySelectorAll('.code-syntax pre')].map((e) => e.scrollWidth - e.clientWidth));
            // Each syntax line's text, to find a "-" or "[" parted from its parameter's name.
            const lines = new Map();
            for (const pre of document.querySelectorAll('.code-syntax pre')) {
              const walk = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
              for (let n; (n = walk.nextNode());) {
                for (let i = 0; i < n.length; i++) {
                  const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
                  const box = r.getClientRects()[0];
                  if (box) lines.set(Math.round(box.top), (lines.get(Math.round(box.top)) ?? '') + n.data[i]);
                }
              }
            }
            const parted = [...lines.values()].filter((l) => /(^|[\s[])-$|\[$/.test(l.trimEnd()));
            return { over: pane.scrollWidth - pane.clientWidth, pre, parted };
          });
          check(m.over <= 0, `${c} at ${width}px: the pane never scrolls sideways`, String(m.over));
          check(m.pre <= 0, `${c} at ${width}px: no syntax runs past the box`, String(m.pre));
          check(!m.parted.length, `${c} at ${width}px: no "-" or "[" parted from its name`, m.parted.join(' | '));
        }
      }
    },
  },
  {
    name: 'comment contrast in the light theme',
    context: { colorScheme: 'light' },
    async run(p) {
      await p.goto(`${BASE}/?c=entra:Get-EntraUser`);
      await p.waitForSelector('.detail .t-com');
      const ratio = await p.evaluate(() => {
        const lum = (s) => { const c = s.match(/\d+/g).slice(0, 3).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
        const com = document.querySelector('.t-com');
        const a = lum(getComputedStyle(com).color), b = lum(getComputedStyle(com.closest('pre')).backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      check(ratio >= 4.5, 'comments meet 4.5:1 on the code frame', ratio.toFixed(2));
    },
  },
  {
    name: 'tab strip fade only while tabs are hidden',
    context: { viewport: { width: 390, height: 844 } },
    async run(p) {
      const faded = () => p.evaluate(() => getComputedStyle(document.querySelector('.sources')).maskImage !== 'none');
      await p.goto(BASE);
      await rowsReady(p);
      await p.waitForFunction(() => document.querySelector('.sources').hasAttribute('data-more'));
      check(await faded(), 'the right edge fades while more tabs lie past it');
      await p.goto(`${BASE}/?s=mecm`);
      await rowsReady(p);
      await p.waitForFunction(() => { const s = document.querySelector('.sources'); return Math.ceil(s.scrollLeft + s.clientWidth) >= s.scrollWidth; });
      await nextFrame(p);
      check(!(await faded()), 'no fade once the strip is scrolled to its end');
    },
  },
  {
    name: 'short viewports scroll the page',
    async run(p) {
      for (const [width, height] of [[844, 390], [1400, 320]]) {
        await p.setViewportSize({ width, height });
        await p.goto(`${BASE}/?q=get-mguser`);
        await rowsReady(p);
        await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        const m = await p.evaluate(() => ({ page: document.documentElement.scrollHeight, y: scrollY, results: document.querySelector('.results').getBoundingClientRect().height }));
        check(m.page > height && m.y > 0, `${width}x${height}: the band scrolls away`, JSON.stringify(m));
        check(m.results >= height * 0.6, `${width}x${height}: the results get most of the viewport`, String(m.results));
      }
      await p.setViewportSize({ width: 1440, height: 900 });
      await p.goto(`${BASE}/?q=get-mguser`);
      await rowsReady(p);
      const tall = await p.evaluate(() => document.documentElement.scrollHeight === innerHeight);
      check(tall, 'a full-height viewport keeps the page fixed');
    },
  },
  {
    name: '404 keeps the stored theme',
    context: { colorScheme: 'dark' },
    async setup(ctx) { await ctx.addInitScript(() => { try { localStorage.setItem('psindex-theme', 'light'); } catch {} }); },
    async run(p) {
      await p.goto(`${BASE}/404.html`);
      const m = await p.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor]);
      check(m[0] === 'light' && m[1] === 'rgb(238, 240, 245)', 'the 404 page applies the stored theme', m.join(' / '));
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
    // Name every line of this file on the stack: the failing wait and the scenario step that ran it.
    const at = [...(e.stack ?? '').matchAll(/e2e\.cjs:(\d+)/g)].map((m) => m[1]);
    check(false, sc.name, e.message.split('\n')[0] + (at.length ? ` (at line ${[...new Set(at)].join(' < ')})` : ''));
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
    const only = process.argv[2];
    const chosen = scenarios.filter((s) => !only || s.name.includes(only));
    // A misspelled filter must not pass green with nothing run.
    if (!chosen.length) check(false, 'harness', `no scenario name contains "${only}"`);
    for (const sc of chosen) await runScenario(browser, sc);
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
