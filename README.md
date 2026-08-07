# 白描 Codex 插件

[English](README.en.md)

白描让 Codex 可以处理 PDF、图片和其他媒体文件，并尽可能在你的设备本地完成操作。

## 主要功能

- 整理、拆分、合并、压缩和转换 PDF。
- 转换、缩放、裁剪图片，添加水印或移除背景。
- 处理 HEIC、GIF 和视频格式。
- 使用白描 OCR、文档转换和文档翻译服务。

本地操作会保留原文件，也不会覆盖已有输出。只有在你选择 OCR、文档转换或翻译时，
对应文件才会上传；这些服务需要通过白描 OAuth 授权，并可能消耗账户积分。

## 安装

1. 在 Codex 桌面应用中打开“插件”。
2. 选择“添加插件市场”，输入：

```text
https://github.com/baimiaoapp/plugins.git
```

3. 从“白描插件”市场安装“白描”。
4. 新建一个 Codex 任务。

也可以通过命令行安装：

```bash
codex plugin marketplace add https://github.com/baimiaoapp/plugins.git
codex plugin add baimiao@baimiao-plugins
```
