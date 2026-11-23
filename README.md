# PSIndex

One searchable reference for the PowerShell an M365 / endpoint admin actually uses:

| Source | Entries | Upstream docs |
|---|---|---|
| Microsoft Graph (`Microsoft.Graph.*`, v1.0 + beta) | ~27,300 | [microsoftgraph-docs-powershell](https://github.com/MicrosoftDocs/microsoftgraph-docs-powershell) |
| Azure (`Az.*`) | ~8,800 | [azure-docs-powershell](https://github.com/MicrosoftDocs/azure-docs-powershell) |
| Microsoft Entra (`Microsoft.Entra.*`) | ~600 | [entra-powershell-docs](https://github.com/MicrosoftDocs/entra-powershell-docs) |
| Exchange, Teams, SharePoint, Skype, Whiteboard | ~3,000 | [office-docs-powershell](https://github.com/MicrosoftDocs/office-docs-powershell) |
| Configuration Manager (MECM) | ~1,200 | [sccm-docs-powershell-ref](https://github.com/MicrosoftDocs/sccm-docs-powershell-ref) |
| Microsoft error codes (Entra, Graph, Intune, SCCM, Exchange, Windows Installer, Windows Update) | ~2,200 | various, see `pipelines/errors/scrape_errors.py` |

It replaces six single-product sites: MgGraphIndex, AzIndex, EntraIndex, ExchIndex, MecmIndex and ErrorIndex.

## How it works

```
pipelines/<source>/   parsers moved from the six old repos (Python, stdlib only)
        │  GitHub Actions: .github/workflows/update-data.yml (daily; errors monthly)
        ▼
data/<source>/        committed JSON: manifest.json, descriptions.json, modules/ or products/
        │  npm run build → scripts/build-index.mjs
        ▼
public/idx/           columnar search shards (~265 KB gzipped for all 43k entries)
public/data/          per-module detail, fetched only when an entry is opened
        │  astro build
        ▼
dist/                 static site, deployed by Vercel on every push to main
```

- **Search** runs in a Web Worker. Name shards load first; description shards load after the first results render and then refine ranking. Ranking: exact → prefix → noun prefix → substring → hyphenless (`getmguser`) → typo-tolerant subsequence → description.
- **Results** are a virtualised list, so "All" (43k rows) renders as fast as a filtered list.
- **Detail** (syntax, parsed parameters, examples, Graph permissions, error resolution) is lazy-loaded per module and cached.
- **URLs** carry state: `?q=mguser&s=graph&verb=Get&c=graph:Get-MgUser`.
- **Background**: an animated ASCII contour field on `<canvas>` (`src/app/ascii.ts`), tinted by the selected source and rippling from the search box as you type. ~30 fps, pauses in hidden tabs, static under `prefers-reduced-motion`.

## Develop

```bash
npm install
npm run dev        # builds the index, then starts Astro on http://localhost:4321
npm run build      # index + static build into dist/
```

## Refresh data locally

Each pipeline writes to `data/<source>/`. Example:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/MicrosoftDocs/sccm-docs-powershell-ref.git docs
(cd docs && git sparse-checkout set sccm-ps/ConfigurationManager)
python3 pipelines/mecm/parse_docs.py docs
```

`.github/workflows/update-data.yml` shows the exact command for every source. Run it on demand from the Actions tab (input `sources`: `all` or e.g. `graph,errors`). `scripts/check-shrink.py` stops a refresh that lost more than 10% of a source's entries, which is what a failed upstream clone looks like.

PowerShell alternatives that read installed modules instead of docs: `pipelines/az/get-azcmdlets.ps1`, `pipelines/mecm/get-mecmcmdlets.ps1`.

## Deploy

Import the repo in Vercel (framework preset: Astro; build command `npm run build`; output `dist`). `vercel.json` sets cache headers for the data files.
