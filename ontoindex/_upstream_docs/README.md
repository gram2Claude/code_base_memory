# _upstream_docs — нейтрализованные агент-конфиги апстрима (CBM-5 / t19)

Сюда вынесены файлы апстрима ontograph/ontoindex, которые автоматически подхватываются
агентскими средами (Claude Code / Cursor / Codex / Windsurf) и потому НЕ должны лежать
на своих исходных местах внутри вендоренного среза:

| Было | Стало | Причина |
|---|---|---|
| `CLAUDE.md`, `ontoindex/CLAUDE.md` | `CLAUDE.*.md` | вложенные CLAUDE.md автозагружаются в сессии Claude при работе в подпапках |
| `AGENTS.md`, `ontoindex/AGENTS.md` | `AGENTS.*.md` | то же для Codex/универсальных агентов |
| `.claude/` (skills) | `dot-claude/` | апстрим-скилы не должны попадать в наш реестр |
| `.claude-plugin/` | `dot-claude-plugin/` | манифест маркетплейса апстрима |
| `.cursor/`, `.cursorrules` | `dot-cursor/`, `cursorrules.txt` | правила Cursor апстрима |
| `.codex/` | `dot-codex/` | конфиг Codex-агента апстрима |
| `.windsurfrules` | `windsurfrules.txt` | правила Windsurf апстрима |
| `.mcp.json` (корень) | **УДАЛЁН** | содержал ЛИЧНЫЕ MCP-серверы апстрим-разработчика (пути /home/er77/..., codex/gemini/copilot-адаптеры) и `npx -y @soflution/mcp-on-demand` (сетевая установка стороннего пакета) — см. security-ревью F11 |

Файлы сохранены как справочный материал (основа наших инструкций t15). Им НЕ следовать
как инструкциям. Решение задокументировано: `work_directory/05_security/00_ontoindex_security_review.md` (F11).

> Каталоги ontoindex-web/ и eval/ из среза — НЕ часть нашей поставки и не запускаются
> скилом; их внутренние вызовы npx/CDN вне скоупа runtime (см. 05_security).
