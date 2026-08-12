param(
[string]$Version = "0.4.6"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $projectRoot "zotero-reader-selection-replacer-test"
$distDir = Join-Path $projectRoot "dist"
$outputPath = Join-Path $distDir "reader-selection-replacer-test-$Version.xpi"

if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) {
    throw "Selection replacer test source directory not found: $sourceDir"
}

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
if (Test-Path -LiteralPath $outputPath) {
    Remove-Item -LiteralPath $outputPath -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open(
    $outputPath,
    [System.IO.Compression.ZipArchiveMode]::Create
)
try {
    foreach ($name in @("manifest.json", "README.md", "bootstrap.js", "page-data-body-extractor.js", "content-segments.js", "translation-service.js")) {
        $path = Join-Path $sourceDir $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Selection replacer test package file not found: $path"
        }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive,
            $path,
            $name,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
}
finally {
    $archive.Dispose()
}

Write-Output $outputPath
