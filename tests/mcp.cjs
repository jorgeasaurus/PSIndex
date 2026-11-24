// HTTP checks for the stateless MCP endpoint against the built Node server.
//   npm run build && node tests/mcp.cjs
// The browser suite serves dist/ as static files and cannot answer /mcp.
const { spawn } = require('node:child_process');
const ACCEPT = 'application/json, text/event-stream';

async function rpc(base, id, method, params, extraHeaders = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  const trimmed = text.trim();
  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) body = JSON.parse(trimmed);
    else {
      const data = trimmed.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter((line) => line && line !== '[DONE]');
      body = data.length ? JSON.parse(data[data.length - 1]) : null;
    }
  } catch {
    body = { parseError: trimmed.slice(0, 300) };
  }
  return { status: res.status, body, text };
}

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

async function runMcp(base, check) {
  const init = await rpc(base, 1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'psindex-test', version: '1.0.0' },
  });
  const protocol = init.body?.result?.protocolVersion;
  check(init.status === 200 && init.body?.result?.serverInfo?.name === 'psindex' && protocol && init.body?.result?.capabilities?.tools, 'mcp initialize', `status ${init.status} ${init.text.slice(0, 240)}`);

  const headers = protocol ? { 'mcp-protocol-version': protocol } : {};
  const listed = await rpc(base, 2, 'tools/list', {}, headers);
  const tools = listed.body?.result?.tools ?? [];
  const names = tools.map((tool) => tool.name);
  const searchTool = tools.find((tool) => tool.name === 'search_cmdlets');
  check(
    listed.status === 200 && ['search_cmdlets', 'get_cmdlet', 'list_modules'].every((name) => names.includes(name)) && searchTool?.inputSchema?.required?.includes('query'),
    'mcp tools/list',
    names.join(', ') || listed.text.slice(0, 240),
  );

  const found = toolData(await rpc(base, 3, 'tools/call', { name: 'search_cmdlets', arguments: { query: 'Get-MgUser', limit: 5 } }, headers).then((r) => r.body));
  const top = found.data?.results?.[0];
  const topUrl = top ? new URL(top.url) : null;
  check(
    top?.name === 'Get-MgUser' && top.module === 'Microsoft.Graph.Users' && top.source === 'graph' && typeof top.description === 'string' && top.description.length > 0 && topUrl?.searchParams.get('c') === 'graph:Get-MgUser',
    'mcp search_cmdlets Get-MgUser',
    JSON.stringify(top ?? found.error ?? found).slice(0, 300),
  );

  const hyphenless = toolData((await rpc(base, 4, 'tools/call', { name: 'search_cmdlets', arguments: { query: 'getmguser', limit: 1 } }, headers)).body);
  check(hyphenless.data?.results?.[0]?.name === 'Get-MgUser', 'mcp search_cmdlets hyphenless query', JSON.stringify(hyphenless.data?.results?.[0] ?? hyphenless.error).slice(0, 200));

  const narrowed = toolData((await rpc(base, 5, 'tools/call', { name: 'search_cmdlets', arguments: { query: 'Get-MgUser', module: 'microsoft.graph.users' } }, headers)).body);
  const narrowedRows = narrowed.data?.results ?? [];
  check(narrowedRows[0]?.name === 'Get-MgUser' && narrowedRows.every((row) => row.module === 'Microsoft.Graph.Users'), 'mcp search_cmdlets module filter', JSON.stringify(narrowedRows.slice(0, 2).map((row) => row.module) ?? narrowed.error).slice(0, 200));

  const badModule = toolData((await rpc(base, 6, 'tools/call', { name: 'search_cmdlets', arguments: { query: 'Get-MgUser', module: 'Not.A.Module' } }, headers)).body);
  check(badModule.error?.isError && /Unknown module/.test(badModule.error.message), 'mcp search_cmdlets unknown module', badModule.error?.message || JSON.stringify(badModule).slice(0, 200));

  const tooMany = await rpc(base, 7, 'tools/call', { name: 'search_cmdlets', arguments: { query: 'Get-MgUser', limit: 100 } }, headers);
  const limitError = tooMany.body?.error?.message || (tooMany.body?.result?.isError ? textOf(tooMany.body.result) : '');
  check(!!limitError && /25|limit|validation|too big/i.test(limitError), 'mcp search_cmdlets rejects limit over 25', limitError.slice(0, 240) || tooMany.text.slice(0, 240));

  const detail = toolData((await rpc(base, 8, 'tools/call', { name: 'get_cmdlet', arguments: { name: 'get-mguser' } }, headers)).body);
  const match = detail.data?.matches?.[0];
  check(
    detail.data?.matches?.length === 1 && match?.name === 'Get-MgUser' && match.module === 'Microsoft.Graph.Users' && match.syntax.includes('Get-MgUser') && match.parameters.length > 3 && match.description && match.url.includes('c=graph%3AGet-MgUser'),
    'mcp get_cmdlet Get-MgUser',
    JSON.stringify(match ? { name: match.name, module: match.module, params: match.parameters?.length, syntax: match.syntax?.slice(0, 80) } : detail.error).slice(0, 300),
  );

  const missing = toolData((await rpc(base, 9, 'tools/call', { name: 'get_cmdlet', arguments: { name: 'Not-ARealCmdlet' } }, headers)).body);
  check(missing.error?.isError && /Unknown cmdlet/.test(missing.error.message), 'mcp get_cmdlet unknown name', missing.error?.message || JSON.stringify(missing).slice(0, 200));

  const modules = toolData((await rpc(base, 10, 'tools/call', { name: 'list_modules', arguments: { source: 'graph' } }, headers)).body);
  check(
    modules.data?.modules?.some((mod) => mod.source === 'graph' && mod.name === 'Microsoft.Graph.Users' && mod.count > 0),
    'mcp list_modules graph',
    modules.error?.message || `modules ${modules.data?.modules?.length ?? 0}`,
  );
}

module.exports = { runMcp };

if (require.main === module) {
  const PORT = 4408;
  const BASE = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['dist/server/entry.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const results = [];
  const check = (ok, name, detail = '') => results.push({ ok: !!ok, name, detail });
  (async () => {
    try {
      for (let i = 0; i < 80; i++) {
        if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${log.slice(-800)}`);
        try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
        if (i === 79) throw new Error(`server did not start\n${log.slice(-800)}`);
        await new Promise((r) => setTimeout(r, 250));
      }
      await runMcp(BASE, check);
    } catch (e) {
      check(false, 'mcp harness', e.message.split('\n')[0]);
    } finally {
      child.kill('SIGTERM');
    }
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
  })();
}
