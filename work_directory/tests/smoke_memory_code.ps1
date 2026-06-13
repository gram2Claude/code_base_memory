# smoke_memory_code.ps1 — регрессионный смоук режимов кодовой памяти (CBM-17 / t20)
# Гоняет цикл on -> off -> on -> clear -> clear-hard на временном репо и проверяет
# идемпотентность + сосуществование с чужими хуками. Без сборки индекса (-SkipAnalyze),
# т.е. проверяются ВСЕ файловые операции движка memory_code.ps1.
# Запуск: powershell -ExecutionPolicy Bypass -File work_directory\tests\smoke_memory_code.ps1
$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$MC = Join-Path $RepoRoot 'tools\memory_code.ps1'
$Tmp = Join-Path $env:TEMP ("mc_smoke_" + (Get-Date -Format 'HHmmss'))
$fails = @()
function Assert($cond, $name) {
    if ($cond) { Write-Host "  PASS  $name" } else { Write-Host "  FAIL  $name"; $script:fails += $name }
}

New-Item -ItemType Directory -Force $Tmp | Out-Null
Push-Location $Tmp
try {
    git init -q .
    'export function hello(){ return 1 }' | Out-File sample.ts -Encoding utf8
    git add -A; git -c user.email=smoke@local -c user.name=smoke commit -qm init

    # Чужой хук (имитация memory_short) — должен пережить on/off
    New-Item -ItemType Directory -Force '.claude' | Out-Null
    '{"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"echo foreign","timeout":5}]}],"PreToolUse":[{"matcher":"Edit","hooks":[{"type":"command","command":"echo foreign-pre","timeout":5}]}]}}' |
        Out-File '.claude\settings.json' -Encoding utf8

    Write-Host "== on =="
    & $MC -Mode on -Project $Tmp -SkipAnalyze | Out-Null
    $mcp = Get-Content .mcp.json -Raw | ConvertFrom-Json
    $set = Get-Content .claude\settings.json -Raw | ConvertFrom-Json
    Assert ($mcp.mcpServers.ontoindex.command -eq 'node') 'on: mcp ontoindex (node, stdio)'
    Assert (($mcp.mcpServers.ontoindex.args -join ' ') -notmatch 'confirm-writes') 'on: read-only (no --confirm-writes)'
    Assert (@($set.hooks.PreToolUse).Count -eq 2) 'on: PreToolUse = чужой + наш'
    Assert (@($set.hooks.PostToolUse).Count -eq 1) 'on: PostToolUse наш'
    Assert (@($set.hooks.PostToolUse)[0].matcher -eq 'Edit|Write|MultiEdit|Bash') 'on: PostToolUse matcher = Edit|Write|MultiEdit|Bash (Lever 1)'
    Assert (@($set.hooks.SessionStart).Count -eq 2) 'on: SessionStart = чужой + наш (CBM-31)'
    $ssOurs = @($set.hooks.SessionStart | Where-Object { ((@($_.hooks).command) -join ' ') -match 'ontoindex-hook' })
    Assert ($ssOurs.Count -eq 1) 'on: наш SessionStart-хук (auto-reindex) зарегистрирован'
    $ssForeign = @($set.hooks.SessionStart | Where-Object { ((@($_.hooks).command) -join ' ') -match 'echo foreign' })
    Assert ($ssForeign.Count -eq 1) 'on: чужой SessionStart жив'
    Assert ((Get-Content CLAUDE.md -Raw) -match 'MEMORY_CODE:BEGIN') 'on: блок в CLAUDE.md'
    Assert ((Get-Content .gitignore) -contains '.ontoindex/') 'on: .gitignore'
    Assert (Test-Path .ontoindexignore) 'on: .ontoindexignore создан'
    $mcpBom = [IO.File]::ReadAllBytes((Resolve-Path .mcp.json))[0] -ne 0xEF
    Assert $mcpBom 'on: .mcp.json без BOM'
    Assert ($mcp.mcpServers.ontoindex.env.ONTOINDEX_DISABLE_SEMANTIC -eq '1') 'on: semantic gate в env'

    Write-Host "== on повторно (идемпотентность) =="
    & $MC -Mode on -Project $Tmp -SkipAnalyze | Out-Null
    $set = Get-Content .claude\settings.json -Raw | ConvertFrom-Json
    $md = Get-Content CLAUDE.md -Raw
    Assert (@($set.hooks.PreToolUse).Count -eq 2) 'on x2: хуки не задвоились'
    Assert (@($set.hooks.SessionStart).Count -eq 2) 'on x2: SessionStart не задвоился'
    Assert (([regex]::Matches($md, 'MEMORY_CODE:BEGIN')).Count -eq 1) 'on x2: блок один'

    Write-Host "== апгрейд matcher (старая установка с matcher=Bash) =="
    # имитируем до-Lever1 установку: откатываем matcher на 'Bash' текстом (без ConvertTo-Json,
    # чтобы не словить схлопывание одноэлементного массива), затем пере-on должен его обновить
    $sp = Resolve-Path .claude\settings.json
    [IO.File]::WriteAllText($sp, ([IO.File]::ReadAllText($sp)).Replace('Edit|Write|MultiEdit|Bash', 'Bash'), (New-Object Text.UTF8Encoding($false)))
    & $MC -Mode on -Project $Tmp -SkipAnalyze | Out-Null
    $set = Get-Content .claude\settings.json -Raw | ConvertFrom-Json
    Assert (@($set.hooks.PostToolUse).Count -eq 1) 'upgrade: PostToolUse не задвоился'
    Assert (@($set.hooks.PostToolUse)[0].matcher -eq 'Edit|Write|MultiEdit|Bash') 'upgrade: matcher обновлён'

    Write-Host "== reapply (refresh регистрации без reindex) =="
    # снова откатываем matcher; reapply обязан обновить хуки/блок, НЕ трогая индекс
    [IO.File]::WriteAllText($sp, ([IO.File]::ReadAllText($sp)).Replace('Edit|Write|MultiEdit|Bash', 'Bash'), (New-Object Text.UTF8Encoding($false)))
    & $MC -Mode reapply -Project $Tmp | Out-Null
    $set = Get-Content .claude\settings.json -Raw | ConvertFrom-Json
    Assert (@($set.hooks.PostToolUse)[0].matcher -eq 'Edit|Write|MultiEdit|Bash') 'reapply: matcher обновлён'
    Assert ((Get-Content CLAUDE.md -Raw) -match 'MEMORY_CODE:BEGIN') 'reapply: блок на месте'
    Assert (Test-Path .ontoindex) 'reapply: индекс не тронут'

    Write-Host "== reapply на неактивном проекте (отказ) =="
    $Tmp2 = Join-Path $env:TEMP ("mc_smoke2_" + (Get-Date -Format 'HHmmssfff'))
    New-Item -ItemType Directory -Force $Tmp2 | Out-Null
    $refusedRe = $false
    try { & $MC -Mode reapply -Project $Tmp2 2>$null | Out-Null } catch { $refusedRe = $true }
    Assert $refusedRe 'reapply: без .ontoindex — отказ'
    Remove-Item $Tmp2 -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue

    Write-Host "== off =="
    & $MC -Mode off -Project $Tmp | Out-Null
    $set = Get-Content .claude\settings.json -Raw | ConvertFrom-Json
    $mcpGone = -not (Test-Path .mcp.json) -or -not ((Get-Content .mcp.json -Raw | ConvertFrom-Json).mcpServers.PSObject.Properties['ontoindex'])
    Assert $mcpGone 'off: mcp снят'
    Assert (@($set.hooks.PreToolUse).Count -eq 1 -and $set.hooks.PreToolUse[0].hooks[0].command -eq 'echo foreign-pre') 'off: наш хук снят, чужой жив'
    Assert (@($set.hooks.SessionStart).Count -eq 1 -and $set.hooks.SessionStart[0].hooks[0].command -eq 'echo foreign') 'off: наш SessionStart снят, чужой жив'
    Assert (-not $set.hooks.PSObject.Properties['PostToolUse']) 'off: PostToolUse снят'
    Assert (-not ((Get-Content CLAUDE.md -Raw) -match 'MEMORY_CODE')) 'off: блок убран'
    Assert (Test-Path .ontoindex) 'off: индекс сохранён'

    Write-Host "== off повторно (идемпотентность) =="
    & $MC -Mode off -Project $Tmp | Out-Null
    Assert $true 'off x2: не упал'

    Write-Host "== on -> clear =="
    & $MC -Mode on -Project $Tmp -SkipAnalyze | Out-Null
    & $MC -Mode clear -Project $Tmp | Out-Null
    Assert (-not (Test-Path .ontoindex)) 'clear: индекса нет'
    Assert ((Get-ChildItem .trash\memory_code -Recurse -Directory -Filter .ontoindex).Count -ge 1) 'clear: индекс в .trash'

    Write-Host "== clear-hard (без -Force должен отказать) =="
    $refused = $false
    try { & $MC -Mode clear-hard -Project $Tmp 2>$null | Out-Null } catch { $refused = $true }
    Assert $refused 'clear-hard: без -Force отказ'
    & $MC -Mode clear-hard -Project $Tmp -Force | Out-Null
    Assert (-not (Test-Path .trash\memory_code)) 'clear-hard: .trash удалён'

    Write-Host "== status =="
    $st = (& $MC -Mode status -Project $Tmp) | ConvertFrom-Json
    Assert (-not $st.mcp -and -not $st.hooks -and -not $st.claudemd) 'status: всё снято'
} finally {
    Pop-Location
    Remove-Item $Tmp -Recurse -Force -Confirm:$false -ErrorAction SilentlyContinue
}

Write-Host ""
if ($fails.Count -eq 0) { Write-Host "SMOKE: ALL PASS"; exit 0 }
else { Write-Host ("SMOKE: FAILED -> " + ($fails -join '; ')); exit 1 }
