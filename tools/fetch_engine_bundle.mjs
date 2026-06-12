#!/usr/bin/env node
// fetch_engine_bundle.mjs — скачать engine-bundle.tgz из релиза engine-bundle-win-node24
// и распаковать в ontoindex/ontoindex (node_modules + dist + grammar-inventory.txt).
// Токен: ~/.wgp/secrets.json (github_token). Запуск: node tools/fetch_engine_bundle.mjs
import { createWriteStream, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(repoRoot, 'ontoindex', 'ontoindex');
const t = JSON.parse(readFileSync(process.env.USERPROFILE + '/.wgp/secrets.json', 'utf8')).github_token;
const H = { Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json' };

const rel = await (await fetch('https://api.github.com/repos/gram2Claude/code_base_memory/releases/tags/engine-bundle-win-node24', { headers: H })).json();
if (!rel.assets || !rel.assets.length) { console.error('release/asset not found: ' + JSON.stringify(rel.message || rel)); process.exit(1); }
const asset = rel.assets.find(a => a.name === 'engine-bundle.tgz');
console.log('asset:', asset.name, Math.round(asset.size / 1024 / 1024) + ' MB, from release:', rel.body || rel.name);

const dl = await fetch('https://api.github.com/repos/gram2Claude/code_base_memory/releases/assets/' + asset.id, {
  headers: { Authorization: 'Bearer ' + t, Accept: 'application/octet-stream' },
  redirect: 'follow',
});
if (!dl.ok) { console.error('download failed: ' + dl.status); process.exit(1); }
const tgz = join(pkgDir, 'engine-bundle.tgz');
await pipeline(Readable.fromWeb(dl.body), createWriteStream(tgz));
console.log('downloaded ->', tgz);

const x = spawnSync('tar', ['-xzf', 'engine-bundle.tgz'], { cwd: pkgDir, stdio: 'inherit' });
if (x.status !== 0) { console.error('tar extract failed'); process.exit(1); }
console.log('extracted: node_modules=' + existsSync(join(pkgDir, 'node_modules')) + ' dist=' + existsSync(join(pkgDir, 'dist')) + ' inventory=' + existsSync(join(pkgDir, 'grammar-inventory.txt')));
