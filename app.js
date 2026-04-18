import { layoutWithLines, prepareWithSegments } from '@chenglou/pretext'
import { decompressFrames, parseGIF } from 'gifuct-js'
import { Bench, PlaybackBench } from './bench.js'
import { decodeVideoWebCodecs } from './video-decoder.js'
import { loadAsciiWasm, loadGifWasm } from './wasm-loader.js'

// ── ASCII ramps ────────────────────────────────────────────────────────────
const RAMPS = {
    detailed: " .·:;!|ilI1][tf{jrxnuvczXYJ()Cüö0Oqpdb$m#MW&8%B@Ñ",
    simple:   " .:-=+*#%@",
    blocks:   " ░▒▓█",
}

const COLOR_PRESETS = {
    matrix:   { fg: '#00ff41', bg: '#0a0a0a' },
    cyan:     { fg: '#00ffff', bg: '#0a0a0a' },
    amber:    { fg: '#ff8800', bg: '#0a0a0a' },
    magenta:  { fg: '#ff00ff', bg: '#0a0a0a' },
    white:    { fg: '#ffffff', bg: '#0a0a0a' },
    red:      { fg: '#ff3333', bg: '#0a0a0a' },
    orange:   { fg: '#ff6633', bg: '#0a0a0a' },
    blue:     { fg: '#4499ff', bg: '#0a0a0a' },
    purple:   { fg: '#bb66ff', bg: '#0a0a0a' },
    gold:     { fg: '#ffd700', bg: '#0a0a0a' },
    neonpink: { fg: '#ff69b4', bg: '#0a0a0a' },
    ice:      { fg: '#aaeeff', bg: '#001a33' },
    forest:   { fg: '#44dd88', bg: '#001a0a' },
    blood:    { fg: '#cc2200', bg: '#0a0000' },
    sepia:    { fg: '#c4a265', bg: '#1a1005' },
    black:    { fg: '#111111', bg: '#f5f5f0' },
}

// ── GPU ASCII encoder (WebGL, lazy-init) ────────────────────────────────────
// Runs luminance + ramp-index computation in a fragment shader.
// Falls back transparently to CPU if WebGL is unavailable.
class _GpuAsciiEncoder {
    constructor() {
        this._ready   = null   // null = untested, true = ok, false = unavailable
        this._gl      = null
        this._prog    = null
        this._quadBuf = null
        this._tex     = null
        this._uLen    = null
        this._aPos    = -1
        this._aUv     = -1
        this._outBuf  = null   // reused readPixels buffer to reduce GC
    }

    _init() {
        if (this._ready !== null) return this._ready
        try {
            const canvas = new OffscreenCanvas(1, 1)
            const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
            if (!gl) { this._ready = false; return false }

            // Flush any driver-accumulated errors before setup
            while (gl.getError() !== gl.NO_ERROR) {}

            const vert = `
                attribute vec2 a_p, a_u;
                varying vec2 v;
                void main(){ gl_Position=vec4(a_p,0,1); v=a_u; }`

            // Output: R = ramp index (0..rampLen-1), G/B/A = original R/G/B
            // Encoding ramp index as R/255 is safe for all ramps (max 50 chars)
            const frag = `
                precision highp float;
                uniform sampler2D t; uniform float n;
                varying vec2 v;
                void main(){
                    vec4 c = texture2D(t, v);
                    float l = 0.299*c.r + 0.587*c.g + 0.114*c.b;
                    gl_FragColor = vec4(min(floor(l*n), n-1.0)/255.0, c.r, c.g, c.b);
                }`

            const compile = (type, src) => {
                const sh = gl.createShader(type)
                gl.shaderSource(sh, src); gl.compileShader(sh)
                if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
                    throw new Error(gl.getShaderInfoLog(sh))
                return sh
            }

            const prog = gl.createProgram()
            gl.attachShader(prog, compile(gl.VERTEX_SHADER, vert))
            gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag))
            gl.linkProgram(prog)
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
                throw new Error(gl.getProgramInfoLog(prog))
            gl.useProgram(prog)

            // Full-screen quad (triangle strip: BL BR TL TR)
            // UV Y is inverted so readPixels row order matches ImageData row order
            // (requires UNPACK_FLIP_Y_WEBGL=true on texImage2D upload)
            const buf = gl.createBuffer()
            gl.bindBuffer(gl.ARRAY_BUFFER, buf)
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                -1,-1, 0,1,   1,-1, 1,1,   -1,1, 0,0,   1,1, 1,0
            ]), gl.STATIC_DRAW)

            const aPos = gl.getAttribLocation(prog, 'a_p')
            const aUv  = gl.getAttribLocation(prog, 'a_u')
            gl.enableVertexAttribArray(aPos)
            gl.enableVertexAttribArray(aUv)

            const tex = gl.createTexture()
            gl.bindTexture(gl.TEXTURE_2D, tex)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

            this._gl = gl; this._prog = prog; this._quadBuf = buf; this._tex = tex
            this._uLen = gl.getUniformLocation(prog, 'n')
            this._aPos = aPos; this._aUv = aUv
            this._ready = true
            console.log('[GPU] WebGL ASCII encoder ready')
            return true
        } catch(e) {
            console.warn('[GPU] WebGL unavailable, using CPU fallback:', e.message)
            this._ready = false
            return false
        }
    }

    // Returns Uint8Array (width*height*4): R=rampIdx, G/B/A=orig R/G/B per pixel
    // Returns null on failure → CPU fallback
    encode(imageData, width, height, rampLen) {
        if (!this._init()) return null
        const gl = this._gl
        try {
            if (gl.canvas.width !== width || gl.canvas.height !== height) {
                gl.canvas.width = width; gl.canvas.height = height
                gl.viewport(0, 0, width, height)
            }
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
            gl.bindTexture(gl.TEXTURE_2D, this._tex)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
                          gl.RGBA, gl.UNSIGNED_BYTE, imageData.data)
            gl.uniform1f(this._uLen, rampLen)
            gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf)
            gl.vertexAttribPointer(this._aPos, 2, gl.FLOAT, false, 16, 0)
            gl.vertexAttribPointer(this._aUv,  2, gl.FLOAT, false, 16, 8)
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

            const size = width * height * 4
            if (!this._outBuf || this._outBuf.length < size)
                this._outBuf = new Uint8Array(size)
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this._outBuf)
            if (gl.getError() !== gl.NO_ERROR) return null
            return this._outBuf
        } catch(e) {
            console.warn('[GPU] encode error:', e.message)
            return null
        }
    }
}
const _gpuEncoder = new _GpuAsciiEncoder()

// ── Web Worker pool for parallel pixel processing ──────────────────────────────────
const _WORKER_SRC = `
let _cRamp = null, _cCharLut, _cLut
self.onmessage = ({ data: { pixels, width, height, ramp, color, idx } }) => {
    if (ramp !== _cRamp) {
        _cCharLut = Array.from(ramp)
        const n = _cCharLut.length
        _cLut = new Uint8Array(256)
        for (let b = 0; b < 256; b++) _cLut[b] = Math.min((b * n) >> 8, n - 1)
        _cRamp = ramp
    }
    const charLut = _cCharLut, lut = _cLut
    const totalPx = width * height
    // Emit quantized 12-bit color keys (Uint16) instead of raw RGB (Uint8×3).
    // Key = ((r&0xF0)<<8)|((g&0xF0)<<4)|(b>>4)  — matches _buildPalette.
    // Halves color data size and removes re-quantization pass on main thread.
    const colorKeys = color ? new Uint16Array(totalPx) : null
    const lineBuf = new Array(width)
    const lines = new Array(height)
    for (let y = 0; y < height; y++) {
        const rowOff = y * width
        for (let x = 0; x < width; x++) {
            const i = (rowOff + x) * 4
            const r = pixels[i], g = pixels[i+1], b = pixels[i+2]
            lineBuf[x] = charLut[lut[(r * 77 + g * 150 + b * 29) >> 8]]
            if (colorKeys) colorKeys[rowOff + x] = ((r & 0xF0) << 8) | ((g & 0xF0) << 4) | (b >> 4)
        }
        lines[y] = lineBuf.join('')
    }
    const transfer = colorKeys ? [colorKeys.buffer] : []
    self.postMessage({ text: lines.join('\\n'), colorKeys, idx }, transfer)
}
`

class _WorkerPool {
    constructor() {
        const n = Math.min(Math.max(navigator.hardwareConcurrency || 2, 2), 8)
        const url = URL.createObjectURL(new Blob([_WORKER_SRC], { type: 'text/javascript' }))
        this._workers = Array.from({ length: n }, () => new Worker(url))
        this._idle    = [...this._workers]
        this._pending = new Map()   // idx → resolve
        this._queue   = []
        URL.revokeObjectURL(url)
        this._workers.forEach(w => {
            w.onmessage = e  => this._done(w, e.data)
            w.onerror   = ev => console.error('[WorkerPool] error', ev)
        })
        console.log(`[WorkerPool] ${n} workers ready`)
    }

    _done(worker, data) {
        this._pending.get(data.idx)(data)
        this._pending.delete(data.idx)
        if (this._queue.length) {
            const task = this._queue.shift()
            this._pending.set(task.msg.idx, task.resolve)
            worker.postMessage(task.msg, task.transfer)
        } else {
            this._idle.push(worker)
        }
    }

    submit(pixels, width, height, ramp, color, idx) {
        const msg = { pixels, width, height, ramp, color, idx }
        const transfer = [pixels.buffer]
        return new Promise(resolve => {
            if (this._idle.length) {
                const w = this._idle.pop()
                this._pending.set(idx, resolve)
                w.postMessage(msg, transfer)
            } else {
                this._queue.push({ msg, transfer, resolve })
            }
        })
    }
}

let _workerPool = null, _workerPoolFailed = false
function _getWorkerPool() {
    if (_workerPoolFailed) return null
    if (!_workerPool) {
        try { _workerPool = new _WorkerPool() }
        catch (e) { console.warn('[WorkerPool] unavailable:', e.message); _workerPoolFailed = true; return null }
    }
    return _workerPool
}

// ── App ────────────────────────────────────────────────────────────────────
class App {
    constructor() {
        // State
        this.sourceFile  = null
        this.isJsonMode  = false   // true when user loaded a .json directly
        this.data        = null
        this.frameCache  = new Map()
        this.charWidth   = 0

        // Playback
        this.currentFrame    = 0
        this.playing         = false
        this.animationId     = null
        this.lastFrameTime   = 0
        this.speedMultiplier = 1

        // Display
        this.fontSize    = 14
        this.fgColor     = '#00ff41'
        this.bgColor     = '#0a0a0a'
        this.renderMode  = 'source-color'
        this.lightMode   = false

        // Conversion
        this._convertGen   = 0
        this._previewTimer = null
        // Cached ramp lookups — only recomputed when ramp string changes
        this._rampCache    = { ramp: null, charLut: null, lut: null }

        // Benchmark instrumentation (logs to console)
        this._playbackBench = new PlaybackBench()

        // Eagerly attempt to load optional WASM accelerators (no-op if absent).
        // ascii.wasm is used by the main-thread fallback in _pixelsToAscii;
        // workers continue to use plain JS (which already gives us parallelism).
        this._asciiWasm = null
        loadAsciiWasm().then(m => { this._asciiWasm = m })
        loadGifWasm()

        this._bindUI()
        this._initSliderLabels()
    }

    // ── Computed properties ───────────────────────────────────────────────

    get font() { return `${this.fontSize}px "Courier New","Consolas",monospace` }
    get lineHeight() { return Math.ceil(this.fontSize * 1.2) }

    // ── UI binding ────────────────────────────────────────────────────────

    _bindUI() {
        const dropScreen = document.getElementById('drop-screen')
        const fileInput  = document.getElementById('file-input')

        // Drop screen
        dropScreen.addEventListener('click', () => fileInput.click())
        dropScreen.addEventListener('dragover', e => { e.preventDefault(); dropScreen.classList.add('dragover') })
        dropScreen.addEventListener('dragleave', () => dropScreen.classList.remove('dragover'))
        dropScreen.addEventListener('drop', e => {
            e.preventDefault()
            dropScreen.classList.remove('dragover')
            const file = e.dataTransfer.files[0]
            if (file) this._loadFile(file)
        })
        fileInput.addEventListener('change', e => { if (e.target.files[0]) this._loadFile(e.target.files[0]) })

        // Sidebar – generic
        document.getElementById('btn-new').addEventListener('click', () => this._reset())
        document.getElementById('btn-download').addEventListener('click', () => this._download())

        // Convert settings → schedule re-convert
        for (const id of ['s-width', 's-ramp', 's-invert', 's-color', 's-max-frames', 's-video-fps']) {
            const el = document.getElementById(id)
            el.addEventListener('input',  () => this._scheduleConvert())
            el.addEventListener('change', () => this._scheduleConvert())
        }

        // Playback
        document.getElementById('btn-play').addEventListener('click', () => this._togglePlay())
        document.getElementById('btn-prev').addEventListener('click', () => this._stepFrame(-1))
        document.getElementById('btn-next').addEventListener('click', () => this._stepFrame(+1))

        document.getElementById('speed').addEventListener('input', e => {
            this.speedMultiplier = parseFloat(e.target.value)
            document.getElementById('speed-val').textContent = this.speedMultiplier.toFixed(1) + '×'
        })

        // Display settings → immediate re-render (no re-convert needed)
        document.getElementById('font-size').addEventListener('input', e => {
            this.fontSize = parseInt(e.target.value)
            document.getElementById('size-val').textContent = this.fontSize + 'px'
            this.frameCache.clear()
            if (this.data) { this._updateCanvasSize(); this._renderFrame(this.currentFrame) }
        })

        document.getElementById('light-mode').addEventListener('change', e => {
            this.lightMode = e.target.checked
            document.documentElement.dataset.theme = this.lightMode ? 'light' : 'dark'
            if (this.data) this._renderFrame(this.currentFrame)
        })

        document.getElementById('render-mode').addEventListener('change', e => {
            this.renderMode = e.target.value
            document.getElementById('mono-controls').style.display = this.renderMode === 'mono' ? '' : 'none'
            if (this.data) this._renderFrame(this.currentFrame)
        })

        document.getElementById('color-preset').addEventListener('change', e => {
            const val = e.target.value
            document.getElementById('custom-colors').classList.toggle('hidden', val !== 'custom')
            if (val !== 'custom') {
                this.fgColor = COLOR_PRESETS[val].fg
                this.bgColor = COLOR_PRESETS[val].bg
            }
            if (this.data) this._renderFrame(this.currentFrame)
        })

        document.getElementById('custom-fg').addEventListener('input', e => {
            this.fgColor = e.target.value
            if (this.data) this._renderFrame(this.currentFrame)
        })
        document.getElementById('custom-bg').addEventListener('input', e => {
            this.bgColor = e.target.value
            if (this.data) this._renderFrame(this.currentFrame)
        })

        // Keyboard
        document.addEventListener('keydown', e => {
            if (!this.data) return
            if (e.key === ' ')           { e.preventDefault(); this._togglePlay() }
            else if (e.key === 'ArrowLeft')  { e.preventDefault(); this._stepFrame(-1) }
            else if (e.key === 'ArrowRight') { e.preventDefault(); this._stepFrame(+1) }
        })
    }

    _initSliderLabels() {
        const sync = (id, valId, suffix) => {
            const el = document.getElementById(id)
            const lbl = document.getElementById(valId)
            const update = () => { lbl.textContent = el.value + suffix }
            el.addEventListener('input', update)
            update()
        }
        sync('s-width', 'width-val', ' chars')
        sync('s-max-frames', 'maxframes-val', '')
        // Video FPS: 0 = Source (no limit)
        const fpsSl  = document.getElementById('s-video-fps')
        const fpsLbl = document.getElementById('videofps-val')
        const fpsUpdate = () => { fpsLbl.textContent = fpsSl.value === '0' ? '(Source)' : fpsSl.value + ' fps' }
        fpsSl.addEventListener('input', fpsUpdate)
        fpsUpdate()
    }

    // ── File loading ──────────────────────────────────────────────────────

    _loadFile(file) {
        const isJson = file.name.toLowerCase().endsWith('.json')
        this.sourceFile  = file
        this.isJsonMode  = isJson

        // Show workspace
        document.getElementById('drop-screen').classList.add('hidden')
        document.getElementById('workspace').classList.remove('hidden')

        // Show/hide sections
        document.getElementById('convert-section').classList.toggle('hidden', isJson)
        document.getElementById('source-name').textContent = file.name
        const metaEl = document.getElementById('source-meta')
        metaEl.textContent = ''
        metaEl.classList.add('hidden')

        if (isJson) {
            document.getElementById('source-thumb').src = ''
            document.getElementById('source-thumb').classList.add('hidden')
            this._loadJSON(file)
        } else {
            const thumb = document.getElementById('source-thumb')
            const isGif   = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif')
            const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(file.name)

            if (isVideo) {
                thumb.src = ''
                thumb.classList.add('hidden')
                // Show video metadata when loaded
                this._showVideoMeta(file)
            } else if (isGif) {
                thumb.src = URL.createObjectURL(file)
                thumb.classList.remove('hidden')
                this._showGifMeta(file)
            } else {
                thumb.src = URL.createObjectURL(file)
                thumb.classList.remove('hidden')
                this._showImageMeta(file)
            }

            document.getElementById('gif-settings').classList.toggle('hidden', !isGif && !isVideo)
            document.getElementById('video-settings').classList.toggle('hidden', !isVideo)

            this._scheduleConvert()
        }
    }

    _formatDuration(secs) {
        const m = Math.floor(secs / 60)
        const s = Math.floor(secs % 60)
        return m > 0 ? `${m}m ${s}s` : `${s}s`
    }

    _setSourceMeta(text) {
        this._sourceBaseMeta = text
        const el = document.getElementById('source-meta')
        el.textContent = text
        el.classList.remove('hidden')
    }

    _appendSourceMeta(text) {
        const el = document.getElementById('source-meta')
        el.textContent = (this._sourceBaseMeta || '') + ' · ' + text
        el.classList.remove('hidden')
    }

    _showVideoMeta(file) {
        const url = URL.createObjectURL(file)
        const v   = document.createElement('video')
        v.preload = 'metadata'
        v.src     = url
        v.onloadedmetadata = () => {
            const parts = [`${v.videoWidth}×${v.videoHeight}`]
            if (v.duration && isFinite(v.duration))
                parts.push(this._formatDuration(v.duration))
            this._setSourceMeta(parts.join(' · '))
            URL.revokeObjectURL(url)
        }
        v.onerror = () => URL.revokeObjectURL(url)
    }

    async _showGifMeta(file) {
        try {
            const buf = await file.arrayBuffer()
            const gif = parseGIF(buf)
            const frames = decompressFrames(gif, true)
            const parts = [`${gif.lsd.width}×${gif.lsd.height}`, `${frames.length} frames`]
            // gf.delay is centiseconds; convert to ms with 10ms (1cs) minimum for data accuracy
            const totalMs = frames.reduce((sum, f) => sum + Math.max(10, (f.delay || 1) * 10), 0)
            parts.push(this._formatDuration(totalMs / 1000))
            this._setSourceMeta(parts.join(' · '))
        } catch { /* ignore */ }
    }

    _showImageMeta(file) {
        const url = URL.createObjectURL(file)
        const img = new Image()
        img.onload = () => {
            this._setSourceMeta(`${img.naturalWidth}×${img.naturalHeight}`)
            URL.revokeObjectURL(url)
        }
        img.onerror = () => URL.revokeObjectURL(url)
        img.src = url
    }

    async _loadJSON(file) {
        try {
            const text = await file.text()
            const data = JSON.parse(text)
            if (!data.meta || !Array.isArray(data.frames)) throw new Error('Invalid JSON format')
            this._applyData(data)
        } catch (err) {
            alert('Error loading JSON: ' + err.message)
        }
    }

    _reset() {
        clearTimeout(this._previewTimer)
        this._convertGen++
        this._pause()
        this.data       = null
        this.sourceFile = null
        this.frameCache.clear()

        document.getElementById('workspace').classList.add('hidden')
        document.getElementById('drop-screen').classList.remove('hidden')
        document.getElementById('file-input').value = ''
        document.getElementById('canvas').classList.add('hidden')
        document.getElementById('canvas-placeholder').classList.remove('hidden')
        document.getElementById('export-section').classList.add('hidden')
        document.getElementById('info-bar').textContent = ''
        const metaEl = document.getElementById('source-meta')
        metaEl.textContent = ''
        metaEl.classList.add('hidden')
        this._sourceBaseMeta = ''
    }

    // ── Conversion ────────────────────────────────────────────────────────

    _scheduleConvert() {
        if (!this.sourceFile || this.isJsonMode) return
        clearTimeout(this._previewTimer)
        this._previewTimer = setTimeout(() => this._convert(), 500)
    }

    _getConvertSettings() {
        const rampName = document.getElementById('s-ramp').value
        let ramp = RAMPS[rampName]
        if (document.getElementById('s-invert').checked) ramp = [...ramp].reverse().join('')
        return {
            width:     parseInt(document.getElementById('s-width').value) || 120,
            ramp,
            color:     document.getElementById('s-color').checked,
            maxFrames: parseInt(document.getElementById('s-max-frames').value) || 200,
            targetFps: parseInt(document.getElementById('s-video-fps').value),  // 0 = no limit (source)
        }
    }

    async _convert() {
        if (!this.sourceFile || this.isJsonMode) return
        const gen = ++this._convertGen
        const settings = this._getConvertSettings()
        const file = this.sourceFile
        const isGif   = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif')
        const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(file.name)

        this._setProgress(0, 'Loading…')
        const bench = this._bench = new Bench(`convert ${file.name}`)

        try {
            let frames, allColors, fps, charW, charH

            let frameDelays = null
            if (isGif) {
                const r = await this._convertGif(file, settings, gen)
                if (r === null) return
                ;({ frames, allColors, fps, frameDelays, charW, charH } = r)
            } else if (isVideo) {
                const r = await this._convertVideo(file, settings, gen)
                if (r === null) return
                ;({ frames, allColors, fps, charW, charH } = r)
            } else {
                const r = await this._convertImage(file, settings)
                frames   = [r.text]
                allColors = r.colors ? [r.colors] : []
                fps      = 1
                charW    = r.charW
                charH    = r.charH
            }

            if (gen !== this._convertGen) return

            const data = {
                meta: { source: file.name, charWidth: charW, charHeight: charH,
                        frameCount: frames.length, fps, hasColor: allColors.length > 0,
                        ...(frameDelays ? { frameDurations: frameDelays } : {}) },
                frames,
            }
            if (allColors.length > 0) {
                bench.start('palette')
                const pxPerFrame = charW * charH
                const { palette, paletteMap } = this._buildPalette(allColors, pxPerFrame)
                data.palette   = palette
                data.colorMaps = allColors.map(fc => Array.from(this._mapColors(fc, pxPerFrame, paletteMap)))
                bench.end('palette')
            }

            this._applyData(data)
            bench.report({
                source:     file.name,
                grid:       `${data.meta.charWidth}\u00d7${data.meta.charHeight}`,
                frames:     data.meta.frameCount,
                fps:        data.meta.fps,
                color:      data.meta.hasColor,
                fileMB:     +(file.size / 1048576).toFixed(2),
                decode_via: this._lastDecodeMethod ?? 'n/a',
            })
        } catch (err) {
            if (gen === this._convertGen) {
                console.error(err)
                alert('Conversion error: ' + err.message)
            }
        } finally {
            if (gen === this._convertGen) this._hideProgress()
        }
    }

    async _convertImage(file, { width, ramp, color }) {
        const img = await this._loadImg(file)
        const aspect = img.height / img.width
        const height = Math.max(1, Math.round(width * aspect * 0.5))
        const canvas = new OffscreenCanvas(width, height)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, width, height)
        return this._pixelsToAscii(ctx.getImageData(0, 0, width, height), width, height, ramp, color)
    }

    async _convertGif(file, { width, ramp, color, maxFrames }, gen) {
        const bench = this._bench
        const buf = await file.arrayBuffer()

        // ── Decode: try WASM first, fall back to gifuct-js ─────────────────
        bench?.start('gif.decode')
        const gifMod = await loadGifWasm()
        let gifW, gifH, charW, charH, total
        const frameDelays = []
        const imageDataBufs = []

        if (gifMod) {
            const decoded = gifMod.decode_gif(new Uint8Array(buf))
            gifW = decoded.width; gifH = decoded.height
            const aspect = gifH / gifW
            charH = Math.max(1, Math.round(width * aspect * 0.5)); charW = width
            const out  = new OffscreenCanvas(charW, charH)
            const octx = out.getContext('2d', { willReadFrequently: true })
            const src  = new OffscreenCanvas(gifW, gifH)
            const sctx = src.getContext('2d')
            const frames = decoded.frames
            total = Math.min(frames.length, maxFrames)
            for (let i = 0; i < total; i++) {
                if (gen !== this._convertGen) { bench?.end('gif.decode'); return null }
                if (i % 10 === 0) await new Promise(r => setTimeout(r, 0))
                this._setProgress(Math.round(i / total * 50), `Extracting ${i + 1}/${total}…`)
                sctx.putImageData(new ImageData(new Uint8ClampedArray(frames[i].rgba), gifW, gifH), 0, 0)
                octx.drawImage(src, 0, 0, charW, charH)
                imageDataBufs.push(octx.getImageData(0, 0, charW, charH).data)
                frameDelays.push(frames[i].delayMs)
            }
        } else {
            const gif = parseGIF(buf)
            const gifFrames = decompressFrames(gif, true)
            if (!gifFrames?.length) throw new Error('No frames found in GIF')
            gifW = gif.lsd.width; gifH = gif.lsd.height
            const aspect = gifH / gifW
            charH = Math.max(1, Math.round(width * aspect * 0.5)); charW = width
            const screen = new OffscreenCanvas(gifW, gifH)
            const sctx   = screen.getContext('2d')
            const out    = new OffscreenCanvas(charW, charH)
            const octx   = out.getContext('2d', { willReadFrequently: true })
            total = Math.min(gifFrames.length, maxFrames)
            let prev = null
            for (let i = 0; i < total; i++) {
                if (gen !== this._convertGen) { bench?.end('gif.decode'); return null }
                if (i % 10 === 0) await new Promise(r => setTimeout(r, 0))
                this._setProgress(Math.round(i / total * 50), `Extracting ${i + 1}/${total}…`)
                const gf = gifFrames[i]
                if (prev?.disposalType === 2)
                    sctx.clearRect(prev.dims.left, prev.dims.top, prev.dims.width, prev.dims.height)
                const patch = new OffscreenCanvas(gf.dims.width, gf.dims.height)
                patch.getContext('2d').putImageData(new ImageData(gf.patch, gf.dims.width, gf.dims.height), 0, 0)
                sctx.drawImage(patch, gf.dims.left, gf.dims.top)
                octx.drawImage(screen, 0, 0, charW, charH)
                imageDataBufs.push(octx.getImageData(0, 0, charW, charH).data)
                // gf.delay is centiseconds. Apply browser-compatible minimum:
                // delays < 2cs (20ms) are treated as 10cs (100ms), matching
                // real browser GIF rendering behaviour for "fast" frames.
                const rawCs = gf.delay ?? 0
                frameDelays.push(rawCs < 2 ? 100 : rawCs * 10)
                prev = gf
            }
        }
        bench?.end('gif.decode')
        if (gen !== this._convertGen) return null

        // ── Process: parallel workers (CPU/SIMD via WASM) ──────────────────
        bench?.start('process')
        const { frames, allColors } = await this._processFrames(
            imageDataBufs, charW, charH, ramp, color, gen,
            (n) => this._setProgress(50 + Math.round(n / total * 50), `Processing ${n}/${total}…`)
        )
        bench?.end('process')
        if (frames === null) return null

        const totalDur = frameDelays.reduce((a, b) => a + b, 0)
        const fps = Math.max(1, Math.round(1000 / (totalDur / total)))
        this._appendSourceMeta(`${fps} fps`)
        return { frames, allColors, fps, frameDelays, charW, charH }
    }

    async _convertVideo(file, { width, ramp, color, maxFrames, targetFps }, gen) {
        const bench = this._bench
        const limitFps = targetFps  // 0 = no limit, >0 = hard cap

        // Probe metadata up front (needed by both decode paths to size the grid).
        const meta = await new Promise((res, rej) => {
            const v = document.createElement('video')
            v.preload = 'metadata'; v.muted = true
            v.src = URL.createObjectURL(file)
            v.onloadedmetadata = () => res({
                vw: v.videoWidth, vh: v.videoHeight, dur: v.duration, url: v.src,
            })
            v.onerror = () => rej(new Error('Failed to load video metadata'))
        })
        if (!meta.dur || !isFinite(meta.dur)) throw new Error('Cannot determine video duration')
        const aspect = meta.vh / meta.vw
        const charH  = Math.max(1, Math.round(width * aspect * 0.5))
        const charW  = width

        // ── Try WebCodecs first (deterministic, true source fps) ──────────
        bench?.start('video.decode')
        this._lastDecodeMethod = 'webcodecs'
        let captured = await decodeVideoWebCodecs(
            file, charW, charH, maxFrames, limitFps,
            (n, total) => this._setProgress(Math.round(n / Math.max(1, total) * 50), `Decoding ${n}…`)
        ).catch(e => { console.warn('[webcodecs] failed:', e?.message); return null })

        // ── Fallback: existing RVFC / seek pipeline ───────────────────────
        if (!captured) {
            const url   = URL.createObjectURL(file)
            const video = document.createElement('video')
            video.src = url; video.muted = true; video.preload = 'metadata'
            await new Promise((res, rej) => {
                video.onloadedmetadata = res
                video.onerror = () => rej(new Error('Failed to load video metadata'))
            })
            const canvas = new OffscreenCanvas(charW, charH)
            const ctx    = canvas.getContext('2d', { willReadFrequently: true })
            const useRvfc = ('requestVideoFrameCallback' in video)
            this._lastDecodeMethod = useRvfc ? 'rvfc' : 'seek'
            console.log(`[video] capture: ${this._lastDecodeMethod}, limitFps=${limitFps || 'source'}`)
            captured = useRvfc
                ? await this._captureRVFC(video, ctx, charW, charH, meta.dur, maxFrames, limitFps, gen)
                : await this._captureSeek(video, ctx, charW, charH, meta.dur, maxFrames, limitFps, gen)
            URL.revokeObjectURL(url)
        }
        bench?.end('video.decode')
        URL.revokeObjectURL(meta.url)
        if (!captured) return null

        const { imageDataBufs, outputFps, sourceFps } = captured
        const total = imageDataBufs.length
        bench?.start('process')
        const { frames, allColors } = await this._processFrames(
            imageDataBufs, charW, charH, ramp, color, gen,
            (n) => this._setProgress(50 + Math.round(n / total * 50), `Processing ${n}/${total}…`)
        )
        bench?.end('process')
        if (frames === null) return null
        const fpsMeta = sourceFps !== outputFps
            ? `${sourceFps} fps source · ${outputFps} fps output`
            : `${sourceFps} fps`
        this._appendSourceMeta(`${fpsMeta} · ${total} frames`)
        return { frames, allColors, fps: outputFps, charW, charH }
    }

    // Snap raw fps to nearest standard video frame rate.
    static _STANDARD_FPS = [10, 12, 15, 20, 23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60]
    _snapToStandardFps(rawFps) {
        let best = rawFps, bestDist = Infinity
        for (const std of this.constructor._STANDARD_FPS) {
            const d = Math.abs(rawFps - std)
            if (d < bestDist) { bestDist = d; best = std }
        }
        // Only snap if within 8% of a standard rate
        return bestDist / best < 0.08 ? Math.round(best) : Math.round(rawFps)
    }

    // Capture via requestVideoFrameCallback — plays at speed, no seeking.
    // Detects source fps from frame deltas using median of 15+ probes;
    // snaps to nearest standard frame rate. Chrome 83+, Edge 83+, Safari 15.4+.
    _captureRVFC(video, ctx, charW, charH, duration, maxFrames, limitFps, gen) {
        return new Promise(resolve => {
            const imageDataBufs = []
            let lastCapturedTime = -Infinity
            // 0 = capture every frame initially; >0 = enforce interval
            let targetInterval = limitFps > 0 ? 1 / limitFps : 0
            let watchdogId = null
            const fpsProbes = []
            let detectedFps = null
            let prevMediaTime = -Infinity

            const finish = () => {
                clearTimeout(watchdogId)
                video.onended   = null
                video.onerror   = null
                video.onstalled = null
                video.pause()
                if (!imageDataBufs.length) { resolve(null); return }
                // outputFps: use detected source fps (or measured from count/duration),
                // clamped to limitFps if set, and never implying more frames than we have.
                const sourceFps   = detectedFps ?? Math.round(imageDataBufs.length / duration)
                const capFps      = limitFps > 0 ? Math.min(limitFps, sourceFps) : sourceFps
                const outputFps   = Math.max(1, capFps)
                resolve({ imageDataBufs, outputFps, sourceFps })
            }

            const resetWatchdog = () => {
                clearTimeout(watchdogId)
                watchdogId = setTimeout(() => {
                    console.warn('[RVFC] no progress for 3s — finishing with collected frames')
                    finish()
                }, 3000)
            }

            const onFrame = (_, metadata) => {
                if (gen !== this._convertGen) { finish(); return }
                resetWatchdog()

                // Probe source fps from early frame deltas using median
                if (prevMediaTime > -Infinity && detectedFps === null) {
                    const delta = metadata.mediaTime - prevMediaTime
                    if (delta > 0.005 && delta < 0.5) fpsProbes.push(delta)
                    if (fpsProbes.length >= 15) {
                        // Use median (robust to outlier frames)
                        const sorted = [...fpsProbes].sort((a, b) => a - b)
                        const mid = sorted.length >> 1
                        const median = sorted.length & 1
                            ? sorted[mid]
                            : (sorted[mid - 1] + sorted[mid]) / 2
                        const rawFps = 1 / median
                        detectedFps = this._snapToStandardFps(rawFps)
                        console.log(`[RVFC] detected source fps: ${detectedFps} (raw ${rawFps.toFixed(2)}, ${fpsProbes.length} probes, median delta ${(median*1000).toFixed(1)}ms)`)
                        // If no limit and source would exceed maxFrames, spread evenly
                        if (limitFps === 0 && duration * detectedFps > maxFrames) {
                            targetInterval = duration / maxFrames
                            console.log(`[RVFC] maxFrames throttle: interval=${targetInterval.toFixed(3)}s`)
                        }
                    }
                }
                prevMediaTime = metadata.mediaTime

                if (metadata.mediaTime - lastCapturedTime >= targetInterval - 0.001) {
                    lastCapturedTime = metadata.mediaTime
                    ctx.drawImage(video, 0, 0, charW, charH)
                    imageDataBufs.push(ctx.getImageData(0, 0, charW, charH).data)
                    this._setProgress(
                        Math.min(49, Math.round(imageDataBufs.length / Math.max(1, duration * (detectedFps ?? 30)) * 50)),
                        `Extracting frame ${imageDataBufs.length}…`
                    )
                }

                if (!video.ended && imageDataBufs.length < maxFrames) {
                    video.requestVideoFrameCallback(onFrame)
                } else {
                    finish()
                }
            }

            video.onended   = () => finish()
            video.onerror   = () => resolve(imageDataBufs.length ? { imageDataBufs, outputFps: detectedFps ?? 1, sourceFps: detectedFps ?? 1 } : null)
            video.onstalled = () => resetWatchdog()
            video.requestVideoFrameCallback(onFrame)
            video.playbackRate = 8
            resetWatchdog()
            video.play().catch(() => finish())
        })
    }

    // Capture by seeking to each timestamp — universal fallback.
    // limitFps=0 means use source fps; inferred as min(30, maxFrames/duration) since
    // HTML video elements don't expose source fps directly.
    async _captureSeek(video, ctx, charW, charH, duration, maxFrames, limitFps, gen) {
        // Determine fps to use
        const maxFpsFromFrames = maxFrames / duration
        const seekFps = limitFps > 0
            ? Math.min(limitFps, maxFpsFromFrames)
            : Math.min(30, maxFpsFromFrames)  // assume up to 30fps source
        const totalFrames = Math.max(1, Math.round(duration * seekFps))
        const outputFps   = Math.max(1, Math.round(seekFps))
        const sourceFps   = outputFps  // seek fallback has no independent source-fps detection

        const imageDataBufs = []
        for (let i = 0; i < totalFrames; i++) {
            if (gen !== this._convertGen) return null
            if (i % 5 === 0) await new Promise(r => setTimeout(r, 0))
            this._setProgress(Math.round(i / totalFrames * 50), `Extracting ${i + 1}/${totalFrames}…`)

            video.currentTime = i / seekFps
            await new Promise(res => { video.onseeked = res })

            ctx.drawImage(video, 0, 0, charW, charH)
            imageDataBufs.push(ctx.getImageData(0, 0, charW, charH).data)
        }
        return { imageDataBufs, outputFps, sourceFps }
    }

    // Process pixel buffers in parallel via Web Workers.
    // Falls back to single-threaded _pixelsToAscii if workers unavailable.
    async _processFrames(imageDataBufs, charW, charH, ramp, color, gen, progressCb) {
        const pool = _getWorkerPool()
        if (pool) {
            let completed = 0
            const promises = imageDataBufs.map((pixels, idx) =>
                pool.submit(pixels, charW, charH, ramp, color, idx).then(result => {
                    progressCb?.(++completed)
                    return result
                })
            )
            const results = await Promise.all(promises)
            if (gen !== this._convertGen) return { frames: null, allColors: null }
            return {
                frames:    results.map(r => r.text),
                allColors: results.map(r => r.colorKeys).filter(Boolean),
            }
        }

        // Workers unavailable — single-threaded fallback
        const frames = [], allColors = []
        for (let i = 0; i < imageDataBufs.length; i++) {
            if (gen !== this._convertGen) return { frames: null, allColors: null }
            const ascii = this._pixelsToAscii({ data: imageDataBufs[i] }, charW, charH, ramp, color)
            frames.push(ascii.text)
            if (ascii.colorKeys) allColors.push(ascii.colorKeys)
            progressCb?.(i + 1)
        }
        return { frames, allColors }
    }

    _pixelsToAscii(imageData, width, height, ramp, color) {
        // Cache charLut + lut — only rebuilt when the ramp string changes
        let charLut, lut
        if (this._rampCache.ramp === ramp) {
            charLut = this._rampCache.charLut
            lut     = this._rampCache.lut
        } else {
            charLut = Array.from(ramp)
            const rampLen0 = charLut.length
            lut = new Uint8Array(256)
            for (let b = 0; b < 256; b++)
                lut[b] = Math.min((b * rampLen0) >> 8, rampLen0 - 1)
            this._rampCache = { ramp, charLut, lut }
        }
        const rampLen = charLut.length
        const totalPx = width * height

        // ── WASM SIMD path (preferred when available) ──────────────────
        const wasm = this._asciiWasm
        if (wasm && wasm.encode_frame) {
            try {
                const colorOut = color ? new Uint8Array(totalPx * 3) : null
                const idx = wasm.encode_frame(imageData.data, width, height, rampLen, colorOut ?? undefined)
                const colorKeys = colorOut ? new Uint16Array(totalPx) : null
                if (colorKeys) {
                    for (let p = 0, ci = 0; p < totalPx; p++, ci += 3)
                        colorKeys[p] = ((colorOut[ci] & 0xF0) << 8) | ((colorOut[ci+1] & 0xF0) << 4) | (colorOut[ci+2] >> 4)
                }
                const lineBuf = new Array(width)
                const lines = new Array(height)
                for (let y = 0; y < height; y++) {
                    const rowOff = y * width
                    for (let x = 0; x < width; x++) lineBuf[x] = charLut[idx[rowOff + x]]
                    lines[y] = lineBuf.join('')
                }
                return { text: lines.join('\n'), colorKeys, charW: width, charH: height }
            } catch (e) { console.warn('[wasm] encode_frame failed, falling back:', e?.message) }
        }

        // ── GPU path ──────────────────────────────────────────────
        const gpuOut = _gpuEncoder.encode(imageData, width, height, rampLen)
        if (gpuOut) {
            const colorKeys = color ? new Uint16Array(totalPx) : null
            const lineBuf = new Array(width)
            const lines = new Array(height)
            for (let y = 0; y < height; y++) {
                const rowOff = y * width
                for (let x = 0; x < width; x++) {
                    const i = (rowOff + x) * 4
                    lineBuf[x] = charLut[gpuOut[i]]
                    if (colorKeys) {
                        const r = gpuOut[i+1], g = gpuOut[i+2], b = gpuOut[i+3]
                        colorKeys[rowOff + x] = ((r & 0xF0) << 8) | ((g & 0xF0) << 4) | (b >> 4)
                    }
                }
                lines[y] = lineBuf.join('')
            }
            return { text: lines.join('\n'), colorKeys, charW: width, charH: height }
        }

        // ── CPU fallback ─────────────────────────────────────────────────
        const d = imageData.data
        const colorKeys = color ? new Uint16Array(totalPx) : null
        const lineBuf = new Array(width)
        const lines = new Array(height)
        for (let y = 0; y < height; y++) {
            const rowOff = y * width
            for (let x = 0; x < width; x++) {
                const i = (rowOff + x) * 4
                const r = d[i], g = d[i+1], b = d[i+2]
                lineBuf[x] = charLut[lut[(r * 77 + g * 150 + b * 29) >> 8]]
                if (colorKeys) colorKeys[rowOff + x] = ((r & 0xF0) << 8) | ((g & 0xF0) << 4) | (b >> 4)
            }
            lines[y] = lineBuf.join('')
        }
        return { text: lines.join('\n'), colorKeys, charW: width, charH: height }
    }

    _buildPalette(allColorKeys, pixelsPerFrame) {
        // allColorKeys: Uint16Array[] — each value is a pre-quantized 12-bit key
        // ((r&0xF0)<<8)|((g&0xF0)<<4)|(b>>4), emitted directly by workers.
        // No re-quantization needed here; just collect unique keys.
        const seen = new Set()
        for (const keys of allColorKeys) {
            for (let p = 0; p < pixelsPerFrame; p++) seen.add(keys[p])
        }
        const sorted = [...seen].sort((a, b) => a - b)
        const palette = sorted.map(k => {
            const r = (k >> 8) & 0xF0, g = (k >> 4) & 0xF0, b = (k & 0xF) << 4
            return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`
        })
        const paletteMap = new Map(sorted.map((k, i) => [k, i]))
        return { palette, paletteMap }
    }

    _mapColors(colorKeys, pixelsPerFrame, paletteMap) {
        // colorKeys is already a Uint16Array of pre-quantized keys — map directly to palette indices.
        const out = new Uint16Array(pixelsPerFrame)
        for (let p = 0; p < pixelsPerFrame; p++) out[p] = paletteMap.get(colorKeys[p]) ?? 0
        return out
    }

    _setProgress(pct, text) {
        const bar = document.getElementById('progress-bar')
        bar.classList.remove('hidden')
        document.getElementById('progress-fill').style.width = pct + '%'
        document.getElementById('progress-text').textContent = text
    }
    _hideProgress() { document.getElementById('progress-bar').classList.add('hidden') }

    // ── Data → Viewer ─────────────────────────────────────────────────────

    _applyData(data) {
        this._pause()
        this.data = data
        this.frameCache.clear()
        this.currentFrame = 0

        // Update source-color availability
        const hasColor = data.meta.hasColor && data.palette && data.colorMaps
        const opt = document.querySelector('#render-mode [value="source-color"]')
        opt.disabled = !hasColor
        opt.textContent = hasColor ? 'Source Colors' : 'Source Colors (not in file)'
        if (!hasColor && this.renderMode === 'source-color') {
            this.renderMode = 'mono'
            document.getElementById('render-mode').value = 'mono'
        }

        // Show canvas, hide placeholder
        document.getElementById('canvas-placeholder').classList.add('hidden')
        document.getElementById('canvas').classList.remove('hidden')

        // Show export section
        if (!this.isJsonMode) {
            document.getElementById('export-section').classList.remove('hidden')
            // Fast size estimate — avoids serializing the full data object on every conversion.
            // Actual JSON size is computed only on download (user-triggered).
            const textBytes  = data.frames.reduce((s, f) => s + f.length, 0)
            const colorBytes = data.colorMaps
                ? data.meta.frameCount * data.meta.charWidth * data.meta.charHeight * 2
                : 0
            const palBytes   = data.palette ? data.palette.length * 10 : 0
            const sizeKB     = ((textBytes + colorBytes + palBytes + 200) / 1024).toFixed(1)
            const clr        = data.meta.hasColor ? `, ${data.palette.length} colors` : ''
            document.getElementById('export-info').textContent =
                `${data.meta.frameCount} frame(s) · ${data.meta.charWidth}×${data.meta.charHeight} · ~${sizeKB} KB${clr}`
        }

        this._updateCanvasSize()
        this._renderFrame(0)
        this._updateInfo()
        if (data.meta.frameCount > 1) this._play()
    }

    // ── Canvas rendering ──────────────────────────────────────────────────

    _updateCanvasSize() {
        const canvas = document.getElementById('canvas')
        const ctx    = canvas.getContext('2d')
        ctx.font     = this.font
        this.charWidth = ctx.measureText('M').width

        const pw = Math.ceil(this.charWidth * this.data.meta.charWidth) + 4
        const ph = this.lineHeight * this.data.meta.charHeight + 4
        const dpr = window.devicePixelRatio || 1

        canvas.width  = pw * dpr
        canvas.height = ph * dpr
        canvas.style.width  = pw + 'px'
        canvas.style.height = ph + 'px'
        ctx.scale(dpr, dpr)

        this._canvasW = pw
        this._canvasH = ph
        this._ctx     = ctx
    }

    _getLines(index) {
        if (this.frameCache.has(index)) return this.frameCache.get(index)
        const prepared = prepareWithSegments(this.data.frames[index], this.font, { whiteSpace: 'pre-wrap' })
        const { lines } = layoutWithLines(prepared, this._canvasW * 2, this.lineHeight)
        this.frameCache.set(index, lines)
        return lines
    }

    _renderFrame(index) {
        this.currentFrame = index
        const lines = this._getLines(index)
        const ctx   = this._ctx
        const w = this._canvasW, h = this._canvasH
        const useSrcColor = this.renderMode === 'source-color' &&
            this.data.meta.hasColor && this.data.palette && this.data.colorMaps

        // Background
        const bg = useSrcColor ? (this.lightMode ? '#f5f5f0' : '#0a0a0a') : this.bgColor
        ctx.fillStyle = bg
        ctx.fillRect(0, 0, w, h)
        ctx.font = this.font
        ctx.textBaseline = 'top'

        if (useSrcColor) {
            this._renderColor(ctx, lines, index)
        } else {
            ctx.fillStyle = this.fgColor
            for (let i = 0; i < lines.length; i++)
                ctx.fillText(lines[i].text, 2, 2 + i * this.lineHeight)
        }

        document.getElementById('frame-info').textContent =
            `${this.currentFrame + 1} / ${this.data.meta.frameCount}`
    }

    _renderColor(ctx, lines, frameIndex) {
        const palette  = this.data.palette
        const colorMap = this.data.colorMaps[frameIndex]
        if (!colorMap) { ctx.fillStyle = this.fgColor; for (const l of lines) ctx.fillText(l.text, 2, 2 + lines.indexOf(l) * this.lineHeight); return }

        const cw = this.charWidth
        let offset = 0

        for (let i = 0; i < lines.length; i++) {
            const text = lines[i].text
            const y = 2 + i * this.lineHeight
            let batchStart = 0
            let batchColor = offset < colorMap.length ? palette[colorMap[offset]] : this.fgColor

            for (let j = 0; j < text.length; j++) {
                const c = (offset + j) < colorMap.length ? palette[colorMap[offset + j]] : this.fgColor
                if (c !== batchColor) {
                    ctx.fillStyle = batchColor
                    ctx.fillText(text.slice(batchStart, j), 2 + batchStart * cw, y)
                    batchStart = j; batchColor = c
                }
            }
            ctx.fillStyle = batchColor
            ctx.fillText(text.slice(batchStart), 2 + batchStart * cw, y)
            offset += text.length
        }
    }

    _updateInfo() {
        const m = this.data.meta
        let t = `${m.source} · ${m.charWidth}×${m.charHeight} chars · ${m.frameCount} frame(s) · ${m.fps} fps`
        if (m.hasColor && this.data.palette) t += ` · ${this.data.palette.length} colors`
        document.getElementById('info-bar').textContent = t
    }

    // ── Playback ──────────────────────────────────────────────────────────

    _play() {
        if (!this.data || this.data.meta.frameCount <= 1) return
        this.playing = true
        document.getElementById('btn-play').textContent = '⏸'
        this.lastFrameTime = performance.now()
        this._playbackBench.reset()
        this._tick()
    }

    _pause() {
        this.playing = false
        const btn = document.getElementById('btn-play')
        if (btn) btn.textContent = '▶'
        if (this.animationId) { cancelAnimationFrame(this.animationId); this.animationId = null }
    }

    _togglePlay() { if (this.playing) this._pause(); else this._play() }

    _stepFrame(delta) {
        if (!this.data) return
        this._pause()
        const n = this.data.meta.frameCount
        this._renderFrame((this.currentFrame + delta + n) % n)
    }

    _tick() {
        if (!this.playing) return
        const now = performance.now()
        const fd = this.data.meta.frameDurations
        // Use per-frame duration if available (GIFs can have variable delays),
        // otherwise fall back to uniform fps.
        const baseDuration = fd ? fd[this.currentFrame] : (1000 / this.data.meta.fps)
        const interval = baseDuration / this.speedMultiplier
        if (now - this.lastFrameTime >= interval) {
            const t0 = performance.now()
            this._renderFrame((this.currentFrame + 1) % this.data.meta.frameCount)
            this._playbackBench.onFrame(performance.now() - t0)
            // Use += to keep drift-free timing instead of resetting to now.
            // Cap so we don't spiral into catch-up bursts after tab suspension.
            this.lastFrameTime += interval
            if (this.lastFrameTime < now - interval) this.lastFrameTime = now
        }
        this.animationId = requestAnimationFrame(() => this._tick())
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    _loadImg(file) {
        return new Promise((res, rej) => {
            const img = new Image()
            img.onload = () => res(img)
            img.onerror = () => rej(new Error('Failed to load image'))
            img.src = URL.createObjectURL(file)
        })
    }

    _download() {
        if (!this.data) return
        const blob = new Blob([JSON.stringify(this.data)], { type: 'application/json' })
        const url  = URL.createObjectURL(blob)
        const a    = document.createElement('a')
        a.href     = url
        a.download = this.sourceFile.name.replace(/\.[^.]+$/, '') + '.json'
        a.click()
        URL.revokeObjectURL(url)
    }
}

new App()
