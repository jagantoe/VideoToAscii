# wasm-src — native modules for video2pretext

Two small Rust crates compiled to WebAssembly + SIMD:

| Crate | Purpose | Output → |
|---|---|---|
| `ascii_simd` | Luminance + ramp-index inner loop, SIMD-accelerated | `../wasm/ascii.{js,wasm}` |
| `gif_wasm`   | GIF decoder with full disposal handling             | `../wasm/gif.{js,wasm}` |

**The site works without these.** `wasm-loader.js` checks for the prebuilt
artifacts in `../wasm/` and silently falls back to the existing JS path
(WebGL + Web Workers + gifuct-js) if they are missing.

## One-time setup

```bash
# Rust toolchain
curl https://sh.rustup.rs -sSf | sh         # macOS/Linux
# (Windows: install rustup from https://rustup.rs)

rustup target add wasm32-unknown-unknown
cargo install wasm-pack
```

## Build

```powershell
# Windows
./build.ps1
```

```bash
# macOS / Linux
./build.sh
```

Both scripts:
1. Run `wasm-pack build --release --target web` for each crate
2. Copy the generated `.js` and `.wasm` into `../wasm/`
3. Commit those artifacts so GitHub Pages serves them

## How the SIMD flag works

`build.ps1` / `build.sh` set `RUSTFLAGS="-C target-feature=+simd128"` so
the resulting `.wasm` uses SIMD opcodes. `wasm-loader.js` runtime-checks
for SIMD support before importing the module, so older browsers keep
working through the JS path.

## Updating

Whenever you change a crate's `lib.rs`, rerun the build script and commit
both the source change and the regenerated `wasm/` artifacts.
