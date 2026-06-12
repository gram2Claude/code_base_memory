# Execute-прогресс CBM (автономный прогон 2026-06-12)

**Мандат управленца:** работать без остановок; разрешения выданы заранее (вкл. merge);
по готовности — ревью независимым агентом → ревью codex → проверка безопасности →
обновление памяти проекта/организации/инфо → коммит/пуш/merge → рапорт.

**Ветка работы:** oleg (→ merge в main через gate).
**Закрытие задач:** code — через gate-merge (один merge на всё); qa/doc/research — `timechecker task done` + отчёты.

## Статус задач

| ID | Задача | Статус прогона |
|---|---|---|
| CBM-1 (t01) | Вендоренный срез вместо submodule | IN PROGRESS |
| CBM-2 (t02) | Security-меры (scarf, F4, npx) | IN PROGRESS |
| CBM-3 (t03) | Windows-сборка и смоук | IN PROGRESS |
| CBM-4 (t04) | Контроль сети | IN PROGRESS |
| CBM-5 (t19) | Нейтрализация агент-конфигов | IN PROGRESS |
| CBM-7 (t05) | install.ps1 | todo |
| CBM-8 (t06) | update.ps1 | todo |
| CBM-10 (t07) | Каркас скила | todo |
| CBM-11 (t08) | Режим on | todo |
| CBM-12 (t09) | Режим off | todo |
| CBM-14 (t10) | clear/clear --hard | todo |
| CBM-15 (t11) | update + хуки | todo |
| CBM-16 (t12) | QA сосуществования | todo |
| CBM-17 (t20) | Скриптовый смоук | todo |
| CBM-19 (t13) | Вопрос в init WGP | todo |
| CBM-20 (t14) | Автоактивация | todo |
| CBM-22 (t15) | Инструкции v1 | todo |
| CBM-23 (t16) | Пилот (этот репо) | todo |
| CBM-25 (t17) | README | todo |
| CBM-26 (t18) | Орг-память + рапорт | todo |

## Ключевые решения по ходу (лог)

- Ветка oleg checkout'нута от main@76e4451.
- CBM-1 done-факт: срез 3222 файла/22МБ закоммичен (38a478b); .claude/ среза был gitignored
  апстримом — нейтрализован физическим mv (CBM-5, d55f423).
- CBM-2 (41b2d5c): scarf удалён из package.json+lock; F4 --end-of-options; npx → локальный
  движок во всех agent-facing файлах (mcp.json×7, hooks×3, skills .md×19, setup.ts fallback,
  analyze.ts/resources.ts, тесты обновлены). Остался 1 КОММЕНТАРИЙ в setup.ts (не вызов).
- CBM-3 ход: Node 24.15 = целевая версия. npm ci требует --legacy-peer-deps (npm 11 строже
  npm 10 апстрима; конфликт peer optional-грамматик). tree-sitter 0.25 без prebuild под
  ABI Node 24 → node-gyp → НЕТ MSVC (риск подтвердился) → ставлю VS Build Tools 2022
  (choco, detached) — вотчер ждёт cl.exe.
- Архитектурное решение: файловые операции режимов скила вынесены в детерминированный
  tools/memory_code.ps1 (ставится в <ENGINE>/skill/); SKILL.md делегирует ему. Это сделало
  CBM-17 настоящим тестом: смоук 18/18 PASS (вкл. идемпотентность и выживание чужих хуков).
- PS 5.1 требует UTF-8 BOM для .ps1 с кириллицей — добавлен во все наши скрипты.
- CBM-19/20: вопрос «Активировать кодовую память?» + code_memory (true/false/deferred,
  greenfield-отложка) добавлены в фазы init/publish workflow_global_plan.
