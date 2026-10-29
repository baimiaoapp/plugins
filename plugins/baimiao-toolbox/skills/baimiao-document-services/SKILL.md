---
name: baimiao-document-services
description: Use OAuth-authorized Baimiao remote services for image OCR, PDF-to-Office/Markdown conversion, and PDF translation. Use for text, LaTeX, or table recognition from supported images; converting PDFs to DOCX, Markdown, PPT, or Excel; translating PDFs; and Baimiao login, logout, or account-service routing. Trigger for equivalent Chinese or English requests. Do not use for local PDF page editing, compression, image editing, GIF, or video workflows.
---

# Baimiao Document Services

Use the Baimiao MCP tools for remote OCR, document conversion, and translation. Remote processing
uploads the selected file; never imply that these operations happen locally. Preserve every input
and refuse to overwrite an existing output.

## Run The Workflow

1. Resolve the input and any requested output to absolute paths.
2. Call `get_baimiao_execution_plan` first when the execution boundary or supported operation is
   unclear.
3. Before a start tool, state the absolute input path that will be uploaded and that credits may be
   used. The user's OAuth approval is upload consent, so do not request a second per-call consent.
4. Start the matching operation:
   - Use `start_baimiao_conversion` for PDF to `docx`, `markdown`, `ppt`, or `excel`.
   - Use `start_baimiao_translation` with a target language, `normal` or `compare` mode,
     and `output_format: "word"` (default) or `"pdf"`.
   - Use `start_baimiao_ocr` for `text`, `latex`, or `table` recognition.
5. Poll `get_baimiao_task`; do not hold one tool call open for a long conversion.
6. For file results, call `save_baimiao_result` with a new absolute output path and verify that it
   exists before presenting it.

## Handle Formats And Results

Read [references/service-capabilities.md](references/service-capabilities.md) when checking OCR input
formats, result formats, download limits, translation language codes, or exact website routes.

## Handle Authentication And Browser Fallback

If MCP returns `AUTH_REQUIRED`, call `login_baimiao`. It opens the system browser for OAuth consent
and returns through a local callback; never ask the user to copy a code or credential. Retry after
login. Use `logout_baimiao` when the user asks to disconnect the Baimiao account.

If MCP is unavailable, use the browser route documented in the service reference. Browser fallback
uploads remain user-driven in the UI. Reuse the user's existing browser login; never ask for access
tokens, passwords, verification codes, payment data, or session cookies.

Require explicit user confirmation immediately before purchases, redemption, account mutation, or
any action that consumes credits when the UI discloses a charge.

## Continue Locally

After saving a result, pass its verified path to the local-media skill for local PDF editing,
compression, or DOCX/PPTX-to-PDF conversion. Keep each intermediate file and choose new output paths.
Do not automatically submit a second cloud job when only local follow-up processing was requested.
