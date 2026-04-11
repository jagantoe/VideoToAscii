# [Video-to-ASCII Converter](https://jagantoe.github.io/VideoToAscii/)

https://jagantoe.github.io/VideoToAscii/

A creative web application that converts images, GIFs, and videos into animated ASCII art. Customize colors, text density, playback speed, and real-time preview your conversions with multiple rendering modes.

## Features

- **Multi-Format Support**: Convert PNG, JPG, GIF, WebP, and BMP images (video support via Python CLI)
- **Live Preview**: See conversions instantly as you adjust settings
- **Customizable Rendering**:
  - 3 ASCII ramp levels (detailed 50-char, simple 10-char, block 5-char)
  - Monochrome or source-color rendering
  - 7 built-in color presets or custom colors
  - Adjustable font size and line height
- **Playback Controls**: Play, pause, frame stepping, speed multiplier (0.1× to 4×)
- **Theme Support**: Light and dark mode with persistent preference
- **Export**: Save conversions as JSON for later viewing or processing
- **Performance**: Efficient palette quantization (4-bit per channel) and per-frame indexing

## Quick Start

1. Open `index.html` in a web browser (or serve via HTTP at `localhost:8081`)
2. Drag and drop an image or GIF onto the canvas
3. Adjust settings in the sidebar (width, colors, rendering mode, etc.)
4. Watch the live preview update automatically
5. Click **Export** to save as JSON for future loading

### Video Files (Python CLI)

For video conversion, use the included Python script:

```bash
python convert.py input_video.mp4 --width 100 --color --fps 10
```

Then load the generated JSON into the web app.

## Installation

### Web App (No Installation Required)
Simply open `index.html` in any modern browser.

### Python CLI Dependencies
```bash
pip install -r requirements.txt
```

## JSON Format

When you export a conversion, it generates a JSON file containing all frame data and metadata. This format allows you to:
- Save conversions for later viewing without re-processing
- Share ASCII animations with others
- Build custom players or tools

### JSON Structure

```json
{
  "meta": {
    "source": "input.gif",
    "charWidth": 120,
    "charHeight": 55,
    "frameCount": 38,
    "fps": 17,
    "hasColor": true
  },
  "frames": [
    "█████▓▒░ ...",
    "..."
  ],
  "palette": ["#000000", "#ff3300", "#00ff88", "..."],
  "colorMaps": [
    [0, 2, 1, 0, 3, ...],
    "..."
  ]
}
```

- **`meta`** — conversion settings: dimensions in characters, FPS, source filename
- **`frames`** — one string per frame; each character maps to one cell in the grid (left→right, top→bottom)
- **`palette`** — shared list of CSS hex color strings used across all frames
- **`colorMaps`** — per-frame arrays of palette indices, one index per character in `frames[i]`

### Visualizing JSON Files

`viewer.html` is a ready-made, self-contained player — open it in any browser and drop a `.json` file onto it. It supports monochrome + source-color rendering, 16 color presets, font size, light/dark theme, play/pause, frame stepping, and speed control.

#### Key parts for building your own player

**Text layout** — `viewer.html` uses [Pretext.js](https://github.com/chenglou/pretext) (`@chenglou/pretext` via esm.sh) for accurate character measurement on a Canvas 2D context. If you want a simpler approach without that dependency, measure a single `'M'` with `ctx.measureText` and step through the frame string character-by-character.

**Canvas sizing**

```js
ctx.font = '14px "Courier New", monospace'
const charW = ctx.measureText('M').width
const charH = Math.ceil(14 * 1.2)           // font-size * line-height factor
canvas.width  = charW * data.meta.charWidth
canvas.height = charH * data.meta.charHeight
```

**Rendering a monochrome frame**

```js
function renderMono(ctx, frameText, cols, charW, charH, fg, bg) {
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = fg
    ctx.textBaseline = 'top'
    const lines = frameText.split('\n')
    for (let i = 0; i < lines.length; i++)
        ctx.fillText(lines[i], 0, i * charH)
}
```

**Rendering a color frame** — palette indices are batched per run of same-color characters to minimise `fillText` calls:

```js
function renderColor(ctx, frameText, colorMap, palette, cols, charW, charH) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.textBaseline = 'top'
    const lines = frameText.split('\n')
    let offset = 0
    for (let row = 0; row < lines.length; row++) {
        const line = lines[row]
        const y = row * charH
        let batchStart = 0, batchColor = palette[colorMap[offset]]
        for (let col = 0; col < line.length; col++) {
            const c = palette[colorMap[offset + col]]
            if (c !== batchColor) {
                ctx.fillStyle = batchColor
                ctx.fillText(line.slice(batchStart, col), batchStart * charW, y)
                batchStart = col; batchColor = c
            }
        }
        ctx.fillStyle = batchColor
        ctx.fillText(line.slice(batchStart), batchStart * charW, y)
        offset += line.length
    }
}
```

**Playback loop**

```js
let frameIndex = 0, lastTime = 0
const frameDuration = 1000 / data.meta.fps

function tick(ts) {
    if (ts - lastTime >= frameDuration) {
        frameIndex = (frameIndex + 1) % data.meta.frameCount
        renderMono(ctx, data.frames[frameIndex], ...)
        lastTime = ts
    }
    requestAnimationFrame(tick)
}
requestAnimationFrame(tick)
```

## Technical Details

- **Web Frontend**: Vanilla JavaScript with Canvas 2D rendering
- **Text Layout**: Pretext.js for accurate monospace text measurement without DOM manipulation
- **GIF Processing**: Pure-JavaScript GIF decoder with frame compositing and disposal type handling
- **ASCII Conversion**: Luminance-based character mapping with optional per-pixel color storage
- **Playback**: RequestAnimationFrame loop with frame-accurate timing

## Third-Party Dependencies

### JavaScript Libraries
- **[Pretext.js](https://github.com/chenglou/pretext)** (v0.0.5) – DOM-free text measurement and layout engine. Used for calculating text dimensions on the canvas without DOM reflow.
- **[gifuct-js](https://github.com/jnordberg/gifuct-js)** (v2.1.2) – Pure-JavaScript GIF image decoder supporting frame decompression, GIF89A extensions, and disposal types.

### Python Libraries
- **[Pillow](https://pillow.readthedocs.io/)** – Image processing and GIF frame extraction
- **[OpenCV](https://opencv.org/)** – Video frame sampling and processing

### Browser APIs
- Canvas 2D Context – Native browser API for rendering ASCII text with colors
- FileReader API – Local file handling for drag-and-drop
- LocalStorage API – Theme preference persistence

## Credits

**Fully generated by AI using Claude models (Opus and Sonnet 4.6) via GitHub Copilot**.
