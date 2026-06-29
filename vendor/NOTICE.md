# Third-party components in `vendor/`

This directory bundles a prebuilt **ffmpeg.wasm** engine so the app works
fully offline (no CDN, no network). These files are **not** authored by this
project and carry their own licenses.

| Path | Component | Upstream | License |
|---|---|---|---|
| `core/ffmpeg-core.wasm`, `core/ffmpeg-core.js` | FFmpeg compiled to WebAssembly, **built with `--enable-gpl` and `libx264`** | [FFmpeg](https://ffmpeg.org/) / [x264](https://www.videolan.org/developers/x264.html) | **GPL** |
| `ffmpeg/*` | `@ffmpeg/ffmpeg` (JS wrapper) | [ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) | MIT |
| `util/*` | `@ffmpeg/util` | [ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) | MIT |

Because the FFmpeg core is a **GPL** build (it links x264), the bundled
distribution as a whole is governed by the GPL. This project is therefore
released under **GPL-3.0** (see `../LICENSE`).

FFmpeg source and build configuration: <https://github.com/ffmpegwasm/ffmpeg.wasm>.
