# Changelog

## 0.6.0

- Add local DOCX/PPTX-to-PDF, document scanning and six enhancement modes, scanned PDF generation,
  and analyzed/structured watermark removal.
- Add RealESRGAN photo/anime upscaling, SlimSAM point-guided cutout with editable masks,
  and per-object outline/light/movement animation exported as GIF or MP4.
- Add target-size PDF/image compression, dimension controls, and content-aware PDF image handling.
- Add cloud translation PDF output and local result handoff suggestions. Local OCR is excluded.
- Pin all new runtime/model/font downloads by HTTPS URL, size and SHA-256; keep files local and
  publish outputs through the existing no-overwrite transaction.

## 0.5.0

- Rename the product and plugin identifier to Baimiao Toolbox (`baimiao-toolbox`).
- Use the host-neutral `documents:process` OAuth scope.
- Stream runtime downloads and verify them incrementally.
- Route local operations through a shared handler registry.
- Share artifact transactions across local media and MCP result publishing.
- Isolate OCR input preparation behind a dedicated module.
