# Build the WASM modules and stage them in ../wasm/.
# Requires: rustup, wasm-pack, target wasm32-unknown-unknown.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out  = Join-Path (Split-Path -Parent $root) 'wasm'
New-Item -ItemType Directory -Force -Path $out | Out-Null

# Locate wasm-pack — prefer PATH, fall back to %USERPROFILE%\.cargo\bin
$wasmPack = Get-Command wasm-pack -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
if (-not $wasmPack) {
    $wasmPack = Join-Path $env:USERPROFILE '.cargo\bin\wasm-pack.exe'
    if (-not (Test-Path $wasmPack)) {
        Write-Host "wasm-pack not found. Install with: cargo install wasm-pack" -ForegroundColor Red
        exit 1
    }
}

$env:RUSTFLAGS = '-C target-feature=+simd128'

function Build-Crate($name, $outName) {
    Push-Location (Join-Path $root $name)
    Write-Host "==> Building $name (SIMD)" -ForegroundColor Green
    & $wasmPack build --release --target web --out-dir pkg --out-name $outName
    if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }
    Copy-Item -Force "pkg/$outName.js"         (Join-Path $out "$outName.js")
    Copy-Item -Force "pkg/${outName}_bg.wasm"  (Join-Path $out "${outName}_bg.wasm")
    Pop-Location
}

Build-Crate 'ascii_simd' 'ascii'
Build-Crate 'gif_wasm'   'gif'

Write-Host "==> Done. Artifacts in $out" -ForegroundColor Green
