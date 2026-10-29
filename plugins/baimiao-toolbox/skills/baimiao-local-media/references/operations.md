# Operations Reference

The newer scan, Office, AI cutout/motion, watermark-removal, and target-compression operations are
documented in [advanced-operations.md](advanced-operations.md), including their exact CLI options.

## Operation Selection

| User intent | CLI operation | Required information |
| --- | --- | --- |
| Combine multiple PDFs in order | `merge` | Two or more input paths and one output path |
| Produce one PDF per page range | `split` | One input, ranges, and output directory |
| Copy selected pages into one PDF | `extract` | One input, pages, and one output path |
| Rewrite and losslessly optimize structure | `optimize` | One input and one output path |
| Rotate selected pages | `rotate` | One input, pages, relative angle, and one output path |
| Remove selected pages while preserving the input | `delete` | One input, pages to remove, and one output path |
| Produce a PDF in an explicit page order | `reorder` | One input, page order, and one output path |
| Reorder with blank pages or per-page rotation | `reorder-plan` | One input, JSON plan, and one output path |
| Add styled page numbers | `page-numbers` | One input, optional pages/JSON plan, and one output |
| Remove document metadata | `metadata-cleanup` | One input and one output |
| Turn ordered PNG/JPEG files into a PDF | `images-to-pdf` | One or more images, optional JSON plan, and one output |
| Add a text or image watermark | `watermark` | One PDF, JSON plan, and one output |
| Validate a PDF structure | `check` | One input; JSON report has no output file |
| Rewrite and recover a readable PDF | `repair` | One input and one output |
| Linearize for progressive web viewing | `linearize` | One input and one output |
| Encrypt a PDF | `encrypt` | One input, one output, and secret JSON on stdin |
| Decrypt a PDF | `decrypt` | One input, one output, and secret JSON on stdin |
| Render PDF pages as images | `pdf-to-images` | One PDF, optional plan, and output directory |
| Compress PDF image objects | `compress-lossy` | One PDF, optional plan, and one output |
| Convert image formats | `image-convert` | One or more images, optional plan, and output directory |
| Convert HEIC/HEIF images | `heic-convert` | One or more inputs, optional plan, and output directory |
| Compress images | `image-compress` | One or more images, optional plan, and output directory |
| Resize images | `image-resize` | One or more images, optional plan, and output directory |
| Crop images | `image-crop` | One or more images, optional plan, and output directory |
| Mask private image regions | `image-privacy-mask` | One or more images, optional plan, and output directory |
| Add image text watermarks | `image-watermark` | One or more images, optional plan, and output directory |
| Add rounded corners and borders | `image-border-radius` | One or more images, optional plan, and output directory |
| Rotate or flip images | `image-rotate-flip` | One or more images, optional plan, and output directory |
| Remove image backgrounds | `image-rembg` | One or more images and output directory |
| Create an animated GIF | `image-to-gif` | Ordered distinct images, optional plan, and one output |
| Convert a video clip to GIF | `video-to-gif` | One video, optional plan, and one output |
| Extract animated image frames | `gif-to-images` | One GIF/APNG/WebP, optional plan, and output directory |

Do not describe `optimize` as guaranteed compression. Structural optimization may leave a file the
same size or make it slightly larger.

## Page Ranges

Use one-based, inclusive page numbers:

- `1` selects page 1.
- `1-3` selects pages 1, 2, and 3.
- `1-3,8,10-12` selects three separate ranges.

For `split`, each comma-separated range becomes one output PDF. For `extract`, all ranges are joined
into one output PDF in the specified order. Reject zero, negative, reversed, empty, or out-of-bounds
ranges.

For `rotate` and `delete`, overlapping ranges are applied once per selected page. Rotation angles are
relative to each page's current rotation and must be `-90`, `90`, or `180`. `delete` must leave at
least one page.

For `reorder`, use one-based pages and ascending ranges inside an explicit sequence. For example,
`3,1-2` produces pages 3, 1, 2. Repeated pages are allowed, and omitted pages are not copied.

## JSON Plans

Use an absolute `--plan` path. Plans must contain valid JSON and be no larger than 1 MiB.

Advanced reorder:

```json
{
  "pages": [
    { "page": 3, "rotation": 90 },
    { "type": "blank" },
    1,
    { "page": 2, "rotation": 270 }
  ]
}
```

Blank pages inherit the most recently copied page size. To set one explicitly, add positive
`width` and `height` values in PDF points. Rotations must be `0`, `90`, `180`, or `270`.

Page numbers:

```json
{
  "startNumber": 1,
  "position": "bottom-center",
  "format": "custom",
  "customFormat": "{page} / {total}",
  "facingPages": false,
  "coverPage": false,
  "style": {
    "fontSize": 11,
    "margin": 28,
    "color": "#404040",
    "bold": false,
    "italic": false,
    "underline": false
  }
}
```

Use `--pages "1-3,8"` or a plan `ranges` array such as
`[{"start":1,"end":3},{"start":8,"end":8}]`, but not both. Positions support all top/bottom and
left/center/right combinations. Formats are `number`, `page-number`, `page-of-total`, or `custom`.
The built-in page-number font supports Latin text. Report custom non-Latin labels as unsupported.

Images to PDF:

```json
{ "pageSize": "a4", "orientation": "portrait", "margin": 24 }
```

`pageSize` is `fit-image`, `a4`, or `letter`; orientation is `auto`, `portrait`, or `landscape`;
margin is 0-144 PDF points. Repeat `--input` in the intended page order.

Watermark:

```json
{
  "mode": "text",
  "text": "CONFIDENTIAL",
  "ranges": [{ "start": 1, "end": 3 }],
  "opacity": 0.15,
  "angle": 45,
  "fontSize": 48,
  "color": "#808080",
  "pattern": "mosaic",
  "position": "center",
  "bold": true,
  "italic": false,
  "underline": false
}
```

For an image watermark, set `mode` to `image`, provide an absolute PNG/JPEG `imagePath`, and set
`imageScale` from `0.05` to `1`. Local text watermarking supports printable Latin text. Use an
image watermark for Chinese or other scripts. Under-content watermarks are unsupported locally.

PDF rendering and lossy compression:

```json
{ "pages": [1, { "start": 3, "end": 5 }], "dpi": 144, "format": "png", "quality": 0.9 }
```

`pdf-to-images` supports `dpi` 36-600, `format` `png`/`jpeg`/`webp`, `quality` 0.1-1, and a
one-based `pages` array. Do not put PDF passwords in a plan. `compress-lossy` accepts preset
`small`, `standard`, or `clear`, plus optional `jpegQuality` 0.1-0.95,
`maxImageDimension` 240-2400, `grayscale`, and `flattenTransparency`. It preserves text and vector
content and may report `notEffective: true` when replacing images would not save enough bytes.

Image conversion and editing plans:

```json
{
  "format": "png",
  "quality": 0.9,
  "mode": "max-edge",
  "value": 1280
}
```

All image operations accept `format` `png`/`jpeg`/`webp` and `quality` 0.1-1. Relevant fields are:

- `image-compress`: `maxEdge` 240-6000.
- `image-resize`: `mode` `max-edge`/`width`/`height`/`percent` and `value` 1-8000.
- `image-crop`: `crop` with integer `x`, `y`, `width`, `height`, or `aspectRatio` such as `16:9`.
- `image-privacy-mask`: `selection`, `mode` `solid`/`blur`/`pixelate`, `color`, and `opacity`.
- `image-watermark`: `text`, `textSize`, `opacity`, `color`, `angle`, `pattern`, and `position`.
- `image-border-radius`: `borderRadius`, `borderWidth`, and `borderColor`.
- `image-rotate-flip`: `rotation` 0/90/180/270, `flipHorizontal`, and `flipVertical`.
- `image-rembg`: emits transparent PNG using the local RMBG-1.4 model. Its optional plan field
  `precision` accepts `fp32` (default, aligned with the web WASM path) or `quint8` (smaller
  download and lower memory use, with a possible small quality tradeoff). Only the selected
  weight file is downloaded and cached.

```json
{ "precision": "fp32" }
```

GIF and video plans:

```json
{ "maxEdge": 720, "delayMs": 500, "repeat": 0 }
```

`image-to-gif` accepts `maxEdge` 64-1920, `delayMs` 20-60000, and `repeat` 0-65535.
`video-to-gif` accepts `fps` 1-30, `maxEdge` 64-1920, `startSeconds`, optional `endSeconds`, and
`repeat`; it never enlarges the source. `gif-to-images` accepts `format` and `quality` and emits
one file per frame.

Command forms:

```bash
node "<skill-dir>/scripts/baimiao.mjs" reorder-plan --input "/a.pdf" --plan "/plan.json" --output "/out.pdf"
node "<skill-dir>/scripts/baimiao.mjs" page-numbers --input "/a.pdf" --pages "1-3" --plan "/plan.json" --output "/out.pdf"
node "<skill-dir>/scripts/baimiao.mjs" metadata-cleanup --input "/a.pdf" --output "/clean.pdf"
node "<skill-dir>/scripts/baimiao.mjs" images-to-pdf --input "/1.png" --input "/2.jpg" --plan "/plan.json" --output "/images.pdf"
node "<skill-dir>/scripts/baimiao.mjs" watermark --input "/a.pdf" --plan "/watermark.json" --output "/marked.pdf"
node "<skill-dir>/scripts/baimiao.mjs" check --input "/a.pdf"
node "<skill-dir>/scripts/baimiao.mjs" repair --input "/a.pdf" --output "/repaired.pdf"
node "<skill-dir>/scripts/baimiao.mjs" linearize --input "/a.pdf" --output "/linearized.pdf"
node "<skill-dir>/scripts/baimiao.mjs" pdf-to-images --input "/a.pdf" --plan "/render.json" --output-dir "/pages"
node "<skill-dir>/scripts/baimiao.mjs" compress-lossy --input "/a.pdf" --plan "/compress.json" --output "/small.pdf"
node "<skill-dir>/scripts/baimiao.mjs" image-resize --input "/a.png" --plan "/resize.json" --output-dir "/images"
node "<skill-dir>/scripts/baimiao.mjs" image-to-gif --input "/1.png" --input "/2.png" --plan "/gif.json" --output "/out.gif"
node "<skill-dir>/scripts/baimiao.mjs" video-to-gif --input "/clip.mp4" --plan "/gif.json" --output "/clip.gif"
node "<skill-dir>/scripts/baimiao.mjs" gif-to-images --input "/animation.gif" --output-dir "/frames"
```

For `encrypt`, write `{"userPassword":"...","ownerPassword":"..."}` to a host-provided secret
stdin channel. For `decrypt`, use `{"password":"..."}`. Never place these values in command
arguments, environment variables, plans, files, or task logs. Do not call the password CLI unless
the host guarantees that stdin is excluded from task history.

## Structured Errors

| Code | Response |
| --- | --- |
| `INVALID_ARGUMENT` | Correct the command only when the user's intent is already clear; otherwise ask. |
| `INPUT_NOT_FOUND` | Ask for an existing absolute path. |
| `INPUT_NOT_PDF` | Stop and explain that the selected input is not a readable PDF. |
| `INPUT_NOT_IMAGE` | Stop and ask for a readable supported image; `images-to-pdf` accepts PNG/JPEG only. |
| `INPUT_NOT_GIF` | Stop and ask for a readable GIF, APNG, or animated WebP. |
| `INPUT_NOT_VIDEO` | Stop and ask for a supported readable video. |
| `PASSWORD_REQUIRED` | Stop; do not add a password to the plan or command arguments. |
| `OUTPUT_EXISTS` | Pick a new filename and retry once. Never delete or overwrite the existing file. |
| `INVALID_PAGE_RANGE` | Ask for corrected ranges and include `details.pageCount` when present. |
| `INVALID_PAGE_ORDER` | Ask for a corrected page order and include `details.pageCount` when present. |
| `INVALID_PLAN` | Correct or recreate the JSON plan without changing the requested operation. |
| `UNSUPPORTED_WATERMARK_TEXT` | Use an image watermark or report that the text is unsupported locally. |
| `UNSUPPORTED_WATERMARK_LAYER` | Report that under-content watermarks are unsupported locally. |
| `DELETE_ALL_PAGES` | Ask the user to choose pages that leave at least one page in the result. |
| `ENCRYPTED_PDF` | Stop and explain that the host has no safe secret-input channel. Never request a password for the CLI. |
| `QPDF_UNAVAILABLE` | Stop and report that the bundled local runtime is unavailable. |
| `RUNTIME_DOWNLOAD_FAILED` | Explain that the operation needs a one-time public runtime download and ask the user to reconnect before retrying. |
| `RUNTIME_INTEGRITY_FAILED` | Stop. Do not bypass the size or SHA-256 check; report that the runtime source failed verification. |
| `RUNTIME_CACHE_CONFLICT` | Stop and report the cache path from `details.path`; do not silently use an invalid cached file. |
| `PROCESSING_FAILED` | Retry once only if the failure was plausibly transient; otherwise stop and explain the failure. |
| `OUTPUT_WRITE_FAILED` | Ask for another writable output directory. |

## Output Naming

Prefer these names when the user did not specify one:

- Merge: `<first-input>-merged.pdf`
- Extract: `<input>-extracted.pdf`
- Optimize: `<input>-optimized.pdf`
- Rotate: `<input>-rotated.pdf`
- Delete pages: `<input>-pages-removed.pdf`
- Reorder: `<input>-reordered.pdf`
- Page numbers: `<input>-numbered.pdf`
- Metadata cleanup: `<input>-metadata-cleaned.pdf`
- Images to PDF: `images.pdf`
- Split directory: `<input>-split`
- PDF pages directory: `<input>-pages`
- Lossy PDF compression: `<input>-compressed.pdf`
- Image batches: `<operation>-results`
- Image to GIF: `<first-input>.gif`
- Video to GIF: `<input>.gif`
- GIF frames directory: `<input>-frames`

If a preferred name exists, add a numeric suffix instead of overwriting it.

## On-Demand Runtimes

QPDF, pdf-lib, and the image codecs are bundled. ImageMagick, PDFium, FFmpeg, ONNX Runtime, the
RMBG model, and the CJK watermark font are downloaded only when an operation first needs them.
The downloader accepts only the exact HTTPS URL, byte size, and SHA-256 declared in
`scripts/runtime-assets.mjs`, then atomically links the verified file into a versioned platform
cache. A runtime download transfers only public executable/model/font assets and never transfers
the user's input file.
