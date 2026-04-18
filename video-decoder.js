// ── WebCodecs-based video decoder ──────────────────────────────────────────
// Demuxes MP4/MOV with mp4box.js and decodes via the browser's VideoDecoder.
// Yields ImageData buffers at the source frame rate, faster than realtime,
// with exact frame timestamps (no need for RVFC playback probing).
//
// Fallback: returns null if WebCodecs is unavailable or the file is not a
// supported MP4 variant; caller falls back to the existing RVFC path.

import MP4Box from 'mp4box'

/**
 * Decode a video file via WebCodecs and return ImageData buffers + true source fps.
 *
 * @param {File}   file
 * @param {number} charW       output width in chars (also pixel width of resize canvas)
 * @param {number} charH       output height in chars
 * @param {number} maxFrames
 * @param {number} limitFps    0 = source fps, else cap
 * @param {(n:number,total:number)=>void} progressCb
 * @param {AbortSignal} [signal]
 * @returns {Promise<null | { imageDataBufs: Uint8ClampedArray[], outputFps: number, sourceFps: number }>}
 */
export async function decodeVideoWebCodecs(file, charW, charH, maxFrames, limitFps, progressCb, signal) {
    if (typeof VideoDecoder === 'undefined') {
        console.warn('[webcodecs] VideoDecoder unsupported')
        return null
    }
    // mp4box only handles ISO BMFF (mp4/mov/m4v). WebM needs a different demuxer.
    const name = file.name.toLowerCase()
    if (!/\.(mp4|m4v|mov)$/.test(name) && !file.type.includes('mp4')) {
        console.warn('[webcodecs] non-MP4 container, deferring to fallback')
        return null
    }

    let trackInfo, decoderConfig
    const mp4 = MP4Box.createFile()

    // Collect samples + decoder config
    const trackReady = new Promise((resolve, reject) => {
        mp4.onError = e => reject(new Error('mp4box: ' + e))
        mp4.onReady = info => {
            const v = info.videoTracks?.[0]
            if (!v) return reject(new Error('No video track'))
            trackInfo = v
            const trak = mp4.getTrackById(v.id)
            // Build avcC/hvcC description for WebCodecs
            const description = _buildAvccDescription(trak)
            decoderConfig = {
                codec: v.codec,
                codedWidth:  v.video.width,
                codedHeight: v.video.height,
                description,
            }
            resolve()
        }
    })

    // Stream the file into mp4box
    let offset = 0
    const reader = file.stream().getReader()
    const pump = async () => {
        while (true) {
            const { done, value } = await reader.read()
            if (done) { mp4.flush(); break }
            const ab = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            ab.fileStart = offset
            offset += value.byteLength
            mp4.appendBuffer(ab)
        }
    }
    const pumpPromise = pump()

    try { await Promise.race([trackReady, pumpPromise.then(() => trackReady)]) }
    catch (e) { console.warn('[webcodecs]', e.message); return null }

    const sourceFps = +(trackInfo.nb_samples / (trackInfo.duration / trackInfo.timescale)).toFixed(3)
    const limited   = limitFps > 0 ? Math.min(limitFps, sourceFps) : sourceFps
    const skipEvery = Math.max(1, Math.round(sourceFps / limited))
    const totalEst  = Math.min(maxFrames, Math.floor(trackInfo.nb_samples / skipEvery))

    const samplesQueue = []
    let extractDone = false
    mp4.setExtractionOptions(trackInfo.id, null, { nbSamples: 100 })
    mp4.onSamples = (_id, _user, samples) => samplesQueue.push(...samples)
    mp4.start()
    // Continue pumping the file in the background
    pumpPromise.finally(() => { extractDone = true })

    // Set up decoder
    const imageDataBufs = []
    const resize = new OffscreenCanvas(charW, charH)
    const rctx   = resize.getContext('2d', { willReadFrequently: true })
    let frameIdx = 0
    let kept = 0

    let decodeErr = null
    const decoder = new VideoDecoder({
        output: (vf) => {
            try {
                if (kept >= maxFrames) { vf.close(); return }
                if (frameIdx % skipEvery === 0) {
                    rctx.drawImage(vf, 0, 0, charW, charH)
                    imageDataBufs.push(rctx.getImageData(0, 0, charW, charH).data)
                    kept++
                    progressCb?.(kept, totalEst)
                }
                frameIdx++
            } finally { vf.close() }
        },
        error: e => { decodeErr = e },
    })
    decoder.configure(decoderConfig)

    // Feed samples into decoder
    while (kept < maxFrames) {
        if (signal?.aborted) { decoder.close(); return null }
        if (decodeErr) throw decodeErr
        if (samplesQueue.length === 0) {
            if (extractDone) break
            await new Promise(r => setTimeout(r, 4))
            continue
        }
        const s = samplesQueue.shift()
        decoder.decode(new EncodedVideoChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: (s.cts * 1e6) / s.timescale,
            duration:  (s.duration * 1e6) / s.timescale,
            data: s.data,
        }))
    }
    try { await decoder.flush() } catch {}
    decoder.close()

    if (!imageDataBufs.length) return null
    const outputFps = Math.max(1, Math.round(limited))
    return { imageDataBufs, outputFps, sourceFps: Math.round(sourceFps) }
}

// Build avcC/hvcC descriptor box bytes from an mp4box trak (required by VideoDecoder).
function _buildAvccDescription(trak) {
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C
        if (!box) continue
        const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN)
        box.write(stream)
        return new Uint8Array(stream.buffer, 8)  // strip box header (size + type)
    }
    return undefined
}
