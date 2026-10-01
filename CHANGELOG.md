# 更新日志

本文件记录 `dsh-asset-library` 的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 改进

**媒体只加载一次（面板持久化缓存）**

针对「每次切换页面 / 重开应用都重新从宿主拉取图片和视频」的问题，把媒体获取从
「纯内存 LRU（翻页即淘汰、关闭即丢失）」升级为「内存 LRU + 浏览器 Cache Storage 持久化」双层：

- **图片缩略图**：进视口后先查 Cache Storage，命中直接出图；未命中才向宿主取原图，
  小图直接缓存原图 blob，大图在浏览器端降采样到 480px 后缓存缩略图。
- **视频封面**：首次进视口用隐藏 `<video>` 取元数据 → seek 到 10% → 画到 canvas →
  生成 jpeg 封面并持久化；时长同时写入 localStorage，翻页 / 重开不再重新解码。
- **放大原图**：详情视图同样先查 Cache Storage，未命中才 fetch + blob（≤8MB 持久化），
  用 objectURL 渲染，卸载时 revoke 避免泄漏。
- **键策略**：缓存键 = `media-v1://{mtimeMs-size}/{relPath}`，文件改动（mtime/size 变化）
  签名自动失效，避免吃到旧文件——与宿主 `no-store` 不冲突，宿主仍不缓存，
  持久化由客户端自己负责。
- **能力降级**：环境不支持 `caches` / `navigator.storage` 时静默退回实时取，不抛错；
  Cache Storage 写超配额（上限 2000 条，超限删最旧 20%）也静默吞掉。

效果：翻回上一页、切合集、重启 DSH 后，图片和视频封面直接从本地命中，
首屏与回看不再有网络加载等待；视频仍保留悬停静音预览。

**注意**：宿主侧媒体响应仍维持 `cache-control: no-store`（防止工作文件被覆盖后吃到旧
缓存），持久化完全发生在客户端 Cache Storage，不受该头影响。

### 设计取舍（更新）

- 原「一律不缓存」改为「宿主不缓存、客户端按需持久化」：宿主 `no-store` 保留，
  客户端用内容签名键兜底文件变更，二者互不矛盾。

## [0.1.0] - 2026-10-01

首个可用版本。本地资产库插件落地：把项目目录里的图片 / 视频 / 音频变成
一块可浏览、可筛选、可标注的面板，同时开放只读工具给 Agent。

### 新增

**面板（client 半）**

- 网格视图：缩略图墙，图片直显、视频取首帧并标时长（悬停静音预览）、音频显示时长徽标，
  卡片上标注文件大小、探测到的分辨率与彩色标签。
- 放大卡片视图：左媒体右详情，图片支持滚轮缩放、拖拽平移、双击放大，透明素材棋盘格衬底。
- 键盘操作：`/` 搜索、`←`/`→`/`j`/`k` 移动光标、`Enter` 打开、`Esc` 返回、`+`/`-`/`0` 缩放。
- 标签与备注：点击即筛，按名字稳定配色；搜索同时覆盖路径、标签与备注。
- 合集：把「类型 + 目录 + 标签 + 关键词」存成命名组合，一键整套恢复。
- 批量打标：`Ctrl+点击` 多选、`Shift+点击` 范围选择，一次给整批素材加 / 去标签（上限 500）。
- 参照图钉：钉住一张图，浏览其他素材时悬在角落，用于对比 AI 生成的候选版本。
- 目录渐进收窄：顶层只列一级目录，进入后给「上一级」与直接子目录。

**宿主（host 半）**

- HTTP 接口 `/api/asset-library/*`：索引、状态、资产列表、单条详情、目录树、重扫、
  根目录切换、文件管理器 reveal、标注写入、媒体流共 10 个端点。
- 媒体流支持 HTTP Range（`bytes=` 区间、206 / 416、`content-range`、`accept-ranges`）。
- 纯 JS 读文件头探测分辨率（PNG / JPEG / GIF / WEBP / BMP），带 `(mtime, size)` 备忘录。
- 扫描器：递归 walk、可配深度与文件数上限、跳过 `.git` / `node_modules` / 回收站 / 系统目录。
- 索引：`.dsh-assets/index.json` 只存人工输入（标签、备注、用过的根目录），原子写入，
  损坏时降级为空索引而不报错。

**Agent 工具**

- `asset_library_overview`：概览 —— 扫描目录、各类数量、子目录分布。
- `asset_library_list`：检索 —— 按类型 / 关键词 / 标签 / 子目录过滤，排序与分页可控。
- `asset_library_get`：单条元数据（含探测到的分辨率）与**绝对路径**，供模型引用或读取。
- `asset_library_annotate`：**默认不注册**，需显式打开 `allowAgentAnnotate: true`；
  只能改标签 / 备注，仍然不能动文件。

### 安全

- 路径包含检查做两层：词法 `isInside` + `realpath` 真实路径复核，挡 `../` 与指向外部的软链。
- 媒体与 reveal 端点只服务资产扩展名，同目录的 `.env`、私钥读不走。
- SVG 等内联内容附带 `Content-Security-Policy: sandbox` 与 `nosniff`。
- reveal 只 `spawn` 不经 shell，路径字符不会被解释成命令。
- 每个请求都过浏览器信任栅栏（Host / Origin 按请求解析，不快照）。

### 设计取舍

- **磁盘是权威**：资产清单是扫描的派生结果，外部改名 / 删除后下次扫描即同步，不留幽灵条目。
- **一律不缓存**：扫描缓存默认 `cacheMs: 0`，媒体响应 `no-store`，重扫换 URL 强制重取。
- **零外部依赖**：不需要 ffmpeg 或缩略图服务，缩略图在浏览器端 `createImageBitmap` 降采样到 480px。
- **大目录可用**：卡片进视口 ±600px 才挂媒体，缩略图 LRU 上限 240 张，
  `content-visibility: auto` 跳过视口外布局与绘制。

### 已知限制

- 缩略图为浏览器端降采样，超大图首次进视口会有一次原图传输。
- 视频首帧封面取决于浏览器容器支持，mkv / avi 可能显示为空白卡片。
- AVIF / TIFF / SVG 不做头部尺寸探测，详情页由浏览器实测兜底。
- 无转码与代理文件，4K 素材按原码率播放。
- 扫描不进 worker 线程（有意决策，`fs.promises` 已走 libuv 线程池）。
- 宿主半改动需重启进程，面板刷新窗口即可（已做能力协商降级）。

### 测试

三层测试共 **220 项全绿**，全部离线可跑：

| 命令 | 覆盖 | 项数 |
|---|---|---|
| `node tools/client-test.mjs` | 面板契约与交互行为 | 111 |
| `node tools/tool-test.mjs <项目>` | Agent 工具行为 | 38 |
| `tools/asset-library-smoke.ps1` | HTTP 面 + Range + 安全收口 + 不缓存 | 71 |

[Unreleased]: https://github.com/Hnqhj/dsh-asset-library/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Hnqhj/dsh-asset-library/releases/tag/v0.1.0
