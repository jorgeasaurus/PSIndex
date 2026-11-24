# PSIndex

One searchable reference for the PowerShell cmdlets an M365 / endpoint admin actually uses:

| Source | Entries | Upstream docs |
|---|---|---|
| Microsoft Graph (`Microsoft.Graph.*`, v1.0 + beta) | ~27,300 | [microsoftgraph-docs-powershell](https://github.com/MicrosoftDocs/microsoftgraph-docs-powershell) |
| Azure (`Az.*`) | ~8,800 | [azure-docs-powershell](https://github.com/MicrosoftDocs/azure-docs-powershell) |
| Microsoft Entra (`Microsoft.Entra.*`) | ~600 | [entra-powershell](https://github.com/microsoftgraph/entra-powershell) |
| Exchange, Teams, SharePoint, Skype, Whiteboard | ~3,000 | [office-docs-powershell](https://github.com/MicrosoftDocs/office-docs-powershell) |
| Configuration Manager (MECM) | ~1,200 | [sccm-docs-powershell-ref](https://github.com/MicrosoftDocs/sccm-docs-powershell-ref) |

It replaces five single-product sites: MgGraphIndex, AzIndex, EntraIndex, ExchIndex and MecmIndex. (Error codes are out of scope; ErrorIndex stays its own site.)

## How it works

```
pipelines/<source>/   parsers moved from the five old repos (Python, stdlib only)
        │  GitHub Actions: .github/workflows/update-data.yml (daily)
        ▼
data/<source>/        committed JSON: manifest.json, descriptions.json, modules/ or products/
        │  npm run build → scripts/build-index.ts
        ▼
public/a/<build>/idx/  columnar search shards (~245 KB gzipped for all 41k cmdlets)
public/a/<build>/data/ per-module detail, fetched only when an entry is opened
        │  astro build
        ▼
dist/                 static site, plus a /mcp function, deployed by Vercel on every push to main
```

- **Search** runs in a Web Worker. Name shards load first; description shards load after the first results render and then refine ranking. Ranking: exact → prefix → noun prefix → substring → hyphenless (`getmguser`) → typo-tolerant subsequence → description.
- **Results** are a virtualised list, so "All" (41k rows) renders as fast as a filtered list.
- **Detail** (syntax, parsed parameters, examples, Graph permissions) is lazy-loaded per module and cached.
- **URLs** carry state: `?q=mguser&s=graph&verb=Get&c=graph:Get-MgUser`.
- **Background**: an animated ASCII contour field on `<canvas>` (`src/app/ascii.ts`), tinted by the selected source and rippling from the search box as you type. ~30 fps, pauses in hidden tabs, static under `prefers-reduced-motion`.

## MCP

Agents can query this index over the [Model Context Protocol](https://modelcontextprotocol.io) Streamable HTTP transport at `https://psindex.vercel.app/mcp`. The endpoint is stateless and read-only, and it does not require authentication. `search_cmdlets` returns names, modules, short descriptions, and page URLs; `get_cmdlet` returns the syntax, parameters, and the rest of an entry; `list_modules` lists modules.

Cursor, Claude, and VS Code accept the same shape:

```json
{
  "mcpServers": {
    "psindex": {
      "url": "https://psindex.vercel.app/mcp"
    }
  }
}
```

## Develop

```bash
npm install
npm run dev        # builds the index, then starts Astro on http://localhost:4321
npm run build      # index, then the site. On Vercel this also bundles /mcp
npm run typecheck  # tsc (run after build or index, which generates src/sources.generated.json)
npm run test:e2e   # browser checks against the built site (needs Playwright + Chromium)
npm run test:mcp   # HTTP checks for /mcp against the built server
npm run verify     # build, typecheck, browser checks, and the MCP checks: the gate CI runs
```

## Refresh data locally

`pipelines/refresh.sh <source>` clones that source's upstream docs (configured in `pipelines/<source>/source.env`) into a temp directory and rewrites `data/<source>/`:

```bash
bash pipelines/refresh.sh mecm
python3 scripts/check-shrink.py mecm   # refuses a refresh that lost more than 10% of its entries
```

`.github/workflows/update-data.yml` runs the same script daily for every source, or on demand from the Actions tab (input `sources`: `all` or e.g. `graph,mecm`). A new source needs `pipelines/<id>/` (a `parse_docs.py` and a `source.env`), its `data/<id>/`, and an entry in `SOURCES` in `scripts/build-index.ts`; the build fails if those three disagree.

A parser that finds no cmdlets fails the run. A source's version is the one found this run, else the last committed one (with a warning), else the run fails (`pipelines/common.py` `source_version`).

## Deploy

Import the repo in Vercel (framework preset: Astro; build command `npm run build`). `@astrojs/vercel` publishes the static site and the `/mcp` function. `vercel.json` sets cache headers for the data files.
