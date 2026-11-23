// Build-time step: turns the raw pipeline output in data/<source>/ into
//   public/idx/sources.json      – source list, counts, versions
//   public/idx/<source>.json     – columnar search index (names + facets), loaded first
//   public/idx/<source>.desc.json – short descriptions aligned to the index, loaded after first paint
//   public/data/<source>/<file>.json – per-module / per-product detail, fetched on demand
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA = join(ROOT, 'data');
const OUT_IDX = join(ROOT, 'public', 'idx');
const OUT_DATA = join(ROOT, 'public', 'data');
const DESC_MAX = 220;

export const SOURCES = [
  { id: 'graph', label: 'Microsoft Graph', short: 'Graph', kind: 'cmdlet', learn: 'module' },
  { id: 'az', label: 'Azure (Az)', short: 'Az', kind: 'cmdlet', learn: 'module' },
  { id: 'entra', label: 'Microsoft Entra', short: 'Entra', kind: 'cmdlet', learn: 'module' },
  { id: 'exchange', label: 'Exchange, Teams & SharePoint', short: 'Exchange', kind: 'cmdlet', learn: 'module' },
  { id: 'mecm', label: 'Configuration Manager', short: 'MECM', kind: 'cmdlet', learn: 'configurationmanager' },
  { id: 'errors', label: 'Error codes', short: 'Errors', kind: 'error' },
];

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const clip = (s) => {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > DESC_MAX ? s.slice(0, DESC_MAX - 1).trimEnd() + '…' : s;
};

function interner() {
  const list = [];
  const map = new Map();
  return {
    list,
    id(v) {
      v = v ?? '';
      let i = map.get(v);
      if (i === undefined) { i = list.length; list.push(v); map.set(v, i); }
      return i;
    },
  };
}

async function buildCmdletSource(src) {
  const dir = join(DATA, src.id);
  const manifest = await readJson(join(dir, 'manifest.json'));
  const descriptions = await readJson(join(dir, 'descriptions.json')).catch(() => ({}));

  // Map every cmdlet to the detail file(s) that hold it. A name can live in several files
  // (Entra v1.0 + beta, Teams + Skype, Az.PostgreSql + Az.PostgreSqlFlexibleServer).
  const fileOf = new Map();
  const modDir = join(dir, 'modules');
  await mkdir(join(OUT_DATA, src.id), { recursive: true });
  for (const f of (await readdir(modDir)).filter((f) => f.endsWith('.json'))) {
    const stem = basename(f, '.json');
    const body = await readJson(join(modDir, f));
    for (const [name, c] of Object.entries(body.cmdlets ?? {})) {
      if (!fileOf.has(name)) fileOf.set(name, []);
      fileOf.get(name).push(stem);
      if (descriptions[name] && !c.description) c.description = descriptions[name];
    }
    await writeFile(join(OUT_DATA, src.id, f), JSON.stringify(body));
  }

  const verbs = interner(), mods = interner(), cats = interner(), files = interner(), extra = interner();
  const rows = [...manifest.d].sort((a, b) => a.n.localeCompare(b.n));
  const idx = { n: [], v: [], m: [], c: [], f: [], x: [], p: [], e: [] };
  const desc = [];
  for (const r of rows) {
    idx.n.push(r.n);
    idx.v.push(verbs.id(r.v));
    idx.m.push(mods.id(r.m ?? ''));
    idx.c.push(cats.id(r.c ?? ''));
    // Prefer the file named after the row's own module; fall back to the only/first holder.
    const holders = (fileOf.get(r.n) ?? []).sort();
    idx.f.push(files.id(holders.includes(r.m) ? r.m : holders[0] ?? ''));
    // x: api version (graph/entra) or site role (mecm)
    idx.x.push(extra.id(r.a ?? r.r ?? ''));
    idx.p.push(r.p ?? 0);
    idx.e.push(r.e ? 1 : 0);
    desc.push(clip(descriptions[r.n]));
  }
  const missing = rows.filter((r) => !fileOf.has(r.n)).length;
  if (missing) console.warn(`  ${src.id}: ${missing} cmdlets have no detail file`);

  return {
    meta: { count: rows.length, version: manifest.v ?? '' },
    index: { ...idx, verbs: verbs.list, mods: mods.list, cats: cats.list, files: files.list, extras: extra.list },
    desc,
  };
}

async function buildErrorSource(src) {
  const dir = join(DATA, src.id);
  const manifest = await readJson(join(dir, 'manifest.json'));
  const descriptions = await readJson(join(dir, 'descriptions.json')).catch(() => ({}));
  await mkdir(join(OUT_DATA, src.id), { recursive: true });
  for (const f of (await readdir(join(dir, 'products'))).filter((f) => f.endsWith('.json'))) {
    await writeFile(join(OUT_DATA, src.id, f), JSON.stringify(await readJson(join(dir, 'products', f))));
  }
  const prods = interner(), cats = interner(), files = interner(), verbs = interner(), extra = interner();
  const rows = [...manifest.d].sort((a, b) => a.p.localeCompare(b.p) || a.c.localeCompare(b.c));
  const idx = { n: [], v: [], m: [], c: [], f: [], x: [], p: [], e: [] };
  const desc = [];
  for (const r of rows) {
    idx.n.push(r.c);
    idx.v.push(verbs.id(''));
    idx.m.push(prods.id(r.p));
    idx.c.push(cats.id(r.t ?? ''));
    idx.f.push(files.id(r.p.toLowerCase().replace(/\s+/g, '-')));
    idx.x.push(extra.id(''));
    idx.p.push(0);
    idx.e.push(r.h ? 1 : 0); // has a resolution
    desc.push(clip(r.m || descriptions[`${r.p}::${r.c}`]));
  }
  return {
    meta: { count: rows.length, version: manifest.updated ?? '' },
    index: { ...idx, verbs: verbs.list, mods: prods.list, cats: cats.list, files: files.list, extras: extra.list },
    desc,
  };
}

async function main() {
  const t0 = Date.now();
  await rm(OUT_IDX, { recursive: true, force: true });
  await rm(OUT_DATA, { recursive: true, force: true });
  await mkdir(OUT_IDX, { recursive: true });
  const sources = [];
  for (const src of SOURCES) {
    const built = src.kind === 'error' ? await buildErrorSource(src) : await buildCmdletSource(src);
    await writeFile(join(OUT_IDX, `${src.id}.json`), JSON.stringify(built.index));
    await writeFile(join(OUT_IDX, `${src.id}.desc.json`), JSON.stringify(built.desc));
    sources.push({ ...src, ...built.meta });
    console.log(`  ${src.id.padEnd(9)} ${String(built.meta.count).padStart(6)} entries`);
  }
  const total = sources.reduce((a, s) => a + s.count, 0);
  // Shards are fetched as /idx/<id>.json?v=<build>, so an index and its descriptions always come from the same build.
  const build = Date.now().toString(36);
  await writeFile(join(OUT_IDX, 'sources.json'), JSON.stringify({ build, total, sources }));
  await writeFile(join(ROOT, 'src', 'sources.generated.json'), JSON.stringify({ total, sources }, null, 2) + '\n');
  console.log(`  ${total} entries indexed in ${Date.now() - t0} ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
