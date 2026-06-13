# memory_code.ps1 — детерминированный движок скила memory_code_active (CBM-11/12/14/15)
# Все файловые операции режимов on/off/clear/update. Вызывается скилом и смоуком (CBM-17).
# Запуск:  powershell -ExecutionPolicy Bypass -File memory_code.ps1 -Mode on -Project <путь>
param(
    [Parameter(Mandatory)][ValidateSet('on','off','clear','clear-hard','update','status','reapply')]
    [string]$Mode,
    [string]$Project = (Get-Location).Path,
    [switch]$Force,        # для clear-hard (подтверждение даёт вызывающий)
    [switch]$SkipAnalyze   # для смоука: on без построения индекса
)
$ErrorActionPreference = 'Stop'
$Project = (Resolve-Path -LiteralPath $Project).Path
$EngineDir = if ($env:ONTOINDEX_HOME) { $env:ONTOINDEX_HOME } else { Join-Path $env:USERPROFILE '.claude\tools\ontoindex' }
$CliJs   = Join-Path $EngineDir 'ontoindex\dist\cli\index.js'
$HookJs  = Join-Path $EngineDir 'ontoindex-claude-plugin\hooks\ontoindex-hook.js'
$BlockTpl= Join-Path $EngineDir 'skill\claude_block.md'
$McpPath = Join-Path $Project '.mcp.json'
$SetPath = Join-Path $Project '.claude\settings.json'
$ClaudeMd= Join-Path $Project 'CLAUDE.md'
$GitIgn  = Join-Path $Project '.gitignore'
$IdxDir  = Join-Path $Project '.ontoindex'
$MarkBeg = '<!-- MEMORY_CODE:BEGIN'
$MarkEnd = '<!-- MEMORY_CODE:END -->'

# Все записи — UTF-8 БЕЗ BOM ([IO.File]): PS 5.1 Out-File -Encoding utf8 ставит BOM,
# а BOM в .mcp.json/settings.json может ломать JSON-парсеры (ревью, major #2).
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Text($path, $text) {
    $dir = Split-Path $path -Parent
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom)
}
function Read-Json($path) {
    if (Test-Path -LiteralPath $path) {
        $raw = [System.IO.File]::ReadAllText($path)  # ReadAllText сам срезает BOM
        $raw | ConvertFrom-Json
    } else { $null }
}
function Write-Json($path, $obj) {
    Write-Text $path (($obj | ConvertTo-Json -Depth 20) + "`n")
}
function Invoke-Analyze {
    if (-not (Test-Path $CliJs)) { throw "Движок не установлен: $CliJs (запусти tools\install.ps1)" }
    Push-Location $Project
    try {
        node $CliJs analyze .   # БЕЗ --embeddings: семантический режим запрещён (F10, HF-офлайн)
        if ($LASTEXITCODE -ne 0) { throw "ontoindex analyze failed: $LASTEXITCODE (если ошибка lock — закрой сессии Claude с MCP ontoindex этого проекта и повтори)" }
    } finally { Pop-Location }
    Remove-UpstreamBlock
}
function Remove-UpstreamBlock {
    # run-analyze.ts безусловно дописывает в CLAUDE.md блок <!-- ontoindex:start/end -->
    # (ссылается на НЕустановленные skill-файлы); канонические инструкции — наш блок
    # MEMORY_CODE, апстримовский вычищаем.
    if (Test-Path -LiteralPath $ClaudeMd) {
        $md = [System.IO.File]::ReadAllText($ClaudeMd)
        $clean = [regex]::Replace($md, '(?ms)^<!-- ontoindex:start -->.*?^<!-- ontoindex:end -->[ \t]*(\r?\n)?', '')
        if ($clean -ne $md) { Write-Text $ClaudeMd ($clean.TrimEnd() + "`n") }
    }
    foreach ($f in @('AGENTS.md')) {
        $p = Join-Path $Project $f
        if (Test-Path -LiteralPath $p) {
            $md = [System.IO.File]::ReadAllText($p)
            $clean = [regex]::Replace($md, '(?ms)^<!-- ontoindex:start -->.*?^<!-- ontoindex:end -->[ \t]*(\r?\n)?', '')
            if ($clean -ne $md) {
                if ($clean.Trim().Length -eq 0) { Remove-Item -LiteralPath $p -Force -Confirm:$false } else { Write-Text $p ($clean.TrimEnd() + "`n") }
            }
        }
    }
}
function Get-HookCommand { 'node "' + $HookJs + '"' }
function Test-OurHook($entry) {
    # Узкая сигнатура (ревью, major #5): наш хук = ontoindex-hook + наш движковый путь
    # (…\.claude\tools\ontoindex\…). Хук стороннего плагина апстрима под фильтр не попадает.
    foreach ($h in @($entry.hooks)) {
        if ($h.command -and $h.command -like '*ontoindex-hook*' -and $h.command -like '*.claude*tools*ontoindex*') { return $true }
    }
    return $false
}

# reapply — донести свежую регистрацию (хуки/инструкции/.mcp.json/.gitignore) до уже
# активированного проекта без reindex: нормализуем в on + SkipAnalyze (индекс на месте,
# DB-lock не трогаем). Требует существующий .ontoindex (иначе — сначала on).
$Reapplied = $false
if ($Mode -eq 'reapply') {
    if (-not (Test-Path -LiteralPath $IdxDir)) { throw "Проект не активирован (нет .ontoindex) — сначала: /memory_code_active on" }
    $SkipAnalyze = $true
    $Reapplied   = $true
    $Mode        = 'on'
}

switch ($Mode) {

'on' {
    if (-not $SkipAnalyze -and -not (Test-Path $CliJs)) { throw "Движок не установлен: $CliJs (запусти tools\install.ps1)" }
    # 1. Индекс
    if (-not (Test-Path $IdxDir)) {
        if ($SkipAnalyze) { New-Item -ItemType Directory -Force $IdxDir | Out-Null }
        else { Invoke-Analyze }
    }
    # 2. .mcp.json — merge, чужие серверы не трогаем
    $mcp = Read-Json $McpPath
    if ($null -eq $mcp) { $mcp = [pscustomobject]@{ mcpServers = [pscustomobject]@{} } }
    if (-not $mcp.PSObject.Properties['mcpServers']) { $mcp | Add-Member mcpServers ([pscustomobject]@{}) }
    $proj = $Project -replace '\\','/'
    $entry = [pscustomobject]@{
        command = 'node'
        args    = @(($CliJs -replace '\\','/'), 'mcp')
        env     = [pscustomobject]@{
            ONTOINDEX_MCP_PROJECT_CWD  = $proj
            ONTOINDEX_MCP_REPO         = $proj
            ONTOINDEX_MCP_AUTO_ANALYZE = '0'
            ONTOINDEX_DISABLE_SEMANTIC = '1'   # технический гейт embedder→huggingface (F10, наш патч)
            ONTOINDEX_QUERY_LOG        = '0'   # локальный query-лог выключен (~/.ontoindex/logs)
            ONTOINDEX_TOOL_TELEMETRY   = '0'   # локальная телеметрия инструментов выключена (наш патч)
            HF_HUB_OFFLINE             = '1'   # страховка для HF-стека
            TRANSFORMERS_OFFLINE       = '1'
        }
    }
    if ($mcp.mcpServers.PSObject.Properties['ontoindex']) { $mcp.mcpServers.ontoindex = $entry }
    else { $mcp.mcpServers | Add-Member ontoindex $entry }
    Write-Json $McpPath $mcp
    # 3. Хуки — merge в settings.json, существующие хуки других памятей сохраняются
    $set = Read-Json $SetPath
    if ($null -eq $set) { $set = [pscustomobject]@{} }
    if (-not $set.PSObject.Properties['hooks']) { $set | Add-Member hooks ([pscustomobject]@{}) }
    $defs = @(
        @{ ev='PreToolUse';  matcher='Grep|Glob|Bash' },
        @{ ev='PostToolUse'; matcher='Edit|Write|MultiEdit|Bash' }
    )
    foreach ($d in $defs) {
        $ev = $d.ev
        if (-not $set.hooks.PSObject.Properties[$ev]) { $set.hooks | Add-Member $ev @() }
        $arr = @($set.hooks.$ev)
        $ours = $null
        foreach ($e in $arr) { if (Test-OurHook $e) { $ours = $e } }
        if ($ours) {
            # апгрейд уже установленного проекта: держать matcher актуальным
            # (Lever 1 добавил Edit/Write/MultiEdit к PostToolUse) — идемпотентно
            if ($ours.PSObject.Properties['matcher']) { $ours.matcher = $d.matcher }
            else { $ours | Add-Member matcher $d.matcher }
        } else {
            $arr += [pscustomobject]@{
                matcher = $d.matcher
                hooks   = @([pscustomobject]@{ type='command'; command=(Get-HookCommand); timeout=10 })
            }
        }
        $set.hooks.$ev = $arr
    }
    Write-Json $SetPath $set
    # 4. CLAUDE.md — блок между маркерами (заменить, если есть)
    if (-not (Test-Path $BlockTpl)) {
        # fallback на шаблон из репо-источника (смоук до установки движка)
        $alt = Join-Path $PSScriptRoot 'templates\claude_block.md'
        if (Test-Path $alt) { $BlockTpl = $alt } else { throw "Шаблон не найден: $BlockTpl" }
    }
    $tpl = Get-Content $BlockTpl -Raw -Encoding utf8
    $md = if (Test-Path -LiteralPath $ClaudeMd) { [System.IO.File]::ReadAllText($ClaudeMd) } else { '' }
    $bi = $md.IndexOf($MarkBeg); $ei = $md.IndexOf($MarkEnd)
    if ($bi -ge 0 -and $ei -gt $bi) { $md = $md.Substring(0, $bi) + $tpl.TrimEnd() + "`n" + $md.Substring($ei + $MarkEnd.Length).TrimStart("`r","`n") }
    else { $md = $md.TrimEnd() + "`n`n" + $tpl.TrimEnd() + "`n" }
    Write-Text $ClaudeMd $md
    # 5. .gitignore (учитываем оба написания: апстрим-analyze сам дописывает '.ontoindex');
    #    точечный append без перезаписи файла (сохраняем чужие переводы строк/кодировку)
    $gi = if (Test-Path -LiteralPath $GitIgn) { Get-Content -LiteralPath $GitIgn -Encoding utf8 } else { @() }
    if (($gi -notcontains '.ontoindex/') -and ($gi -notcontains '.ontoindex')) {
        [System.IO.File]::AppendAllText($GitIgn, "`n.ontoindex/`n", $Utf8NoBom)
    }
    # 6. .ontoindexignore — шаблон для больших репо (если нет)
    $OiIgn = Join-Path $Project '.ontoindexignore'
    if (-not (Test-Path -LiteralPath $OiIgn)) {
        Write-Text $OiIgn "node_modules/`ndist/`nbuild/`nout/`n.git/`n.trash/`n*.min.js`n*.bundle.js`n"
    }
    Remove-UpstreamBlock
    if ($Reapplied) { Write-Host "REAPPLY: hooks=ok claude_md=ok mcp=ok gitignore=ok (reindex пропущен; индекс не тронут)" }
    else { Write-Host "ON: index=$(Test-Path -LiteralPath $IdxDir) mcp=ok hooks=ok claude_md=ok gitignore=ok ontoindexignore=ok" }
}

'off' {
    # 1. .mcp.json: убрать только наш сервер
    $mcp = Read-Json $McpPath
    if ($mcp -and $mcp.PSObject.Properties['mcpServers'] -and $mcp.mcpServers.PSObject.Properties['ontoindex']) {
        $mcp.mcpServers.PSObject.Properties.Remove('ontoindex')
        $rest = @($mcp.mcpServers.PSObject.Properties).Count
        $top  = @($mcp.PSObject.Properties).Count
        if ($rest -eq 0 -and $top -eq 1) { Remove-Item $McpPath -Force -Confirm:$false }
        else { Write-Json $McpPath $mcp }
    }
    # 2. settings.json: убрать только наши хуки
    $set = Read-Json $SetPath
    if ($set -and $set.PSObject.Properties['hooks']) {
        foreach ($ev in @('PreToolUse','PostToolUse')) {
            if ($set.hooks.PSObject.Properties[$ev]) {
                $kept = @(); foreach ($e in @($set.hooks.$ev)) { if (-not (Test-OurHook $e)) { $kept += $e } }
                if ($kept.Count -gt 0) { $set.hooks.$ev = $kept } else { $set.hooks.PSObject.Properties.Remove($ev) }
            }
        }
        Write-Json $SetPath $set
    }
    # 3. CLAUDE.md: убрать блок
    if (Test-Path -LiteralPath $ClaudeMd) {
        $md = [System.IO.File]::ReadAllText($ClaudeMd)
        $bi = $md.IndexOf($MarkBeg); $ei = $md.IndexOf($MarkEnd)
        if ($bi -ge 0 -and $ei -gt $bi) {
            Write-Text $ClaudeMd ($md.Substring(0, $bi).TrimEnd() + "`n" + $md.Substring($ei + $MarkEnd.Length).TrimStart("`r","`n"))
        }
    }
    # 4. Индекс и глобальный реестр СОХРАНЯЮТСЯ (решение CBM: re-on дёшев; запись в
    #    ~/.ontoindex/registry.json безвредна без индекса и чистится только clear --hard)
    Write-Host "OFF: mcp/hooks/claude_md сняты; .ontoindex/ сохранён"
}

'clear' {
    & $PSCommandPath -Mode off -Project $Project | Out-Null
    if (Test-Path -LiteralPath $IdxDir) {
        $stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
        $dest = Join-Path $Project ".trash\memory_code\$stamp"
        New-Item -ItemType Directory -Force $dest | Out-Null
        try { Move-Item -LiteralPath $IdxDir -Destination (Join-Path $dest '.ontoindex') }
        catch { throw "CLEAR: не удалось переместить .ontoindex (вероятно, DB-lock LadybugDB — закрой сессии Claude с MCP ontoindex этого проекта и повтори): $_" }
        Write-Host "CLEAR: индекс перемещён в .trash\memory_code\$stamp (восстановимо; запись в ~/.ontoindex/registry.json сохраняется до clear --hard)"
    } else { Write-Host "CLEAR: индекса нет — только off" }
}

'clear-hard' {
    if (-not $Force) { throw "clear-hard требует -Force (подтверждение пользователя обязан получить вызывающий)" }
    & $PSCommandPath -Mode off -Project $Project | Out-Null
    foreach ($p in @($IdxDir, (Join-Path $Project '.trash\memory_code'))) {
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -Confirm:$false }
    }
    # Глобальный реестр: убрать запись проекта. Реестр ontoindex — JSON-МАССИВ объектов
    # {name,path,storagePath,...}. Round-trip делаем через node (PS ConvertTo-Json
    # схлопывает одноэлементный массив в объект и ломает реестр — урок ревью-смоука).
    $reg = Join-Path $env:USERPROFILE '.ontoindex\registry.json'
    if (Test-Path -LiteralPath $reg) {
        try {
            $code = @'
const fs=require('fs'); const [reg,proj]=process.argv.slice(1);
let j; try{ j=JSON.parse(fs.readFileSync(reg,'utf8')); }catch{ process.exit(0); }
const norm=s=>String(s||'').replace(/\\/g,'/').replace(/\/+$/,'');
const p=norm(proj);
if(Array.isArray(j)){ const out=j.filter(e=>norm(e&&e.path)!==p); fs.writeFileSync(reg, JSON.stringify(out,null,2)+'\n'); }
'@
            node -e $code $reg $Project
        } catch { Write-Warning "registry.json: не удалось обновить ($_)" }
    }
    Write-Host "CLEAR --HARD: индекс, .trash и запись реестра удалены"
}

'update' {
    Invoke-Analyze
    Write-Host "UPDATE: индекс переиндексирован до текущего состояния"
}

'status' {
    $mcp = Read-Json $McpPath
    $set = Read-Json $SetPath
    $hasMcp = [bool]($mcp -and $mcp.PSObject.Properties['mcpServers'] -and $mcp.mcpServers.PSObject.Properties['ontoindex'])
    $hasHook = $false
    if ($set -and $set.PSObject.Properties['hooks']) {
        foreach ($ev in @('PreToolUse','PostToolUse')) {
            if ($set.hooks.PSObject.Properties[$ev]) { foreach ($e in @($set.hooks.$ev)) { if (Test-OurHook $e) { $hasHook = $true } } }
        }
    }
    $hasBlock = (Test-Path -LiteralPath $ClaudeMd) -and (([System.IO.File]::ReadAllText($ClaudeMd)).Contains($MarkBeg))
    [pscustomobject]@{
        index    = Test-Path -LiteralPath $IdxDir
        mcp      = $hasMcp
        hooks    = $hasHook
        claudemd = $hasBlock
    } | ConvertTo-Json
}
}
