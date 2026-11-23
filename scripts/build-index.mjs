// Build-time step: turns the raw pipeline output in data/<source>/ into
//   src/sources.generated.json        – the source list (single source of truth for the app and worker)
//   public/idx/<source>.json          – columnar search index (names + facets), loaded first
//   public/idx/<source>.desc.json     – short descriptions aligned to the index, loaded after first paint
//   public/data/<source>/<file>.json  – per-module / per-product detail, fetched on demand
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA = join(ROOT, 'data');
const OUT_IDX = join(ROOT, 'public', 'idx');
const OUT_DATA = join(ROOT, 'public', 'data');
const DESC_MAX = 220;

const LEARN_MODULE = 'https://learn.microsoft.com/powershell/module/{module}/{name}';

// Every per-source fact lives here. `extraLabel` names the shard's `x` column for that source;
// `sample` is the example search the intro panel offers.
const SOURCES = [
  { id: 'graph', sample: 'Get-MgUser', label: 'Microsoft Graph', short: 'Graph', kind: 'cmdlet', color: '#9b8cff', extraLabel: 'API', learn: LEARN_MODULE },
  { id: 'az', sample: 'Get-AzVM', label: 'Azure (Az)', short: 'Az', kind: 'cmdlet', color: '#4cb3ff', extraLabel: '', learn: LEARN_MODULE },
  { id: 'entra', sample: 'Get-EntraGroupMember', label: 'Microsoft Entra', short: 'Entra', kind: 'cmdlet', color: '#2fd0b5', extraLabel: 'API', learn: LEARN_MODULE },
  { id: 'exchange', sample: 'Set-Mailbox', label: 'Exchange, Teams & SharePoint', short: 'Exchange', kind: 'cmdlet', color: '#f2b33d', extraLabel: '', learn: LEARN_MODULE },
  { id: 'mecm', sample: 'Invoke-CMClientAction', label: 'Configuration Manager', short: 'MECM', kind: 'cmdlet', color: '#7fd45a', extraLabel: 'Site role', learn: 'https://learn.microsoft.com/powershell/module/configurationmanager/{name}' },
  { id: 'errors', sample: 'AADSTS50076', label: 'Error codes', short: 'Errors', kind: 'error', color: '#ff7a6b', extraLabel: '', learn: '' },
];

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const jsonFiles = async (dir) => (await readdir(dir)).filter((f) => f.endsWith('.json'));
const clip = (s) => {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > DESC_MAX ? s.slice(0, DESC_MAX - 1).trimEnd() + '…' : s;
};

/**
 * Each kind reads its pipeline output and returns uniform rows:
 *   { n: name, v: verb, m: module/product, c: category, f: detail file, x: extra, p: permission count, e: flag, desc }
 * in display order, and copies its detail files to public/data/<source>/.
 */
const LOADERS = {
  async cmdlet(dir, out) {
    const manifest = await readJson(join(dir, 'manifest.json'));
    const descriptions = await readJson(join(dir, 'descriptions.json')).catch(() => ({}));
    // A name can live in several module files (Entra v1.0 + beta, Teams + Skype, Az.PostgreSql + Az.PostgreSqlFlexibleServer).
    const holders = new Map();
    for (const f of await jsonFiles(join(dir, 'modules'))) {
      const stem = basename(f, '.json');
      const body = await readJson(join(dir, 'modules', f));
      for (const [name, c] of Object.entries(body.cmdlets)) {
        holders.set(name, [...(holders.get(name) ?? []), stem]);
        c.description ??= descriptions[name];
      }
      await writeFile(join(out, f), JSON.stringify(body));
    }
    const rows = manifest.d.map((r) => {
      const files = (holders.get(r.n) ?? []).sort();
      return {
        n: r.n, v: r.v, m: r.m, c: r.c, x: r.a ?? r.r, p: r.p, e: r.e, desc: descriptions[r.n],
        f: files.includes(r.m) ? r.m : files[0], // prefer the file named after the row's own module
      };
    });
    const missing = rows.filter((r) => !r.f).length;
    if (missing) console.warn(`    ${missing} cmdlets have no detail file`);
    return { version: manifest.v, rows: rows.sort((a, b) => a.n.localeCompare(b.n)) };
  },

  async error(dir, out) {
    const manifest = await readJson(join(dir, 'manifest.json'));
    const descriptions = await readJson(join(dir, 'descriptions.json')).catch(() => ({}));
    for (const f of await jsonFiles(join(dir, 'products'))) {
      await writeFile(join(out, f), JSON.stringify(await readJson(join(dir, 'products', f))));
    }
    const rows = manifest.d.map((r) => ({
      n: r.c, m: r.p, c: r.t, e: r.h, desc: r.m || descriptions[`${r.p}::${r.c}`],
      f: r.p.toLowerCase().replace(/\s+/g, '-'),
    }));
    // Grouped by product, so neighbouring codes are related codes.
    return { version: manifest.updated, rows: rows.sort((a, b) => a.m.localeCompare(b.m) || a.n.localeCompare(b.n)) };
  },
};

function interner() {
  const list = [];
  const map = new Map();
  return {
    list,
    id(v = '') {
      let i = map.get(v);
      if (i === undefined) { i = list.length; list.push(v); map.set(v, i); }
      return i;
    },
  };
}

/** Rows (already in display order) -> the columnar `IndexShard` (src/app/types.ts) plus the aligned description array. */
function buildShard(rows) {
  const verbs = interner(), mods = interner(), cats = interner(), files = interner(), extras = interner();
  const index = { n: [], v: [], m: [], c: [], f: [], x: [], p: [], e: [], verbs: verbs.list, mods: mods.list, cats: cats.list, files: files.list, extras: extras.list };
  for (const r of rows) {
    index.n.push(r.n);
    index.v.push(verbs.id(r.v));
    index.m.push(mods.id(r.m));
    index.c.push(cats.id(r.c));
    index.f.push(files.id(r.f));
    index.x.push(extras.id(r.x));
    index.p.push(r.p ?? 0);
    index.e.push(r.e ? 1 : 0);
  }
  return { index, desc: rows.map((r) => clip(r.desc)) };
}

async function main() {
  const t0 = Date.now();
  await rm(OUT_IDX, { recursive: true, force: true });
  await rm(OUT_DATA, { recursive: true, force: true });
  await mkdir(OUT_IDX, { recursive: true });
  const sources = [];
  for (const src of SOURCES) {
    const out = join(OUT_DATA, src.id);
    await mkdir(out, { recursive: true });
    const { version, rows } = await LOADERS[src.kind](join(DATA, src.id), out);
    const { index, desc } = buildShard(rows);
    await writeFile(join(OUT_IDX, `${src.id}.json`), JSON.stringify(index));
    await writeFile(join(OUT_IDX, `${src.id}.desc.json`), JSON.stringify(desc));
    sources.push({ ...src, count: rows.length, version: version ?? '' });
    console.log(`  ${src.id.padEnd(9)} ${String(rows.length).padStart(6)} entries`);
  }
  const total = sources.reduce((a, s) => a + s.count, 0);
  // Shards are fetched as /idx/<id>.json?v=<build>; the id is bundled into the app, so HTML,
  // worker, index and descriptions always come from the same build.
  const build = Date.now().toString(36);
  await writeFile(join(ROOT, 'src', 'sources.generated.json'), JSON.stringify({ build, total, sources }, null, 2) + '\n');
  console.log(`  ${total} entries indexed in ${Date.now() - t0} ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
