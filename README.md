# dsh-asset-library

DeepSeek Harness 的**本地资产库**插件：把一个项目文件夹里的图片、视频、音乐当作资产来
浏览、筛选、预览和标注，同时让 Agent 能检索它们、读到元数据、拿到绝对路径去引用。

为短剧 / AI 视觉这类"一个项目一堆素材"的工作流设计：素材留在你自己的项目目录里，
插件只做索引与展示，不搬文件、不改文件。

## 它长什么样

侧边栏多一个 **资产库** 面板，两种视图：

- **网格**：图片直接显示，视频用 `<video preload="metadata">` 取首帧当封面并标出时长
  （**悬停静音预览**），音频挂不显示的 `<audio preload="metadata">` 拿时长（音符卡片 + 时长徽标）；
- **放大卡片**：点任意资产进入 —— **左边是媒体本体，右边是详细信息**（类型、大小、修改时间、分辨率、
  时长、相对/绝对路径、复制路径、在资源管理器中显示、在新标签页打开、标签与备注编辑）。
  它不是浮层也不是抽屉，所以不会挤压界面；`Esc` 返回，`←`/`→` 在当前结果里前后翻；
  图片支持**滚轮缩放**（以指针为锚）、拖拽平移、双击放大/还原，透明素材有棋盘格衬底；
- **筛选**：类型（图片/视频/音频）、关键词（**同时匹配路径、标签和备注**）、标签（点击即筛）、
  **合集**（命名的筛选组合，一键整套恢复）、子目录（chips **渐进收窄**：顶层只列一级目录，
  进入后给"上一级"和直接子目录，不再平铺出超长路径）；标题在筛选时显示**匹配数**；
- **多选批量**：`Ctrl+点击` 多选、`Shift+点击` 范围选择，底部批量条给选中项**加/去标签**
  （一次读盘一次写盘，被删文件自动跳过并计数）；
- **参照图钉**：详情里把一张图"设为参照"，浏览别的素材时它悬在媒体角落方便对比
  AI 生成的候选版本；
- **键盘**：网格里 `/` 聚焦搜索、`←`/`→`（或 `j`/`k`）移动光标、`Enter` 打开、`Esc` 清除；
  焦点在输入框里时所有快捷键让路；
- **排序与分页**：名称 / 修改时间 / 大小 + **方向切换**（默认名称升序、时间/大小降序，
  方向记进偏好），滚动到底"加载更多"；详情翻页时**预取相邻图片**；
- **项目切换**：顶部输入框粘贴项目文件夹绝对路径，或直接选**最近项目**下拉；
- **界面偏好**（排序/筛选）记在浏览器里，下次打开保持原样。

零外部依赖：不需要 ffmpeg，不装缩略图服务，媒体一律原生播放器 + HTTP Range 流。

大目录也能用，四层配合：

1. 网格卡片**贴近视口才挂媒体**（±600px 的 `IntersectionObserver`），滚出即释放回骨架屏；
2. 缩略图结果进**模块级 LRU**（240 张，淘汰即回收 object URL）—— 滚回来是瞬间重现，
   不重新下载、不重新降采样；
3. 图片用 `createImageBitmap` + canvas 在浏览器里**降采样到 480px 长边**，顺手取 1×1 主色当
   加载占位色；卡片本身还有 `content-visibility: auto`，视口外跳过布局与绘制；
4. 首屏之后 `/status` 只在换项目/重扫/保存标注后刷新，筛选与翻页每步只有一个请求。

几千张 4K 图的目录不会一次性把内存吃光。

## 数据模型

```
<项目根>/
  assets/                      ← 约定目录（可配置 assetsDir）
    images/  video/  audio/    ← 约定分类（按扩展名归类，不强制目录结构）
    ...                        ← 任意深度的子目录都会扫到
  .dsh-assets/
    index.json                 ← 索引：只存标签、备注、用过的根目录
```

三条原则：

1. **磁盘是权威**。资产清单是扫描的派生结果，你在资源管理器里改名/删除，下一次扫描就跟着变，
   不会留下幽灵条目。
2. **索引只存人的输入**。`index.json` 里只有 `annotations`（标签、备注、加入时间）与 `roots`，
   丢了可以重建，但不会被扫描结果覆盖。
3. **一律不缓存**。素材是会被反复覆盖的工作文件，任何一层缓存都会变成"我明明换了图怎么还是旧的"：
   - 扫描缓存默认关闭（`cacheMs: 0`），每次请求都重新遍历目录 —— 所以新增/删除文件**不用**点重扫就能看到；
   - 媒体响应带 `cache-control: no-store`，浏览器不存副本；
   - 项目登记表每次读盘，不留进程内记忆；
   - 已挂载的 `<img>/<video>` 不会因为磁盘变了就自己失效，所以"重新扫描"会同时把媒体 URL 的
     `rev` 计数换掉，强制真的重取一次。
   想用缓存换一次遍历，把 `cacheMs` 显式设成毫秒数即可。

支持的类型（封闭清单，只收录浏览器能原生解码的格式）：

| 类型 | 扩展名 |
|---|---|
| 图片 | jpg jpeg jpe png webp gif avif bmp svg ico tif tiff |
| 视频 | mp4 m4v mov webm mkv avi ogv |
| 音频 | mp3 wav flac m4a aac ogg oga opus aif aiff wma |

图片里 png/jpg/gif/webp/bmp 会在扫描时**读文件头探测分辨率**（零依赖，几十字节），
宽高随清单一起返回：卡片按横竖选裁切策略（竖图 3:4 完整显示，不再被 4:3 裁掉构图）、
卡片元信息直接显示尺寸、`asset_library_get` 直接报尺寸；探测结果按 `(mtime,size)` 记进
备忘录，文件没变就不重读。AVIF/TIFF/SVG 不探测（盒子结构复杂或本身是矢量），
详情页仍由浏览器实测兜底。

默认跳过：点开头的目录（`.git`、`.dsh-assets`）、`node_modules`、回收站与系统目录；
深度上限 8 层、文件数上限 20000（都可配置）。

## Agent 工具

三个**只读**工具，注册进工具注册表后会出现在系统提示里：

| 工具 | 作用 |
|---|---|
| `asset_library_overview` | 概览：扫描目录、各类数量、子目录分布 |
| `asset_library_list` | 检索：按类型/关键词/标签/子目录过滤 + 排序 + 分页 |
| `asset_library_get` | 单条元数据（含探测到的分辨率）+ **绝对路径**（模型据此引用或读取文件） |

作用域解析优先级：工具参数 `root` → 当前会话的工作目录（`exec.agent.session.header.cwd`）
→ 界面选定的项目 → 配置 `root` → harness 进程 cwd。

默认**没有**写工具 —— "模型不能改你的文件，也不能改标注"是默认界线。配置里显式打开
`allowAgentAnnotate: true` 后，会多注册一个 `asset_library_annotate`（只能改标签/备注，
仍然不能动文件），给"让 AI 帮我整理标注"的场景用。

## HTTP 面

前缀 `/api/asset-library`，全部 JSON（媒体流除外），每个请求先过浏览器信任栅栏。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/status` | GET | 根目录、计数、扫描时间、自检信息、`capabilities`（能力协商）、`tagFacets`（标签聚合，驱动面板的标签筛选行） |
| `/assets` | GET | `kind` `q` `tag` `dir` `sort` `order`（asc/desc）`limit` `offset` |
| `/asset` | GET | `?relPath=` 单条详情 |
| `/file` | GET/HEAD | 媒体流，支持 `Range`（206/416）、`Cache-Control: no-store`（不做 ETag —— 与"永不缓存"的取舍一致，304 复验没有意义） |
| `/tree` | GET | 子目录数组 `[{ dir, count, kinds }]` |
| `/annotate` | POST | `{ relPath, tags?, note? }` 单条整替；或 `{ relPaths[], tagsAdd?/tagsRemove? }` 批量增量（上限 500，缺失文件计 skipped） |
| `/root` | POST | `{ root }` 切换项目（空串=回到默认） |
| `/rescan` | POST | 丢弃缓存重扫 |
| `/reveal` | POST | `{ relPath }` 在系统文件管理器里定位该文件 |

`/status` 返回 `capabilities: ['assets','file','tree','annotate','root','reveal']`。面板据此决定
是否渲染"在资源管理器中显示"这类依赖较新宿主的按钮 —— **改了宿主半的代码不一定立刻生效**
（HMR 只保证新 bundle 挂载，替换模块要重启进程），所以面板在旧宿主上会自动降级，而不是给用户
一个点了就报错的按钮。

安全上做了五件事：路径包含检查（词法 + `realpath`，挡 `../` 与指向外部的软链）、
媒体与 `reveal` 端点只服务资产扩展名（挡 `.env`、私钥这类同目录文件）、SVG 等内联内容带
`Content-Security-Policy: sandbox` 与 `nosniff`、`reveal` 只 spawn 不经 shell（参数数组传递，
路径里的字符不会被解释成命令）、以及每个请求都查一次 Connection 栅栏。

## 配置

`cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: asset-library
  name: dsh-asset-library
  config:
    root: 'G:\项目\短剧A'      # 空串=跟随会话工作目录
    assetsDir: assets          # 约定子目录；不存在时直接扫项目根
    indexDir: .dsh-assets      # 索引目录
    includeHidden: false
    maxDepth: 8
    maxFiles: 20000
    cacheMs: 0                 # 扫描缓存毫秒数；默认 0 = 每次都重新扫描（不缓存）
    pageSize: 60
    allowAgentAnnotate: false  # true 时额外注册 asset_library_annotate（只改标注，不动文件）
```

## 安装

```powershell
# 1) 装进 profile（官方 CLI 负责 bundle 层）
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'G:\工作\dsh\dsh-asset-library'
```

然后把 `profiles\<profile>\package.json` 里这条依赖的规格从 `link:` 改成 `file:`：

```json
"dsh-asset-library": "file:G:/工作/dsh/dsh-asset-library"
```

再同步一次（`file:` 会装成**实体目录**，解析链才完整）：

```powershell
& 'D:\deepseek\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop install
```

桌面端 profile 带 HMR，装完会被热挂载：`/status` 的 `diagnostics` 立刻变成
`{web:true, tools:{registered:true}}`，Agent 工具当场可用（无需重启进程）。**客户端面板**
可能需要刷新一次窗口（Ctrl+R）才会出现在侧边栏。

### 为什么 `link:` 不行，`file:` 行

Node 解析裸模块名时会先 `realpath`。插件若是指向工作区的 junction，realpath 落在 profile
之外，`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 这类**由 dsh 安装本体提供**的包
就解析不到，插件会以 `failed to import` 静默退出。DSH 的解析链是：

```
<profile>/node_modules  →  <DSH_HOME>/profiles/node_modules（安装范围投影）
```

`file:` 规格让 pnpm 把包**复制**进 `<profile>/node_modules`（实测是实体目录，不是链接），
解析链因此完整；`link:` / 直接 `pnpm add <目录>` 都会建 junction，必须再用
`tools/dev-install.ps1` 手工替换成实体目录。

> Windows 上有个**读**文件的坑，值得单独记一笔：`profiles\<profile>\package.json` 是 UTF-8，
> 而 Windows PowerShell 5.1 的 `Get-Content` 在没有 BOM 时按 ANSI 解码，于是含中文的路径
> 会显示成乱码（`工作` → `宸ヤ綔`）。这纯属显示假象，文件本身没问题 —— 要确认就显式解码：
> `[System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)`。

## 开发

```powershell
# 一次性：建一个开发 profile（独立 DSH_HOME，绝不动桌面应用的 profile）
$env:DSH_HOME="$env:USERPROFILE\.dsh-dev"
& $dsh assetdev --from-default-profile web --help

# 迭代循环：改代码 → 一键同步所有 profile → 重启对应实例
powershell -File tools\sync-all.ps1                              # dev(assetdev) + desktop 一次同步
& $dsh --profile assetdev --port 3084 --no-open                # 记下打印的 token URL

# 验证（三层，全部离线可跑）
node tools\client-test.mjs                                     # 客户端契约 + 交互行为（111 项）
node tools\tool-test.mjs <测试项目>                             # Agent 工具行为（38 项，须从 profile 内副本运行）
powershell -File tools\asset-library-smoke.ps1 -Base http://127.0.0.1:3084 -Token <token> `
    -Root <测试项目> -TagZh <中文标签> -NonAsciiFolder <中文目录>   # HTTP 面 + Range + 不缓存（71 项）
powershell -File tools\make-asset-fixture.ps1 -Root <测试项目> -NonAsciiFolder <中文目录>
```

测试脚本必须用 **ASCII 编写**（中文从参数传入）：Windows PowerShell 5.1 会把无 BOM 的
UTF-8 脚本按 ANSI 读，脚本里的中文会变成乱码路径。同理，`Invoke-WebRequest` 不允许设置
`Range` 受限头、且非 UTF-8 编码请求体 —— 所以冒烟测试用 `curl.exe`。

`tools/client-test.mjs` 自带一个**迷你 React 渲染器**：`createElement` 产出普通对象树，hooks
状态**按组件实例隔离**，`useEffect` 比较依赖数组并由测试显式 flush，`useCallback` 按 React
语义缓存函数身份（否则"稳定回调只跑一次"的写法会每帧重跑，测出假象）。因此它不止检查
静态标记，而是真的走一遍交互：挂载 → 网格 → 标签/合集筛选 → 多选批量打标 → 键盘导航
（光标、Enter、Esc）→ 点卡片 → 放大卡片（含竖屏标注与探得尺寸）→ 翻页 → 返回 → 复制路径
→ 显示在资源管理器 → 保存标注 → 能力协商降级（capabilities 与 tagFacets 双向）→ 缩略图
LRU 重挂载零请求。

之所以不用真 `react-dom/server`：这份安装里 `react` 是 18.3.1 而 `react-dom` 是 19.2.8，
大版本不匹配，真 SSR 认不出对方创建的元素。

`tools/asset-library-smoke.ps1` 里的 `/reveal` 只测**校验路径**（越权 / 缺失 / 非资产 / 方法）；
成功路径会真的弹出资源管理器窗口，所以不放进可重复运行的套件里，需要时手工 curl 一次。

## 已知限制与后续

- **缩略图是浏览器端降采样**（480px 长边，JPEG）。首次进视口要下载原图再压缩，所以超大图会有
  一次"原图传输"；要更省带宽就得在宿主侧生成并缓存缩略图（那是引入 ffmpeg/sharp 的取舍）。
- **视频首帧封面**取决于浏览器能否解析该容器的元数据；mkv/avi 这类可能显示为空白卡片，
  点开仍可尝试播放。
- **没有转码/代理文件**：4K 素材直接原码率播放。
- **没有分镜/角色维度**：当前只按目录结构 + 标签组织；短剧专属的"剧集→镜头→资产"分层
  留给后续版本（标签字段已经能承载，不必改数据结构）。
- ~~**面板像素未由人眼确认**~~ **已两轮目视验收**（2026-10-01，dev 实例 + 真实浏览器，深色主题）：
  网格（缩略图、类型/时长徽标、卡片标签与配色、尺寸标注、竖版 3:4 卡片、最近项目下拉、
  多选批量条）、放大卡片（左媒体右详情、分辨率与横竖屏、标注编辑、滚轮缩放 + 棋盘格）、
  标签/合集筛选（高亮、过滤结果、批量打标回执"更新 2 项，跳过 0 项"）均确认正常。
  唯一的时序现象是首屏缩略图要等浏览器端降采样完成才浮现（渐进加载，符合设计）。
- **扫描不进 worker 线程**（有意决策）：`fs.promises` 本就走 libuv 线程池，2 万文件的
  stat 风暴不会阻塞事件循环；扫描的真正大头是"每次请求都全量走树"（`cacheMs: 0` 的代价），
  尺寸探测已用 `(mtime,size)` 备忘录做了增量，收益比搬线程大。真到十万文件量级再考虑。
- **宿主半改动需要重启进程**才会加载新模块（HMR 只保证新 bundle 挂载）。面板已用
  `capabilities` / `tagFacets` 协商做了降级，但新端点要等重启才可用。
