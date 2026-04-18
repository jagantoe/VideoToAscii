#!/usr/bin/env python3
"""Convert images, GIFs, and videos to Pretext-compatible JSON files."""

import argparse
import json
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("Error: Pillow is required. Install with: pip install Pillow", file=sys.stderr)
    sys.exit(1)

# Detailed ASCII ramp from dark to light
ASCII_RAMP_DETAILED = " .·:;!|ilI1][tf{jrxnuvczXYJ()Cüö0Oqpdb$m#MW&8%B@Ñ"
# Simple ramp
ASCII_RAMP_SIMPLE = " .:-=+*#%@"
# Block elements ramp
ASCII_RAMP_BLOCKS = " ░▒▓█"


def pixel_to_char(brightness, ramp):
    """Map a brightness value (0-255) to an ASCII character."""
    index = int(brightness / 256 * len(ramp))
    return ramp[min(index, len(ramp) - 1)]


def image_to_ascii(img, width, ramp, color=False):
    """Convert a PIL Image to an ASCII art string, optionally with color data."""
    aspect = img.height / img.width
    height = max(1, int(width * aspect * 0.5))  # chars are ~2x tall as wide

    resized = img.resize((width, height))
    gray_pixels = list(resized.convert("L").tobytes())

    colors_flat = None
    if color:
        rgb_bytes = resized.convert("RGB").tobytes()
        colors_flat = []
        for i in range(width * height):
            r, g, b = rgb_bytes[i * 3], rgb_bytes[i * 3 + 1], rgb_bytes[i * 3 + 2]
            colors_flat.append((r, g, b))

    lines = []
    for y in range(height):
        row = gray_pixels[y * width : (y + 1) * width]
        line = "".join(pixel_to_char(p, ramp) for p in row)
        lines.append(line)

    return "\n".join(lines), colors_flat, width, height


def convert_image(path, width, ramp, color=False):
    """Convert a single image file."""
    img = Image.open(path).convert("RGB")
    text, frame_colors, w, h = image_to_ascii(img, width, ramp, color)
    all_colors = [frame_colors] if frame_colors else []
    return [text], all_colors, 1, w, h


def convert_gif(path, width, ramp, color=False):
    """Convert an animated GIF."""
    img = Image.open(path)
    frames = []
    all_colors = []
    durations = []
    w, h = 0, 0

    try:
        while True:
            frame = img.convert("RGBA")
            bg = Image.new("RGBA", frame.size, (255, 255, 255, 255))
            bg.paste(frame, mask=frame.split()[3])
            text, frame_colors, w, h = image_to_ascii(bg.convert("RGB"), width, ramp, color)
            frames.append(text)
            if frame_colors:
                all_colors.append(frame_colors)
            durations.append(max(20, img.info.get("duration", 20)))  # ms, min 20ms matches browser
            img.seek(img.tell() + 1)
    except EOFError:
        pass

    avg_duration = sum(durations) / len(durations) if durations else 100
    fps = max(1, round(1000 / avg_duration))
    return frames, all_colors, fps, w, h


def build_palette(all_colors):
    """Build a color palette from per-frame color lists. Returns (palette_hex, palette_map)."""
    color_set = set()
    for frame_colors in all_colors:
        for r, g, b in frame_colors:
            # Quantize to 4 bits per channel
            qr = (r >> 4) << 4
            qg = (g >> 4) << 4
            qb = (b >> 4) << 4
            color_set.add((qr, qg, qb))

    palette = sorted(color_set)
    palette_map = {c: i for i, c in enumerate(palette)}
    palette_hex = [f"#{r:02x}{g:02x}{b:02x}" for r, g, b in palette]
    return palette_hex, palette_map


def map_colors_to_indices(frame_colors, palette_map):
    """Map a frame's RGB colors to palette indices, encoded as hex string."""
    indices = []
    for r, g, b in frame_colors:
        qr = (r >> 4) << 4
        qg = (g >> 4) << 4
        qb = (b >> 4) << 4
        indices.append(palette_map[(qr, qg, qb)])
    return indices


def convert_video(path, width, ramp, target_fps=None, color=False):
    """Convert a video file using OpenCV."""
    try:
        import cv2
    except ImportError:
        print(
            "Error: opencv-python required for video files.\n"
            "Install with: pip install opencv-python",
            file=sys.stderr,
        )
        sys.exit(1)

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        print(f"Error: Cannot open video {path}", file=sys.stderr)
        sys.exit(1)

    video_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    if target_fps is None:
        target_fps = video_fps
    frame_interval = max(1, round(video_fps / target_fps))

    frames = []
    all_colors = []
    w, h = 0, 0
    frame_idx = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % frame_interval == 0:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            img = Image.fromarray(rgb)
            text, frame_colors, w, h = image_to_ascii(img, width, ramp, color)
            frames.append(text)
            if frame_colors:
                all_colors.append(frame_colors)
        frame_idx += 1

    cap.release()

    if not frames:
        print("Error: No frames extracted from video", file=sys.stderr)
        sys.exit(1)

    return frames, all_colors, target_fps, w, h


def main():
    parser = argparse.ArgumentParser(
        description="Convert images, GIFs, and videos to Pretext-compatible JSON"
    )
    parser.add_argument("input", help="Input file (image, GIF, or video)")
    parser.add_argument(
        "-o",
        "--output",
        help="Output JSON file path (default: output/<name>.json)",
    )
    parser.add_argument(
        "-w", "--width", type=int, default=120, help="Character width (default: 120)"
    )
    parser.add_argument(
        "--fps",
        type=int,
        default=None,
        help="Target FPS for video conversion (default: use source FPS)",
    )
    parser.add_argument(
        "--ramp",
        choices=["simple", "detailed", "blocks"],
        default="detailed",
        help="ASCII character ramp detail level (default: detailed)",
    )
    parser.add_argument(
        "--invert", action="store_true", help="Invert brightness mapping"
    )
    parser.add_argument(
        "--color", action="store_true", help="Include per-character color data"
    )

    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: {input_path} not found", file=sys.stderr)
        sys.exit(1)

    ramp = {"simple": ASCII_RAMP_SIMPLE, "blocks": ASCII_RAMP_BLOCKS}.get(args.ramp, ASCII_RAMP_DETAILED)
    if args.invert:
        ramp = ramp[::-1]

    suffix = input_path.suffix.lower()

    if suffix == ".gif":
        frames, all_colors, fps, w, h = convert_gif(input_path, args.width, ramp, args.color)
    elif suffix in (".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff"):
        frames, all_colors, fps, w, h = convert_image(input_path, args.width, ramp, args.color)
        fps = 1
    elif suffix in (".mp4", ".avi", ".mov", ".webm", ".mkv"):
        frames, all_colors, fps, w, h = convert_video(input_path, args.width, ramp, args.fps, args.color)
    else:
        print(f"Error: Unsupported format: {suffix}", file=sys.stderr)
        sys.exit(1)

    # Determine output path
    if args.output:
        output_path = Path(args.output)
    else:
        output_path = Path("output") / f"{input_path.stem}.json"

    output_path.parent.mkdir(parents=True, exist_ok=True)

    data = {
        "meta": {
            "source": input_path.name,
            "charWidth": w,
            "charHeight": h,
            "frameCount": len(frames),
            "fps": fps,
            "hasColor": bool(all_colors),
        },
        "frames": frames,
    }

    if all_colors:
        palette_hex, palette_map = build_palette(all_colors)
        color_maps = [map_colors_to_indices(fc, palette_map) for fc in all_colors]
        data["palette"] = palette_hex
        data["colorMaps"] = color_maps

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f)

    size_kb = output_path.stat().st_size / 1024
    color_info = f", {len(data.get('palette', []))} colors" if all_colors else ""
    print(f"Converted: {input_path.name} -> {output_path}")
    print(f"  {len(frames)} frame(s), {w}x{h} chars, {fps} fps, {size_kb:.1f} KB{color_info}")


if __name__ == "__main__":
    main()
