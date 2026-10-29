# 白描插件市场

[English](README.en.md)

面向 AI 助手的白描官方插件市场。

## 可用插件

### 白描工具箱

让 AI 助手可以处理 PDF、图片和其他媒体文件，并尽可能在你的设备本地完成操作。

- 整理、拆分、合并 PDF，按目标大小压缩，生成扫描版或移除可识别的水印。
- 本地将 DOCX、PPTX 转为 PDF；扫描照片、校正透视、增强文档并批量导出 PDF。
- 转换、缩放、裁剪和压缩图片，添加水印、AI 放大、去背景或智能抠图。
- 处理 HEIC、GIF 和视频，为抠图对象添加描边、光效并导出 GIF/MP4。
- 使用白描云端 OCR、PDF 转 Office/Markdown，以及输出 Word 或 PDF 的文档翻译。

本地操作会保留原文件，也不会覆盖已有输出；模型和运行时按需下载，本地 OCR 暂不提供。
只有选择云端 OCR、PDF 转 Office/Markdown 或文档翻译时，对应文件才会上传；
这些服务需要通过白描 OAuth 授权，并可能消耗账户积分。目标大小压缩可能无法达到指定大小，
Office 转换效果请以输出预览为准。

## 在 WorkBuddy 中安装

把下面这段话发送给 WorkBuddy：

```text
请帮我安装这个插件市场中的白描工具箱：https://gitee.com/baimiaoapp/plugins。请读取仓库中的插件市场配置并安装 baimiao-toolbox，不要只克隆仓库。安装完成后，请告诉我安装结果，以及需要如何操作才能让插件生效。
```

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
