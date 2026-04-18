// Pure-Rust GIF decoder with full disposal (Keep / Background / Previous) support.
// Returns a JS object: { width, height, frames: [{ rgba: Uint8Array, delayMs: u32 }] }
// `delayMs` honours per-frame delays directly from the GIF — no rendering clamps.

use wasm_bindgen::prelude::*;
use gif::{DecodeOptions, DisposalMethod};

#[wasm_bindgen]
pub fn decode_gif(bytes: &[u8]) -> Result<JsValue, JsValue> {
    let mut opts = DecodeOptions::new();
    opts.set_color_output(gif::ColorOutput::RGBA);
    let mut decoder = opts
        .read_info(bytes)
        .map_err(|e| JsValue::from_str(&format!("gif parse: {e}")))?;

    let w = decoder.width()  as usize;
    let h = decoder.height() as usize;
    let mut canvas: Vec<u8> = vec![0; w * h * 4];
    let mut prev_canvas: Option<Vec<u8>> = None;

    let frames_arr = js_sys::Array::new();

    while let Some(frame) = decoder
        .read_next_frame()
        .map_err(|e| JsValue::from_str(&format!("gif frame: {e}")))?
    {
        let fw = frame.width  as usize;
        let fh = frame.height as usize;
        let fl = frame.left   as usize;
        let ft = frame.top    as usize;

        // Save previous-canvas BEFORE drawing if disposal is RestorePrevious
        let snapshot = if frame.dispose == DisposalMethod::Previous {
            Some(canvas.clone())
        } else { None };

        // Composite frame patch onto canvas (skip transparent pixels)
        for row in 0..fh {
            for col in 0..fw {
                let si = (row * fw + col) * 4;
                let a = frame.buffer[si + 3];
                if a == 0 { continue }
                let dy = ft + row;
                let dx = fl + col;
                if dy >= h || dx >= w { continue }
                let di = (dy * w + dx) * 4;
                canvas[di]     = frame.buffer[si];
                canvas[di + 1] = frame.buffer[si + 1];
                canvas[di + 2] = frame.buffer[si + 2];
                canvas[di + 3] = 255;
            }
        }

        // Emit a copy of the composited canvas as this frame's pixels
        let out = js_sys::Uint8Array::from(&canvas[..]);
        // delay is in centiseconds. Apply browser-compatible minimum:
        // delays < 2cs (20ms) are treated as 10cs (100ms) to match how
        // browsers render GIFs with "fast" or unspecified frame delays.
        let raw_cs = frame.delay;
        let delay_ms = if raw_cs < 2 { 100 } else { raw_cs as u32 * 10 };
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(&obj, &JsValue::from_str("rgba"),    &out)?;
        js_sys::Reflect::set(&obj, &JsValue::from_str("delayMs"), &JsValue::from_f64(delay_ms as f64))?;
        frames_arr.push(&obj);
        prev_canvas = snapshot;

        // Apply disposal AFTER emitting this frame (affects next frame's base)
        match frame.dispose {
            DisposalMethod::Background => {
                for row in 0..fh {
                    for col in 0..fw {
                        let dy = ft + row; let dx = fl + col;
                        if dy >= h || dx >= w { continue }
                        let di = (dy * w + dx) * 4;
                        canvas[di] = 0; canvas[di+1] = 0; canvas[di+2] = 0; canvas[di+3] = 0;
                    }
                }
            }
            DisposalMethod::Previous => {
                if let Some(snap) = prev_canvas.take() { canvas = snap }
            }
            _ => {}
        }
    }

    let result = js_sys::Object::new();
    js_sys::Reflect::set(&result, &JsValue::from_str("width"),  &JsValue::from_f64(w as f64))?;
    js_sys::Reflect::set(&result, &JsValue::from_str("height"), &JsValue::from_f64(h as f64))?;
    js_sys::Reflect::set(&result, &JsValue::from_str("frames"), &frames_arr)?;
    Ok(result.into())
}
