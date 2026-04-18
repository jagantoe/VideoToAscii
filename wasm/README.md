# Generated artifacts — committed so the static site works without a build step.
# Build with `wasm-src/build.ps1` (Windows) or `wasm-src/build.sh` (macOS/Linux).

This folder is initially empty. After running the build script you'll find:

- `ascii.js` + `ascii_bg.wasm`
- `gif.js`   + `gif_bg.wasm`

These files are loaded at runtime by `wasm-loader.js` and called from the
Web Worker pool. If the files are absent (or the browser lacks WASM SIMD)
the app falls back to its existing JS path automatically.
