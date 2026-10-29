# Baimiao Plugin Marketplace

[中文](README.md)

The official Baimiao plugin marketplace for AI assistants.

## Available plugins

### Baimiao Toolbox

Helps AI assistants work with PDFs, images, and other media while keeping local work on your device.

- Organize, split, and merge PDFs; compress toward a target size, create scanned PDFs, or remove identifiable watermarks.
- Convert DOCX/PPTX to PDF locally; scan photos, correct perspective, enhance documents, and export batches to PDF.
- Convert, resize, crop, compress, and watermark images, with AI upscaling, background removal, and smart cutout.
- Process HEIC, GIF, and video; add outlines and lighting effects to cutout objects and export GIF/MP4.
- Use Baimiao cloud OCR, PDF-to-Office/Markdown, and document translation with Word or PDF output.

Local operations preserve inputs and never overwrite outputs. Models and runtimes download on demand;
local OCR is not included. Files upload only for cloud OCR, PDF-to-Office/Markdown, or document
translation. These services require Baimiao OAuth authorization and may use account credits.
Target-size compression may miss the requested size; inspect Office conversion output for fidelity.

## Install in WorkBuddy

Send WorkBuddy this prompt:

```text
Please install Baimiao Toolbox from https://gitee.com/baimiaoapp/plugins. Read the repository's plugin marketplace configuration and install baimiao-toolbox, rather than only cloning the repository. Report the installation result and any steps needed to activate the plugin.
```

## Install in Codex

1. Open **Plugins** in the Codex desktop app.
2. Select **Add plugin marketplace** and enter:

```text
https://github.com/baimiaoapp/plugins.git
```

3. Choose the plugins you need from the **Baimiao Plugin Marketplace**.
4. Start a new Codex task.

Command-line installation:

```bash
codex plugin marketplace add https://github.com/baimiaoapp/plugins.git
codex plugin add baimiao-toolbox@baimiao-plugins
```
