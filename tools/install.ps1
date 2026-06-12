# install.ps1 — установка глобального движка ontoindex (CBM-7)
# Копирует вендоренный срез из этого репо в ~/.claude/tools/ontoindex, ставит зависимости,
# собирает, создаёт глобальный шим `ontoindex` и маркер версии. Идемпотантен.
# Запуск:  powershell -ExecutionPolicy Bypass -File tools\install.ps1
param(
    [string]$EngineDir = (Join-Path $env:USERPROFILE '.claude\tools\ontoindex'),
    [switch]$Prebuilt   # node_modules+dist уже распакованы в срез из CI-бандла (нет MSVC) — npm ci/build пропускаются
)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $RepoRoot 'ontoindex'
$SnapshotRef = 'b373fdf'  # апстрим-коммит среза + патчи CBM-2/CBM-5

if (-not (Test-Path (Join-Path $Src 'ontoindex\package.json'))) {
    throw "Вендоренный срез не найден: $Src"
}

if ($Prebuilt) {
    foreach ($need in @('ontoindex\node_modules', 'ontoindex\dist')) {
        if (-not (Test-Path (Join-Path $Src $need))) { throw "-Prebuilt: в срезе нет $need — распакуй engine-bundle.tgz (см. README, «Установка без MSVC»)" }
    }
}
Write-Host "[1/5] Копирование среза -> $EngineDir"
New-Item -ItemType Directory -Force $EngineDir | Out-Null
# /MIR с /XD: исключённые каталоги не копируются И не удаляются в целевом — повторный
# запуск не сносит установленные node_modules и собранный dist.
$xd = @('.ontoindex', '.git', '.history')
if (-not $Prebuilt) { $xd += @('node_modules', 'dist') }
robocopy $Src $EngineDir /MIR /NFL /NDL /NJH /NJS /NP /XD @xd | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }

if ($Prebuilt) {
    Write-Host "[2-3/5] Пропущено (Prebuilt: node_modules+dist из CI-бандла скопированы как есть)"
} else {
    Write-Host "[2/5] npm ci (пакет ontoindex; НЕ корень монорепо — prepare:husky без .git падает)"
    Push-Location (Join-Path $EngineDir 'ontoindex')
    try {
        # Node >=24/npm 11: peer-конфликты optional-грамматик требуют legacy-peer-deps
        # (апстрим живёт на Node 20/npm 10, где npm ci это не валидировал).
        npm ci --legacy-peer-deps --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed: $LASTEXITCODE" }

        Write-Host "[3/5] Сборка (build.js: ontoindex-shared + ontoindex + super-dispatch валидация)"
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed: $LASTEXITCODE" }
    } finally { Pop-Location }
}

Write-Host "[3.5/5] Скил-движок (memory_code.ps1 + шаблон CLAUDE-блока) + скил в реестр Claude"
$SkillDir = Join-Path $EngineDir 'skill'
New-Item -ItemType Directory -Force $SkillDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'memory_code.ps1') (Join-Path $SkillDir 'memory_code.ps1') -Force
Copy-Item (Join-Path $PSScriptRoot 'templates\claude_block.md') (Join-Path $SkillDir 'claude_block.md') -Force
$ClaudeSkill = Join-Path $env:USERPROFILE '.claude\skills\memory_code_active'
New-Item -ItemType Directory -Force $ClaudeSkill | Out-Null
Copy-Item (Join-Path $RepoRoot 'skills\memory_code_active\SKILL.md') (Join-Path $ClaudeSkill 'SKILL.md') -Force

Write-Host "[4/5] Глобальный шим ontoindex + маркер версии"
$NpmBin = (& npm prefix -g).Trim()
$CliJs = Join-Path $EngineDir 'ontoindex\dist\cli\index.js'
@"
@echo off
node "$CliJs" %*
"@ | Out-File -FilePath (Join-Path $NpmBin 'ontoindex.cmd') -Encoding ascii
@"
snapshot: $SnapshotRef (+ CBM-2 security patches, CBM-5 neutralized agent configs)
installed: $(Get-Date -Format o)
source: $RepoRoot
node: $(node -v)
"@ | Out-File -FilePath (Join-Path $EngineDir 'VERSION.txt') -Encoding utf8

Write-Host "[5/5] Проверка CLI"
$ver = node $CliJs --version
if ($LASTEXITCODE -ne 0) { throw "CLI check failed" }
Write-Host "OK: ontoindex $ver -> $EngineDir"
Write-Host "Шим: $(Join-Path $NpmBin 'ontoindex.cmd') (команда 'ontoindex' доступна глобально)"
