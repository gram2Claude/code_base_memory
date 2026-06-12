# CBM: Ревью реализации (двойное) + триаж исправлений

**Дата:** 2026-06-12 · **Ревьюеры:** Claude-субагент (general-purpose, read-only) + codex
(exec read-only). Объект: ветка oleg + установленный движок. Оба нашли пересекающийся набор;
ниже — объединённый триаж с пометкой статуса.

## BLOCKER / MAJOR — исправлено

| # | Находка (источник) | Файл | Исправление | Статус |
|---|---|---|---|---|
| 1 | Augment-хук мёртв на Windows: `spawnSync('ontoindex.cmd')` без shell → EINVAL на Node ≥20.12 (CVE-2024-27980) → PreToolUse никогда не отдаёт контекст (Claude+codex) | `ontoindex-claude-plugin/hooks/ontoindex-hook.js` | На win32 direct-binary путь убран — всегда `node + engineCli`. **Проверено вживую: хук вернул граф-контекст** («2 related symbols found») | ✅ FIXED+TESTED |
| 2 | BOM в JSON-конфигах: PS 5.1 `Out-File -utf8` пишет BOM → риск для парсеров `.mcp.json`/settings (Claude) | `tools/memory_code.ps1` | Все записи через `[IO.File]::WriteAllText` UTF-8 без BOM; чтение через ReadAllText (срезает BOM). **Проверено: BOM=False на всех трёх файлах** | ✅ FIXED+TESTED |
| 3 | F10 не закрыт технически: embedder→huggingface через `retrieval_policy:"symbol-neighborhood"` (Claude); query-log + telemetry без opt-out (codex) | `src/mcp/core/embedder.ts`, `tool-telemetry.ts` (+dist в репо и движке) | Гейт `ONTOINDEX_DISABLE_SEMANTIC=1` бросает до загрузки модели; `ONTOINDEX_TOOL_TELEMETRY=0`/`ONTOINDEX_QUERY_LOG=0`/`HF_HUB_OFFLINE=1` в env MCP-записи. **Проверено: env проставлены в .mcp.json** | ✅ FIXED |
| 4 | `robocopy /MIR` без guard на $EngineDir → риск стереть чужую папку (codex) | `tools/install.ps1` | Guard: путь обязан оканчиваться на `\ontoindex` И быть пустым/нашим (VERSION.txt/структура) | ✅ FIXED |
| 5 | `Resolve-Path`/Remove-Item без -LiteralPath → wildcard-инъекция в путях с `[]*?`, опасно для clear-hard (codex) | `tools/memory_code.ps1` | Везде `-LiteralPath` (Resolve/Test/Move/Remove) | ✅ FIXED |
| 6 | Сигнатура «нашего» хука слишком широкая (`*ontoindex-hook.js*`) → off мог снять чужой плагинный хук (codex) | `tools/memory_code.ps1` | Сужена: `*ontoindex-hook*` И путь содержит `.claude…tools…ontoindex` (наш движок) | ✅ FIXED |
| 7 | Вторая копия хука `ontoindex/hooks/claude/ontoindex-hook.cjs` с npx-фолбэком пропущена CBM-2 (найдено пилотом через граф) | тот же | Заменён на локальный движок идентично плагину | ✅ FIXED (CBM-2 добор) |
| 8 | README обещает `.ontoindexignore`, on его не ставил (Claude+codex) | `tools/memory_code.ps1` | on создаёт шаблон `.ontoindexignore`; смоук-инвариант обновлён | ✅ FIXED |

## MINOR — исправлено

| # | Находка | Исправление |
|---|---|---|
| 9 | Шим `ontoindex.cmd` с развёрнутым путём в ascii ломается на кириллич. username | install.ps1: путь через `%USERPROFILE%` |
| 10 | clear не давал внятную ошибку при DB-lock | try/catch с подсказкой «закрой сессии с MCP» |
| 11 | npm-хинты `npm install -g ontoindex@latest` в analyze.ts | Заменены на `tools\install.ps1 -Prebuilt` (src + оба dist) |
| 12 | argument-hint/Шаг 1 SKILL.md без режима `status` | Добавлен |
| 13 | `.gitignore` двойная запись + перезапись CRLF | append без перезаписи; учёт обоих написаний |

## MINOR/INFO — приняты как осознанные (документированы, не меняем)

- **clear не чистит ~/.ontoindex/registry.json** (только clear --hard): осознанно —
  восстановимость; без индекса запись безвредна. Зафиксировано в SKILL.md и done_criteria-комментарии.
- **t14 (автоактивация в init) и «новая сессия Claude» (t08/t11/t12/t15)** — требуют живой
  новой сессии Claude, недоступной из текущей; помечены partial в отчётах. Технические
  предпосылки (валидные .mcp.json без BOM, смерженные хуки, рабочий augment) проверены.
- **ontoindex-web/, eval/ из среза** — не часть runtime-поставки (вынесено в `_upstream_docs/README`).
- **fetch_engine_bundle.mjs** — dev-скрипт сопровождения (помечен в README).
- **`git status` чистый (t01)** — временные `_tmp_*` промпты ревью удаляются перед коммитом.
- **PostToolUse regex не ловит `git -c/-C`** — апстрим-логика, низкий приоритет, не трогаем.
- **tree-sitter-proto/ontoindex-native не собраны** — optional, JS-путь работает (пилот §6).

## Доп. находка при верификации (исправлена)

**MAJOR · `tools/memory_code.ps1` clear-hard registry-cleanup** — реестр ontoindex это
JSON-МАССИВ, а `ConvertTo-Json` в PS схлопывает одноэлементный массив в объект → после
clear-hard в смоуке глобальный `~/.ontoindex/registry.json` стал объектом, и MCP-сервер
падал с «registry.json must contain an array». Исправлено: round-trip реестра делает node
(сохраняет форму массива), не PS. Реестр восстановлен; повторный semantic-вызов прошёл.

## Повторная проверка после фиксов
- smoke_memory_code.ps1: **22/22 PASS** (+ инварианты .ontoindexignore, BOM-free, env-гейт).
- Реактивация on на этом репо: BOM=False во всех конфигах, 8 env-гейтов проставлены.
- **Augment-хук вживую: возвращает граф-контекст** («2 related symbols found») — major #1 закрыт.
- **Stale-детект (PostToolUse) вживую: сработал на git commit** этой сессии — t11 подтверждён.
- **F10-гейт (unit): `initEmbedder` бросает при ONTOINDEX_DISABLE_SEMANTIC=1** до сети — t04 закрыт технически.
- registry round-trip через node: clear-hard больше не ломает форму массива.
