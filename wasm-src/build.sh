#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$(dirname "$ROOT")/wasm"
mkdir -p "$OUT"

# Locate wasm-pack — prefer PATH, fall back to ~/.cargo/bin
WASM_PACK="$(command -v wasm-pack 2>/dev/null || echo "$HOME/.cargo/bin/wasm-pack")"
if [ ! -x "$WASM_PACK" ]; then
  echo "wasm-pack not found. Install with: cargo install wasm-pack"; exit 1
fi

export RUSTFLAGS="-C target-feature=+simd128"

build_crate() {
  local name="$1" outname="$2"
  echo "==> Building $name (SIMD)"
  ( cd "$ROOT/$name" && "$WASM_PACK" build --release --target web --out-dir pkg --out-name "$outname" )
  cp -f "$ROOT/$name/pkg/${outname}.js"       "$OUT/${outname}.js"
  cp -f "$ROOT/$name/pkg/${outname}_bg.wasm"  "$OUT/${outname}_bg.wasm"
}

build_crate ascii_simd ascii
build_crate gif_wasm   gif

echo "==> Done. Artifacts in $OUT"
