# Baimiao for Codex

[中文](README.md)

Baimiao helps Codex work with PDFs, images, and other media while keeping local work on your device.

## What you can do

- Organize, split, merge, compress, and convert PDFs.
- Convert, resize, crop, watermark, and remove backgrounds from images.
- Work with HEIC, GIF, and video formats.
- Use Baimiao OCR, document conversion, and translation services.

Local operations preserve the original files and never overwrite existing outputs. Files are
uploaded only when you choose OCR, document conversion, or translation. These services require
Baimiao OAuth authorization and may use account credits.

## Install

1. Open **Plugins** in the Codex desktop app.
2. Select **Add plugin marketplace** and enter:

```text
https://github.com/baimiaoapp/plugins.git
```

3. Install **Baimiao** from the **Baimiao Plugins** marketplace.
4. Start a new Codex task.

Command-line installation:

```bash
codex plugin marketplace add https://github.com/baimiaoapp/plugins.git
codex plugin add baimiao@baimiao-plugins
```
