# Baimiao PPT preview runtime

Conversion wrapper: contributor-original, MIT OR Apache-2.0.
DeckCraft crates: https://github.com/12kv/deckcraft at fddfdf432aa950e9a2c82d7610674a3ab65a5679 (fork of https://github.com/storytold/deckcraft at aaf6c1c38aa6c59beda8110bd014cc6c96c6ec74), MIT OR Apache-2.0; upstream notices included alongside this file. No editor UI or brand artwork is distributed.

The Baimiao wrapper additionally registers Noto Sans CJK SC Regular for simplified Chinese. This is an application integration font, not a modification of DeckCraft's font bundling policy. Font source: https://github.com/notofonts/noto-cjk/tree/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/OTF/SimplifiedChinese (Adobe/Google), OFL-1.1. SHA-256: 2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b.

The wrapper loads external BIZ UDPGothic Regular from Morisawa: https://github.com/googlefonts/morisawa-biz-ud-gothic/tree/18934af56b9c003ca58c54bffbf226848cb11032, OFL-1.1; Ubuntu Light remains embedded from epaint_default_fonts 0.36.2, Canonical, Ubuntu Font Licence 1.0: https://github.com/emilk/egui/tree/0.36.2/crates/epaint_default_fonts.

Font licence texts are in font-licenses/. Font checkout and file hashes are recorded in manifest.json and verified by the build script.

The wrapper also embeds a contributor-original square-only subset of Baimiao Preview Placeholder (MIT); its notice is in font-licenses/.

Wingdings, Wingdings 2, Wingdings 3 and Webdings are separate, named-only runtime files built from local source fonts. They are not OFL assets. Original name-table copyright/license notices accompany each generated file under fonts/. scripts/ppt-preview/symbol-fonts.json pins original source hashes; each runtime catalog entry records sourceSha256 and normalized SHA-256. A Unicode PUA cmap is added without changing glyph outlines or advances.

The pinned DeckCraft source is built with the reproducible scripts/ppt-preview/patches/symbol-fonts.patch, excluding symbol faces from automatic fallback and preferring original symbol bullet glyphs. The adjacent source checkout is not modified.
