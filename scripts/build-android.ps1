param(
    [Parameter(Mandatory)] [string] $JdkHome,
    [Parameter(Mandatory)] [string] $AndroidJar,
    [Parameter(Mandatory)] [string] $BuildTools,
    [Parameter(Mandatory)] [string] $KeyStore
)

$ErrorActionPreference = 'Stop'
if (!$env:IRIS_ANDROID_SIGNING_PASSWORD) { throw 'Configura IRIS_ANDROID_SIGNING_PASSWORD.' }

function Invoke-BuildTool([string] $Program, [string[]] $ToolArgs) {
    & $Program @ToolArgs
    if ($LASTEXITCODE -ne 0) { throw "Falló $(Split-Path -Leaf $Program) ($LASTEXITCODE)." }
}

$project = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).version
$output = Join-Path $project 'build'
$stage = Join-Path $output ("android-" + [guid]::NewGuid().ToString('N'))
$apk = Join-Path $output "Auralis-Iris-$version-android.apk"
$assets = Join-Path $stage 'assets'
$res = Join-Path $stage 'res'
$mipmap = Join-Path $res 'mipmap-xxxhdpi'
$classes = Join-Path $stage 'classes'
$dex = Join-Path $stage 'dex'
$oldJava = $env:JAVA_HOME
$env:JAVA_HOME = $JdkHome

try {
    New-Item -ItemType Directory -Force -Path $assets, $mipmap, $classes, $dex | Out-Null
    Copy-Item -LiteralPath (Join-Path $project 'app') -Destination (Join-Path $assets 'web') -Recurse
    Copy-Item -LiteralPath (Join-Path $project 'LICENSE'), (Join-Path $project 'THIRD-PARTY.md') -Destination $assets
    Copy-Item -LiteralPath (Join-Path $project 'app/iris-192.png') -Destination (Join-Path $mipmap 'iris.png')

    $aapt = Join-Path $BuildTools 'aapt2.exe'
    $compiled = Join-Path $stage 'resources.zip'
    $unsigned = Join-Path $stage 'unsigned.apk'
    $aligned = Join-Path $stage 'aligned.apk'
    $signed = Join-Path $stage 'signed.apk'
    $javaArchive = Join-Path $stage 'iris.jar'
    $manifest = Join-Path $project 'android/AndroidManifest.xml'
    $sources = (Get-ChildItem -LiteralPath (Join-Path $project 'android') -Filter '*.java' -File).FullName
    $bootClassPath = (Join-Path $BuildTools 'core-lambda-stubs.jar') + ';' + $AndroidJar

    Invoke-BuildTool $aapt @('compile', '--dir', $res, '-o', $compiled)
    Invoke-BuildTool $aapt @('link', '--manifest', $manifest, '--version-code', '5', '--version-name', $version,
        '-I', $AndroidJar, '-R', $compiled, '-o', $unsigned)
    Invoke-BuildTool (Join-Path $JdkHome 'bin/javac.exe') (@('-encoding', 'UTF-8', '-source', '8', '-target', '8',
        '-bootclasspath', $bootClassPath, '-d', $classes) + $sources)
    Invoke-BuildTool (Join-Path $JdkHome 'bin/jar.exe') @('cf', $javaArchive, '-C', $classes, '.')
    Invoke-BuildTool (Join-Path $BuildTools 'd8.bat') @('--lib', $AndroidJar, '--min-api', '26', '--output', $dex, $javaArchive)
    Invoke-BuildTool (Join-Path $JdkHome 'bin/jar.exe') @('uf', $unsigned, '-C', $dex, 'classes.dex', '-C', $stage, 'assets')
    $zipalign = Join-Path $BuildTools 'zipalign.exe'
    $signer = Join-Path $BuildTools 'apksigner.bat'
    Invoke-BuildTool $zipalign @('-f', '4', $unsigned, $aligned)
    Invoke-BuildTool $signer @('sign', '--ks', $KeyStore, '--ks-key-alias', 'auralis-iris',
        '--ks-pass', 'env:IRIS_ANDROID_SIGNING_PASSWORD', '--v4-signing-enabled', 'false', '--out', $signed, $aligned)
    Invoke-BuildTool $signer @('verify', '--verbose', '--print-certs', $signed)
    Invoke-BuildTool $zipalign @('-c', '4', $signed)
    Copy-Item -LiteralPath $signed -Destination $apk -Force
    Get-Item -LiteralPath $apk
} finally {
    $env:JAVA_HOME = $oldJava
    if (Test-Path -LiteralPath $stage) {
        $resolvedOutput = (Resolve-Path -LiteralPath $output).ProviderPath
        $resolvedStage = (Resolve-Path -LiteralPath $stage).ProviderPath
        if ($resolvedStage.StartsWith("$resolvedOutput\", [StringComparison]::OrdinalIgnoreCase) -and
                (Split-Path -Parent $resolvedStage) -eq $resolvedOutput) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
