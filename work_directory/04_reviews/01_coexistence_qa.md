# CBM-16: QA сосуществования трёх памятей (short / long / code)

**Дата:** 2026-06-12 · **Статус:** часть 1 (скриптовая) — PASS; часть 2 (живой проект) — см. пилот CBM-23.

## Матрица владения файлами (кто что трогает)

| Артефакт | memory_short | memory_long | memory_code |
|---|---|---|---|
| `.claude/settings.json` hooks | SessionStart/SessionEnd/PreCompact/Stop (memory-compiler) | — | PreToolUse (Grep\|Glob\|Bash), PostToolUse (Bash) — только записи с `ontoindex-hook.js` |
| `.claude/commands/` | — | /ingest /query /lint (+ ingest-split) | — |
| `.claude/memory_short/` | данные | — | — |
| `.claude/memory_long/` | — | данные (SCHEMA/raw/wiki) | — |
| `.ontoindex/` | — | — | индекс (gitignored) |
| `.mcp.json` | — | — | только запись `mcpServers.ontoindex` |
| `CLAUDE.md` | — | — | только блок `MEMORY_CODE:BEGIN/END` |
| `.gitignore` | строки memory_short | строки memory_long (_private/_large) | строка `.ontoindex/` |

Пересечение записи РОВНО ОДНО: `.claude/settings.json` (hooks) — short и code пишут в РАЗНЫЕ
события; движок memory_code делает merge по массивам и фильтрует ТОЛЬКО свои записи
(сигнатура `ontoindex-hook.js`), short-хуки не модифицируются.

## Часть 1 — скриптовая проверка (smoke_memory_code.ps1, 18 проверок)

Прогон 2026-06-12: **ALL PASS**. Ключевые для сосуществования:
- `on: PreToolUse = чужой + наш` — добавление БЕЗ затирания существующего PreToolUse-хука;
- `on: чужой SessionStart жив` — события short-памяти не тронуты;
- `on x2: хуки не задвоились`, `блок один` — идемпотентность;
- `off: наш хук снят, чужой жив` — выборочное снятие по сигнатуре;
- `off x2: не упал` — идемпотентность off.

## Часть 2 — живой проект с тремя памятями (пилот CBM-23, этот репо)

Этот репозиторий уже имеет short (4 хука memory-compiler) и long (memory_long + команды).
Чек-лист при активации code-памяти:
- [ ] `memory_code on` сохранил 4 хука memory-compiler в settings.json
- [ ] `/ingest /query /lint` остались на месте
- [ ] `.gitignore`: строки всех трёх памятей присутствуют, без дублей
- [ ] Новая сессия Claude стартует без ошибок хуков (SessionStart short + PreToolUse code)
- [ ] MCP ontoindex отвечает в новой сессии
(результаты — в отчёте пилота `02_pilot_report.md`)
