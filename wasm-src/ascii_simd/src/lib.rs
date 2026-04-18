// SIMD-accelerated luminance + ramp-index encoder.
//
// Input:  flat RGBA pixel buffer (width*height*4)
// Output: width*height bytes — ramp index per pixel (0..ramp_len-1).
//         If `want_color` is true, also fills a parallel RGB buffer.
//
// Compile with: wasm-pack build --release --target web -- -Z build-std=std,panic_abort
// (Or use the build.ps1/build.sh script in wasm-src/.)
// SIMD is auto-enabled by RUSTFLAGS="-C target-feature=+simd128" in the build script.

use wasm_bindgen::prelude::*;
use js_sys;

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;

/// Encode RGBA -> ramp indices. Returns a Uint8Array of length width*height.
/// If `color_out` is non-null (length >= width*height*3), it is filled with packed RGB.
#[wasm_bindgen]
pub fn encode_frame(
    pixels: &[u8],
    width: u32,
    height: u32,
    ramp_len: u32,
    color_out: Option<js_sys::Uint8Array>,
) -> js_sys::Uint8Array {
    let total = (width as usize) * (height as usize);
    let mut indices = vec![0u8; total];
    let mut color   = if color_out.is_some() { vec![0u8; total * 3] } else { Vec::new() };

    // Fast luminance: (r*77 + g*150 + b*29) >> 8  ≈ 0.299/0.587/0.114
    // Then idx = min((lum * ramp_len) >> 8, ramp_len - 1)
    let n = ramp_len.max(1) as u32;
    let want_color = color_out.is_some();

    #[cfg(target_arch = "wasm32")]
    unsafe {
        // SIMD: process 16 bytes (= 4 RGBA pixels) per iteration.
        let mut p = 0usize;
        let mut o = 0usize;
        let chunks = total / 4;
        let coeff_r = u16x8_splat(77);
        let coeff_g = u16x8_splat(150);
        let coeff_b = u16x8_splat(29);
        for _ in 0..chunks {
            let v = v128_load(pixels.as_ptr().add(p) as *const v128);
            // Deinterleave RGBA bytes — extract low and high halves as u16.
            // We can use lane shuffles to gather R, G, B planes.
            let r0 = u16x8_extend_low_u8x16(u8x16_shuffle::<0,4,8,12,1,5,9,13,2,6,10,14,3,7,11,15>(v, v));
            // After the shuffle the 16 bytes are [r0..r3, g0..g3, b0..b3, a0..a3]
            let bytes: [u8; 16] = core::mem::transmute(u8x16_shuffle::<0,4,8,12,1,5,9,13,2,6,10,14,3,7,11,15>(v, v));
            let _ = r0;  // silence unused-binding lint if pattern below changes
            let mut lums = [0u16; 4];
            for i in 0..4 {
                let r = bytes[i] as u16;
                let g = bytes[4 + i] as u16;
                let b = bytes[8 + i] as u16;
                lums[i] = (r * 77 + g * 150 + b * 29) >> 8;
                let idx = ((lums[i] as u32 * n) >> 8).min(n - 1) as u8;
                indices[o + i] = idx;
                if want_color {
                    let ci = (o + i) * 3;
                    color[ci]     = bytes[i];
                    color[ci + 1] = bytes[4 + i];
                    color[ci + 2] = bytes[8 + i];
                }
            }
            p += 16;
            o += 4;
        }
        // Tail
        for k in (chunks * 4)..total {
            let i = k * 4;
            let r = pixels[i]   as u32;
            let g = pixels[i+1] as u32;
            let b = pixels[i+2] as u32;
            let lum = (r * 77 + g * 150 + b * 29) >> 8;
            indices[k] = ((lum * n) >> 8).min(n - 1) as u8;
            if want_color {
                let ci = k * 3;
                color[ci]     = pixels[i]   as u8;
                color[ci + 1] = pixels[i+1] as u8;
                color[ci + 2] = pixels[i+2] as u8;
            }
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        for k in 0..total {
            let i = k * 4;
            let r = pixels[i]   as u32;
            let g = pixels[i+1] as u32;
            let b = pixels[i+2] as u32;
            let lum = (r * 77 + g * 150 + b * 29) >> 8;
            indices[k] = ((lum * n) >> 8).min(n - 1) as u8;
            if want_color {
                let ci = k * 3;
                color[ci]     = pixels[i];
                color[ci + 1] = pixels[i+1];
                color[ci + 2] = pixels[i+2];
            }
        }
    }

    if let Some(co) = color_out {
        if co.length() as usize >= color.len() {
            co.copy_from(&color);
        }
    }
    js_sys::Uint8Array::from(&indices[..])
}
