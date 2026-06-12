---
name: memory_code_active
description: >
  Управление КОДОВОЙ памятью проекта (Слой «код», граф-индекс ontoindex): подключить /
  отключить / очистить / обновить. Режимы: on — построить локальный граф-индекс .ontoindex/,
  зарегистрировать MCP-сервер ontoindex (stdio, read-only) в .mcp.json проекта, поставить
  хуки (augment + stale-детект) и инструкции для Claude; off — снять MCP/хуки/инструкции,
  индекс сохранить; clear — мягко убрать индекс в .trash (восстановимо); clear --hard —
  удалить окончательно (с подтверждением); update — переиндексация. Запускать в корне проекта.
  Триггеры: «подключить кодовую память», «memory_code_active», «memory code on»,
  «отключить кодовую память», «очистить кодовую память», «обнови индекс кода».
argument-hint: "[on|off|clear [--hard]|update]"
---

# /memory_code_active

Подключает / снимает / чистит **кодовую память проекта** — локальный графовый индекс кодовой
базы (вендоренный ontoindex: Tree-sitter → LadybugDB → MCP). Третий слой в линейке памятей:
`memory_short_active` (краткосрочная) · `memory_long_active` (долгосрочная Wiki-LLM) ·
**`memory_code_active` (структура кода)**.

Движок: `~/.claude/tools/ontoindex/` (вендоренный срез b373fdf с security-патчами CBM;
устанавливается `install.ps1` из репо gram2Claude/code_base_memory). Безопасность: ревью
`work_directory/05_security/00_ontoindex_security_review.md` того же репо — MCP только stdio,
БЕЗ `--confirm-writes` (read-only), без LLM-ключей, без семантического режима (HF-офлайн, F10).

## Переменные
- `PROJECT` = корень текущего проекта (cwd).
- `ENGINE` = `C:\Users\Oleg\.claude\tools\ontoindex` (переопределяется `$env:ONTOINDEX_HOME`).
- `CLI` = `node "<ENGINE>\ontoindex\dist\cli\index.js"`.
- `MC` = `powershell -ExecutionPolicy Bypass -File "<ENGINE>\skill\memory_code.ps1"` —
  **детерминированный движок режимов** (все файловые операции делает ОН, не правь JSON руками).

## Шаг 1 — разобрать аргумент
- (пусто) или `on` → **on**; `off` → **off**; `clear` → **clear**; `clear --hard` → **clear --hard**; `update` → **update**.

## Шаг 2 — выполнить (через движок `MC`; ниже — что он делает и что проверить)

### on — подключить (идемпотентно; существующее не ломать)

0. **Доверие:** индексируем только доверенные репозитории (свой код / прошедший ревью) — F5.
   Движка нет (`<ENGINE>\ontoindex\dist\cli\index.js` отсутствует) → сказать «движок не
   установлен — запусти tools\install.ps1 из репо code_base_memory» и ОСТАНОВИТЬСЯ.
1. Выполнить: `<MC> -Mode on -Project "<PROJECT>"`.
   Движок сделает: индекс `.ontoindex/` (`analyze` БЕЗ `--embeddings` — F10); merge записи
   `mcpServers.ontoindex` в `.mcp.json` (stdio, read-only, БЕЗ `--confirm-writes`, env
   ONTOINDEX_MCP_PROJECT_CWD/REPO); merge хуков augment (PreToolUse: Grep|Glob|Bash) и
   stale-детект (PostToolUse: Bash) в `.claude/settings.json` БЕЗ затирания чужих хуков;
   блок MEMORY_CODE в CLAUDE.md (маркеры); `.ontoindex/` в .gitignore.
2. Проверить вывод `ON: ...` и сказать: «Кодовая память подключена. Работает в НОВОЙ сессии
   Claude. После крупных правок/merge — /memory_code_active update».

### off — отключить (индекс сохранить; идемпотентно)

1. Выполнить: `<MC> -Mode off -Project "<PROJECT>"` — снимет ТОЛЬКО наш MCP-сервер, наши
   хуки (фильтр `ontoindex-hook.js`) и блок MEMORY_CODE; чужое не тронет. `.ontoindex/` и
   запись в `~/.ontoindex/registry.json` сохраняются (re-on дёшев).
2. Сказать: «Кодовая память отключена, индекс сохранён — повторное подключение без переиндексации».

### clear — мягкая очистка (восстановимо)

1. Выполнить: `<MC> -Mode clear -Project "<PROJECT>"` (off + перенос `.ontoindex/` в
   `.trash\memory_code\<метка>`).
2. Сказать: «Индекс убран в .trash (восстановимо)».

### clear --hard — окончательное удаление

1. **СПРОСИТЬ подтверждение**: «Удалить индекс кодовой памяти БЕЗВОЗВРАТНО (вкл. .trash и
   запись в глобальном реестре)? да/нет». Без явного «да» — стоп.
2. Выполнить: `<MC> -Mode clear-hard -Project "<PROJECT>" -Force` (off + удаление индекса,
   .trash и записи в `~/.ontoindex/registry.json`).

### update — переиндексация

1. Если открыты сессии Claude с MCP ontoindex этого проекта — предупредить про DB-lock
   LadybugDB (закрыть сессии; апстрим: «Stop MCP processes first»).
2. Выполнить: `<MC> -Mode update -Project "<PROJECT>"`. Ошибка lock → сказать «закрой
   сессии с MCP и повтори», индекс не тронут.
3. Сказать: «Индекс обновлён. Новые сессии видят актуальный граф».

### status — диагностика

`<MC> -Mode status -Project "<PROJECT>"` → JSON {index, mcp, hooks, claudemd}.

## Шаблон инструкций для CLAUDE.md проекта

Канонический текст блока — `<ENGINE>\skill\claude_block.md` (ставится install.ps1 из
`tools/templates/claude_block.md` репо code_base_memory); движок вставляет его между
маркерами `<!-- MEMORY_CODE:BEGIN -->` / `<!-- MEMORY_CODE:END -->`.

## Сосуществование памятей

on/off правят ТОЛЬКО: запись `mcpServers.ontoindex`, хуки с `ontoindex-hook.js`, блок
MEMORY_CODE в CLAUDE.md, строку `.ontoindex/` в .gitignore. Всё остальное (хуки
memory-compiler, команды /ingest /query /lint, memory_long) — неприкосновенно.
