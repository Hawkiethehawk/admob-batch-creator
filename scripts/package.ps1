$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$scriptPath = Join-Path $projectRoot 'dist/admob-batch-creator.user.js'
$packageInfo = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$scriptText = Get-Content -LiteralPath $scriptPath -Encoding UTF8 -Raw
$versionMatch = [regex]::Match($scriptText, '(?m)^// @version\s+([^\r\n]+)')
if (-not $versionMatch.Success -or $versionMatch.Groups[1].Value.Trim() -ne $packageInfo.version) { throw 'Userscript version differs from package.json; build before packaging' }
$hash = (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
$hashFile = Join-Path $projectRoot 'dist/SHA256SUMS.txt'
[IO.File]::WriteAllText($hashFile, "$hash  admob-batch-creator.user.js`n", [Text.UTF8Encoding]::new($false))
$zipPath = Join-Path $projectRoot 'dist/admob-batch-creator.zip'
$includePaths = @('src','tests','docs','scripts','examples','README.md','CHANGELOG.md','HANDOFF-AI-AGENT.md','package.json','package-lock.json','tsconfig.json','.gitignore','.gitattributes','dist/admob-batch-creator.user.js','dist/SHA256SUMS.txt')
$files = foreach ($relative in $includePaths) {
  $candidate = [IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
  if (-not $candidate.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Packaging path escaped project' }
  if ((Get-Item -LiteralPath $candidate).PSIsContainer) { Get-ChildItem -LiteralPath $candidate -Recurse -File -Force } else { Get-Item -LiteralPath $candidate }
}
$stream = [IO.File]::Open($zipPath,[IO.FileMode]::Create,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$archive = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($source in $files) {
    $relativePath = $source.FullName.Substring($projectRoot.Length).TrimStart('\','/')
    $name = $relativePath.Replace('\','/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$source.FullName,$name,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $archive.Dispose(); $stream.Dispose() }
$check = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  foreach ($source in $files) {
    $expected = $source.FullName.Substring($projectRoot.Length).TrimStart('\','/').Replace('\','/')
    if (-not $check.GetEntry($expected)) { throw "ZIP is missing source file: $expected" }
  }
  $entry = $check.GetEntry('dist/admob-batch-creator.user.js')
  if (-not $entry) { throw 'Installable script missing from ZIP' }
  $reader = $entry.Open()
  try { $sha = [Security.Cryptography.SHA256]::Create(); try { $actualHash = ([BitConverter]::ToString($sha.ComputeHash($reader)) -replace '-','').ToLowerInvariant() } finally { $sha.Dispose() } } finally { $reader.Dispose() }
  if ($actualHash -ne $hash) { throw 'ZIP script hash mismatch' }
  Write-Output "Packaged $($check.Entries.Count) files; version $($packageInfo.version), all source paths and embedded userscript SHA256 verified."
} finally { $check.Dispose() }
$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
# The embedded manifest covers the userscript. The external manifest also
# covers the completed archive, which cannot contain its own final hash.
[IO.File]::WriteAllText($hashFile, "$hash  admob-batch-creator.user.js`n$zipHash  admob-batch-creator.zip`n", [Text.UTF8Encoding]::new($false))
Get-Item -LiteralPath $zipPath,$scriptPath | Select-Object Name,Length
