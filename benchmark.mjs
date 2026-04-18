#!/usr/bin/env node
/**
 * Benchmark script for the ASCII conversion pipeline.
 * Extracts frames from sample_video.mp4 via a Python/OpenCV helper,
 * then benchmarks:
 *   1. _pixelsToAscii  (CPU path — the hot loop)
 *   2. _buildPalette   (post-conversion palette building)
 *   3. _mapColors      (per-frame palette index mapping)
 *
 * Usage:  node benchmark.mjs
 * Requires: Python + opencv-python (pip install opencv-python)
 */

import { execFileSync } from 'child_process'
import { existsSync, readFileSync, unlinkSync } from 'fs'

// ── Settings (max quality) ─────────────────────────────────────────────────
const INPUT      = 'sample_video.mp4'
const WIDTH      = 300          // max width slider
const TARGET_FPS = 30           // highest FPS
const RAMP       = " .·:;!|ilI1][tf{jrxnuvczXYJ()Cüö0Oqpdb$m#MW&8%B@Ñ"   // detailed
const COLOR      = true
const RAW_FILE   = '_bench_frames.bin'
const META_FILE  = '_bench_meta.json'

if (!existsSync(INPUT)) { console.error(`Missing ${INPUT}`); process.exit(1) }

// ── Extract frames via Python/OpenCV ──────────────────────────────────────
const pyScript = `
import cv2, json, sys, struct
cap = cv2.VideoCapture("${INPUT}")
if not cap.isOpened():
    print("Cannot open video", file=sys.stderr); sys.exit(1)

video_fps = cap.get(cv2.CAP_PROP_FPS) or 30
vw = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
vh = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
target_fps = ${TARGET_FPS}
char_w = ${WIDTH}
aspect = vh / vw
char_h = max(1, round(char_w * aspect * 0.5))
frame_interval = max(1, round(video_fps / target_fps))

frames_raw = bytearray()
count = 0
idx = 0
while True:
    ret, frame = cap.read()
    if not ret: break
    if idx % frame_interval == 0:
        resized = cv2.resize(frame, (char_w, char_h))
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGBA)
        frames_raw.extend(rgb.tobytes())
        count += 1
    idx += 1
cap.release()

with open("${RAW_FILE}", "wb") as f:
    f.write(frames_raw)
with open("${META_FILE}", "w") as f:
    json.dump({"w": char_w, "h": char_h, "count": count, "fps": target_fps}, f)
print(f"Extracted {count} frames ({len(frames_raw)/1024/1024:.1f} MB)")
`

console.log('Extracting frames via Python/OpenCV …')
try {
    const out = execFileSync('python', ['-c', pyScript], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
    console.log(out.trim())
} catch (e) {
    console.error('Frame extraction failed. Make sure opencv-python is installed:')
    console.error('  pip install opencv-python')
    console.error(e.stderr || e.message)
    process.exit(1)
}

const meta = JSON.parse(readFileSync(META_FILE, 'utf8'))
const rawBuf = readFileSync(RAW_FILE)
// Cleanup temp files
try { unlinkSync(RAW_FILE); unlinkSync(META_FILE) } catch {}

const { w: charW, h: charH, count: frameCount } = meta
const frameSize = charW * charH * 4
console.log(`ASCII grid: ${charW}×${charH}, ${frameCount} frames\n`)

// ── Build fake ImageData objects ──────────────────────────────────────────
const frameDataList = []
for (let f = 0; f < frameCount; f++) {
    const offset = f * frameSize
    const data = new Uint8ClampedArray(rawBuf.buffer, rawBuf.byteOffset + offset, frameSize)
    frameDataList.push({ data, width: charW, height: charH })
}

// ══════════════════════════════════════════════════════════════════════════
// Functions under test — copied from app.js (CPU path only)
// ══════════════════════════════════════════════════════════════════════════

function pixelsToAscii(imageData, width, height, ramp, color) {
    const charLut = Array.from(ramp)
    const rampLen = ramp.length
    const lut = new Uint8Array(256)
    for (let b = 0; b < 256; b++)
        lut[b] = Math.min(Math.floor(b / 256 * rampLen), rampLen - 1)

    const d = imageData.data
    const lines = [], colors = color ? [] : null
    for (let y = 0; y < height; y++) {
        let line = ''
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4
            const r = d[i], g = d[i + 1], b = d[i + 2]
            line += charLut[lut[Math.round(0.299 * r + 0.587 * g + 0.114 * b)]]
            if (colors) colors.push([r, g, b])
        }
        lines.push(line)
    }
    return { text: lines.join('\n'), colors, charW: width, charH: height }
}

function quantKey(r, g, b) {
    const qr = (r >> 4) << 4, qg = (g >> 4) << 4, qb = (b >> 4) << 4
    return `#${qr.toString(16).padStart(2, '0')}${qg.toString(16).padStart(2, '0')}${qb.toString(16).padStart(2, '0')}`
}

function buildPalette(allColors) {
    const map = new Map()
    for (const fc of allColors)
        for (const [r, g, b] of fc) {
            const k = quantKey(r, g, b)
            map.set(k, true)
        }
    const palette = [...map.keys()].sort()
    const paletteMap = new Map(palette.map((c, i) => [c, i]))
    return { palette, paletteMap }
}

function mapColors(frameColors, paletteMap) {
    return frameColors.map(([r, g, b]) => paletteMap.get(quantKey(r, g, b)))
}

// ══════════════════════════════════════════════════════════════════════════
// OPTIMIZED functions
// ══════════════════════════════════════════════════════════════════════════

function pixelsToAscii_v2(imageData, width, height, ramp, color) {
    const charLut = Array.from(ramp)
    const rampLen = ramp.length
    const lut = new Uint8Array(256)
    for (let b = 0; b < 256; b++)
        lut[b] = Math.min((b * rampLen) >> 8, rampLen - 1)

    const d = imageData.data
    const totalPx = width * height
    // Pre-allocate color array as flat Uint8Array instead of Array-of-arrays
    const colorBuf = color ? new Uint8Array(totalPx * 3) : null
    // Pre-allocate line buffer array
    const lineBuf = new Array(width)

    const lines = new Array(height)
    for (let y = 0; y < height; y++) {
        const rowOff = y * width
        for (let x = 0; x < width; x++) {
            const i = (rowOff + x) * 4
            const r = d[i], g = d[i + 1], b = d[i + 2]
            lineBuf[x] = charLut[lut[(r * 77 + g * 150 + b * 29) >> 8]]
            if (colorBuf) {
                const ci = (rowOff + x) * 3
                colorBuf[ci] = r; colorBuf[ci + 1] = g; colorBuf[ci + 2] = b
            }
        }
        lines[y] = lineBuf.join('')
    }
    return { text: lines.join('\n'), colors: colorBuf, charW: width, charH: height }
}

function buildPalette_v2(allColorBufs, pixelsPerFrame) {
    // Use integer key: quantized (r4<<8|g4)<<8|b4 → fits in 12 bits
    const seen = new Set()
    for (const buf of allColorBufs) {
        for (let i = 0, len = pixelsPerFrame * 3; i < len; i += 3) {
            const k = ((buf[i] & 0xF0) << 8) | ((buf[i + 1] & 0xF0) << 4) | (buf[i + 2] >> 4)
            seen.add(k)
        }
    }

    // Build sorted hex palette
    const sorted = [...seen].sort((a, b) => a - b)
    const palette = sorted.map(k => {
        const r = (k >> 8) & 0xF0, g = (k >> 4) & 0xF0, b = (k & 0xF) << 4
        return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`
    })
    // Int key → palette index lookup
    const paletteMap = new Map(sorted.map((k, i) => [k, i]))
    return { palette, paletteMap }
}

function mapColors_v2(colorBuf, pixelsPerFrame, paletteMap) {
    const out = new Uint16Array(pixelsPerFrame)
    for (let p = 0, ci = 0; p < pixelsPerFrame; p++, ci += 3) {
        const k = ((colorBuf[ci] & 0xF0) << 8) | ((colorBuf[ci + 1] & 0xF0) << 4) | (colorBuf[ci + 2] >> 4)
        out[p] = paletteMap.get(k)
    }
    return out
}

// ══════════════════════════════════════════════════════════════════════════
// Benchmark runner
// ══════════════════════════════════════════════════════════════════════════

function bench(label, fn, iterations = 1) {
    const t0 = performance.now()
    let result
    for (let i = 0; i < iterations; i++) result = fn()
    const elapsed = performance.now() - t0
    const perIter = elapsed / iterations
    console.log(`  ${label}: ${elapsed.toFixed(1)} ms total, ${perIter.toFixed(2)} ms/iter  (${iterations} iter)`)
    return result
}

console.log('═══ BENCHMARK: pixelsToAscii (CPU) ═══')
const asciiResults = bench('pixelsToAscii (all frames)', () => {
    const frames = [], allColors = []
    for (const fd of frameDataList) {
        const r = pixelsToAscii(fd, charW, charH, RAMP, COLOR)
        frames.push(r.text)
        if (r.colors) allColors.push(r.colors)
    }
    return { frames, allColors }
})
const perFrame = (asciiResults.frames.length)
console.log(`  → ${perFrame} frames, ${charW * charH} pixels/frame\n`)

console.log('═══ BENCHMARK: buildPalette ═══')
const paletteResult = bench('buildPalette', () => buildPalette(asciiResults.allColors))
console.log(`  → ${paletteResult.palette.length} unique quantized colors\n`)

console.log('═══ BENCHMARK: mapColors (all frames) ═══')
bench('mapColors', () => {
    return asciiResults.allColors.map(fc => mapColors(fc, paletteResult.paletteMap))
})

console.log('\n═══ TOTAL PIPELINE (original) ═══')
bench('Full pipeline (ascii + palette + map)', () => {
    const frames = [], allColors = []
    for (const fd of frameDataList) {
        const r = pixelsToAscii(fd, charW, charH, RAMP, COLOR)
        frames.push(r.text)
        if (r.colors) allColors.push(r.colors)
    }
    const { palette, paletteMap } = buildPalette(allColors)
    const colorMaps = allColors.map(fc => mapColors(fc, paletteMap))
    return { frames, palette, colorMaps }
})

const pxPerFrame = charW * charH

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('═══ OPTIMIZED BENCHMARKS ═══\n')

console.log('═══ BENCHMARK: pixelsToAscii_v2 ═══')
const asciiResults2 = bench('pixelsToAscii_v2 (all frames)', () => {
    const frames = [], allColors = []
    for (const fd of frameDataList) {
        const r = pixelsToAscii_v2(fd, charW, charH, RAMP, COLOR)
        frames.push(r.text)
        if (r.colors) allColors.push(r.colors)
    }
    return { frames, allColors }
})
console.log(`  → ${asciiResults2.frames.length} frames\n`)

console.log('═══ BENCHMARK: buildPalette_v2 ═══')
const paletteResult2 = bench('buildPalette_v2', () => buildPalette_v2(asciiResults2.allColors, pxPerFrame))
console.log(`  → ${paletteResult2.palette.length} unique quantized colors\n`)

console.log('═══ BENCHMARK: mapColors_v2 (all frames) ═══')
bench('mapColors_v2', () => {
    return asciiResults2.allColors.map(fc => mapColors_v2(fc, pxPerFrame, paletteResult2.paletteMap))
})

console.log('\n═══ TOTAL PIPELINE (optimized) ═══')
bench('Full pipeline v2', () => {
    const frames = [], allColors = []
    for (const fd of frameDataList) {
        const r = pixelsToAscii_v2(fd, charW, charH, RAMP, COLOR)
        frames.push(r.text)
        if (r.colors) allColors.push(r.colors)
    }
    const { palette, paletteMap } = buildPalette_v2(allColors, pxPerFrame)
    const colorMaps = allColors.map(fc => mapColors_v2(fc, pxPerFrame, paletteMap))
    return { frames, palette, colorMaps }
})

// ══════════════════════════════════════════════════════════════════════════
// BREAKDOWN: where does the time in pixelsToAscii_v2 actually go?
// Isolates string building vs color packing to show what's left to squeeze.
// ══════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('═══ BREAKDOWN: string building vs color packing ═══\n')

// Shared precomputed ramp cache (simulates App._rampCache warm)
const charLutCached = Array.from(RAMP)
const rampLen = charLutCached.length
const lutCached = new Uint8Array(256)
for (let b = 0; b < 256; b++) lutCached[b] = Math.min((b * rampLen) >> 8, rampLen - 1)

bench('v2 no-color (pure string building)', () => {
    const frames = []
    for (const fd of frameDataList) {
        const d = fd.data
        const lineBuf = new Array(charW)
        const lines = new Array(charH)
        for (let y = 0; y < charH; y++) {
            const rowOff = y * charW
            for (let x = 0; x < charW; x++) {
                const i = (rowOff + x) * 4
                const r = d[i], g = d[i+1], b = d[i+2]
                lineBuf[x] = charLutCached[lutCached[(r * 77 + g * 150 + b * 29) >> 8]]
            }
            lines[y] = lineBuf.join('')
        }
        frames.push(lines.join('\n'))
    }
    return frames
})

bench('v2 color-only (Uint8Array packing, no strings)', () => {
    const results = []
    for (const fd of frameDataList) {
        const d = fd.data
        const buf = new Uint8Array(pxPerFrame * 3)
        for (let p = 0, ci = 0; p < pxPerFrame; p++, ci += 3) {
            const i = p * 4
            buf[ci] = d[i]; buf[ci+1] = d[i+1]; buf[ci+2] = d[i+2]
        }
        results.push(buf)
    }
    return results
})

bench('v2 cached-ramp full (simulates App warm cache)', () => {
    const frames = [], allColors = []
    for (const fd of frameDataList) {
        const d = fd.data
        const colorBuf = new Uint8Array(pxPerFrame * 3)
        const lineBuf = new Array(charW)
        const lines = new Array(charH)
        for (let y = 0; y < charH; y++) {
            const rowOff = y * charW
            for (let x = 0; x < charW; x++) {
                const i = (rowOff + x) * 4
                const r = d[i], g = d[i+1], b = d[i+2]
                lineBuf[x] = charLutCached[lutCached[(r * 77 + g * 150 + b * 29) >> 8]]
                const ci = (rowOff + x) * 3
                colorBuf[ci] = r; colorBuf[ci+1] = g; colorBuf[ci+2] = b
            }
            lines[y] = lineBuf.join('')
        }
        frames.push(lines.join('\n'))
        allColors.push(colorBuf)
    }
    return { frames, allColors }
})

console.log(`
Remaining bottleneck notes:
  - String building (lineBuf.join + lines.join) is the hard JS limit per thread.
  - Web Workers (parallel frames) split this across CPU cores — see section below.
  - requestVideoFrameCallback in app.js avoids per-frame seek cost in the browser.
`)

// ══════════════════════════════════════════════════════════════════════════
// WORKERS: parallel frame processing (mirrors app.js _WorkerPool)
// ══════════════════════════════════════════════════════════════════════════
import { cpus } from 'os'

const WORKER_CODE = `
const { parentPort } = require('worker_threads')
let _cRamp = null, _cCharLut, _cLut
parentPort.on('message', ({ pixels, width, height, ramp, color, idx }) => {
    if (ramp !== _cRamp) {
        _cCharLut = Array.from(ramp)
        const n = _cCharLut.length
        _cLut = new Uint8Array(256)
        for (let b = 0; b < 256; b++) _cLut[b] = Math.min((b * n) >> 8, n - 1)
        _cRamp = ramp
    }
    const charLut = _cCharLut, lut = _cLut
    const totalPx = width * height
    const colorBuf = color ? new Uint8Array(totalPx * 3) : null
    const lineBuf = new Array(width)
    const lines = new Array(height)
    for (let y = 0; y < height; y++) {
        const rowOff = y * width
        for (let x = 0; x < width; x++) {
            const i = (rowOff + x) * 4
            const r = pixels[i], g = pixels[i+1], b = pixels[i+2]
            lineBuf[x] = charLut[lut[(r * 77 + g * 150 + b * 29) >> 8]]
            if (colorBuf) {
                const ci = (rowOff + x) * 3
                colorBuf[ci] = r; colorBuf[ci+1] = g; colorBuf[ci+2] = b
            }
        }
        lines[y] = lineBuf.join('')
    }
    const transfer = colorBuf ? [colorBuf.buffer] : []
    parentPort.postMessage({ text: lines.join('\\n'), colorBuf, idx }, transfer)
})
`

async function runWithWorkers(numWorkers) {
    const { Worker: NodeWorker } = await import('worker_threads')
    const workers = Array.from({ length: numWorkers }, () =>
        new NodeWorker(WORKER_CODE, { eval: true })
    )
    const idle = [...workers]
    const pending = new Map()
    const queue = []

    const done = (w, data) => {
        pending.get(data.idx)(data)
        pending.delete(data.idx)
        if (queue.length) {
            const task = queue.shift()
            pending.set(task.msg.idx, task.resolve)
            w.postMessage(task.msg, task.transfer)
        } else { idle.push(w) }
    }
    workers.forEach(w => w.on('message', d => done(w, d)))

    const submit = (pixels, idx) => {
        const msg = { pixels, width: charW, height: charH, ramp: RAMP, color: COLOR, idx }
        const transfer = [pixels.buffer]
        return new Promise(resolve => {
            if (idle.length) {
                const w = idle.pop()
                pending.set(idx, resolve)
                w.postMessage(msg, transfer)
            } else { queue.push({ msg, transfer, resolve }) }
        })
    }

    // Copy buffers so transfers don't corrupt frameDataList
    const copies = frameDataList.map(fd => {
        const copy = new Uint8ClampedArray(fd.data.length)
        copy.set(fd.data)
        return copy
    })

    const promises = copies.map((pixels, idx) => submit(pixels, idx))
    const results = await Promise.all(promises)
    workers.forEach(w => w.terminate())

    const { palette, paletteMap } = buildPalette_v2(results.map(r => r.colorBuf), pxPerFrame)
    const colorMaps = results.map(r => mapColors_v2(r.colorBuf, pxPerFrame, paletteMap))
    return { frames: results.map(r => r.text), palette, colorMaps }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
const numCores = cpus().length
console.log(`═══ WORKERS: parallel pixel processing (${numCores} logical cores) ═══\n`)

for (const n of [1, 2, 4, Math.min(numCores, 8)].filter((v,i,a) => a.indexOf(v) === i)) {
    const t0 = performance.now()
    await runWithWorkers(n)
    const elapsed = performance.now() - t0
    console.log(`  ${n} worker(s): ${elapsed.toFixed(1)} ms  (${(528 / elapsed * 100 - 100).toFixed(0)}% vs single-thread)`)
}

console.log('\nDone.')
