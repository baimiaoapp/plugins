# Local feature synchronization (0.6.0)

Source: sibling `baimiao-pdf`, HEAD `096fb54` at synchronization. This is provenance, not a runtime
filesystem dependency. All executable support lives inside the plugin.

- `scripts/ported/document*.mjs`: the document geometry, DocAligner preprocessing/heatmap decoding,
  Harmony-style normalization and six CPU filters from `src/services/document-enhancement/`.
- `scripts/ported/pdfWatermarkRemoval.mjs`: watermark candidate analysis and selected/structured
  removal from `src/services/pdfWatermarkRemoval.js`.
- `scripts/ported/selectFontPacks.mjs`: font-family and character coverage selection from
  `src/services/wordPreviewFonts.js`.
- `scripts/pdf-lossy-runtime/`: synchronized PDF image analysis, placement analysis, compression
  safety and content-aware rewrite logic. The JPEG classifier uses local ImageMagick pixels instead
  of browser Canvas. Browser-only decoding branches remain optional and fail closed in Node.
- `extended-runtime-assets.mjs`: exact deployed WordCraft/DeckCraft runtime bytes, font catalog,
  DocAligner LC100, SlimSAM encoder/decoder, and photo/anime RealESRGAN models. No runtime cache or
  model binaries are included in the package. Runtime cache validation applies on every process.

CLI adaptation uses Node worker isolation for Office conversion, local ONNX WASM for models,
ImageMagick for pixels, PDFium for page rendering, and FFmpeg for animation export. Motion implements
parameterized outline/glow effects and optional transforms; it does not embed the website editor.
AI upscaling is tiled with context padding; CPU jobs intentionally have bounded input dimensions.

Local OCR is deliberately excluded. Cloud translation adds `output_format` without changing
OAuth/upload/credit boundaries. Result handoffs suggest local operations only; they never submit jobs.

Validation: `yarn verify` covers contracts, output transactions, CLI/MCP/OAuth regression tests and
new local operations. `yarn test:ai` additionally runs the real corner, SlimSAM, and both RealESRGAN
models. Model/font downloads are public and verified. Neither command proves live authenticated
cloud conversion or production deployment.

## Verification record

- `yarn install --immutable`: passed with Yarn 4.6.0.
- `yarn verify`: passed, including isolated plugin CLI/MCP/OAuth regressions and 20 extended cases.
  The repeat run reused the external runtime cache; runtime integrity validation remained enabled.
- `yarn test:ai`: passed 24 extended cases including actual LC100, SlimSAM, photo/anime RealESRGAN
  inference, foreground/background mask checks, and animated multi-object lighting output.
- Both skills passed the installed `skill-creator/scripts/quick_validate.py`.
- Package, manifest and MCP server versions match at 0.6.0; marketplace source resolves correctly.
- A generated Chinese 8/9/10/12/16-point sample was converted, rasterized, target-compressed and
  visually checked. Raster compression reduced 216,506 bytes to 148,694 bytes with readable small
  text; preserve mode returned the original when its quality floor could not meet the target.
- The environment does not contain the requested `plugin-creator` validator. Its independent check
  remains outstanding; repository build/manifest checks are not represented as that validator.
- Cloud translation's PDF output was checked through the local backend contract and mocked HTTP/MCP
  tests, without uploading customer files or consuming account credits. No deployment was performed.
