# Baimiao Codex Plugins

[中文说明](README.zh-CN.md)

This repository is the Baimiao Codex plugin marketplace and contains the plugins it distributes.
The `baimiao` plugin provides local PDF and media workflows plus OAuth-authorized Baimiao OCR,
document conversion, and translation.

## Install

In the Codex desktop app, add this plugin marketplace:

```text
https://github.com/baimiaoapp/plugins.git
```

Then install `Baimiao` from the `Baimiao Plugins` marketplace and start a new Codex task.

Command-line installation is also available:

```bash
codex plugin marketplace add https://github.com/baimiaoapp/plugins.git
codex plugin add baimiao@baimiao-plugins
```

## Repository layout

```text
.agents/plugins/marketplace.json  Marketplace catalog
plugins/baimiao/                  Baimiao plugin source
```

The marketplace references the plugin through its local repository path, so plugin metadata and
assets are maintained only in `plugins/baimiao` and require no synchronization workflow.

## Development

```bash
cd plugins/baimiao
corepack enable
yarn install --immutable
yarn verify
```
