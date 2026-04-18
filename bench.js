// ── Lightweight benchmark logger ───────────────────────────────────────────
// Records named phases with start/end timestamps and prints a summary table
// to the console at the end of each conversion. Almost zero runtime cost.
//
// Usage:
//   const b = new Bench('convert')
//   b.start('decode')
//   ...work...
//   b.end('decode')
//   b.start('encode'); ...; b.end('encode')
//   b.report({ frames: 120, charW: 200, charH: 60 })

const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export class Bench {
    constructor(label = 'pipeline') {
        this.label = label
        this.t0    = _now()
        this.phases = new Map()  // name -> { start, total, count }
    }

    start(name) {
        let p = this.phases.get(name)
        if (!p) { p = { start: 0, total: 0, count: 0 }; this.phases.set(name, p) }
        p.start = _now()
    }

    end(name) {
        const p = this.phases.get(name)
        if (!p || !p.start) return
        p.total += _now() - p.start
        p.count += 1
        p.start  = 0
    }

    /** Record a one-shot duration without start/end pairing. */
    add(name, ms) {
        let p = this.phases.get(name)
        if (!p) { p = { start: 0, total: 0, count: 0 }; this.phases.set(name, p) }
        p.total += ms
        p.count += 1
    }

    report(extra = {}) {
        const wall = _now() - this.t0
        const rows = []
        let measured = 0
        for (const [name, p] of this.phases) {
            measured += p.total
            rows.push({
                phase:   name,
                ms:      +p.total.toFixed(1),
                pct:     +(p.total / wall * 100).toFixed(1),
                count:   p.count,
                avg_ms:  +(p.total / Math.max(1, p.count)).toFixed(2),
            })
        }
        const mem = (typeof performance !== 'undefined' && performance.memory)
            ? `${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)} MB`
            : 'n/a'
        console.groupCollapsed(
            `%c[bench] ${this.label} — ${wall.toFixed(0)} ms wall · heap ${mem}`,
            'color:#00ff41;font-weight:bold'
        )
        for (const k in extra) console.log(`  ${k}:`, extra[k])
        console.table(rows)
        const overhead = wall - measured
        if (overhead > 0)
            console.log(`  unmeasured: ${overhead.toFixed(1)} ms (${(overhead/wall*100).toFixed(1)}%)`)
        console.groupEnd()
        return { wall, rows, extra }
    }
}

/** Live FPS meter for playback. Logs once per second when active. */
export class PlaybackBench {
    constructor() { this.reset() }
    reset() {
        this._frames = 0
        this._t0 = _now()
        this._renderTotal = 0
        this._lastLog = this._t0
    }
    onFrame(renderMs) {
        this._frames += 1
        this._renderTotal += renderMs
        const now = _now()
        if (now - this._lastLog >= 2000) {
            const fps = this._frames * 1000 / (now - this._t0)
            const avg = this._renderTotal / this._frames
            console.log(
                `%c[playback] ${fps.toFixed(1)} fps · render avg ${avg.toFixed(2)} ms · ${this._frames} frames`,
                'color:#888'
            )
            this._lastLog = now
        }
    }
}
