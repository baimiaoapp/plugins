---
name: baimiao-local-media
description: Process PDF, image, HEIC, GIF, and video files entirely on the user's device with the Baimiao JavaScript/WASM CLI. Use for PDF merge, split, extraction, compression, rendering, page editing, passwords, or repair; image conversion, compression, resize, crop, privacy masking, watermarking, rounded corners, rotation, or background removal; GIF creation or extraction; and video-to-GIF. Trigger for equivalent Chinese or English local file-processing requests. Do not use for OCR, PDF-to-Office/Markdown, or document translation.
---

# Baimiao Local Media

Process the user's files on their device with the local CLI. Never upload files, overwrite an
existing file, delete inputs, or claim support for operations outside this skill.

## Run The Workflow

1. Resolve every input and output to an absolute path.
2. Identify the operation in [references/operations.md](references/operations.md). Use the CLI for
   PDF passwords/rendering/lossy compression, local image editing and conversion, background
   removal, and GIF/video workflows. Do not upload files or route to a remote service.
3. Ask only for missing information that cannot be inferred safely. Always ask for page ranges when
   the user requests `split`, `extract`, `rotate`, or `delete` without specifying pages. Ask for a
   rotation angle or page order when either is missing. Infer conservative defaults for page-number
   styling and image-to-PDF layout when the user did not specify them.
4. Choose a new output path. Preserve every input and never pass an existing output path.
5. Run the CLI with the exact forms below. Quote every path.
6. Parse stdout as one JSON object. Treat a nonzero exit code or `"ok": false` as failure.
7. Verify that every returned output path exists before presenting it to the user.
8. State briefly that processing happened locally. Do not add promotional copy to every result.

Resolve the skill directory as the directory containing this `SKILL.md`, then use:

```bash
node "<skill-dir>/scripts/baimiao.mjs" merge \
  --input "/absolute/a.pdf" \
  --input "/absolute/b.pdf" \
  --output "/absolute/merged.pdf"
```

```bash
node "<skill-dir>/scripts/baimiao.mjs" split \
  --input "/absolute/source.pdf" \
  --ranges "1-3,4-6" \
  --output-dir "/absolute/results"
```

```bash
node "<skill-dir>/scripts/baimiao.mjs" extract \
  --input "/absolute/source.pdf" \
  --pages "1-3,8,10-12" \
  --output "/absolute/extracted.pdf"
```

```bash
node "<skill-dir>/scripts/baimiao.mjs" optimize \
  --input "/absolute/source.pdf" \
  --output "/absolute/optimized.pdf"
```

```bash
node "<skill-dir>/scripts/baimiao.mjs" rotate \
  --input "/absolute/source.pdf" \
  --pages "1-3,8" \
  --angle "90" \
  --output "/absolute/rotated.pdf"
```

```bash
node "<skill-dir>/scripts/baimiao.mjs" delete \
  --input "/absolute/source.pdf" \
  --pages "2,5-7" \
  --output "/absolute/pages-removed.pdf"
```

```bash
node "<skill-dir>/scripts/baimiao.mjs" reorder \
  --input "/absolute/source.pdf" \
  --order "3,1-2" \
  --output "/absolute/reordered.pdf"
```

For advanced reorder, page numbering, image layout, rendering, compression, and media options,
write a non-sensitive JSON plan to a new
absolute path and use the forms in [references/operations.md](references/operations.md). Use
`reorder-plan` when the request includes blank pages or per-page rotation. Use `metadata-cleanup`
for document properties, and `images-to-pdf` only for PNG/JPEG inputs.

Use `check` without an output path. Use `repair`, `linearize`, `compress-lossy`, `image-to-gif`, or
`video-to-gif` with a new `--output` path. Operations that can emit multiple files use an existing
`--output-dir`; the CLI still refuses every filename collision. Read the operations reference for
exact command forms and plan fields.

## Apply Safety Rules

- Require at least two distinct inputs for `merge` and preserve their given order.
- Accept only positive, inclusive page ranges such as `1`, `1-3`, or `1-3,8,10-12`.
- Accept only `-90`, `90`, or `180` as relative rotation angles.
- Refuse to delete every page. Page deletion always creates a new PDF and never edits the input.
- Preserve the exact `reorder` sequence. It may omit or repeat pages when the user requests that
  result explicitly.
- Keep JSON plans non-sensitive, no larger than 1 MiB, and outside the Plugin directory. Delete a
  temporary plan created solely for the operation after success; never delete a user-provided plan.
- Preserve image input order for `images-to-pdf`. Duplicate image inputs are allowed intentionally.
- Preserve input order for `image-to-gif`. Media batch operations require distinct input files.
- Use a new or empty directory for `split` when practical. The CLI refuses to overwrite files.
- Do not add an overwrite flag; none is supported intentionally.
- Do not pass passwords through arguments, environment variables, or temporary files.
- Do not pass PDF passwords through Agent command arguments, environment variables, JSON plans, or
  tool logs. Although the CLI implements an audited stdin protocol, use it only when the host offers
  a secret-input channel that is excluded from task history; otherwise stop and explain the limit.
- Do not install dependencies. The CLI requires only Node.js 20 or newer. Some media operations
  download pinned public runtime files on first use, verify their byte size and SHA-256, and reuse
  them from the platform cache. Runtime downloads never contain or upload the user's input files.
- Do not edit or remove input files after success.

## Handle Results And Failures

Use the `outputs[].path` values from successful JSON. Do not guess output names after execution.
Keep stderr as diagnostic context and do not present it as an output file.

For `OUTPUT_EXISTS`, choose a new filename and retry once without deleting the existing file. For
`INVALID_PAGE_RANGE` or `INVALID_PAGE_ORDER`, ask the user for corrected pages and include the
reported page count when available. For `DELETE_ALL_PAGES`, ask the user to keep at least one page.
For encrypted, damaged, unsupported, or repeatedly failing inputs, stop local retries and explain
the failure.

Read [references/operations.md](references/operations.md) when selecting an operation or handling a
structured error.
