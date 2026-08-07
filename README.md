# 白描插件市场

[English](README.en.md)

面向 AI 助手的白描官方插件市场。

## 可用插件

### 白描工具箱

让 AI 助手可以处理 PDF、图片和其他媒体文件，并尽可能在你的设备本地完成操作。

- 整理、拆分、合并、压缩和转换 PDF。
- 转换、缩放、裁剪图片，添加水印或移除背景。
- 处理 HEIC、GIF 和视频格式。
- 使用白描 OCR、文档转换和文档翻译服务。

本地操作会保留原文件，也不会覆盖已有输出。只有在你选择 OCR、文档转换或翻译时，
对应文件才会上传；这些服务需要通过白描 OAuth 授权，并可能消耗账户积分。

## 在 Codex 中安装

1. 在 Codex 桌面应用中打开“插件”。
2. 选择“添加插件市场”，输入：

```text
https://gitee.com/baimiaoapp/plugins
```

3. 从“白描插件市场”选择需要的插件。
4. 新建一个 Codex 任务。

也可以通过命令行安装：

```bash
codex plugin marketplace add https://gitee.com/baimiaoapp/plugins
codex plugin add baimiao-toolbox@baimiao-plugins
```
