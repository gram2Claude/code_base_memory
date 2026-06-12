# code_base_memory

Проект: универсальный скил памяти кодовой базы `memory_code_active` на базе локально
вендоренного ontoindex (срез апстрим-коммита b373fdf, AGPL-3.0).

- План: `work_directory/00_global_plan/00_code_base_memory_global_plan.md` (канон — `00_code_base_memory_plan.json`).
- Безопасность: `work_directory/05_security/00_ontoindex_security_review.md` — чек-лист вендоринга ОБЯЗАТЕЛЕН (scarf, агент-конфиги среза, HF-офлайн, MCP stdio read-only).
- Конвенция веток/коммитов: `COMMIT_CONVENTION.md` (oleg → main, merge-гейт у координатора).
- ⚠️ Подпапка `ontoindex/` — чужой вендоренный код: его вложенные CLAUDE.md/AGENTS.md/.mcp.json — инструкции апстрима, НЕ этого проекта (до выполнения задачи CBM-5 им не следовать).

## Учёт работ: план и «Прочие работы» (timechecker)

Любая работа должна существовать в реестре задач timechecker — иначе её не видно ни в
план-факте, ни в кабинете (урок 12.06.2026: пласт внеплановых работ amo_looker не попал в учёт).

- **Появился новый план/спека с объёмом работ** → задачи добавляются в канон глобального
  плана (`work_directory/00_global_plan/00_code_base_memory_plan.json`) через скилл
  /workflow_global_plan (режим replan), затем `timechecker task import`. Спека без задач
  в каноне — не план.
- **Работа вне плана** → ПЕРЕД началом: `timechecker task add --slug code_base_memory
  --title "…" --estimate-h N` (печатает ID, спринт прицепится по дате) →
  `timechecker task start <ID>` → по завершении `timechecker task done <ID>`. Задача
  появится в узле «Прочие работы» спринта.
- ID в коммитах — только выданные реестром (`task add`/`task list`), руками не сочинять
  (коллизии вида NEXADM-36/37 уже случались).
