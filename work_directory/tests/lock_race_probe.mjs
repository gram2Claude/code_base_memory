#!/usr/bin/env node
// lock_race_probe.mjs — ЭКСПЕРИМЕНТ (не штатный смоук): бьётся ли DB-lock LadybugDB,
// если запустить `ontoindex analyze` (reindex), пока ЖИВОЙ MCP-сервер держит ту же БД?
// Это худший случай startup-гонки авто-reindex: MCP поднялся первым и держит lock.
//
// БЕЗОПАСНОСТЬ: работает целиком в одноразовом temp-проекте; реальный .ontoindex/ не трогает.
// Запуск: node work_directory/tests/lock_race_probe.mjs
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const ENGINE = process.env.ONTOINDEX_HOME || join(homedir(), '.claude', 'tools', 'ontoindex');
const CLI = join(ENGINE, 'ontoindex', 'dist', 'cli', 'index.js');
if (!existsSync(CLI)) { console.error('ENGINE NOT INSTALLED: ' + CLI); process.exit(2); }

// env-гейты ровно как в реальном .mcp.json проекта
const GATES = {
  ONTOINDEX_MCP_AUTO_ANALYZE: '0',
  ONTOINDEX_DISABLE_SEMANTIC: '1',
  ONTOINDEX_QUERY_LOG: '0',
  ONTOINDEX_TOOL_TELEMETRY: '0',
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
};

// 1) одноразовый проект
const proj = mkdtempSync(join(tmpdir(), 'oi-race-'));
const pslash = proj.replace(/\\/g, '/');
spawnSync('git', ['init', '-q', proj]);
writeFileSync(join(proj, 'app.ts'),
  "export function greet(n){ return 'hi ' + n; }\n" +
  "export class G { run(){ return greet('x'); } }\n");
writeFileSync(join(proj, 'util.py'), 'def add(a, b):\n    return a + b\n');
spawnSync('git', ['-C', proj, 'add', '-A']);
spawnSync('git', ['-C', proj, '-c', 'user.email=s@l', '-c', 'user.name=s', 'commit', '-qm', 'init']);

const projEnv = { ...process.env, ...GATES, ONTOINDEX_MCP_REPO: pslash, ONTOINDEX_MCP_PROJECT_CWD: pslash };

function runAnalyze() {
  const t0 = Date.now();
  const r = spawnSync('node', [CLI, 'analyze', '.'], { cwd: proj, encoding: 'utf8', timeout: 300000, env: projEnv });
  return { status: r.status, dt: ((Date.now() - t0) / 1000).toFixed(1), stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

console.log('== [1/3] baseline analyze (БЕЗ MCP) — строим .ontoindex/ ==');
const base = runAnalyze();
console.log(`baseline: status=${base.status} time=${base.dt}s`);
if (base.status !== 0 || !existsSync(join(proj, '.ontoindex'))) {
  console.error('baseline analyze FAILED:\n' + (base.stderr || base.stdout).slice(-1500));
  try { rmSync(proj, { recursive: true, force: true }); } catch {}
  process.exit(1);
}

console.log('== [2/4] поднимаю MCP (должен держать LadybugDB) ==');
const mcp = spawn('node', [CLI, 'mcp'], { cwd: proj, env: projEnv, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', mcpErr = '';
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
const send = (o) => mcp.stdin.write(JSON.stringify(o) + '\n');
const call = (id, method, params) => new Promise((res, rej) => {
  pending.set(id, res);
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 90000);
  send({ jsonrpc: '2.0', id, method, params });
});

let mcpAlive = false, dbOpened = false;
try {
  const init = await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'lockrace', version: '0.1' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = await call(2, 'tools/list', {});
  mcpAlive = (tools.result?.tools || []).length > 0;
  console.log(`MCP up: server=${init.result?.serverInfo?.name} tools=${(tools.result?.tools || []).length}`);
  // форсируем открытие БД реальным запросом к графу
  try {
    const q = await call(3, 'tools/call', { name: 'search', arguments: { action: 'repomap' } });
    dbOpened = !q.error && !q.result?.isError;
    console.log(`MCP query search/repomap: ${q.error ? 'RPC error ' + JSON.stringify(q.error) : (q.result?.isError ? 'isError' : 'ok — БД открыта MCP')}`);
  } catch (e) { console.log('MCP query failed: ' + e.message); }
} catch (e) {
  console.error('MCP не поднялся: ' + e.message + '\n' + mcpErr.slice(-1200));
}

// КЛЮЧЕВОЕ: двигаем HEAD вперёд НОВЫМ коммитом, чтобы analyze РЕАЛЬНО писал в граф,
// а не закоротил «Already up to date» (тогда write-lock не берётся и тест пустой).
console.log('== [3/4] вношу правку + коммит (HEAD уходит вперёд от индекса) ==');
writeFileSync(join(proj, 'app.ts'),
  "export function greet(n){ return 'hello ' + n; }\n" +
  "export class G { run(){ return greet('y'); } }\n" +
  "export function farewell(n){ return 'bye ' + n; }\n");
writeFileSync(join(proj, 'extra.ts'),
  "export function newlyAdded(a, b){ return a * b + 1; }\n");
spawnSync('git', ['-C', proj, 'add', '-A']);
spawnSync('git', ['-C', proj, '-c', 'user.email=s@l', '-c', 'user.name=s', 'commit', '-qm', 'change']);

console.log('== [4/4] reindex (analyze) ПОКА MCP жив и держит БД ==');
const race = runAnalyze();
console.log(`under-lock analyze: status=${race.status} time=${race.dt}s`);
const out = (race.stderr + '\n' + race.stdout);
console.log('--- output tail ---\n' + out.split('\n').filter(Boolean).slice(-15).join('\n'));

// вырезаем путь проекта, чтобы имя temp-папки не давало ложных совпадений на /lock/
const scan = out.split(pslash).join('<PROJ>').split(proj).join('<PROJ>');
// сужаем до реальных сигнатур lock/contention-ошибок (а не любой подстроки "lock")
const lockHit = /database is (locked|busy)|could not (acquire|obtain|get)[^\n]{0,30}lock|lock(file)?[^\n]{0,20}(held|exists|busy|in use)|failed to (open|acquire|lock)|EBUSY|EPERM|EACCES|resource temporarily unavailable|another (process|instance)|already in use/i.test(scan);
const indexedOk = /repository indexed successfully/i.test(out);
// валидность: analyze должен был РЕАЛЬНО писать, а не закоротить «up to date»
const didRealWork = !/already up to date/i.test(out);

// MCP ещё отвечает после reindex? (косвенная проверка на повреждение БД)
let mcpStillOk = null;
try {
  const q2 = await call(4, 'tools/call', { name: 'search', arguments: { action: 'repomap' } });
  mcpStillOk = !q2.error && !q2.result?.isError;
} catch { mcpStillOk = false; }

console.log('\n===== VERDICT =====');
console.log('MCP был жив (tools/list)      :', mcpAlive);
console.log('MCP открыл БД (repomap ok)     :', dbOpened);
console.log('reindex exit status           :', race.status, race.error ? `(spawn error: ${race.error.code || race.error.message})` : '');
console.log('reindex время, с              :', race.dt);
console.log('lock-подобная ошибка в выводе  :', lockHit);
console.log('"Repository indexed successfully":', indexedOk);
console.log('analyze РЕАЛЬНО писал в граф    :', didRealWork, didRealWork ? '' : '(!!! "Already up to date" — тест ПУСТОЙ)');
console.log('MCP отвечает ПОСЛЕ reindex     :', mcpStillOk);
if (!didRealWork) {
  console.log('\nИТОГ: НЕВАЛИДНО — analyze ничего не писал (lock не проверен). Нужна реальная дельта индекса.');
} else if (race.status === 0 && !lockHit && indexedOk && mcpStillOk) {
  console.log('\nИТОГ: reindex УСПЕШНО ЗАПИСАЛ граф при живом MCP, держащем БД (и MCP уцелел).');
  console.log('      → худший случай startup-гонки БЕЗОПАСЕН (lock не бьётся).');
} else {
  console.log('\nИТОГ: reindex НЕ прошёл чисто при живом MCP.');
  console.log('      → startup-гонка — РЕАЛЬНЫЙ риск; нужен lock-aware retry/ordering или другой триггер.');
}

mcp.kill();
setTimeout(() => { try { rmSync(proj, { recursive: true, force: true }); } catch {} }, 800);
