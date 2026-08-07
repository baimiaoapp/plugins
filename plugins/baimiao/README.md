# Baimiao Plugin

Codex Plugin for local PDF and media workflows, plus OAuth-authorized Baimiao OCR,
document conversion, and translation.
The Plugin exposes separate `baimiao-local-media` and `baimiao-document-services` skills so local
file operations do not load or trigger remote-service instructions.
The Plugin preserves input files and refuses output overwrites. Local PDF and media operations stay
on the user's device. Its stdio MCP exposes remote tools only for Baimiao OCR,
PDF-to-Office/Markdown, and PDF translation. PDF conversion and translation are asynchronous; OCR
returns a completed result in the current MCP process.

OCR accepts PNG, JPEG, WebP, BMP, HEIC/HEIF, and TIFF images; PDF input is intentionally rejected.
Text and LaTeX OCR expose readable text in the start/get-task result and save extracted content as
UTF-8 text. If a provider returns structured data without extractable text, the result is reported
as `json` and saved as pretty-printed UTF-8 JSON. Table OCR responses with a download URL are
reported as `xlsx` and save the actual workbook rather than the response envelope.

## Remote MCP adapter

The MCP validates absolute input paths and uses the Baimiao OAuth grant as consent for subsequent
remote processing. Before each call, the host should disclose the file being uploaded and possible
credit use, but no second confirmation field is required. It submits remote work, polls normalized
PDF task state, and saves completed results only to new absolute paths. Authentication uses OAuth
2.1 Authorization Code with PKCE and is never accepted as a tool argument. Run `login_baimiao` to
open the system browser, approve access, and return through a temporary `127.0.0.1` callback.
`get_baimiao_auth_status` reports expiry without exposing the credential, and `logout_baimiao`
removes it.

The dependency-free credential fallback is a user-level JSON file. It is written atomically with
mode `0600`, and its directory is restricted to `0700`, but it is not encrypted at rest. The paths
are `~/Library/Application Support/Baimiao PDF/oauth.json` on macOS,
`~/AppData/Roaming/Baimiao PDF/oauth.json` on Windows, and
`~/.config/baimiao/oauth.json` on Linux. Prefer `logout_baimiao` for cleanup; deleting that file
while the MCP is stopped has the same effect. Access tokens are refreshed shortly before expiry;
refresh-token rotation replaces the credential file atomically. A revoked or invalid refresh token
clears local credentials and requires `login_baimiao` again. Logout discovers and calls the OAuth
revocation endpoint before clearing local credentials.

The OAuth client discovers the protected-resource and authorization-server metadata, then requires
the `https://pdf.baimiaoapp.com/api/web/mcp` audience and `mcp:tools` scope. Local paths cannot be
passed to the remote HTTP MCP because its file contract requires a remotely reachable HTTPS URL.
The stdio adapter therefore keeps the local-path flow: obtain a short-lived OSS upload session,
stream the file directly, and submit the task. The backend validates the MCP token on those
endpoints with the same issuer, audience, expiry, and scope rules.

OAuth discovery, token exchange, API calls, uploads, and result downloads all have bounded request
times. Result downloads are limited to 100 MiB; an oversized or interrupted result leaves no output
or temporary file. `save_baimiao_result` reports the saved `format` and always refuses an existing
output path.

Translation language codes follow the API enum exactly: `zh`, `cht`, `en`, `jp`, `kor`, `spa`,
`ru`, `yue`, `th`, `pt`, `el`, `bul`, `fin`, `slo`, `wyw`, `fra`, `ara`, `de`, `nl`, `est`, `cs`,
`swe`, `vie`, `it`, `pl`, `dan`, `rom`, and `hu`.

For tests or host integration, `BAIMIAO_MCP_AUTH_ADAPTER_MODULE` may point to an absolute trusted
module exporting `getAuthorizationHeaders()`. HTTPS or loopback overrides use
`BAIMIAO_MCP_API_BASE_URL` and `BAIMIAO_MCP_RESOURCE_URL`; `BAIMIAO_MCP_OAUTH_CLIENT_ID` selects a
registered public client. `BAIMIAO_MCP_OAUTH_METADATA_URL` can override metadata discovery. These
variables contain locations and a public identifier only, never credentials. Tests can replace the
whole transport through `BAIMIAO_MCP_ADAPTER_MODULE`.

## Development

```bash
yarn install
yarn build
yarn lint
yarn test
```

The first media test downloads pinned runtime files into the user cache. To prefetch selected
runtime groups:

```bash
yarn runtime:prefetch magick pdfium
yarn runtime:prefetch all
```

## Runtime downloads

QPDF, pdf-lib, and the image codecs remain bundled so common PDF operations work offline. Larger
ImageMagick, PDFium, FFmpeg, ONNX Runtime, RMBG model, and CJK font files are downloaded only when
an operation first needs them. Downloads use exact versioned HTTPS URLs and are accepted only when
their byte size and SHA-256 match `skills/baimiao-local-media/scripts/runtime-assets.mjs`.

Cached runtime files live in the platform cache directory. Set `BAIMIAO_PDF_RUNTIME_CACHE` to an
absolute path to use an isolated cache in CI. The default `auto` mode uses the Baimiao web region
endpoint to prefer domestic mirrors in China and international origins elsewhere, then falls back
to the other group while preserving the same size and SHA-256 checks. Set
`BAIMIAO_PDF_RUNTIME_SOURCE=china` or `international` to force one group and skip region detection.
