// HTTP checks for the stateless MCP endpoint against the built Node server.
//   npm run build && node tests/mcp.cjs
// The browser suite serves dist/ as static files and cannot answer /mcp.
const { spawn } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const net = require('node:net');
const { join } = require('node:path');

const ACCEPT = 'application/json, text/event-stream';
const ROOT = join(__dirname, '..');
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
  'cache-control': 'no-store',
};

async function post(base, body, headers = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: ACCEPT, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try { json = text.trim() ? JSON.parse(text) : null; } catch { json = { parseError: text.slice(0, 300) }; }
  return { status: res.status, headers: res.headers, body: json, text };
}

const rpc = (base, id, method, params, headers) => post(base, { jsonrpc: '2.0', id, method, params }, headers);

function textOf(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content.map((part) => part.text || '').join('\n');
}

function toolData(body) {
  if (!body || body.error) return { error: body?.error ?? { message: 'no body' } };
  const result = body.result;
  if (!result) return { error: { message: 'no result' } };
  if (result.isError) return { error: { message: textOf(result), isError: true } };
  try { return { data: JSON.parse(textOf(result)) }; }
  catch { return { error: { message: textOf(result).slice(0, 300) } }; }
}

/** Names of CORS headers missing or wrong on a response. */
function corsGaps(headers) {
  return Object.entries(CORS).filter(([key, value]) => headers.get(key) !== value).map(([key]) => key);
}

/** Every cmdlet row per source in the shipped index, for list_modules totals. */
function shardRows() {
  const build = JSON.parse(readFileSync(join(ROOT, 'src', 'sources.generated.json'), 'utf8')).build;
  const idx = join(ROOT, 'dist', 'client', 'a', build, 'idx');
  const rows = {};
  for (const id of ['graph', 'az', 'entra', 'exchange', 'mecm']) {
    const shard = JSON.parse(readFileSync(join(idx, `${id}.json`), 'utf8'));
    rows[id] = shard.m.filter((mid) => shard.mods[mid]).length;
  }
  return rows;
}

async function runMcp(base, check) {
  const init = await rpc(base, 1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'psindex-test', version: '1.0.0' },
  });
  const protocol = init.body?.result?.protocolVersion;
  check(init.status === 200 && init.body?.result?.serverInfo?.name === 'psindex' && protocol && init.body?.result?.capabilities?.tools, 'mcp initialize', `status ${init.status} ${init.text.slice(0, 240)}`);
  check(!init.headers.has('mcp-session-id'), 'mcp stateless: no mcp-session-id', init.headers.get('mcp-session-id') ?? '');
  const initCors = corsGaps(init.headers);
  check(!initCors.length, 'mcp CORS headers on a 200', initCors.join(', '));

  const headers = protocol ? { 'mcp-protocol-version': protocol } : {};
  const call = (id, name, args, at = base) => rpc(at, id, 'tools/call', { name, arguments: args }, headers);

  // HTTP contract: the SDK transport's own answers, each still carrying the CORS headers.
  const preflight = await fetch(`${base}/mcp`, {
    method: 'OPTIONS',
    headers: { origin: 'https://example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, mcp-protocol-version' },
  });
  const preflightCors = corsGaps(preflight.headers);
  check(preflight.status === 204 && !preflightCors.length, 'mcp OPTIONS preflight 204 with CORS', `status ${preflight.status} ${preflightCors.join(', ')}`);

  const notAcceptable = await post(base, { jsonrpc: '2.0', id: 20, method: 'tools/list' }, { accept: 'text/html' });
  check(notAcceptable.status === 406 && notAcceptable.body?.error && !corsGaps(notAcceptable.headers).length, 'mcp 406 for an Accept without application/json', `status ${notAcceptable.status} ${notAcceptable.text.slice(0, 160)}`);

  // With an Origin header, Astro's CSRF check would answer a form-like type with a bare 403.
  const wrongType = await post(base, '{}', { 'content-type': 'text/plain', origin: 'https://example.test' });
  check(wrongType.status === 415 && wrongType.body?.error && !corsGaps(wrongType.headers).length, 'mcp 415 with CORS for a cross-origin text/plain POST', `status ${wrongType.status} ${wrongType.text.slice(0, 160)}`);

  const badJson = await post(base, '{bad');
  check(badJson.status === 400 && badJson.body?.error?.code === -32700 && !corsGaps(badJson.headers).length, 'mcp 400 parse error for invalid JSON', `status ${badJson.status} ${badJson.text.slice(0, 160)}`);

  const notification = await post(base, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  check(notification.status === 202 && !notification.text && !corsGaps(notification.headers).length, 'mcp 202 for a notification', `status ${notification.status} ${notification.text.slice(0, 160)}`);

  const listed = await rpc(base, 2, 'tools/list', {}, headers);
  const tools = Object.fromEntries((listed.body?.result?.tools ?? []).map((tool) => [tool.name, tool]));
  const readOnly = (tool) => tool?.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false && tool.annotations.idempotentHint === true && tool.annotations.openWorldHint === false;
  const props = (tool) => Object.keys(tool?.inputSchema?.properties ?? {}).sort().join(',');
  const required = (tool) => (tool?.inputSchema?.required ?? []).slice().sort().join(',');
  const search = tools.search_cmdlets;
  check(
    listed.status === 200
      && Object.keys(tools).sort().join(',') === 'get_cmdlet,list_modules,search_cmdlets'
      && Object.values(tools).every(readOnly)
      && props(search) === 'limit,module,query' && required(search) === 'query'
      && search.inputSchema.properties.limit.maximum === 25 && search.inputSchema.properties.limit.minimum === 1
      && props(tools.get_cmdlet) === 'module,name' && required(tools.get_cmdlet) === 'name'
      && props(tools.list_modules) === 'source' && required(tools.list_modules) === '',
    'mcp tools/list names, annotations and schemas',
    JSON.stringify(Object.values(tools).map((tool) => ({ name: tool.name, props: props(tool), required: required(tool), annotations: tool.annotations }))).slice(0, 400) || listed.text.slice(0, 240),
  );

  const found = toolData((await call(3, 'search_cmdlets', { query: 'Get-MgUser', limit: 5 })).body);
  const top = found.data?.results?.[0];
  check(Array.isArray(found.data?.namesOnly) && !found.data.namesOnly.length, 'mcp search_cmdlets namesOnly empty when every description shard loads', JSON.stringify(found.data?.namesOnly ?? found.error).slice(0, 200));
  check(
    top?.name === 'Get-MgUser' && top.module === 'Microsoft.Graph.Users' && top.source === 'graph' && typeof top.description === 'string' && top.description.length > 0 && top.url === `${base}/?c=graph%3AGet-MgUser`,
    'mcp search_cmdlets Get-MgUser, url on the called origin',
    JSON.stringify(top ?? found.error ?? found).slice(0, 300),
  );

  // The same server reached under another host name links back to that host and port.
  const otherBase = base.replace('127.0.0.1', 'localhost');
  const other = toolData((await call(4, 'search_cmdlets', { query: 'Get-MgUser', limit: 1 }, otherBase)).body);
  check(other.data?.results?.[0]?.url === `${otherBase}/?c=graph%3AGet-MgUser`, 'mcp result url follows the Host the client used', JSON.stringify(other.data?.results?.[0]?.url ?? other.error).slice(0, 200));

  const hyphenless = toolData((await call(5, 'search_cmdlets', { query: 'getmguser', limit: 1 })).body);
  check(hyphenless.data?.results?.[0]?.name === 'Get-MgUser', 'mcp search_cmdlets hyphenless query', JSON.stringify(hyphenless.data?.results?.[0] ?? hyphenless.error).slice(0, 200));

  const narrowed = toolData((await call(6, 'search_cmdlets', { query: 'Get-MgUser', module: 'microsoft.graph.users' })).body);
  const narrowedRows = narrowed.data?.results ?? [];
  check(narrowedRows[0]?.name === 'Get-MgUser' && narrowedRows.every((row) => row.module === 'Microsoft.Graph.Users'), 'mcp search_cmdlets module filter', JSON.stringify(narrowedRows.slice(0, 2).map((row) => row.module) ?? narrowed.error).slice(0, 200));

  const badModule = toolData((await call(7, 'search_cmdlets', { query: 'Get-MgUser', module: 'Not.A.Module' })).body);
  check(badModule.error?.isError && /^Unknown module "Not\.A\.Module"\. Call list_modules/.test(badModule.error.message), 'mcp search_cmdlets unknown module', badModule.error?.message || JSON.stringify(badModule).slice(0, 200));

  // Input validation: the SDK reports zod failures as an isError result naming the field.
  const invalid = [
    ['punctuation-only query', { query: '---' }, /Input validation error: .*Query needs an ASCII letter or digit; cmdlet names are ASCII\. at query/],
    ['non-ASCII query', { query: 'Получить' }, /Input validation error: .*Query needs an ASCII letter or digit; cmdlet names are ASCII\. at query/],
    ['parameter-only query', { query: '-All' }, /parameters alone \(-All\) match nothing/],
    ['empty query', { query: '   ' }, /Input validation error: .* at query/],
    ['limit over 25', { query: 'Get-MgUser', limit: 100 }, /Input validation error: .*<=25 at limit/],
    ['limit 0', { query: 'Get-MgUser', limit: 0 }, /Input validation error: .*>=1 at limit/],
    ['missing query', {}, /Input validation error: .* at query/],
  ];
  for (const [i, [label, args, expected]] of invalid.entries()) {
    const res = toolData((await call(30 + i, 'search_cmdlets', args)).body);
    check(res.error?.isError && expected.test(res.error.message), `mcp search_cmdlets rejects ${label}`, res.error?.message || JSON.stringify(res).slice(0, 200));
  }

  const unknownTool = toolData((await call(8, 'not_a_tool', {})).body);
  check(unknownTool.error?.isError && /Tool not_a_tool not found/.test(unknownTool.error.message), 'mcp tools/call unknown tool', unknownTool.error?.message || JSON.stringify(unknownTool).slice(0, 200));

  const detail = toolData((await call(9, 'get_cmdlet', { name: 'get-mguser' })).body);
  const match = detail.data?.matches?.[0];
  check(
    detail.data?.matches?.length === 1 && match?.name === 'Get-MgUser' && match.module === 'Microsoft.Graph.Users' && match.syntax.includes('Get-MgUser') && match.parameters.length > 3 && match.description && match.url === `${base}/?c=graph%3AGet-MgUser`,
    'mcp get_cmdlet Get-MgUser, url on the called origin',
    JSON.stringify(match ? { name: match.name, module: match.module, params: match.parameters?.length, url: match.url } : detail.error).slice(0, 300),
  );

  const shared = toolData((await call(10, 'get_cmdlet', { name: 'Connect-Entra' })).body);
  const sharedUrls = (shared.data?.matches ?? []).map((m) => m.url).sort();
  check(
    sharedUrls.join(' ') === [`${base}/?c=entra%3AConnect-Entra%40Microsoft.Entra.Authentication`, `${base}/?c=entra%3AConnect-Entra%40Microsoft.Entra.Beta.Authentication`].join(' '),
    'mcp get_cmdlet shared name returns every match with qualified urls',
    JSON.stringify(sharedUrls.length ? sharedUrls : shared.error).slice(0, 300),
  );

  const missing = toolData((await call(11, 'get_cmdlet', { name: 'Not-ARealCmdlet' })).body);
  check(missing.error?.isError && missing.error.message === 'Unknown cmdlet "Not-ARealCmdlet".', 'mcp get_cmdlet unknown name', missing.error?.message || JSON.stringify(missing).slice(0, 200));

  const rows = shardRows();
  const all = toolData((await call(12, 'list_modules', {})).body);
  const totals = {};
  for (const mod of all.data?.modules ?? []) totals[mod.source] = (totals[mod.source] ?? 0) + mod.count;
  check(
    Object.keys(rows).every((id) => totals[id] === rows[id]),
    'mcp list_modules totals match the index',
    `got ${JSON.stringify(totals)} want ${JSON.stringify(rows)}`,
  );

  const graph = toolData((await call(13, 'list_modules', { source: 'Graph' })).body);
  const graphModules = graph.data?.modules ?? [];
  check(
    graphModules.length > 0 && graphModules.every((mod) => mod.source === 'graph') && graphModules.some((mod) => mod.name === 'Microsoft.Graph.Users' && mod.count > 0),
    'mcp list_modules graph',
    graph.error?.message || `modules ${graphModules.length}`,
  );

  const badSource = toolData((await call(14, 'list_modules', { source: 'nope' })).body);
  check(badSource.error?.isError && /^Unknown source "nope"\. Sources: graph, az, entra, exchange, mecm\.$/.test(badSource.error.message), 'mcp list_modules unknown source', badSource.error?.message || JSON.stringify(badSource).slice(0, 200));
}

module.exports = { runMcp };

/** A port the OS just reported free on 127.0.0.1. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

if (require.main === module) {
  const results = [];
  const check = (ok, name, detail = '') => results.push({ ok: !!ok, name, detail });
  let child = null;
  let log = '';
  let stopping = false;
  const exitReason = (port) => {
    const tail = log.trim().split('\n').slice(-6).join(' | ');
    if (/EADDRINUSE/.test(log)) return `port ${port} is already taken; the server exited (${tail})`;
    return `server exited with code ${child.exitCode ?? child.signalCode} (${tail || 'no output'})`;
  };
  (async () => {
    let port = 0;
    try {
      // Node's own MODULE_NOT_FOUND trace is too long for the log tail to keep the path.
      if (!existsSync(join(ROOT, 'dist', 'server', 'entry.mjs'))) throw new Error('dist/server/entry.mjs is missing; run npm run build first');
      port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      child = spawn(process.execPath, ['dist/server/entry.mjs'], {
        cwd: ROOT,
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => { log += chunk; });
      child.stderr.on('data', (chunk) => { log += chunk; });
      const exited = new Promise((resolve) => child.once('exit', resolve));
      // Ready means our child answers initialize; anything else on the port is not the server under test.
      for (let i = 0; ; i++) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(exitReason(port));
        try {
          const res = await rpc(base, 0, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'psindex-test', version: '1.0.0' } });
          if (res.body?.result?.serverInfo?.name === 'psindex') break;
        } catch { /* not up yet */ }
        if (i === 79) throw new Error(`server did not answer on ${base}/mcp within 20 s (${log.trim().split('\n').slice(-6).join(' | ') || 'no output'})`);
        await new Promise((r) => setTimeout(r, 250));
      }
      // If the child dies mid-run, say so instead of reporting a list of failed requests. The
      // request it dropped usually rejects before its 'exit' event, so give that event a moment
      // and let the exit reason replace the fetch error.
      const run = runMcp(base, check).catch(async (err) => {
        const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(r, 1000, false))]);
        throw gone ? new Error(exitReason(port)) : err;
      });
      await Promise.race([
        run,
        exited.then(() => { if (!stopping) throw new Error(exitReason(port)); }),
      ]);
    } catch (e) {
      check(false, 'mcp harness', e.message);
    } finally {
      stopping = true;
      if (child && child.exitCode === null) child.kill('SIGTERM');
    }
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  })();
}
