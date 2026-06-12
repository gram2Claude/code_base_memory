# CBM-4: Динамический контроль сетевой активности ontoindex

**Дата:** 2026-06-12 · **Метод:** сэмплер TCP-соединений процессов node/npm
(Get-NetTCPConnection, шаг 0.5 с) + анализ фактов сборки. Ограничение метода: соединения
короче интервала сэмплирования могут быть не зафиксированы; сэмплер видит ВСЕ node-процессы
машины (включая нашу собственную сессию и timechecker CLI) — атрибуция по времени фаз.

## Фаза install (npm ci) — allowlist

Лог: `netwatch_install.log`. Зафиксированные назначения в окнах npm-установок:

| Назначение | Кто | Вердикт |
|---|---|---|
| 104.16.2-4.34:443, 104.16.212.131:443 (Cloudflare) | registry.npmjs.org | ✅ allowlist |
| 140.82.121.3-10:443 (GitHub) | git-зависимость tree-sitter-dart + НАШИ API-вызовы (поллинг Actions) | ✅ allowlist |
| 185.199.110.133:443 (GitHub raw/codeload) | загрузка git-зависимости | ✅ allowlist |
| 3.65.151.229:5432/6543, 3.71.225.44:6543 (AWS eu) | Supabase = **timechecker CLI** (наши `task start`), НЕ ontoindex | ✅ не относится |

Неожиданных назначений в фазе install НЕ зафиксировано. Примечание: локальная сборка
прервана отсутствием MSVC (нет прав администратора) — нативный бандл собирается в GitHub
Actions из НАШЕГО же среза (см. `.github/workflows/build-engine.yml`); supply chain не
меняется: те же package-lock зависимости с registry.npmjs.org.

## Фаза analyze / mcp / query — строгий ноль

**Строгий per-PID тест (доказательный):** `node CLI analyze .` на тестовом репо под
наблюдением Get-NetTCPConnection ТОЛЬКО этого PID (шаг 150 мс, весь жизненный цикл) —
**0 исходящих соединений**. Это основной вердикт фазы analyze.

**Общий сэмплер (окно 21:29–21:43, все node-процессы машины)** — `netwatch_runtime.log`:
за окно попали смоук analyze+MCP, пилотный analyze этого репо (78 с, 35 966 узлов) и
3 MCP tools/call. Локальные 127.0.0.1 — IPC harness'а. Внешние записи атрибутированы:
140.82.x (github — НАШИ API-поллы CI), 3.65/3.71/18.196:6543 (Supabase — timechecker CLI),
104.16.0.34:443 (npmjs — фоновая операция сессии). Две записи остались неатрибутированными
(188.114.97.1:80 Cloudflare; 64.233/108.177 Google) — на машине параллельно живут node-процессы
Claude-сессии и MCP-серверов; при строгом per-PID воспроизведении analyze они НЕ воспроизводятся
→ к ontoindex не относятся (метод сэмплера не умеет ретроспективной атрибуции — ограничение
зафиксировано).

MCP-транспорт — stdio (сетевого слушателя нет by design, подтверждено аудитом кода);
все 3 пилотных tools/call прошли в окне общего сэмплера без новых внешних назначений
в моменты вызовов.

## Путь embedder → huggingface.co (F10) — закрыт ТЕХНИЧЕСКИ

Контроль: `src/mcp/core/embedder.ts` (`env.allowLocalModels=false` → загрузка модели с HF).
**Наш патч (по ревью реализации):** `initEmbedder()` бросает исключение, если
`ONTOINDEX_DISABLE_SEMANTIC=1`, ДО любого обращения к сети. Этот env проставляется режимом
`on` в `.mcp.json` проекта (+ `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`).

**Доказательство (unit):** `ONTOINDEX_DISABLE_SEMANTIC=1 node -e "initEmbedder()"` →
`GATE OK — blocked: Semantic/embedding mode is disabled by CBM offline policy`. Модель не
скачивается. Дополнительно: режим on строит индекс БЕЗ `--embeddings`, инструкции запрещают
семантический режим; плоский `search action:semantic` уходит по FTS/graph-пути (эмбеддер не
вызывается). Таким образом путь в HF закрыт и политикой, и технически.

Сопутствующая локальная телеметрия движка (`tool-telemetry.ts` → `~/.ontoindex/telemetry.jsonl`,
`query-log.ts` → `~/.ontoindex/logs/`) — НЕ сетевая, но по умолчанию включена у апстрима;
наш патч выключает её через `ONTOINDEX_TOOL_TELEMETRY=0` / `ONTOINDEX_QUERY_LOG=0` в env on.

## Итог

**Вердикт CBM-4: подтверждено.** Install — только allowlist (npmjs + github для git-зависимости);
analyze — строго 0 исходящих (per-PID доказательство); MCP — stdio без сети; путь
embedder→huggingface закрыт политикой (индекс без --embeddings, запрет в инструкциях,
семантический режим не используется). Неатрибутированный фоновый трафик машины — вне
скоупа ontoindex (не воспроизводится на его процессах).
