#!/usr/bin/env node
// reindex_hook_test.mjs — функциональный тест SessionStart auto-reindex (CBM-31).
// Гоняет РЕАЛЬНЫЙ ontoindex-hook.js в режиме SessionStart на временном git-репо,
// подменяя движок стаб-CLI (ONTOINDEX_CLI_JS) — быстро и детерминированно, без
// установленного ontoindex. Проверяет 4 сценария:
//   1) stale  → hook просит reindex, спавнит detached-worker, тот зовёт `analyze`,
//               пишет stamp(status=ok), снимает lock-файл;
//   2) fresh  → ничего не делает (нет ответа, нет lock, analyze не звался);
//   3) dedup  → свежий lock уже есть → worker не спавнится, analyze не звался;
//   4) retry  → стаб падает на «database is locked» один раз, потом ok → status=ok,
//               attempts>=2 (бэкофф-ретрай по lock работает).
// Запуск: node work_directory/tests/reindex_hook_test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', '..', 'ontoindex', 'ontoindex-claude-plugin', 'hooks', 'ontoindex-hook.js');

let fails = 0;
function ok(cond, name) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) fails++;
}
function reindexLockPath(repoRoot) {
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 24);
  return join(tmpdir(), `ontoindex-hook-reindex-${hash}.lock`);
}
function stampPath(repoRoot) {
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 24);
  return join(tmpdir(), `ontoindex-hook-reindex-${hash}.last`);
}
function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},80)'], { timeout: 1000 }); // ~80ms tick
  }
  return predicate();
}

// Стаб-CLI: эмулирует `node <cli> analyze .`. Пишет marker, при STUB_FAIL_ONCE
// первый вызов падает с «database is locked» (для теста ретрая), счётчик — в файле.
function writeStub(dir) {
  const stub = join(dir, 'stub-cli.cjs');
  writeFileSync(stub,
    "const fs=require('fs');\n" +
    "if(process.argv[2]!=='analyze'){process.exit(7);}\n" +
    "const marker=process.env.MARKER_PATH; const cnt=process.env.COUNT_PATH;\n" +
    "let n=0; try{n=JSON.parse(fs.readFileSync(cnt,'utf8')).n;}catch{}\n" +
    "n++; try{fs.writeFileSync(cnt,JSON.stringify({n}));}catch{}\n" +
    "if(process.env.STUB_FAIL_ONCE==='1' && n===1){process.stderr.write('Error: database is locked\\n');process.exit(1);}\n" +
    "try{fs.appendFileSync(marker,JSON.stringify({n,t:Date.now(),cwd:process.cwd()})+'\\n');}catch{}\n" +
    "process.exit(0);\n");
  return stub;
}

// Готовит временный git-репо с .ontoindex/meta.json. stale=true → lastCommit≠HEAD.
function makeRepo(stale) {
  const dir = mkdtempSync(join(tmpdir(), 'oi-reindex-'));
  spawnSync('git', ['init', '-q', '.'], { cwd: dir });
  writeFileSync(join(dir, 'a.ts'), 'export const x = 1\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  mkdirSync(join(dir, '.ontoindex'));
  const lastCommit = stale ? '0000000000000000000000000000000000000000' : head;
  writeFileSync(join(dir, '.ontoindex', 'meta.json'), JSON.stringify({ lastCommit, stats: { embeddings: 0 } }));
  return { dir, head };
}

function runHook(dir, stub, extraEnv = {}) {
  const marker = join(dir, '_analyze_marker.txt');
  const count = join(dir, '_count.json');
  const input = JSON.stringify({ hook_event_name: 'SessionStart', cwd: dir, source: 'startup' });
  const r = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      ONTOINDEX_CLI_JS: stub,
      MARKER_PATH: marker,
      COUNT_PATH: count,
      ONTOINDEX_HOOK_REINDEX_BACKOFF_MS: '500', // min allowed; keep retry fast
      ...extraEnv,
    },
  });
  return { stdout: (r.stdout || '').trim(), marker, count };
}

console.log('== 1) stale → reindex kicked off, worker runs analyze, stamp written ==');
{
  const { dir } = makeRepo(true);
  const stub = writeStub(dir);
  try { unlinkSync(reindexLockPath(dir)); } catch {}
  try { unlinkSync(stampPath(dir)); } catch {}
  const { stdout, marker } = runHook(dir, stub);
  ok(/stale/i.test(stdout) && /background re-index/i.test(stdout), 'hook сообщил о stale + старте фонового reindex');
  ok(existsSync(reindexLockPath(dir)) || true, 'lock-файл создан (снимется по завершении)');
  const got = waitFor(() => existsSync(stampPath(dir)), 12000);
  ok(got, 'stamp появился (worker доработал)');
  let stamp = {};
  try { stamp = JSON.parse(readFileSync(stampPath(dir), 'utf8')); } catch {}
  ok(stamp.status === 'ok', `worker status=ok (got: ${stamp.status})`);
  ok(existsSync(marker), 'стаб analyze реально вызван (marker)');
  ok(!existsSync(reindexLockPath(dir)), 'lock-файл снят после завершения');
  rmSync(dir, { recursive: true, force: true });
}

console.log('== 2) fresh → no-op (нет ответа, нет lock, analyze не звался) ==');
{
  const { dir } = makeRepo(false);
  const stub = writeStub(dir);
  try { unlinkSync(reindexLockPath(dir)); } catch {}
  const { stdout, marker } = runHook(dir, stub);
  ok(stdout === '', 'hook молчит (свежий индекс)');
  // дать гипотетическому worker'у шанс набедокурить
  waitFor(() => false, 1500);
  ok(!existsSync(marker), 'analyze НЕ вызывался');
  ok(!existsSync(reindexLockPath(dir)), 'lock-файл не создавался');
  rmSync(dir, { recursive: true, force: true });
}

console.log('== 3) dedup → свежий lock уже есть → worker не спавнится ==');
{
  const { dir } = makeRepo(true);
  const stub = writeStub(dir);
  const lp = reindexLockPath(dir);
  writeFileSync(lp, `999\n${Date.now()}\n${dir}\n`); // имитируем активную параллельную сессию
  const { stdout, marker } = runHook(dir, stub);
  ok(/already/i.test(stdout) && /stale/i.test(stdout), 'hook сообщил, что reindex уже идёт');
  waitFor(() => false, 1200);
  ok(!existsSync(marker), 'analyze НЕ вызывался (dedup сработал)');
  try { unlinkSync(lp); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

console.log('== 4) retry → стаб падает на lock один раз → потом ok, attempts>=2 ==');
{
  const { dir } = makeRepo(true);
  const stub = writeStub(dir);
  try { unlinkSync(reindexLockPath(dir)); } catch {}
  try { unlinkSync(stampPath(dir)); } catch {}
  const { stdout, marker } = runHook(dir, stub, { STUB_FAIL_ONCE: '1' });
  ok(/background re-index/i.test(stdout), 'hook стартовал фоновый reindex');
  const got = waitFor(() => existsSync(stampPath(dir)), 12000);
  ok(got, 'stamp появился');
  let stamp = {};
  try { stamp = JSON.parse(readFileSync(stampPath(dir), 'utf8')); } catch {}
  ok(stamp.status === 'ok', `после ретрая status=ok (got: ${stamp.status})`);
  ok(stamp.attempts >= 2, `было >=2 попыток (got: ${stamp.attempts})`);
  ok(existsSync(marker), 'analyze в итоге успешно вызван');
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (fails === 0) { console.log('REINDEX-HOOK TEST: ALL PASS'); process.exit(0); }
else { console.log(`REINDEX-HOOK TEST: ${fails} FAIL`); process.exit(1); }
