# Third-Party Notices

The Baimiao Toolbox Plugin bundles its core JavaScript and WebAssembly runtimes and downloads
larger optional runtimes from pinned public URLs on first use. The Plugin contains, downloads, or
is built with the following projects:

- QPDF v11.9.1, copyright 2005-2024 Jay Berkenbilt, licensed under Apache-2.0.
  See `third-party/QPDF-LICENSE.txt` and `third-party/QPDF-NOTICE.md`.
- Emscripten-generated JavaScript and WebAssembly runtime support, available under the MIT and
  University of Illinois/NCSA licenses. See `third-party/EMSCRIPTEN-LICENSE.txt`.
- musl libc portions used by the Emscripten runtime. See `third-party/MUSL-COPYRIGHT.txt`.
- zlib 1.3.1, copyright Jean-loup Gailly and Mark Adler. See
  `third-party/ZLIB-LICENSE.txt`.
- Independent JPEG Group JPEG software release 9f. This software is based in part on the work of
  the Independent JPEG Group. See `third-party/LIBJPEG-README.txt`.
- pdf-lib 1.17.1, copyright 2019 Andrew Dillon, licensed under the MIT License. See
  `third-party/PDF-LIB-LICENSE.txt`.
- ImageMagick WASM 0.0.42, licensed under Apache-2.0. See
  `third-party/IMAGEMAGICK-LICENSE.txt` and `third-party/IMAGEMAGICK-NOTICE.txt`.
- EmbedPDF PDFium wrapper 2.14.4, licensed under MIT, and the downloaded PDFium runtime, licensed
  under the BSD-style PDFium license. See `third-party/PDFIUM-WRAPPER-LICENSE.txt` and
  `third-party/PDFIUM-LICENSE.txt`.
- FFmpeg core 0.12.10, licensed under GPL-2.0-or-later. The downloaded FFmpeg WebAssembly core is
  a GPL component; downstream redistributors must evaluate and satisfy the GPL obligations for
  their distribution. See `third-party/FFMPEG-GPL-2.0.txt`.
- ONNX Runtime Web 1.26.0 development build, licensed under MIT. See
  `third-party/ONNXRUNTIME-LICENSE.txt`.
- RMBG-1.4 FP32 and quantized ONNX models from
  `kittypdf/RMBG-1.4-transformersjs@2d116050ec1d32554a52c017375e1cea31253b90`, licensed under
  Apache-2.0. See `third-party/RMBG-1.4-LICENSE.txt`.
- Noto Sans CJK SC Regular, licensed under the SIL Open Font License 1.1. See
  `third-party/NOTO-SANS-CJK-OFL.txt`.

The QPDF notice also contains attribution for code included within QPDF, including its Rijndael and
sphlib-derived implementations. The original license and notice texts are distributed alongside the
runtime and govern their respective components.

## Additional optional runtimes in 0.6.0

- WordCraft preview at f30ad85ac4b7ac453a099728ded7fa6f62b50624 and DeckCraft preview at
  fddfdf432aa950e9a2c82d7610674a3ab65a5679, MIT OR Apache-2.0. Source, transitive notices and font
  notices accompany `third-party/wordcraft-preview/` and `third-party/deckcraft-preview/`.
  Fonts are downloaded only when selected by the pinned coverage/family catalog. Named symbol fonts
  have their own notices and are not described as OFL fonts.
- DocsaidLab DocAligner LC100 heatmap model, Apache-2.0; see `third-party/DOCALIGNER-LICENSE.txt`.
- SlimSAM encoder/decoder from `Xenova/slimsam-77-uniform` revision
  5850ab45f587c112167512ffef949107115e26a0, Apache-2.0; see `third-party/SLIMSAM-LICENSE.txt`.
- Real-ESRGAN photo x4plus and anime 6B ONNX conversions. Upstream Real-ESRGAN is BSD-3-Clause;
  see `third-party/REALESRGAN-LICENSE.txt`. Exact conversion repository revisions and file hashes
  are recorded in `extended-runtime-assets.mjs`.
