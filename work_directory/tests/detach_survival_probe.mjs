#!/usr/bin/env node
// detach_survival_probe.mjs — ЭКСПЕРИМЕНТ: переживает ли detached-ребёнок СМЕРТЬ родителя?
// Имитация хука: launcher спавнит worker через spawn(detached:true)+unref() и СРАЗУ exit 0.
// worker спит ~20с и пишет stamp. Если stamp появился ПОСЛЕ выхода launcher и launcher уже
// мёртв — значит OS/Node-detach на этой машине работает (необходимое условие для авто-reindex).
//
// ВНИМАНИЕ: это проверяет только OS/Node-механизм, НЕ teardown самого Claude Code.
// Запуск: node work_directory/tests/detach_survival_probe.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SLEEP_MS = 20000;
const dir = mkdtempSync(join(tmpdir(), 'oi-detach-'));

// worker.cjs — спит SLEEP_MS, потом пишет worker-done.json + проверяет, жив ли родитель
writeFileSync(join(dir, 'worker.cjs'),
  "const fs=require('fs');const path=require('path');\n" +
  "const dir=process.argv[2];const ppid=process.ppid;\n" +
  "fs.writeFileSync(path.join(dir,'worker-started.json'),JSON.stringify({pid:process.pid,ppid:ppid,t:Date.now()}));\n" +
  "setTimeout(function(){\n" +
  "  var alive=false; try{process.kill(ppid,0);alive=true;}catch(e){}\n" +
  "  fs.writeFileSync(path.join(dir,'worker-done.json'),JSON.stringify({pid:process.pid,ppid:ppid,t:Date.now(),parentAlive:alive}));\n" +
  "}," + SLEEP_MS + ");\n");

// launcher.cjs — имитация хука: detached-спавн worker + unref + НЕМЕДЛЕННЫЙ exit 0
writeFileSync(join(dir, 'launcher.cjs'),
  "const cp=require('child_process');const path=require('path');\n" +
  "const dir=process.argv[2];\n" +
  "const child=cp.spawn(process.execPath,[path.join(dir,'worker.cjs'),dir],{detached:true,stdio:'ignore'});\n" +
  "child.unref();\n" +
  "process.stdout.write(JSON.stringify({launcherPid:process.pid,childPid:child.pid,t:Date.now()}));\n" +
  "process.exit(0);\n");

console.log('== launcher спавнит detached-worker и сразу выходит ==');
const t0 = Date.now();
const r = spawnSync(process.execPath, [join(dir, 'launcher.cjs'), dir], { encoding: 'utf8', timeout: 15000 });
const launcherExit = Date.now();
let info = {};
try { info = JSON.parse((r.stdout || '').trim()); } catch {}
console.log('launcher stdout :', (r.stdout || '').trim());
console.log('launcher exit   :', r.status, `(+${launcherExit - t0}ms)`);
console.log('launcherPid', info.launcherPid, '| childPid (worker)', info.childPid);

// сразу после выхода launcher: жив ли он? (должен быть уже мёртв)
let launcherAliveNow = false;
if (info.launcherPid) { try { process.kill(info.launcherPid, 0); launcherAliveNow = true; } catch {} }
console.log('launcher жив сразу после spawnSync:', launcherAliveNow, '(ожидаем false)');

const startedPath = join(dir, 'worker-started.json');
const donePath = join(dir, 'worker-done.json');
console.log(`\n== жду worker-done (worker спит ${SLEEP_MS / 1000}с)... ==`);
const deadline = Date.now() + SLEEP_MS + 12000;
let done = null;
while (Date.now() < deadline) {
  if (existsSync(donePath)) { done = JSON.parse(readFileSync(donePath, 'utf8')); break; }
  await new Promise((res) => setTimeout(res, 500));
}
const started = existsSync(startedPath) ? JSON.parse(readFileSync(startedPath, 'utf8')) : null;

console.log('\n===== VERDICT =====');
console.log('worker стартовал (started stamp):', !!started);
if (!done) {
  console.log('worker-done stamp НЕ появился → detached-ребёнок НЕ пережил выход родителя (или слишком медленно).');
  console.log('\nИТОГ: detached-выживание НЕ подтверждено. Схема detached-reindex на этой машине под вопросом.');
} else {
  const afterExit = done.t > launcherExit;
  console.log('worker дописал done   : +' + (done.t - t0) + 'ms');
  console.log('launcher вышел        : +' + (launcherExit - t0) + 'ms');
  console.log('worker завершился ПОСЛЕ выхода launcher:', afterExit);
  console.log('родитель (launcher) был мёртв, когда worker финишировал:', done.parentAlive === false);
  if (afterExit && done.parentAlive === false) {
    console.log('\nИТОГ: detached-ребёнок ПЕРЕЖИЛ смерть родителя и доработал ~' + (SLEEP_MS / 1000) + 'с спустя.');
    console.log('      → OS/Node-detach на этой машине РАБОТАЕТ (необходимое условие выполнено).');
    console.log('      Остаётся проверить teardown самого Claude Code реальным хуком (runbook).');
  } else {
    console.log('\nИТОГ: неоднозначно — см. поля выше.');
  }
}

rmSync(dir, { recursive: true, force: true });
