# PSIndex

One searchable reference for the PowerShell cmdlets an M365 / endpoint admin actually uses:

| Source | Entries | Upstream docs |
|---|---|---|
| Microsoft Graph (`Microsoft.Graph.*`, v1.0 + beta) | ~27,300 | [microsoftgraph-docs-powershell](https://github.com/MicrosoftDocs/microsoftgraph-docs-powershell) |
| Azure (`Az.*`) | ~8,800 | [azure-docs-powershell](https://github.com/MicrosoftDocs/azure-docs-powershell) |
| Microsoft Entra (`Microsoft.Entra.*`) | ~600 | [entra-powershell-docs](https://github.com/MicrosoftDocs/entra-powershell-docs) |
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
public/idx/           columnar search shards (~245 KB gzipped for all 41k cmdlets)
public/data/          per-module detail, fetched only when an entry is opened
        │  astro build
        ▼
dist/                 static site, deployed by Vercel on every push to main
```

- **Search** runs in a Web Worker. Name shards load first; description shards load after the first results render and then refine ranking. Ranking: exact → prefix → noun prefix → substring → hyphenless (`getmguser`) → typo-tolerant subsequence → description.
- **Results** are a virtualised list, so "All" (41k rows) renders as fast as a filtered list.
- **Detail** (syntax, parsed parameters, examples, Graph permissions) is lazy-loaded per module and cached.
- **URLs** carry state: `?q=mguser&s=graph&verb=Get&c=graph:Get-MgUser`.
- **Background**: an animated ASCII contour field on `<canvas>` (`src/app/ascii.ts`), tinted by the selected source and rippling from the search box as you type. ~30 fps, pauses in hidden tabs, static under `prefers-reduced-motion`.

## Develop

```bash
npm install
npm run dev        # builds the index, then starts Astro on http://localhost:4321
npm run build      # index + static build into dist/
npm run typecheck  # tsc (run after build or index, which generates src/sources.generated.json)
npm run test:e2e   # browser checks against the built site (needs Playwright + Chromium)
```

## Refresh data locally

`pipelines/refresh.sh <source>` clones that source's upstream docs (configured in `pipelines/<source>/source.env`) into a temp directory and rewrites `data/<source>/`:

```bash
bash pipelines/refresh.sh mecm
python3 scripts/check-shrink.py mecm   # refuses a refresh that lost entries or its version
```

`.github/workflows/update-data.yml` runs the same script daily for every source, or on demand from the Actions tab (input `sources`: `all` or e.g. `graph,mecm`). A new source needs `pipelines/<id>/` (a `parse_docs.py` and a `source.env`), its `data/<id>/`, and an entry in `SOURCES` in `scripts/build-index.ts`; the build fails if those three disagree.

PowerShell alternatives that read installed modules instead of docs: `pipelines/az/get-azcmdlets.ps1`, `pipelines/mecm/get-mecmcmdlets.ps1`.

## Deploy

Import the repo in Vercel (framework preset: Astro; build command `npm run build`; output `dist`). `vercel.json` sets cache headers for the data files.
