# memory_code.ps1 — детерминированный движок скила memory_code_active (CBM-11/12/14/15)
# Все файловые операции режимов on/off/clear/update. Вызывается скилом и смоуком (CBM-17).
# Запуск:  powershell -ExecutionPolicy Bypass -File memory_code.ps1 -Mode on -Project <путь>
param(
    [Parameter(Mandatory)][ValidateSet('on','off','clear','clear-hard','update','status')]
    [string]$Mode,
    [string]$Project = (Get-Location).Path,
    [switch]$Force,        # для clear-hard (подтверждение даёт вызывающий)
    [switch]$SkipAnalyze   # для смоука: on без построения индекса
)
$ErrorActionPreference = 'Stop'
$Project = (Resolve-Path $Project).Path
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

function Read-Json($path) {
    if (Test-Path $path) { Get-Content $path -Raw -Encoding utf8 | ConvertFrom-Json } else { $null }
}
function Write-Json($path, $obj) {
    $dir = Split-Path $path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    ($obj | ConvertTo-Json -Depth 20) | Out-File $path -Encoding utf8
}
function Invoke-Analyze {
    if (-not (Test-Path $CliJs)) { throw "Движок не установлен: $CliJs (запусти tools\install.ps1)" }
    Push-Location $Project
    try {
        node $CliJs analyze .   # БЕЗ --embeddings: семантический режим запрещён (F10, HF-офлайн)
        if ($LASTEXITCODE -ne 0) { throw "ontoindex analyze failed: $LASTEXITCODE (если ошибка lock — закрой сессии Claude с MCP ontoindex этого проекта и повтори)" }
    } finally { Pop-Location }
}
function Get-HookCommand { 'node "' + $HookJs + '"' }
function Test-OurHook($entry) {
    foreach ($h in @($entry.hooks)) { if ($h.command -and $h.command -like '*ontoindex-hook.js*') { return $true } }
    return $false
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
            ONTOINDEX_MCP_PROJECT_CWD = $proj
            ONTOINDEX_MCP_REPO        = $proj
            ONTOINDEX_MCP_AUTO_ANALYZE = '0'
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
        @{ ev='PostToolUse'; matcher='Bash' }
    )
    foreach ($d in $defs) {
        $ev = $d.ev
        if (-not $set.hooks.PSObject.Properties[$ev]) { $set.hooks | Add-Member $ev @() }
        $arr = @($set.hooks.$ev)
        $has = $false
        foreach ($e in $arr) { if (Test-OurHook $e) { $has = $true } }
        if (-not $has) {
            $arr += [pscustomobject]@{
                matcher = $d.matcher
                hooks   = @([pscustomobject]@{ type='command'; command=(Get-HookCommand); timeout=10 })
            }
            $set.hooks.$ev = $arr
        }
    }
    Write-Json $SetPath $set
    # 4. CLAUDE.md — блок между маркерами (заменить, если есть)
    if (-not (Test-Path $BlockTpl)) {
        # fallback на шаблон из репо-источника (смоук до установки движка)
        $alt = Join-Path $PSScriptRoot 'templates\claude_block.md'
        if (Test-Path $alt) { $BlockTpl = $alt } else { throw "Шаблон не найден: $BlockTpl" }
    }
    $tpl = Get-Content $BlockTpl -Raw -Encoding utf8
    $md = if (Test-Path $ClaudeMd) { Get-Content $ClaudeMd -Raw -Encoding utf8 } else { '' }
    $bi = $md.IndexOf($MarkBeg); $ei = $md.IndexOf($MarkEnd)
    if ($bi -ge 0 -and $ei -gt $bi) { $md = $md.Substring(0, $bi) + $tpl.TrimEnd() + "`n" + $md.Substring($ei + $MarkEnd.Length).TrimStart("`r","`n") }
    else { $md = $md.TrimEnd() + "`n`n" + $tpl.TrimEnd() + "`n" }
    $md | Out-File $ClaudeMd -Encoding utf8
    # 5. .gitignore
    $gi = if (Test-Path $GitIgn) { Get-Content $GitIgn -Encoding utf8 } else { @() }
    if ($gi -notcontains '.ontoindex/') { ($gi + '.ontoindex/') -join "`n" | Out-File $GitIgn -Encoding utf8 }
    Write-Host "ON: index=$(Test-Path $IdxDir) mcp=ok hooks=ok claude_md=ok gitignore=ok"
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
    if (Test-Path $ClaudeMd) {
        $md = Get-Content $ClaudeMd -Raw -Encoding utf8
        $bi = $md.IndexOf($MarkBeg); $ei = $md.IndexOf($MarkEnd)
        if ($bi -ge 0 -and $ei -gt $bi) {
            ($md.Substring(0, $bi).TrimEnd() + "`n" + $md.Substring($ei + $MarkEnd.Length).TrimStart("`r","`n")) | Out-File $ClaudeMd -Encoding utf8
        }
    }
    # 4. Индекс и глобальный реестр СОХРАНЯЮТСЯ (решение CBM: re-on дёшев)
    Write-Host "OFF: mcp/hooks/claude_md сняты; .ontoindex/ сохранён"
}

'clear' {
    & $PSCommandPath -Mode off -Project $Project | Out-Null
    if (Test-Path $IdxDir) {
        $stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
        $dest = Join-Path $Project ".trash\memory_code\$stamp"
        New-Item -ItemType Directory -Force $dest | Out-Null
        Move-Item $IdxDir (Join-Path $dest '.ontoindex')
        Write-Host "CLEAR: индекс перемещён в .trash\memory_code\$stamp (восстановимо)"
    } else { Write-Host "CLEAR: индекса нет — только off" }
}

'clear-hard' {
    if (-not $Force) { throw "clear-hard требует -Force (подтверждение пользователя обязан получить вызывающий)" }
    & $PSCommandPath -Mode off -Project $Project | Out-Null
    foreach ($p in @($IdxDir, (Join-Path $Project '.trash\memory_code'))) {
        if (Test-Path $p) { Remove-Item $p -Recurse -Force -Confirm:$false }
    }
    # Глобальный реестр: убрать запись проекта (формат реестра — best effort, оба варианта)
    $reg = Join-Path $env:USERPROFILE '.ontoindex\registry.json'
    if (Test-Path $reg) {
        try {
            $j = Get-Content $reg -Raw -Encoding utf8 | ConvertFrom-Json
            $proj = $Project -replace '\\','/'
            if ($j.PSObject.Properties['repos'] -and $j.repos -is [array]) {
                $j.repos = @($j.repos | Where-Object { ($_.path -replace '\\','/') -ne $proj })
            } else {
                foreach ($p in @($j.PSObject.Properties)) {
                    $v = $p.Value
                    if (($v -is [string] -and ($v -replace '\\','/') -eq $proj) -or
                        ($v.PSObject.Properties['path'] -and (($v.path -replace '\\','/') -eq $proj))) {
                        $j.PSObject.Properties.Remove($p.Name)
                    }
                }
            }
            Write-Json $reg $j
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
    $hasBlock = (Test-Path $ClaudeMd) -and ((Get-Content $ClaudeMd -Raw -Encoding utf8).Contains($MarkBeg))
    [pscustomobject]@{
        index    = Test-Path $IdxDir
        mcp      = $hasMcp
        hooks    = $hasHook
        claudemd = $hasBlock
    } | ConvertTo-Json
}
}
