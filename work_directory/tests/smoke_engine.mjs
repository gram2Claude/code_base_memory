#!/usr/bin/env node
// smoke_engine.mjs — смоук движка ontoindex (CBM-3 / t03):
//   1) analyze тестовой папки -> .ontoindex/ создан;
//   2) MCP stdio handshake: initialize -> tools/list, печатает список инструментов.
// Запуск: node smoke_engine.mjs [projectDir]   (по умолчанию — временная папка с примером)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const ENGINE = process.env.ONTOINDEX_HOME || join(homedir(), '.claude', 'tools', 'ontoindex');
const CLI = join(ENGINE, 'ontoindex', 'dist', 'cli', 'index.js');
if (!existsSync(CLI)) { console.error('ENGINE NOT INSTALLED: ' + CLI); process.exit(2); }

let proj = process.argv[2];
let cleanup = null;
if (!proj) {
  proj = mkdtempSync(join(tmpdir(), 'oi-smoke-'));
  cleanup = proj;
  spawnSync('git', ['init', '-q', proj]);
  writeFileSync(join(proj, 'app.ts'), `
export function greet(name: string): string { return 'hi ' + name; }
export class Greeter { constructor(private n: string) {} run() { return greet(this.n); } }
`);
  writeFileSync(join(proj, 'util.py'), 'def add(a, b):\n    return a + b\n');
  spawnSync('git', ['-C', proj, 'add', '-A']);
  spawnSync('git', ['-C', proj, '-c', 'user.email=s@l', '-c', 'user.name=s', 'commit', '-qm', 'init']);
}

console.log('== [1/2] analyze ==');
const an = spawnSync('node', [CLI, 'analyze', '.'], { cwd: proj, encoding: 'utf8', timeout: 300000 });
process.stdout.write((an.stdout || '').split('\n').slice(-12).join('\n'));
if (an.status !== 0) { console.error('ANALYZE FAILED\n' + (an.stderr || '')); process.exit(1); }
if (!existsSync(join(proj, '.ontoindex'))) { console.error('NO .ontoindex DIR'); process.exit(1); }
console.log('\nanalyze: OK (.ontoindex создан)');

console.log('== [2/2] MCP stdio handshake ==');
const mcp = spawn('node', [CLI, 'mcp'], {
  cwd: proj,
  env: { ...process.env, ONTOINDEX_MCP_REPO: proj.replace(/\\/g, '/'), ONTOINDEX_MCP_PROJECT_CWD: proj.replace(/\\/g, '/'), ONTOINDEX_MCP_AUTO_ANALYZE: '0' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
let mcpErr = '';
mcp.stderr.on('data', (d) => { mcpErr += d.toString(); });
const pending = new Map();
mcp.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
const send = (obj) => mcp.stdin.write(JSON.stringify(obj) + '\n');
const call = (id, method, params) => new Promise((res, rej) => {
  pending.set(id, res);
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 90000);
  send({ jsonrpc: '2.0', id, method, params });
});

try {
  const init = await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cbm-smoke', version: '0.1' } });
  console.log('initialize: OK — server', init.result?.serverInfo?.name, init.result?.serverInfo?.version);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = await call(2, 'tools/list', {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  console.log(`tools/list: ${names.length} инструментов`);
  console.log(names.slice(0, 12).join(', ') + (names.length > 12 ? ', ...' : ''));
  if (names.length < 5) { console.error('TOO FEW TOOLS'); process.exitCode = 1; }
  else console.log('MCP SMOKE: OK');
} catch (e) {
  console.error('MCP SMOKE FAILED: ' + e.message);
  console.error('stderr tail:\n' + String(mcpErr).slice(-2000));
  process.exitCode = 1;
} finally {
  mcp.kill();
  if (cleanup) setTimeout(() => { try { rmSync(cleanup, { recursive: true, force: true }); } catch {} }, 500);
}
