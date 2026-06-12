#!/usr/bin/env node
// mcp_call.mjs — вызов инструмента MCP-сервера ontoindex по stdio (для пилота CBM-23).
// Запуск: node mcp_call.mjs <projectDir> <toolName> '<jsonArgs>'
// Пример: node mcp_call.mjs . search '{"action":"repomap"}'
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const [proj0, tool, argsJson] = process.argv.slice(2);
if (!tool) { console.error('usage: node mcp_call.mjs <projectDir> <toolName> [jsonArgs]'); process.exit(2); }
const proj = resolve(proj0 || '.');
const ENGINE = process.env.ONTOINDEX_HOME || join(homedir(), '.claude', 'tools', 'ontoindex');
const CLI = join(ENGINE, 'ontoindex', 'dist', 'cli', 'index.js');
if (!existsSync(CLI)) { console.error('engine not installed: ' + CLI); process.exit(2); }

const mcp = spawn('node', [CLI, 'mcp'], {
  cwd: proj,
  env: { ...process.env, ONTOINDEX_MCP_REPO: proj.replace(/\\/g, '/'), ONTOINDEX_MCP_PROJECT_CWD: proj.replace(/\\/g, '/'), ONTOINDEX_MCP_AUTO_ANALYZE: '0' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '', err = '';
mcp.stderr.on('data', (d) => { err += d.toString(); });
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
const send = (o) => mcp.stdin.write(JSON.stringify(o) + '\n');
const call = (id, method, params) => new Promise((res, rej) => {
  pending.set(id, res);
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 120000);
  send({ jsonrpc: '2.0', id, method, params });
});

try {
  await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cbm-pilot', version: '0.1' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const r = await call(2, 'tools/call', { name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} });
  if (r.error) { console.error('RPC ERROR: ' + JSON.stringify(r.error)); process.exitCode = 1; }
  else {
    const content = r.result?.content || [];
    for (const c of content) console.log(typeof c.text === 'string' ? c.text : JSON.stringify(c));
    if (r.result?.isError) { console.error('(tool returned isError)'); process.exitCode = 1; }
  }
} catch (e) {
  console.error('FAILED: ' + e.message + '\nstderr tail:\n' + err.slice(-1500));
  process.exitCode = 1;
} finally { mcp.kill(); }
