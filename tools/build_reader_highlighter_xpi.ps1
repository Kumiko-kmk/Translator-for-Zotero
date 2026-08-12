param(
    [string]$Version = "0.8.1"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $projectRoot "zotero-reader-highlighter"
$layoutEnginePath = Join-Path $projectRoot "zotero-reader-highlighter\layout-extractor.js"
$distDir = Join-Path $projectRoot "dist"
$outputPath = Join-Path $distDir "reader-text-highlighter-$Version.xpi"

if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) {
    throw "Plugin source directory not found: $sourceDir"
}
if (-not (Test-Path -LiteralPath $layoutEnginePath -PathType Leaf)) {
    throw "Shared layout engine not found: $layoutEnginePath"
}

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
if (Test-Path -LiteralPath $outputPath) {
    Remove-Item -LiteralPath $outputPath -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $sourceDir,
    $outputPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
)

Write-Output $outputPath
