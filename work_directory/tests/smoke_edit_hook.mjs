// smoke_edit_hook.mjs — регрессионный смоук PostToolUse-хука кодовой памяти (CBM-28).
// Проверяет БЕЗ движка/MCP, чисто на уровне ontoindex-hook.js:
//   Lever 1 — edit-staleness: правки Edit/Write копятся, после порога (с кулдауном)
//             хук вбрасывает напоминание; off-switch ONTOINDEX_HOOK_EDIT_REMINDER=0 глушит;
//             правки вне репо / в .git|node_modules|.ontoindex не считаются.
//   Git-staleness: после git commit при HEAD != meta.lastCommit хук напоминает про reindex.
// Запуск: node work_directory/tests/smoke_edit_hook.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'ontoindex',
  'ontoindex-claude-plugin',
  'hooks',
  'ontoindex-hook.js',
);

let fails = 0;
function assert(cond, name) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}`);
    fails += 1;
  }
}

// Прогон хука: подаём JSON в stdin, возвращаем additionalContext (или '').
function runHook(payload, env = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  const out = (res.stdout || '').trim();
  if (!out) return '';
  try {
    return JSON.parse(out).hookSpecificOutput?.additionalContext || '';
  } catch {
    return out;
  }
}

function editStatePath(repoRoot) {
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 24);
  return join(tmpdir(), `ontoindex-hook-edits-${hash}.json`);
}

function editPayload(repoRoot, file) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    cwd: repoRoot,
    tool_input: { file_path: join(repoRoot, file) },
  };
}

const repo = mkdtempSync(join(tmpdir(), 'mc_hook_'));
try {
  mkdirSync(join(repo, '.ontoindex'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, '.ontoindex', 'meta.json'), JSON.stringify({ lastCommit: 'abc1234deadbeef' }));
  // чистый старт счётчика правок для этого repoRoot
  const stamp = editStatePath(repo);
  if (existsSync(stamp)) unlinkSync(stamp);

  // --- Lever 1: порог (THRESHOLD=3) ---
  const e1 = runHook(editPayload(repo, 'src/a.ts'));
  const e2 = runHook(editPayload(repo, 'src/b.ts'));
  assert(e1 === '' && e2 === '', 'edit: правки 1-2 ниже порога — тихо');
  const e3 = runHook(editPayload(repo, 'src/c.ts'));
  assert(/file edit\(s\)/.test(e3), 'edit: правка 3 (порог) — напоминание');
  assert(/abc1234/.test(e3), 'edit: в напоминании есть последний индексированный коммит');

  // --- кулдаун: сразу после напоминания снова тихо (счётчик сброшен) ---
  const e4 = runHook(editPayload(repo, 'src/d.ts'));
  const e5 = runHook(editPayload(repo, 'src/e.ts'));
  const e6 = runHook(editPayload(repo, 'src/f.ts'));
  assert(e4 === '' && e5 === '' && e6 === '', 'edit: в окне кулдауна повторно не шумит');

  // --- off-switch ---
  if (existsSync(stamp)) unlinkSync(stamp);
  const offs = [1, 2, 3, 4].map(() =>
    runHook(editPayload(repo, 'src/x.ts'), { ONTOINDEX_HOOK_EDIT_REMINDER: '0' }),
  );
  assert(offs.every((o) => o === ''), 'edit: ONTOINDEX_HOOK_EDIT_REMINDER=0 глушит');

  // --- правки вне репо / в служебных каталогах не считаются ---
  if (existsSync(stamp)) unlinkSync(stamp);
  const skipPayloads = [
    { ...editPayload(repo, 'node_modules/p/index.js') },
    { ...editPayload(repo, '.git/COMMIT_EDITMSG') },
    { ...editPayload(repo, '.ontoindex/meta.json') },
  ];
  const skipped = skipPayloads.map((p) => runHook(p));
  // плюс одна реальная правка — счётчик должен быть 1, не 4 → тихо (порог 3)
  const afterSkips = runHook(editPayload(repo, 'src/real.ts'));
  assert(skipped.every((s) => s === '') && afterSkips === '', 'edit: служебные пути не инкрементят счётчик');

  // --- git-staleness: HEAD != meta.lastCommit → напоминание про reindex ---
  const gi = spawnSync('git', ['init', '-q', repo], { encoding: 'utf-8' });
  spawnSync('git', ['-C', repo, 'add', '-A'], { encoding: 'utf-8' });
  spawnSync(
    'git',
    ['-C', repo, '-c', 'user.email=smoke@local', '-c', 'user.name=smoke', 'commit', '-qm', 'init'],
    { encoding: 'utf-8' },
  );
  const gitOut = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    cwd: repo,
    tool_input: { command: 'git commit -m x' },
    tool_output: { exit_code: 0 },
  });
  assert(gi.status === 0 && /stale/i.test(gitOut), 'git: commit при stale-индексе → напоминание');
} finally {
  rmSync(repo, { recursive: true, force: true });
  const stamp = editStatePath(repo);
  if (existsSync(stamp)) unlinkSync(stamp);
}

console.log('');
if (fails === 0) {
  console.log('EDIT-HOOK SMOKE: ALL PASS');
  process.exit(0);
} else {
  console.log(`EDIT-HOOK SMOKE: FAILED (${fails})`);
  process.exit(1);
}
