# Service Capabilities

Use this reference for Baimiao MCP service contracts, result formats, and the account boundary
below. Use the website routes only when MCP is unavailable. Prefix routes with
`https://pdf.baimiaoapp.com`. Simplified Chinese may omit a locale prefix. Other supported locale
prefixes are `en`, `zh-hant`, `ja`, `ko`, `es`, `pt`, `de`, `fr`, `it`, `ru`, and `id`.

## MCP-Remote Operations

These workflows upload user-selected files to Baimiao services and may require login or credits:

| Operation | MCP tool | Value |
| --- | --- | --- |
| PDF to Word | `start_baimiao_conversion` | `format: docx` |
| PDF to Markdown | `start_baimiao_conversion` | `format: markdown` |
| PDF to PowerPoint | `start_baimiao_conversion` | `format: ppt` |
| PDF to Excel | `start_baimiao_conversion` | `format: excel` |
| PDF translation | `start_baimiao_translation` | `mode: normal` or `compare`; `output_format: word` (default) or `pdf` |
| Image text OCR | `start_baimiao_ocr` | `kind: text` |
| Image formula OCR | `start_baimiao_ocr` | `kind: latex` |
| Image table OCR | `start_baimiao_ocr` | `kind: table` |

Every start call requires a normalized absolute `input_path`. State the named file and possible
credit use before calling; the OAuth grant supplies upload consent, so there is no per-call
confirmation field. Start calls return immediately with a task ID. Poll `get_baimiao_task`, then
use `save_baimiao_result` with a new absolute path for a completed file result. Never place
authentication or upload-signature data in tool arguments.
When authentication is required, call `login_baimiao` and let the user approve access in the
system browser. Never ask the user to paste a token or authorization code. `logout_baimiao` removes
the locally stored OAuth credential.

OCR inputs may be PNG, JPEG, WebP, BMP, HEIC/HEIF, or TIFF; do not submit PDFs to OCR. The Plugin
converts HEIC/HEIF and TIFF inputs to JPEG locally before upload because the remote OCR engines do
not accept those source formats. Text and LaTeX OCR expose `result.text` when extractable and save UTF-8 text. Structured responses without
extractable text save as pretty JSON (`format: json`). Table responses with a download URL save the
actual workbook (`format: xlsx`). Saved result downloads are capped at 100 MiB and never overwrite
an existing path. Translation accepts exactly: `zh`, `cht`, `en`, `jp`, `kor`, `spa`, `ru`, `yue`,
`th`, `pt`, `el`, `bul`, `fin`, `slo`, `wyw`, `fra`, `ara`, `de`, `nl`, `est`, `cs`, `swe`, `vie`,
`it`, `pl`, `dan`, `rom`, and `hu`.

The website routes remain the fallback when MCP is unavailable: `/pdf-to-word`,
`/pdf-to-markdown`, `/pdf-to-ppt`, `/pdf-to-excel`, `/pdf-to-word-translation`, `/image-ocr`,
`/image-to-latex`, and `/image-to-excel`. Reuse the browser login flow and never request account
secrets in chat.

## Account Boundary

Use `/pricing` for plan and credit purchase information. Purchases, redemption, login, password
changes, phone binding, nickname changes, and entitlement restoration remain user-driven browser
actions. The Agent may navigate and explain but must not submit a purchase or mutate account data
without an immediately preceding explicit confirmation.
