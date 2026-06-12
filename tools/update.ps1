# update.ps1 — обновление глобального движка ontoindex из vendor-среза (CBM-8)
# Тонкая обёртка над install.ps1: тот же идемпотентный прогон. Проектные индексы
# (.ontoindex/ в проектах) НЕ затрагиваются — движок и индексы разделены by design.
# Запуск:  powershell -ExecutionPolicy Bypass -File tools\update.ps1
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install.ps1') @args
Write-Host "Update готов. Версия: " -NoNewline
Get-Content (Join-Path $env:USERPROFILE '.claude\tools\ontoindex\VERSION.txt') | Select-Object -First 1
