// ── WASM loader with graceful JS fallback ─────────────────────────────────
// Tries to load the prebuilt WASM modules from ./wasm/. If absent or the
// browser lacks WASM SIMD, returns null and callers stay on the JS path.
//
// Build instructions are in wasm-src/README.md.

let _asciiMod = null   // null = untested, false = unavailable, object = ready
let _gifMod   = null

/** Detect WebAssembly SIMD support (cached). */
let _simdOk = null
async function _hasSimd() {
    if (_simdOk !== null) return _simdOk
    try {
        // (module (func (result v128) v128.const i8x16 0 ...(×16)))
        // Body = local_count(1) + v128.const opcode(2) + 16-byte immediate + end(1) = 20 bytes
        // Code section content = num_funcs(1) + body_size(1) + body(20) = 22 bytes
        const bytes = new Uint8Array([
            0,97,115,109,1,0,0,0,   // magic + version
            1,5,1,96,0,1,123,       // type section: (func () -> v128)
            3,2,1,0,                // function section
            10,22,1,20,0,           // code section: size=22, 1 func, body=20, 0 locals
            253,12,                 // v128.const opcode
            0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, // 16-byte immediate
            11                      // end
        ])
        _simdOk = await WebAssembly.validate(bytes)
    } catch { _simdOk = false }
    if (!_simdOk) console.warn('[wasm] SIMD unsupported — JS fallback will be used')
    return _simdOk
}

/** Load wasm/ascii.js (wasm-bindgen output). Resolves to module or null. */
export async function loadAsciiWasm() {
    if (_asciiMod !== null) return _asciiMod || null
    try {
        if (!(await _hasSimd())) { _asciiMod = false; return null }
        // wasm-bindgen --target web emits an ES module that initializes with default()
        const url = new URL('./wasm/ascii.js', import.meta.url).href
        const mod = await import(/* @vite-ignore */ url)
        await mod.default()  // initializes the wasm
        _asciiMod = mod
        console.log('%c[wasm] ascii encoder loaded', 'color:#00ff41')
        return mod
    } catch (e) {
        console.warn('[wasm] ascii encoder unavailable, using JS path:', e.message)
        _asciiMod = false
        return null
    }
}

export async function loadGifWasm() {
    if (_gifMod !== null) return _gifMod || null
    try {
        if (!(await _hasSimd())) { _gifMod = false; return null }
        const url = new URL('./wasm/gif.js', import.meta.url).href
        const mod = await import(/* @vite-ignore */ url)
        await mod.default()
        _gifMod = mod
        console.log('%c[wasm] gif decoder loaded', 'color:#00ff41')
        return mod
    } catch (e) {
        console.warn('[wasm] gif decoder unavailable, using gifuct-js:', e.message)
        _gifMod = false
        return null
    }
}
