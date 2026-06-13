# code_base_memory — кодовая память для Claude Code

Универсальный скил **`memory_code_active`** — третий слой памяти проекта (после
краткосрочной `memory_short_active` и долгосрочной `memory_long_active`): **структурная
память о кодовой базе**. Локальный графовый индекс кода (вендоренный
[ontoindex](https://github.com/ontograph/ontoindex): Tree-sitter → LadybugDB → MCP)
подключается к любому проекту, и Claude обязан использовать его инструменты при работе
с файлами, функциями и классами — меньше ошибок «правки вслепую».

## Состав репозитория

| Путь | Что это |
|---|---|
| `ontoindex/` | Вендоренный срез монорепо ontoindex @ апстрим-коммит `b373fdf` (AGPL-3.0, LICENSE/NOTICE сохранены) с нашими security-патчами. От апстрима НЕ зависит. |
| `ontoindex/_upstream_docs/` | Нейтрализованные агент-конфиги апстрима (CLAUDE.md, .mcp.json и пр.) — справочно, им не следовать |
| `tools/install.ps1` | Установка глобального движка в `~/.claude/tools/ontoindex` + скил в `~/.claude/skills/` + шим `ontoindex` |
| `tools/update.ps1` | Обновление движка из среза (индексы проектов не трогает) |
| `tools/memory_code.ps1` | Детерминированный движок режимов скила (on/off/clear/clear-hard/update/reapply/status) |
| `tools/templates/claude_block.md` | Канонический блок инструкций для CLAUDE.md проекта |
| `skills/memory_code_active/SKILL.md` | Источник скила Claude Code |
| `.github/workflows/build-engine.yml` | CI-сборка нативного бандла (см. «Установка без MSVC») |
| `work_directory/` | Артефакты управления проектом (план CBM, security-ревью, тесты) |

## Установка

Требования: Windows, Node.js ≥ 20 (проверено на 24), npm, git. Для нативной сборки
tree-sitter нужен MSVC Build Tools («Desktop development with C++»).

```powershell
git clone https://github.com/gram2Claude/code_base_memory.git
cd code_base_memory
powershell -ExecutionPolicy Bypass -File tools\install.ps1
```

`install.ps1`: копирует срез в `~/.claude/tools/ontoindex` → `npm ci --legacy-peer-deps`
(Node ≥ 24/npm 11 строже валидируют peer-конфликты optional-грамматик — флаг обязателен) →
`npm run build` → ставит скил и глобальную команду `ontoindex`.

### Установка без MSVC (нет прав администратора)

Нативные модули собирает CI (`build-engine.yml`, раннер windows-2022 = Windows Server 2022,
Node 24): закоммить любое изменение в `.github/engine-build-request` → workflow соберёт
и опубликует `engine-bundle.tgz` в релиз `engine-bundle-win-node24`. Локально:

```powershell
# скачать asset релиза engine-bundle-win-node24 (dev-скрипт, читает PAT из ~/.wgp/secrets.json):
node tools\fetch_engine_bundle.mjs
powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Prebuilt
```

> `fetch_engine_bundle.mjs` — вспомогательный dev-скрипт сопровождения (НЕ часть runtime
> поставки скила); без PAT asset можно скачать вручную со страницы релиза.

## Использование

В корне проекта (НОВАЯ сессия Claude Code):

| Команда | Действие |
|---|---|
| `/memory_code_active on` | Индекс `.ontoindex/` + MCP `ontoindex` (stdio, **read-only**) + хуки (augment + stale-детект: commit/merge **и правки**) + инструкции (вкл. lazy-reindex через `gn_ensure_fresh`) в CLAUDE.md + .gitignore |
| `/memory_code_active off` | Снять MCP/хуки/инструкции; индекс сохранить |
| `/memory_code_active update` | Переиндексация (после крупных правок/merge; закрыть MCP-сессии — DB lock) |
| `/memory_code_active reapply` | Обновить регистрацию (хуки/инструкции/.mcp.json) без переиндексации — донести апдейт скила до уже активного проекта (нет reindex → нет DB-lock) |
| `/memory_code_active clear` | Индекс в `.trash` (восстановимо) |
| `/memory_code_active clear --hard` | Удалить окончательно (с подтверждением) |

Интеграция с `/workflow_global_plan`: фаза init нового проекта спрашивает «Активировать
кодовую память?» (поле `code_memory: true|false|"deferred"`; для пустого проекта активация
откладывается до появления кода).

## Ограничения и безопасность

- Полное security-ревью среза: `work_directory/05_security/00_ontoindex_security_review.md`
  (F1–F11). Применённые меры: телеметрия `@scarf/scarf` удалена; личные агент-конфиги
  апстрима нейтрализованы; все вызовы `npx ontoindex@latest` заменены локальным движком;
  патч `--end-of-options` (git argument injection).
- **MCP только read-only** (без `--confirm-writes`): правки кода делает Claude через свои
  инструменты, индекс — только чтение.
- **Семантический режим/эмбеддинги запрещены** до офлайн-модели: `@huggingface/transformers`
  при первом семантическом запросе тянет модель с huggingface.co (F10).
- **Индексировать только доверенные репозитории**: вывод инструментов попадает в контекст
  агента без фильтрации (prompt-injection, F5) — как и любой инструмент чтения кода.
- Большие монорепо: добавьте `.ontoindexignore` (шаблон ставится режимом on) и смотрите
  лимиты в `ontoindex/_upstream_docs/` (GUARDRAILS).
- Смоук режимов: `work_directory/tests/smoke_memory_code.ps1`; смоук хука свежести (edit/git staleness): `work_directory/tests/smoke_edit_hook.mjs`.

## Лицензия

Вендоренный `ontoindex/` — **AGPL-3.0-or-later** (© ontograph contributors, см.
`ontoindex/LICENSE`, `ontoindex/NOTICE`). Наша обвязка (tools/, skills/) распространяется
на тех же условиях в составе репозитория. При распространении модификаций исходники
обязаны оставаться открытыми (этот репозиторий публичен — условие выполнено).
