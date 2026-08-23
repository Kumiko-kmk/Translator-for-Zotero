$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $projectRoot "plugin"
$distDir = Join-Path $projectRoot "dist"

if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) {
    throw "Translator for Zotero source directory not found: $sourceDir"
}

$manifestPath = Join-Path $sourceDir "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
$zoteroManifest = $manifest.applications.zotero
if ($manifest.manifest_version -ne 2) { throw "manifest_version must be 2." }
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Manifest version must use x.y.z format: $version"
}
if ($zoteroManifest.id -ne "reader-selection-replacer-test@local.kumiko") {
    throw "Unexpected Zotero plugin id: $($zoteroManifest.id)"
}
if ($zoteroManifest.update_url -ne
    "https://reader-selection-replacer-test.invalid/updates.json") {
    throw "Zotero update_url is required and must match the validated plugin manifest."
}
if ($zoteroManifest.strict_min_version -ne "9.0" -or
    $zoteroManifest.strict_max_version -ne "9.*") {
    throw "Zotero compatibility must be 9.0 through 9.*."
}

$bootstrapPath = Join-Path $sourceDir "bootstrap.js"
$bootstrap = Get-Content -LiteralPath $bootstrapPath -Raw -Encoding UTF8
$versionDeclaration = 'const PLUGIN_VERSION = "' + [regex]::Escape($version) + '";'
if ($bootstrap -notmatch $versionDeclaration) {
    throw "bootstrap.js PLUGIN_VERSION does not match manifest version $version."
}

$packageFiles = @(
    "manifest.json",
    "bootstrap.js",
    "page-text-index.js",
    "selection-block.js",
    "front-matter-extractor.js",
    "content-segments.js",
    "translation-service.js",
    "icons/paper-assistant-16.svg",
    "icons/paper-assistant-20.svg",
    "icons/translator-for-zotero-16.svg",
    "icons/translator-for-zotero-20.svg",
    "icons/translator-for-zotero.png",
    "icons/qwen-symbol-32.png",
    "icons/deepseek-symbol-32.png",
    "icons/gemini-symbol-32.svg",
    "icons/bing-symbol-32.svg",
    "icons/transmart-symbol-32.svg",
    "icons/cnki-symbol-32.svg",
    "icons/qwen-symbol-hd.png",
    "icons/deepseek-symbol-hd.png",
    "icons/gemini-symbol-hd.png",
    "icons/bing-symbol-hd.png",
    "icons/transmart-symbol-hd.png",
    "icons/cnki-symbol-hd.png",
    "locale/en-US/reader-selection-replacer-test.ftl",
    "locale/zh-CN/reader-selection-replacer-test.ftl"
)
foreach ($name in $packageFiles) {
    $path = Join-Path $sourceDir $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Package file not found: $path"
    }
}

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$outputPath = Join-Path $distDir "Translator-for-Zotero-$version.xpi"
$temporaryPath = Join-Path $distDir (".Translator-for-Zotero-$version-" +
    [guid]::NewGuid().ToString("N") + ".tmp")

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
    $archive = [System.IO.Compression.ZipFile]::Open(
        $temporaryPath,
        [System.IO.Compression.ZipArchiveMode]::Create
    )
    try {
        foreach ($name in $packageFiles) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                (Join-Path $sourceDir $name),
                $name,
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    }
    finally {
        $archive.Dispose()
    }

    $validationArchive = [System.IO.Compression.ZipFile]::OpenRead($temporaryPath)
    try {
        $entryNames = @($validationArchive.Entries | ForEach-Object FullName)
        $unexpected = @($entryNames | Where-Object { $_ -notin $packageFiles })
        $missing = @($packageFiles | Where-Object { $_ -notin $entryNames })
        if ($entryNames.Count -ne $packageFiles.Count -or $unexpected.Count -or $missing.Count) {
            throw "XPI file list validation failed. Missing: $($missing -join ', '); unexpected: $($unexpected -join ', ')"
        }
        if (@($entryNames | Where-Object { $_.Contains('\') }).Count) {
            throw "XPI entries must use forward slashes."
        }

        $manifestEntry = $validationArchive.GetEntry("manifest.json")
        if (-not $manifestEntry) { throw "manifest.json is not at the XPI root." }
        $reader = [System.IO.StreamReader]::new(
            $manifestEntry.Open(),
            [System.Text.Encoding]::UTF8
        )
        try { $packedManifest = $reader.ReadToEnd() | ConvertFrom-Json }
        finally { $reader.Dispose() }
        if ($packedManifest.version -ne $version -or
            $packedManifest.applications.zotero.id -ne $zoteroManifest.id -or
            $packedManifest.applications.zotero.update_url -ne $zoteroManifest.update_url -or
            $packedManifest.applications.zotero.strict_min_version -ne "9.0" -or
            $packedManifest.applications.zotero.strict_max_version -ne "9.*") {
            throw "Packed manifest validation failed."
        }
    }
    finally {
        $validationArchive.Dispose()
    }

    Move-Item -LiteralPath $temporaryPath -Destination $outputPath -Force
}
finally {
    if (Test-Path -LiteralPath $temporaryPath) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
}

$result = Get-Item -LiteralPath $outputPath
$hash = Get-FileHash -LiteralPath $outputPath -Algorithm SHA256
Write-Output "XPI: $($result.FullName)"
Write-Output "Size: $($result.Length) bytes"
Write-Output "SHA256: $($hash.Hash)"
