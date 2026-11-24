// Stateless Streamable HTTP MCP server. A fresh transport per request: the SDK rejects a reused
// stateless transport, and nothing about a query needs to be remembered.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { getCmdlet, listModules, searchCmdlets, type ToolResult } from './catalog';

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
  'cache-control': 'no-store',
};

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

function from<T>(result: ToolResult<T>) {
  return result.ok ? jsonResult(result.data) : errorResult(result.message);
}

function createServer(origin: string) {
  const server = new McpServer({
    name: 'psindex',
    version: '1.0.0',
  }, {
    instructions: 'Search and read Microsoft 365 and Azure PowerShell cmdlets from PSIndex. Use search_cmdlets to find a name, then get_cmdlet for its syntax and parameters. Read-only.',
  });
  server.registerTool('search_cmdlets', {
    title: 'Search cmdlets',
    description: 'Search the PSIndex catalog of Microsoft Graph, Azure (Az), Entra, Exchange/Teams/SharePoint, and Configuration Manager PowerShell cmdlets. Matches names (hyphens optional, so getmguser finds Get-MgUser) and short descriptions, using the same ranking as the website. Returns name, module, source, a short description, and the PSIndex page URL.',
    inputSchema: {
      query: z.string().trim().min(1).max(200).refine((q) => /[a-z0-9]/i.test(q), 'Query needs a letter or digit.').describe('Name, noun, or words to search for. Must contain a letter or digit. Hyphens are optional.'),
      module: z.string().trim().min(1).max(200).optional().describe('Limit results to this PowerShell module, for example Microsoft.Graph.Users. Case-insensitive.'),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Maximum results to return. Default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.`),
    },
    annotations: readOnly,
  }, async ({ query, module, limit }) => {
    try {
      return from(await searchCmdlets(origin, query, module, limit ?? DEFAULT_LIMIT));
    } catch (e) {
      console.error('[psindex] search_cmdlets', e);
      return errorResult('The cmdlet index could not be read.');
    }
  });
  server.registerTool('get_cmdlet', {
    title: 'Get cmdlet',
    description: 'Look up a PowerShell cmdlet by name and return the details PSIndex shows: syntax, parameters, description, examples, permissions, module, source, and page URL. The name is case-insensitive. When several cmdlets share it, pass module to select one; otherwise every match is returned. Unknown names return an error.',
    inputSchema: {
      name: z.string().trim().min(1).max(200).describe('Cmdlet name, for example Get-MgUser.'),
      module: z.string().trim().min(1).max(200).optional().describe('PowerShell module, when the name is shared by more than one cmdlet.'),
    },
    annotations: readOnly,
  }, async ({ name, module }) => {
    try {
      return from(await getCmdlet(origin, name, module));
    } catch (e) {
      console.error('[psindex] get_cmdlet', e);
      return errorResult('The cmdlet index could not be read.');
    }
  });
  server.registerTool('list_modules', {
    title: 'List modules',
    description: 'List PowerShell modules in the PSIndex catalog and how many cmdlets each contains. Optionally limit to one source: graph, az, entra, exchange, or mecm.',
    inputSchema: {
      source: z.string().trim().min(1).max(40).optional().describe('Source id (graph, az, entra, exchange, mecm) or its short name. Omit for every source.'),
    },
    annotations: readOnly,
  }, async ({ source }) => {
    try {
      return from(await listModules(source));
    } catch (e) {
      console.error('[psindex] list_modules', e);
      return errorResult('The cmdlet index could not be read.');
    }
  });
  return server;
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function handleMcp(request: Request): Promise<Response> | Response {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  return dispatch(request);
}

async function dispatch(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  const server = createServer(origin);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return withCors(await transport.handleRequest(request));
  } catch (e) {
    console.error('[psindex] mcp', e);
    return withCors(new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null,
    }), { status: 500, headers: { 'content-type': 'application/json', ...CORS } }));
  } finally {
    await server.close().catch(() => {});
  }
}
