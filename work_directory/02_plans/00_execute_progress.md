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
