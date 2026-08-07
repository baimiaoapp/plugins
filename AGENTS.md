# Agent Guide

- This repository contains the Baimiao Codex marketplace and its plugins.
- The Baimiao plugin lives at `plugins/baimiao` and uses Yarn 4.6.0.
- Prefer `yarn <script>` over npm or pnpm inside the plugin directory.
- Keep PDF and image processing local unless a tool explicitly documents a remote API boundary.
- Large media runtimes are downloaded on first use; never commit runtime cache files.
- Every remote runtime must use an exact HTTPS URL, byte size, and SHA-256.
- Preserve inputs, refuse output overwrites, and keep stdout to one JSON result for CLI operations.
- Never put passwords, access tokens, cookies, or verification codes in arguments, plans, logs, or fixtures.
- Keep the Chinese `README.md` and English `README.en.md` concise, customer-facing, and equivalent
  in meaning. Chinese is the default repository README.
- Customer documentation must clearly distinguish local processing from services that upload files
  and may consume account credits. Keep repository maintenance details in this file or plugin docs.

## Repository boundaries

- Treat `plugins/baimiao/.codex-plugin/plugin.json` as the source of truth for plugin metadata.
- Keep the marketplace entry at `.agents/plugins/marketplace.json` pointed at `./plugins/baimiao`.
- Do not duplicate plugin interface metadata or assets at the repository root.
- Keep feature code, skills, MCP servers, resources, and plugin descriptions under `plugins/baimiao`.
- Keep general generated-file rules in the root `.gitignore` and plugin-specific runtime rules in
  `plugins/baimiao/.gitignore`.

## Verification

Run these checks from `plugins/baimiao` before release:

```bash
yarn install --immutable
yarn verify
```

Also validate both skills and the plugin with the current `skill-creator` and `plugin-creator`
validators. Confirm that `package.json`, `.codex-plugin/plugin.json`, and the MCP server version are
identical, that the marketplace source path resolves to the plugin directory, and that both customer
README files still describe the manifest's current capabilities and privacy boundaries.
