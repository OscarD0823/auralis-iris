$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $project
try {
    $version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
    New-Item -ItemType Directory -Path 'build' -Force | Out-Null
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    go build -trimpath -buildvcs=false -ldflags '-s -w' -o 'build/Auralis-Iris.exe' .
    if ($LASTEXITCODE -ne 0) { throw 'Falló la compilación de Auralis Iris.' }

    $goRoot = go env GOROOT
    if ($LASTEXITCODE -ne 0) { throw 'No se encontró la licencia de Go.' }
    Copy-Item -LiteralPath (Join-Path $goRoot 'LICENSE') -Destination 'build/GO-LICENSE.txt'
    $zip = "build/Auralis-Iris-$version-windows-x64.zip"
    $notices = Get-ChildItem -LiteralPath 'app/vendor' -File -Filter '*LICENSE*'
    $files = @('build/Auralis-Iris.exe', 'build/GO-LICENSE.txt', 'README.md', 'LICENSE', 'THIRD-PARTY.md') + @($notices.FullName)
    Compress-Archive -LiteralPath $files -DestinationPath $zip -CompressionLevel Optimal -Force
    $sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    "$sha  $(Split-Path -Leaf $zip)" | Set-Content -LiteralPath 'build/SHA256SUMS.txt' -Encoding ascii
    Get-Item -LiteralPath $zip, 'build/SHA256SUMS.txt'
} finally {
    Pop-Location
}
