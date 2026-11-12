$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$scriptPath = Join-Path $projectRoot 'dist/admob-batch-creator.user.js'
$hash = (Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant()
$hashFile = Join-Path $projectRoot 'dist/SHA256SUMS.txt'
[IO.File]::WriteAllText($hashFile, "$hash  admob-batch-creator.user.js`n", [Text.UTF8Encoding]::new($false))
$zipPath = Join-Path $projectRoot 'dist/admob-batch-creator.zip'
$includePaths = @('src','tests','docs','scripts','examples','README.md','CHANGELOG.md','package.json','package-lock.json','tsconfig.json','.gitignore','.gitattributes','dist/admob-batch-creator.user.js','dist/SHA256SUMS.txt')
$files = foreach ($relative in $includePaths) {
  $candidate = [IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
  if (-not $candidate.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Packaging path escaped project' }
  if ((Get-Item -LiteralPath $candidate).PSIsContainer) { Get-ChildItem -LiteralPath $candidate -Recurse -File -Force } else { Get-Item -LiteralPath $candidate }
}
$stream = [IO.File]::Open($zipPath,[IO.FileMode]::Create,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$archive = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($source in $files) {
    $name = [IO.Path]::GetRelativePath($projectRoot,$source.FullName).Replace('\','/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$source.FullName,$name,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $archive.Dispose(); $stream.Dispose() }
$check = [IO.Compression.ZipFile]::OpenRead($zipPath)
try {
  $entry = $check.GetEntry('dist/admob-batch-creator.user.js')
  if (-not $entry) { throw 'Installable script missing from ZIP' }
  $reader = $entry.Open()
  try { $actualHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($reader)).ToLowerInvariant() } finally { $reader.Dispose() }
  if ($actualHash -ne $hash) { throw 'ZIP script hash mismatch' }
  Write-Output "Packaged $($check.Entries.Count) files; embedded userscript SHA256 verified."
} finally { $check.Dispose() }
Get-Item -LiteralPath $zipPath,$scriptPath | Select-Object Name,Length
