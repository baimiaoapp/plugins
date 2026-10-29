# Scan, Office, AI images, and compression

These operations run locally. First use downloads only public, integrity-checked runtimes/models/fonts.
Input documents and images are not uploaded. Local OCR is not included.

Use the common CLI form, adding repeated `--input` arguments in the desired order for batches:

```bash
node "<skill-dir>/scripts/baimiao.mjs" <operation> --input "/absolute/input" --plan "/absolute/plan.json" --output "/absolute/new-output"
```

Use `--output-dir` instead of `--output` for `document-scan`, `image-upscale`, and
`image-smart-cutout`. The directory must exist. Never overwrite inputs or existing outputs.
`pdf-analyze-watermarks` takes no output option and returns candidates in the JSON result.
Plans are optional unless required to identify an object or advanced watermark candidates.

## Office to PDF

- `word-to-pdf`: DOCX input only; legacy DOC is unsupported.
- `pptx-to-pdf`: PPTX input only; legacy PPT is unsupported.

WordCraft and DeckCraft convert locally, with fonts selected from an integrity-pinned catalog.
Inputs are limited to 100 MiB; the worker has a five-minute deadline including downloads.
Check `outputs[].metadata.missingGlyphs` and `incomplete`: report missing glyphs rather than claiming
perfect conversion. Complex Office layouts may differ from the original application; inspect the PDF.

## Document scanning

`document-scan` emits one PNG per input. `document-scan-pdf` creates one ordered PDF.
Default: local DocAligner corner detection, perspective correction, background normalization, and
`colourSharp` enhancement. Modes: `original`, `colour`, `colourSharp`, `gray`, `bw`, `bwSharp`.
Images are limited to 16 megapixels. Review automatic crops, especially low-confidence detections.
A failed/ambiguous detector may retain the whole page; inspect returned corners and confidence.

```json
{
  "mode": "colourSharp",
  "normalizeBackground": true,
  "dpi": 144,
  "pages": [
    { "corners": [[0.1,0.1],[0.9,0.08],[0.95,0.9],[0.06,0.92]] },
    { "mode": "gray" }
  ]
}
```

`pages`, if supplied, must have one object per input. Corners are normalized `[x,y]` pairs in
clockwise top-left, top-right, bottom-right, bottom-left order. A top-level `corners` applies to every
input; page-specific corners take precedence. Use `detector: "none"` for full-frame processing
without downloading the corner model. `dpi` (72–600) controls PDF page size, not image resampling.
The PDF has image pages without a searchable OCR layer.

## PDF scanning and watermark removal

`pdf-to-scanned` rasterizes selected pages into a PDF, preserving physical page dimensions.
Plan: `dpi` 72–600 (default 144), `quality` 0.1–1, `grayscale`, and the same `pages` array as
`pdf-to-images`. Text becomes pixels; links, forms, and annotations are not preserved as editable
objects. Use only when the user requests a scanned/rasterized result.

`pdf-remove-watermark` defaults to `mode: "structured"`, removing identifiable watermark structures.
For heuristic removal, first run `pdf-analyze-watermarks`, inspect the candidates, then use:

```json
{ "mode": "advanced", "candidateIds": ["structured"] }
```

Use only candidate IDs returned for the same unchanged input. An ID is not proof that the content
is unwanted: choose candidates that match the user's intended watermark. This is not image
inpainting and cannot remove a watermark baked into page pixels. Removal metadata reports counts
and affected pages; zero removed is not a successful removal claim.

## AI upscaling

`image-upscale` uses tiled RealESRGAN inference. It supports `model: "photo"` (default) or `"anime"`
and `scale: 2` or `4` (default). Output is PNG and retains alpha. Inputs are limited to one megapixel
per image, with up to sixteen megapixels after inference. Large CPU/WASM jobs can take time.

## Smart cutout and editable masks

`image-smart-cutout` uses SlimSAM to select objects from normalized positive/negative points.
Return a transparent PNG; `saveMask: true` also emits a reusable grayscale PNG mask.

```json
{
  "points": [{"x":0.5,"y":0.5,"label":1},{"x":0.05,"y":0.05,"label":0}],
  "saveMask": true,
  "brushes": [{"x":0.5,"y":0.7,"radius":0.03,"mode":"erase"}]
}
```

Use 1–64 points with at least one foreground (`label: 1`) point; background is `label: 0`.
Coordinates refer to the auto-oriented image. `brushes` supports at most 200 circles, with `add` or
`erase`; radius is a fraction of the shorter image edge. `invert: true` reverses the mask before
brush edits. Alternatively supply `maskPath` to a local mask matching the oriented image dimensions;
its red channel supplies opacity (black excluded, white included). This avoids model inference.
Review the mask before using it for another operation; do not silently substitute whole-image
background removal when the user selected a particular object.

## Cutout motion

`cutout-motion` accepts one source image and 1–8 ordered objects. Each object uses the same `points`,
`maskPath`, `invert`, and `brushes` settings as smart cutout. Masks are inferred once and reused.

```json
{
  "format": "mp4", "duration": 3, "fps": 12, "maxEdge": 720,
  "background": "original",
  "objects": [
    {"maskPath":"/absolute/mask.png","outline":"dashed","outlineWidth":3,
     "outlineColor":"#ffffff","glow":"neon","glowIntensity":0.8,"cycles":1}
  ]
}
```

- `format`: `mp4` (default) or `gif`; duration 0.1–15 seconds; fps 1–30; maxEdge 64–1280.
- `background`: `original` (default) or a six-digit hex color.
- `outline`: `none`, `solid` (default), `dashed`, `double`; width 1–16 output pixels;
  `outlineColor` defaults white and double-outline `outerColor` defaults black.
- `glow`: `none`, `exposure`, `neon`, `sweep`; `glowColor` defaults white,
  `glowIntensity` 0–1 (default 0.8). Neon cycles colors.
- Optional object movement `effect`: `none` (default), `float`, `swing`, `pulse`, `orbit`;
  `amplitude` 0–0.5 (default 0.05), `rotation` 0–180 degrees (default 12),
  `phase` 0–360, `cycles` 0.1–10 (default 1), `opacity` 0–1.

Rendering is capped at 180 million output-pixel × frame × object operations; reduce size, fps,
duration, or object count when `MOTION_RESOURCE_LIMIT` is returned. Objects layer in array order. The command renders a parameterized animation; it does not launch the
website's interactive editor or promise pixel-identical Canvas effects. MP4/GIF outputs are opaque.

## Target-size compression

`targetBytes` is a positive integer byte budget. Always inspect `metadata.targetMet`; an impossible
budget returns the smallest permitted result with `targetMet: false` rather than promising success.

For `compress-lossy`:

```json
{ "targetBytes": 1048576, "mode": "preserve" }
```

`mode: "preserve"` is the default, retaining text/vector objects. Target search uses content-aware
image classification with document-quality/resolution floors. Optional `contentAware: true` also
selects that strategy without a target. Manual preset, JPEG quality, and max image dimension options
remain available. Rasterization requires explicit `mode: "raster"`; that mode loses searchable text
and interactive document objects. Raster target search stays at or above 144 DPI and does not
sacrifice text readability indefinitely to chase a byte budget. For explicit raster target searches,
`dpi` is 144–600 and `quality`/`jpegQuality` is 0.55–0.95. The original may be returned if no smaller
result is available; metadata records `notEffective`.

For `image-compress`:

```json
{ "targetBytes": 204800, "format": "jpeg", "width": 1200, "height": 800,
  "keepAspectRatio": true, "allowResize": false }
```

`width` and `height` are 1–8000. One dimension preserves aspect ratio; two dimensions fit within the
box unless `keepAspectRatio: false`. `aspectRatio: "3:2"` crops before resizing. Without dimensions,
`maxEdge` still applies. JPEG/WebP search quality; PNG stays lossless. Further downscaling toward the
target occurs only with `allowResize: true`. Returned width/height describe the actual output.

## Continue from a result

Use verified `outputs[].path` values as subsequent inputs, creating new paths at every step:

- Scan photos → `document-scan-pdf` → `compress-lossy` / merge / split.
- DOCX/PPTX → PDF → watermark / page numbers / images / compression.
- Smart cutout → saved mask → `cutout-motion`.
- Downloaded cloud DOCX/PPTX → local PDF conversion; downloaded PDF → local editing.

Remote OCR/translation/conversion remains a separate upload boundary. Follow the document-services
skill before uploading any intermediate result; local completion never authorizes a new cloud job.
