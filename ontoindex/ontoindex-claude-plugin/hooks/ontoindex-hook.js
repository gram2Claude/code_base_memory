#!/usr/bin/env node
/**
 * OntoIndex Claude Code Plugin Hook
 *
 * PreToolUse  — intercepts Grep/Glob/Bash searches and augments
 *               with graph context from the OntoIndex index.
 * PostToolUse — detects stale index after git mutations / edits and notifies
 *               the agent to reindex.
 * SessionStart — when the index is stale (HEAD ≠ last indexed commit), kicks off
 *               a DETACHED background `analyze` (fire-and-forget) so the NEXT
 *               session opens on a fresh graph. The current session's MCP already
 *               holds the previous snapshot and won't pick up the rewrite.
 *
 * Validated 2026-06-14 (CBM-31): SessionStart hooks DO fire on this Windows
 * machine and Claude Code does NOT reap the hook's detached children — the
 * earlier bug #23576 (freeze) did not reproduce. A synchronous reindex is still
 * unsafe inside a session hook (15s timeout + bug #41577 kills heavy work), hence
 * the detached worker that survives the hook returning exit 0.
 */

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const AUGMENT_TIMEOUT_MS = readIntEnv('ONTOINDEX_HOOK_AUGMENT_TIMEOUT_MS', 2000, 250, 10000);
const AUGMENT_COOLDOWN_MS = readIntEnv('ONTOINDEX_HOOK_AUGMENT_COOLDOWN_MS', 30000, 0, 300000);
const AUGMENT_LOCK_STALE_MS = readIntEnv(
  'ONTOINDEX_HOOK_AUGMENT_LOCK_STALE_MS',
  60000,
  1000,
  300000,
);

// Edit-staleness reminder (Lever 1): after this many countable edits to indexed
// files, and at most once per cooldown, nudge the agent that the graph is stale.
const EDIT_REMINDER_THRESHOLD = readIntEnv('ONTOINDEX_HOOK_EDIT_THRESHOLD', 3, 1, 100);
const EDIT_REMINDER_COOLDOWN_MS = readIntEnv(
  'ONTOINDEX_HOOK_EDIT_COOLDOWN_MS',
  180000,
  30000,
  1800000,
);

// SessionStart auto-reindex (CBM-31): when the graph predates HEAD, spawn a
// DETACHED `analyze` so the NEXT session opens fresh. A cross-session lock file
// prevents two concurrent sessions from reindexing the same repo twice; the
// detached worker retries on DB-lock contention with a linear backoff.
const REINDEX_LOCK_STALE_MS = readIntEnv('ONTOINDEX_HOOK_REINDEX_LOCK_STALE_MS', 900000, 60000, 3600000);
const REINDEX_MAX_ATTEMPTS = readIntEnv('ONTOINDEX_HOOK_REINDEX_MAX_ATTEMPTS', 5, 1, 20);
const REINDEX_BACKOFF_MS = readIntEnv('ONTOINDEX_HOOK_REINDEX_BACKOFF_MS', 5000, 500, 60000);
const REINDEX_WORKER_TIMEOUT_MS = readIntEnv('ONTOINDEX_HOOK_REINDEX_TIMEOUT_MS', 300000, 30000, 1800000);

function readIntEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

/**
 * Read JSON input from stdin synchronously.
 */
function readInput() {
  try {
    const data = fs.readFileSync(0, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Find the .ontoindex directory by walking up from startDir.
 * Returns the path to .ontoindex/ or null if not found.
 */
function findOntoIndexDir(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.ontoindex');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Extract search pattern from tool input.
 */
function extractPattern(toolName, toolInput) {
  if (toolName === 'Grep') {
    return toolInput.pattern || null;
  }

  if (toolName === 'Glob') {
    const raw = toolInput.pattern || '';
    const match = raw.match(/[*\/]([a-zA-Z][a-zA-Z0-9_-]{2,})/);
    return match ? match[1] : null;
  }

  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;

    const tokens = cmd.split(/\s+/);
    let foundCmd = false;
    let skipNext = false;
    const flagsWithValues = new Set([
      '-e',
      '-f',
      '-m',
      '-A',
      '-B',
      '-C',
      '-g',
      '--glob',
      '-t',
      '--type',
      '--include',
      '--exclude',
    ]);

    for (const token of tokens) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (!foundCmd) {
        if (/\brg$|\bgrep$/.test(token)) foundCmd = true;
        continue;
      }
      if (token.startsWith('-')) {
        if (flagsWithValues.has(token)) skipNext = true;
        continue;
      }
      const cleaned = token.replace(/['"]/g, '');
      return cleaned.length >= 3 ? cleaned : null;
    }
    return null;
  }

  return null;
}

function normalizePattern(pattern) {
  if (typeof pattern !== 'string') return null;
  const trimmed = pattern.trim();
  if (trimmed.length < 3 || trimmed.length > 120) return null;
  if (/[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function augmentPaths(cwd, pattern) {
  const hash = crypto.createHash('sha256').update(`${cwd}\0${pattern}`).digest('hex').slice(0, 24);
  const base = path.join(os.tmpdir(), `ontoindex-hook-augment-${hash}`);
  return { lockPath: `${base}.lock`, stampPath: `${base}.stamp` };
}

function beginAugment(cwd, pattern) {
  if (process.env.ONTOINDEX_HOOK_AUGMENT === '0') return null;
  const now = Date.now();
  const paths = augmentPaths(cwd, pattern);

  try {
    const stamp = fs.statSync(paths.stampPath);
    if (now - stamp.mtimeMs < AUGMENT_COOLDOWN_MS) return null;
  } catch {
    /* no recent cooldown stamp */
  }

  try {
    const lock = fs.statSync(paths.lockPath);
    if (now - lock.mtimeMs < AUGMENT_LOCK_STALE_MS) return null;
    fs.unlinkSync(paths.lockPath);
  } catch (err) {
    if (err && err.code !== 'ENOENT') return null;
  }

  try {
    const fd = fs.openSync(paths.lockPath, 'wx');
    try {
      fs.writeFileSync(fd, `${process.pid}\n${now}\n${cwd}\n${pattern.slice(0, 120)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return paths;
  } catch {
    return null;
  }
}

function finishAugment(paths) {
  if (!paths) return;
  try {
    fs.writeFileSync(paths.stampPath, `${process.pid}\n${Date.now()}\n`);
  } catch {
    /* best effort */
  }
  try {
    fs.unlinkSync(paths.lockPath);
  } catch {
    /* best effort */
  }
}

/**
 * Spawn a ontoindex CLI command synchronously.
 * Detects binary on PATH once, then runs exactly once.
 *
 * SECURITY: Never use shell: true with user-controlled arguments.
 * On Windows, invoke ontoindex.cmd directly (no shell needed).
 */
function runOntoIndexCli(args, cwd, timeout, opts = {}) {
  const isWin = process.platform === 'win32';
  // opts (additive) lets the SessionStart reindex worker raise maxBuffer and
  // drop stdout — a long `analyze` can emit >1MB and would otherwise trip the
  // default maxBuffer and look like a failure. Default behaviour unchanged.
  const spawnOpts = { encoding: 'utf-8', timeout, cwd, stdio: ['pipe', 'pipe', 'pipe'], ...opts };

  // CBM review fix (major #1): на Windows НЕ зовём ontoindex.cmd напрямую —
  // spawnSync('.cmd') без shell на Node >=20.12/24 возвращает EINVAL
  // (фикс CVE-2024-27980), и хук молча умирал. Везде, где можно, идём через
  // node + js-движок; PATH-бинарь используем только вне Windows.
  if (!isWin) {
    let useDirectBinary = false;
    try {
      const which = spawnSync('which', ['ontoindex'], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      useDirectBinary = which.status === 0;
    } catch {
      /* not on PATH */
    }
    if (useDirectBinary) {
      return spawnSync('ontoindex', args, spawnOpts);
    }
  }
  // CBM-2: network npx fallback removed — fall back to the vendored local
  // engine (ONTOINDEX_CLI_JS overrides; default: ~/.claude/tools/ontoindex).
  const engineCli =
    process.env.ONTOINDEX_CLI_JS ||
    path.join(
      os.homedir(),
      '.claude',
      'tools',
      'ontoindex',
      'ontoindex',
      'dist',
      'cli',
      'index.js',
    );
  if (!fs.existsSync(engineCli)) {
    return { status: 1, stdout: '', stderr: `ontoindex engine not found: ${engineCli}` };
  }
  return spawnSync(process.execPath, [engineCli, ...args], spawnOpts);
}

/**
 * Emit a hook response with additional context for the agent.
 */
function sendHookResponse(hookEventName, message) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext: message },
    }),
  );
}

/**
 * PreToolUse handler — augment searches with graph context.
 */
function handlePreToolUse(input) {
  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;
  if (!findOntoIndexDir(cwd)) return;

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  if (toolName !== 'Grep' && toolName !== 'Glob' && toolName !== 'Bash') return;

  const pattern = normalizePattern(extractPattern(toolName, toolInput));
  if (!pattern) return;

  const augmentLease = beginAugment(cwd, pattern);
  if (!augmentLease) return;

  let result = '';
  try {
    const child = runOntoIndexCli(['augment', '--', pattern], cwd, AUGMENT_TIMEOUT_MS);
    if (!child.error && child.status === 0) {
      result = child.stderr || '';
    }
  } catch {
    /* graceful failure */
  } finally {
    finishAugment(augmentLease);
  }

  if (result && result.trim()) {
    sendHookResponse('PreToolUse', result.trim());
  }
}

/**
 * PostToolUse dispatcher.
 *  - Bash (git mutation)      → staleness check vs last indexed commit.
 *  - Edit/Write/MultiEdit     → in-session edit-staleness reminder (Lever 1).
 */
function handlePostToolUse(input) {
  const toolName = input.tool_name || '';
  if (toolName === 'Bash') {
    handleGitMutation(input);
    return;
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    handleEditMutation(input);
  }
}

function editStatePath(repoRoot) {
  const hash = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), `ontoindex-hook-edits-${hash}.json`);
}

function readEditState(statePath) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return {
      count: Number.isFinite(s.count) ? s.count : 0,
      lastReminderMs: Number.isFinite(s.lastReminderMs) ? s.lastReminderMs : 0,
    };
  } catch {
    return { count: 0, lastReminderMs: 0 };
  }
}

function writeEditState(statePath, state) {
  try {
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch {
    /* best effort */
  }
}

// Editing these areas does not change the code graph — don't count them.
const EDIT_SKIP_RE = /[\\/](\.ontoindex|\.trash|\.git|node_modules|dist|\.history)[\\/]/i;

/**
 * Edit/Write/MultiEdit handler — track edits to indexed files and (debounced)
 * remind that the graph predates them. In-session reindex is impossible (the
 * MCP holds the LadybugDB write-lock), so the actionable advice is: for files
 * edited this session trust the file over the graph, and reindex next session.
 */
function handleEditMutation(input) {
  if (process.env.ONTOINDEX_HOOK_EDIT_REMINDER === '0') return;

  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;
  const ontoIndexDir = findOntoIndexDir(cwd);
  if (!ontoIndexDir) return;
  const repoRoot = path.dirname(ontoIndexDir);

  const filePath = (input.tool_input || {}).file_path || '';
  if (!filePath || !path.isAbsolute(filePath)) return;
  const rel = path.relative(repoRoot, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return; // outside the indexed repo
  if (EDIT_SKIP_RE.test(filePath)) return;

  const now = Date.now();
  const statePath = editStatePath(repoRoot);
  const state = readEditState(statePath);
  state.count += 1;

  if (state.count < EDIT_REMINDER_THRESHOLD || now - state.lastReminderMs < EDIT_REMINDER_COOLDOWN_MS) {
    writeEditState(statePath, state);
    return;
  }

  let lastCommit = '';
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ontoIndexDir, 'meta.json'), 'utf-8'));
    lastCommit = meta.lastCommit || '';
  } catch {
    /* no meta — omit commit hint */
  }

  const edited = state.count;
  writeEditState(statePath, { count: 0, lastReminderMs: now });

  sendHookResponse(
    'PostToolUse',
    `OntoIndex: ${edited} file edit(s) since the last index` +
      `${lastCommit ? ` (indexed at ${lastCommit.slice(0, 7)})` : ''}. ` +
      'The code graph (impact/search/inspect/gn_*) does NOT reflect these edits — ' +
      'for files changed this session trust the file contents over the graph. ' +
      'Re-index before the next session: run `/memory_code_active update`.',
  );
}

/**
 * Bash/git handler — detect index staleness after git mutations.
 *
 * Instead of spawning a full `ontoindex analyze` synchronously (which blocks
 * the agent for up to 120s and risks LadybugDB corruption on timeout), we do a
 * lightweight staleness check: compare `git rev-parse HEAD` against the
 * lastCommit stored in `.ontoindex/meta.json`. If they differ, notify the
 * agent so it can decide when to reindex.
 */
function handleGitMutation(input) {
  const command = (input.tool_input || {}).command || '';
  if (!/\bgit\s+(commit|merge|rebase|cherry-pick|pull)(\s|$)/.test(command)) return;

  // Only proceed if the command succeeded
  const toolOutput = input.tool_output || {};
  if (toolOutput.exit_code !== undefined && toolOutput.exit_code !== 0) return;

  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;
  const ontoIndexDir = findOntoIndexDir(cwd);
  if (!ontoIndexDir) return;

  // Compare HEAD against last indexed commit — skip if unchanged
  let currentHead = '';
  try {
    const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 3000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    currentHead = (headResult.stdout || '').trim();
  } catch {
    return;
  }

  if (!currentHead) return;

  let lastCommit = '';
  let hadEmbeddings = false;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ontoIndexDir, 'meta.json'), 'utf-8'));
    lastCommit = meta.lastCommit || '';
    hadEmbeddings = meta.stats && meta.stats.embeddings > 0;
  } catch {
    /* no meta — treat as stale */
  }

  // If HEAD matches last indexed commit, no reindex needed
  if (currentHead && currentHead === lastCommit) return;

  const analyzeCmd = `ontoindex analyze${hadEmbeddings ? ' --embeddings' : ''}`;
  sendHookResponse(
    'PostToolUse',
    `OntoIndex index is stale (last indexed: ${lastCommit ? lastCommit.slice(0, 7) : 'never'}). ` +
      `Run \`${analyzeCmd}\` to update the knowledge graph.`,
  );
}

/**
 * SessionStart handler — auto-reindex on a stale graph (CBM-31).
 *
 * Cheap staleness check (HEAD vs meta.lastCommit, identical to handleGitMutation).
 * If stale, kick off a DETACHED `analyze` and return immediately so session start
 * is never blocked (a synchronous reindex would hit the hook timeout and bug
 * #41577). The rebuilt graph lands in the NEXT session: this session's MCP already
 * holds the previous snapshot and will not pick up the on-disk rewrite. Lever 1
 * (in-session edit reminder) therefore stays — it covers what this cannot.
 */
function handleSessionStart(input) {
  if (process.env.ONTOINDEX_HOOK_SESSIONSTART_REINDEX === '0') return;

  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;
  const ontoIndexDir = findOntoIndexDir(cwd);
  if (!ontoIndexDir) return;
  const repoRoot = path.dirname(ontoIndexDir);

  let currentHead = '';
  try {
    const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 3000,
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    currentHead = (headResult.stdout || '').trim();
  } catch {
    return;
  }
  if (!currentHead) return;

  let lastCommit = '';
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(ontoIndexDir, 'meta.json'), 'utf-8'));
    lastCommit = meta.lastCommit || '';
  } catch {
    /* no meta — treat as stale */
  }

  if (currentHead && currentHead === lastCommit) return; // fresh — nothing to do

  const spawned = spawnDetachedReindex(repoRoot);
  const indexedAt = lastCommit ? lastCommit.slice(0, 7) : 'never';

  if (spawned) {
    sendHookResponse(
      'SessionStart',
      `OntoIndex: code graph was stale (indexed ${indexedAt}, HEAD ${currentHead.slice(0, 7)}). ` +
        'A background re-index has been started; it will be ready in the NEXT session. ' +
        'For THIS session the graph still reflects the previous index — trust file ' +
        'contents over the graph (impact/search/inspect/gn_*) for anything changed since.',
    );
  } else {
    sendHookResponse(
      'SessionStart',
      `OntoIndex: code graph is stale (indexed ${indexedAt}). A re-index is already ` +
        'running (another session) or will run next session. If it persists, run ' +
        '`/memory_code_active update`.',
    );
  }
}

function reindexLockPath(repoRoot) {
  const hash = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), `ontoindex-hook-reindex-${hash}.lock`);
}

/**
 * Acquire a cross-session lock and spawn the detached reindex worker.
 * Returns true if THIS call started a reindex, false if another session already
 * holds a fresh lock (dedup) or the spawn failed.
 */
function spawnDetachedReindex(repoRoot) {
  const lockPath = reindexLockPath(repoRoot);
  const now = Date.now();

  try {
    const lock = fs.statSync(lockPath);
    if (now - lock.mtimeMs < REINDEX_LOCK_STALE_MS) return false; // another session is on it
    fs.unlinkSync(lockPath); // stale — steal it
  } catch (err) {
    if (err && err.code !== 'ENOENT') return false;
  }

  try {
    const fd = fs.openSync(lockPath, 'wx'); // atomic create — loses race => throws
    try {
      fs.writeFileSync(fd, `${process.pid}\n${now}\n${repoRoot}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false; // lost the race to a concurrent session
  }

  try {
    // Re-invoke THIS file in worker mode, detached + unref'd so it outlives the
    // hook's exit 0. Re-assert the offline/no-telemetry gates (the worker does
    // not inherit the MCP server's .mcp.json env) — defense in depth (F10).
    const child = spawn(
      process.execPath,
      [__filename, '--reindex-worker', repoRoot, lockPath],
      {
        detached: true,
        stdio: 'ignore',
        cwd: repoRoot,
        env: {
          ...process.env,
          ONTOINDEX_DISABLE_SEMANTIC: '1',
          ONTOINDEX_TOOL_TELEMETRY: '0',
          ONTOINDEX_QUERY_LOG: '0',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
        },
      },
    );
    child.unref();
    return true;
  } catch {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
    return false;
  }
}

/**
 * Detached worker entry — runs `analyze .` (never --embeddings: semantic mode is
 * gated, F10), retrying ONLY on DB-lock contention with a linear backoff, then
 * releases the cross-session lock. Runs in its own process (unref'd from the
 * SessionStart hook) so it survives the hook returning exit 0.
 */
function runReindexWorker(repoRoot, lockPath) {
  let status = 'failed';
  let attempts = 0;
  try {
    for (let attempt = 1; attempt <= REINDEX_MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      const r = runOntoIndexCli(['analyze', '.'], repoRoot, REINDEX_WORKER_TIMEOUT_MS, {
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      if (!r.error && r.status === 0) {
        status = 'ok';
        break;
      }
      const out = `${r.stderr || ''}${r.error ? ` ${r.error.message}` : ''}`;
      const lockBusy = /lock|EBUSY|in use|database is locked|LadybugDB/i.test(out);
      if (!lockBusy || attempt === REINDEX_MAX_ATTEMPTS) {
        status = lockBusy ? 'lock-timeout' : 'failed';
        break;
      }
      sleepSync(REINDEX_BACKOFF_MS * attempt); // linear backoff
    }
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
    writeReindexStamp(repoRoot, status, attempts);
  }
}

/** Block the current (detached) process for ms without burning CPU. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* fallback busy-wait if SharedArrayBuffer is unavailable */
    }
  }
}

/** Best-effort last-run stamp (tmpdir) so a background reindex can be observed. */
function writeReindexStamp(repoRoot, status, attempts) {
  try {
    const hash = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 24);
    fs.writeFileSync(
      path.join(os.tmpdir(), `ontoindex-hook-reindex-${hash}.last`),
      JSON.stringify({ pid: process.pid, t: Date.now(), iso: new Date().toISOString(), status, attempts }),
    );
  } catch {
    /* best effort */
  }
}

// Dispatch map for hook events
const handlers = {
  PreToolUse: handlePreToolUse,
  PostToolUse: handlePostToolUse,
  SessionStart: handleSessionStart,
};

function main() {
  try {
    const input = readInput();
    const handler = handlers[input.hook_event_name || ''];
    if (handler) handler(input);
  } catch (err) {
    if (process.env.ONTOINDEX_DEBUG) {
      console.error('OntoIndex hook error:', (err.message || '').slice(0, 200));
    }
  }
}

// Detached-worker mode: `node ontoindex-hook.js --reindex-worker <repoRoot> <lockPath>`.
// Spawned (detached) by handleSessionStart; runs the background reindex instead of
// reading a hook event from stdin. Normal hook invocation has no extra argv → main().
if (process.argv[2] === '--reindex-worker') {
  runReindexWorker(process.argv[3], process.argv[4]);
} else {
  main();
}
