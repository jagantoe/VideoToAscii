import { layoutWithLines, prepareWithSegments } from '@chenglou/pretext'
import { decompressFrames, parseGIF } from 'gifuct-js'

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
        this.renderMode  = 'mono'
        this.lightMode   = false

        // Conversion
        this._convertGen   = 0
        this._previewTimer = null

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
        sync('s-video-fps', 'videofps-val', ' fps')
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
            } else {
                thumb.src = URL.createObjectURL(file)
                thumb.classList.remove('hidden')
            }

            document.getElementById('gif-settings').classList.toggle('hidden', !isGif && !isVideo)
            document.getElementById('video-settings').classList.toggle('hidden', !isVideo)

            this._scheduleConvert()
        }
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
            targetFps: parseInt(document.getElementById('s-video-fps').value) || 10,
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

        try {
            let frames, allColors, fps, charW, charH

            if (isGif) {
                const r = await this._convertGif(file, settings, gen)
                console.log('Conversion result:', r)
                if (r === null) return
                ;({ frames, allColors, fps, charW, charH } = r)
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
                        frameCount: frames.length, fps, hasColor: allColors.length > 0 },
                frames,
            }
            if (allColors.length > 0) {
                const pxPerFrame = charW * charH
                const { palette, paletteMap } = this._buildPalette(allColors, pxPerFrame)
                data.palette   = palette
                data.colorMaps = allColors.map(fc => Array.from(this._mapColors(fc, pxPerFrame, paletteMap)))
            }

            this._applyData(data)
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
        const buf = await file.arrayBuffer()
        const gif = parseGIF(buf)
        const gifFrames = decompressFrames(gif, true)
        if (!gifFrames?.length) throw new Error('No frames found in GIF')

        const gifW = gif.lsd.width, gifH = gif.lsd.height
        const aspect = gifH / gifW
        const charH = Math.max(1, Math.round(width * aspect * 0.5))
        const charW = width

        const screen = new OffscreenCanvas(gifW, gifH)
        const sctx   = screen.getContext('2d')
        const total  = Math.min(gifFrames.length, maxFrames)
        const frames = [], allColors = []
        let totalDur = 0, prev = null

        for (let i = 0; i < total; i++) {
            if (gen !== this._convertGen) return null
            if (i % 5 === 0) await new Promise(r => setTimeout(r, 0))
            this._setProgress(Math.round(i / total * 100), `Frame ${i + 1}/${total}`)

            const gf = gifFrames[i]
            if (prev?.disposalType === 2)
                sctx.clearRect(prev.dims.left, prev.dims.top, prev.dims.width, prev.dims.height)

            const patch = new OffscreenCanvas(gf.dims.width, gf.dims.height)
            patch.getContext('2d').putImageData(new ImageData(gf.patch, gf.dims.width, gf.dims.height), 0, 0)
            sctx.drawImage(patch, gf.dims.left, gf.dims.top)

            const out = new OffscreenCanvas(charW, charH)
            const octx = out.getContext('2d')
            octx.drawImage(screen, 0, 0, charW, charH)

            const ascii = this._pixelsToAscii(octx.getImageData(0, 0, charW, charH), charW, charH, ramp, color)
            frames.push(ascii.text)
            if (ascii.colors) allColors.push(ascii.colors)
            totalDur += Math.max(20, gf.delay || 20)  // gifuct-js returns ms; minimum 20ms matches browser
            prev = gf
        }

        const fps = Math.max(1, Math.round(1000 / (totalDur / total)))
        return { frames, allColors, fps, charW, charH }
    }

    async _convertVideo(file, { width, ramp, color, maxFrames, targetFps }, gen) {
        const url   = URL.createObjectURL(file)
        const video = document.createElement('video')
        video.src   = url
        video.muted = true
        video.preload = 'metadata'

        await new Promise((res, rej) => {
            video.onloadedmetadata = res
            video.onerror = () => rej(new Error('Failed to load video metadata'))
        })

        const duration = video.duration
        if (!duration || !isFinite(duration)) throw new Error('Cannot determine video duration')

        const totalFrames = Math.min(Math.floor(duration * targetFps), maxFrames)
        if (totalFrames === 0) throw new Error('No frames to extract')

        const aspect = video.videoHeight / video.videoWidth
        const charH  = Math.max(1, Math.round(width * aspect * 0.5))
        const charW  = width

        const canvas = new OffscreenCanvas(charW, charH)
        const ctx    = canvas.getContext('2d')
        const frames = [], allColors = []

        for (let i = 0; i < totalFrames; i++) {
            if (gen !== this._convertGen) { URL.revokeObjectURL(url); return null }
            if (i % 5 === 0) await new Promise(r => setTimeout(r, 0))
            this._setProgress(Math.round(i / totalFrames * 100), `Frame ${i + 1}/${totalFrames}`)

            video.currentTime = i / targetFps
            await new Promise(res => { video.onseeked = res })

            ctx.drawImage(video, 0, 0, charW, charH)
            const ascii = this._pixelsToAscii(ctx.getImageData(0, 0, charW, charH), charW, charH, ramp, color)
            frames.push(ascii.text)
            if (ascii.colors) allColors.push(ascii.colors)
        }

        URL.revokeObjectURL(url)
        return { frames, allColors, fps: targetFps, charW, charH }
    }

    _pixelsToAscii(imageData, width, height, ramp, color) {
        // Pre-build char lookup: index → character (handles multi-byte Unicode ramp chars)
        const charLut = Array.from(ramp)
        const rampLen = ramp.length
        const totalPx = width * height

        // ── GPU path ─────────────────────────────────────────────────────
        const gpuOut = _gpuEncoder.encode(imageData, width, height, rampLen)
        if (gpuOut) {
            const colorBuf = color ? new Uint8Array(totalPx * 3) : null
            const lineBuf = new Array(width)
            const lines = new Array(height)
            for (let y = 0; y < height; y++) {
                const rowOff = y * width
                for (let x = 0; x < width; x++) {
                    const i = (rowOff + x) * 4
                    lineBuf[x] = charLut[gpuOut[i]]
                    if (colorBuf) {
                        const ci = (rowOff + x) * 3
                        colorBuf[ci] = gpuOut[i+1]; colorBuf[ci+1] = gpuOut[i+2]; colorBuf[ci+2] = gpuOut[i+3]
                    }
                }
                lines[y] = lineBuf.join('')
            }
            return { text: lines.join('\n'), colors: colorBuf, charW: width, charH: height }
        }

        // ── CPU fallback ─────────────────────────────────────────────────
        const lut = new Uint8Array(256)
        for (let b = 0; b < 256; b++)
            lut[b] = Math.min((b * rampLen) >> 8, rampLen - 1)

        const d = imageData.data
        const colorBuf = color ? new Uint8Array(totalPx * 3) : null
        const lineBuf = new Array(width)
        const lines = new Array(height)
        for (let y = 0; y < height; y++) {
            const rowOff = y * width
            for (let x = 0; x < width; x++) {
                const i = (rowOff + x) * 4
                const r = d[i], g = d[i+1], b = d[i+2]
                lineBuf[x] = charLut[lut[(r * 77 + g * 150 + b * 29) >> 8]]
                if (colorBuf) {
                    const ci = (rowOff + x) * 3
                    colorBuf[ci] = r; colorBuf[ci+1] = g; colorBuf[ci+2] = b
                }
            }
            lines[y] = lineBuf.join('')
        }
        return { text: lines.join('\n'), colors: colorBuf, charW: width, charH: height }
    }

    _buildPalette(allColors, pixelsPerFrame) {
        // Use integer key: quantized (r4<<8|g4)<<8|b4 — avoids string allocation
        const seen = new Set()
        for (const buf of allColors) {
            for (let i = 0, len = pixelsPerFrame * 3; i < len; i += 3) {
                const k = ((buf[i] & 0xF0) << 8) | ((buf[i + 1] & 0xF0) << 4) | (buf[i + 2] >> 4)
                seen.add(k)
            }
        }
        const sorted = [...seen].sort((a, b) => a - b)
        const palette = sorted.map(k => {
            const r = (k >> 8) & 0xF0, g = (k >> 4) & 0xF0, b = (k & 0xF) << 4
            return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`
        })
        const paletteMap = new Map(sorted.map((k, i) => [k, i]))
        return { palette, paletteMap }
    }

    _mapColors(colorBuf, pixelsPerFrame, paletteMap) {
        const out = new Uint16Array(pixelsPerFrame)
        for (let p = 0, ci = 0; p < pixelsPerFrame; p++, ci += 3) {
            const k = ((colorBuf[ci] & 0xF0) << 8) | ((colorBuf[ci + 1] & 0xF0) << 4) | (colorBuf[ci + 2] >> 4)
            out[p] = paletteMap.get(k)
        }
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
            const jsonStr = JSON.stringify(data)
            const sizeKB  = (new Blob([jsonStr]).size / 1024).toFixed(1)
            const clr     = data.meta.hasColor ? `, ${data.palette.length} colors` : ''
            document.getElementById('export-info').textContent =
                `${data.meta.frameCount} frame(s) · ${data.meta.charWidth}×${data.meta.charHeight} · ${sizeKB} KB${clr}`
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
        const interval = 1000 / (this.data.meta.fps * this.speedMultiplier)
        if (now - this.lastFrameTime >= interval) {
            this._renderFrame((this.currentFrame + 1) % this.data.meta.frameCount)
            this.lastFrameTime = now
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
