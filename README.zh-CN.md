# 白描 Codex 插件

[English](README.md)

本仓库同时包含白描 Codex 插件市场和其中发布的插件。`baimiao` 插件支持在本地处理
PDF、图片、HEIC、GIF 和视频，并通过 OAuth 授权使用白描 OCR、文档转换和文档翻译。

## 安装

在 Codex 桌面应用的插件页面添加以下插件市场：

```text
https://github.com/baimiaoapp/plugins.git
```

然后从“白描插件”市场安装“白描”，并新建一个 Codex 任务。

也可以使用命令行安装：

```bash
codex plugin marketplace add https://github.com/baimiaoapp/plugins.git
codex plugin add baimiao@baimiao-plugins
```

## 仓库结构

```text
.agents/plugins/marketplace.json  插件市场目录
plugins/baimiao/                  白描插件源码
```

插件市场通过仓库内相对路径引用插件，因此插件元数据和资源只在 `plugins/baimiao` 中维护，
不再需要跨仓库同步 workflow。

## 开发

```bash
cd plugins/baimiao
corepack enable
yarn install --immutable
yarn verify
```
