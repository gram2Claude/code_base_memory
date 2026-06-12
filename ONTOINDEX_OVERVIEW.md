# OntoIndex — обзор репозитория

> Дата изучения: 2026-06-12
> Источник: https://github.com/ontograph/ontoindex
> **ВЕНДОРЕНО (CBM-1, 2026-06-12): `./ontoindex/` — полный локальный срез апстрим-коммита
> `b373fdf` (без `.git` и `.history`), от апстрима НЕ зависит. Апдейты — только осознанным
> diff-переносом с повторным security-ревью.**
> Версия: 1.9.3 · Лицензия: AGPL-3.0-or-later (LICENSE/NOTICE сохранены) · Наследник GitNexus

## Что это

**OntoIndex** — «графовый интеллект кода» (graph-powered code intelligence) для AI-агентов.
Строит **локальный граф знаний о кодовой базе** и отдаёт его агентам (Claude Code, Cursor,
Codex и любым MCP-клиентам), чтобы те редактировали код с пониманием всей картины:
кто кого вызывает, что сломается при изменении, какие процессы затронуты.

По сути — **структурная память о кодовой базе** (дополняет эпизодическую память типа
Graphiti, не конкурирует с ней).

## Как работает

1. `ontoindex analyze` — конвейер из 12 фаз:
   `scan → structure → [markdown, cobol] → parse → [routes, tools, orm] → crossFile → mro → communities → processes`
2. Парсинг через **Tree-sitter**, ~15 языков: TypeScript, JS, Python, Java, Kotlin, C#,
   Go, Rust, PHP, Ruby, Swift, C/C++, Dart, COBOL (regex).
3. Результат — граф в embedded-БД **LadybugDB** в папке `.ontoindex/` внутри репозитория:
   - **узлы**: файлы, функции, классы, методы, API-роуты, MCP-инструменты, секции доков,
     «процессы» (execution flows), сообщества (Leiden);
   - **рёбра**: `CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `CONTAINS`, `DEFINES`,
     `HANDLES_ROUTE`, `STEP_IN_PROCESS`, `MEMBER_OF` и др.
4. Глобальный реестр индексированных репо: `~/.ontoindex/registry.json` (только метаданные и пути).
5. Всё локально — код никуда не отправляется.

## Четыре интерфейса к одному графу

| Интерфейс | Запуск | Назначение |
|---|---|---|
| CLI | `ontoindex query/ctx/impact/...` | прямые команды |
| MCP-сервер (stdio) | `ontoindex mcp` | 60+ инструментов для агентов |
| HTTP API | `ontoindex serve` (порт 4747) | Express-бэкенд |
| Web UI | React/Vite, https://ontoindex.vercel.app | обозреватель графа + AI-чат |

## Ключевые возможности (MCP-инструменты)

| Инструмент | Что делает |
|---|---|
| `query` | гибридный поиск: BM25 + векторный + графовый, RRF-слияние, результаты сгруппированы по процессам |
| `context` | полный контекст символа: вызывающие, вызываемые, участие в процессах |
| `impact` | **анализ радиуса поражения** перед правкой (upstream/downstream, риск, тесты) |
| `detect_changes` | маппинг git-диффа на затронутые символы и процессы (pre-commit аудит) |
| `rename` | переименование с пониманием графа вызовов (не find-and-replace), есть `dry_run` |
| `api_impact`, `route_map`, `shape_check` | аудит API-роутов, маппинг роут→хендлер→потребитель, проверка форм ответов |
| `cypher` | произвольные Cypher-запросы к графу |
| `group_list`, `group_sync` | мульти-репо группы: контракты между сервисами, кросс-репо impact через Contract Bridge |

Плюс: генерация wiki по коду (`ontoindex wiki`), генерация skills для агентов,
проверка дрейфа документации, трассировка требований.

## Структура монорепо

| Путь | Назначение |
|---|---|
| `ontoindex/` | npm-пакет: CLI, ingestion pipeline, MCP-сервер, HTTP API, граф |
| `ontoindex-web/` | React/Vite web UI |
| `ontoindex-shared/` | общие TS-типы и константы |
| `ontoindex-native/` | опциональные нативные хелперы |
| `ontoindex-claude-plugin/` | интеграция с Claude |
| `ontoindex-cursor-integration/` | интеграция с Cursor |
| `docs/` | ADR, гайды, генерированная wiki |
| `eval/` | бенчмарк-харнесс использования инструментов |

Ключевые точки в коде (относительно `ontoindex/`):
- CLI-команды: `src/cli/`
- Пайплайн индексации: `src/core/ingestion/pipeline-phases/` + `pipeline.ts`
- Схема/БД графа: `src/core/lbug/` (`schema.ts`, `lbug-adapter.ts`)
- MCP: `src/mcp/` (`server.ts`, `tools.ts`, `resources.ts`)
- Поиск/ранжирование: `src/core/search/`
- Кросс-репо группы: `src/core/group/` (`service.ts`, `cross-impact.ts`)
- Поддержка языков: `src/core/ingestion/languages/` + `ontoindex-shared/src/languages.ts`

## Установка и первый запуск (Windows)

```powershell
# установка последнего релиза с GitHub
iwr -useb https://raw.githubusercontent.com/ontograph/ontoindex/master/scripts/install-ontoindex-latest.ps1 | iex
ontoindex --version

# в корне целевого репозитория
ontoindex analyze          # построить индекс
ontoindex status           # проверить
ontoindex setup            # автонастройка MCP-клиентов (Claude Code, Cursor, Codex)
# или вручную: claude mcp add ontoindex -- ontoindex mcp
```

Требования: Node.js 20+, Git; для нативных парсеров — Python 3 + MSVC Build Tools.
Безопасность таргета: `ONTOINDEX_MCP_PROJECT_CWD` / `ONTOINDEX_MCP_REPO` —
MCP-сервер не должен молча обслуживать не тот репозиторий.

## Типовые рабочие команды агента

```powershell
ontoindex query "authentication flow"                      # найти flow
ontoindex ctx validateUser                                  # контекст символа
ontoindex impact validateUser --include-tests --depth 2     # радиус поражения
ontoindex review diff                                       # ревью текущего диффа
ontoindex detect-changes                                    # аудит перед коммитом
ontoindex analyze --force                                   # пересборка индекса
ontoindex wiki . --out docs/wiki                            # генерация wiki
```

## Где применять

1. **Усиление Claude Code / Cursor на больших кодовых базах** — MCP-сервер даёт агенту
   видимость всех вызывающих перед правкой. Самое прямое применение.
2. **Страховочный слой для автономных агентов** — pre-edit impact + pre-commit аудит =
   меньше регрессий при работе без присмотра (фоновые задачи, cron, CI-боты).
3. **Безопасный рефакторинг легаси** — граф вызовов + MRO + переименование с проверками
   (вплоть до COBOL).
4. **Микросервисы / монорепо** — кросс-репо контракты и impact через границы сервисов.
5. **Онбординг и документация** — автогенерация wiki, карта процессов, веб-обозреватель
   графа, контроль дрейфа доков от кода.
6. **Code review** — `ontoindex review diff` показывает, какие процессы и флоу задевает дифф.

## Заметки

- Проект «ест свой корм»: его собственные CLAUDE.md/AGENTS.md обязывают агента запускать
  `ontoindex_impact` перед правкой символа и `ontoindex_detect_changes` перед коммитом.
- Сравнение с аналогами (из README): GitNexus (предшественник), Graphify (отчёты/знания
  для людей), CodeGPT Deep Graph MCP (hosted), Serena (символьные правки через LSP),
  Graphiti MCP (темпоральная память — дополняет, не заменяет).
- У проекта НЕТ официальной криптовалюты/токена (явное предупреждение в README).
- Enterprise-контакт: erasyuk@gmail.com
