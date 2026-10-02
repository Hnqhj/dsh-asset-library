/**
 * 资产库浏览器半（Client plugin）。
 *
 * 纯 JS、无构建：DSH 的模块加载器要的就是
 * `window.__ModuleLoader__.load({ id, factory })`，`require('react')` 由页面自己的
 * 模块表提供（不会装第二份 React）。
 *
 * 两个注册（形状照抄官方 Plugin Manager 面板）：
 *
 *   slots.inject('main',             → register({ name:'main', key: PANEL_ID, … }, Panel))
 *   slots.inject('sidebar.panellist',→ register({ name:'sidebar.panellist', id: PANEL_ID, … }, Icon))
 *
 * 侧边栏条目的 `id` 与 `main` 槽的 `key` 相同 —— 这是"点侧边栏打开这个面板"的
 * 连接点，不要自己再加按钮或第二次 selectPanel。
 *
 * 视图与交互：
 *  - **网格**：筛选栏（类型 / 关键词 / 标签 / 合集 / 子目录）+ 缩略图墙；
 *  - **放大卡片**：点任意资产进入，左边媒体本体（图片支持滚轮缩放、拖拽平移、
 *    双击放大、透明棋盘格），右边详细信息与标注，Esc 返回，←/→ 在当前结果里翻；
 *  - **多选批量**：Ctrl+点击 多选、Shift+点击 范围选择，底部批量条给选中项
 *    加/去标签；
 *  - **键盘**：网格里 `/` 聚焦搜索，←/→/j/k 移动光标，Enter 打开，Esc 清除；
 *    输入框打字时所有快捷键让路。
 *
 * 性能取向：
 *  - 卡片进入视口附近（±600px）才挂媒体，滚出即释放；缩略图结果进模块级 LRU
 *    （object URL 复用），滚回来瞬间重现，不重新下载降采样；
 *  - 图片在浏览器里降采样到 480px 长边，顺手取主色做加载占位；视频封面同样降采样，
 *    并且**限并发**取帧（视频 2、缩略图 4）—— 首屏几十张卡片一起解码会冻住主线程；
 *  - 卡片 `content-visibility: auto`，视口外跳过布局与绘制；
 *  - 媒体结果持久化在 Cache Storage，键带 `(mtimeMs-size)` 签名，翻页 / 重开后直接命中；
 *    时长（视频与音频）另存一份，已知时长就不再为卡片挂媒体元素；
 *  - 首次加载后 `/status` 只在换项目/重扫/保存标注后刷新，筛选与翻页只发一个请求。
 */
window.__ModuleLoader__.load({
    id: 'dsh-asset-library',
    factory(require) {
        const React = require('react');
        const h = React.createElement;
        const { useCallback, useEffect, useMemo, useRef, useState } = React;

        /** 词典命名空间。 */
        const NS = 'asset-library';
        /** 侧边栏条目 id，同时也是 `main` 槽的 key。 */
        const PANEL_ID = 'asset-library';
        /** host 半的路由前缀。 */
        const API = '/api/asset-library';
        /** 每页条数。 */
        const PAGE_SIZE = 60;
        /** 缩略图长边上限（像素）。 */
        const THUMB_MAX = 480;
        /** 界面偏好（排序/筛选）在浏览器里的键。 */
        const PREFS_KEY = 'dsh-asset-library.prefs.v1';
        /** 合集（命名的筛选组合）在浏览器里的键；跟着浏览器走，不进项目索引。 */
        const COLLECTIONS_KEY = 'dsh-asset-library.collections.v1';
        /** 卡片媒体与视口的贴近距离（像素）：进入即加载，滚出即释放。 */
        const PROXIMITY_PX = 600;
        /** 缩略图 LRU 上限；超出后最旧的 object URL 被回收。 */
        const THUMB_CACHE_MAX = 240;
        /**
         * 同时进行的缩略图作业上限。
         *
         * 首屏可能有几十张卡片一起进视口：一口气解码几十张大图（`createImageBitmap`
         * + canvas 降采样）会把主线程和内存打满，表现就是"切个类型要卡好几秒"。
         * 排队之后，用户在滚动时看到的是逐步浮现，而不是整块界面冻住。
         */
        const THUMB_CONCURRENCY = 4;
        /**
         * 同时进行的视频取帧作业上限。
         *
         * 每个作业要建一个 `<video>`、等元数据、再 seek 一帧画到 canvas —— 比缩略图
         * 重得多。上限放到 2，既不空转也不让硬盘/解码器排队爆掉。
         */
        const POSTER_CONCURRENCY = 2;
        /** 等媒体元数据的上限（毫秒）：mkv/avi 这类容器可能永远不给 metadata。 */
        const METADATA_TIMEOUT_MS = 8000;
        /** 一次批量标注允许的资产数（与 host 端上限一致）。 */
        const BATCH_MAX = 500;
        /** 缩放上限。 */
        const ZOOM_MAX = 12;

        const zh = {
            panel: '资产库',
            title: '资产库',
            project: '项目根目录',
            inputPath: '输入路径…',
            assetsRoot: '扫描目录',
            conventional: '（自动使用 assets 子目录）',
            recent: '最近项目',
            apply: '切换',
            useSession: '用默认目录',
            rescan: '重新扫描',
            rescanning: '扫描中…',
            search: '搜索文件名或路径',
            sortName: '按名称',
            sortMtime: '按修改时间',
            sortSize: '按大小',
            all: '全部',
            image: '图片',
            video: '视频',
            audio: '音频',
            empty: '这个目录里没有找到图片、视频或音频。',
            emptyHint: '把素材放进 assets/ 下（例如 assets/images、assets/video、assets/audio），或在上方切换项目目录。',
            loading: '读取中…',
            loadMore: '加载更多',
            truncated: '文件过多，只显示了前一部分。',
            allFolders: '全部目录',
            collections: '合集',
            saveFilter: '存为合集',
            filterNamePlaceholder: '合集名称，回车保存',
            deleteFilter: '删除合集',
            back: '返回',
            prev: '上一个',
            next: '下一个',
            position: '{i} / {n}',
            size: '大小',
            modified: '修改时间',
            dimensions: '分辨率',
            duration: '时长',
            type: '类型',
            relPath: '相对路径',
            absPath: '绝对路径',
            // 路径行本身就是"点击即复制"，所以复制对象写在 title 上，而不是再摆一个复制按钮。
            copyRelPath: '复制相对路径',
            copyAbsPath: '复制绝对路径',
            copied: '已复制',
            unsaved: '未保存的改动',
            selectOne: '选中',
            deselectOne: '取消选中',
            reveal: '在资源管理器中显示',
            revealing: '正在打开…',
            revealFailed: '打不开资源管理器',
            openTab: '在新标签页打开',
            resetZoom: '重置缩放',
            orientationPortrait: '竖屏',
            orientationLandscape: '横屏',
            tags: '标签',
            tagPlaceholder: '回车添加标签',
            note: '备注',
            notePlaceholder: '这个素材是干什么用的…',
            save: '保存',
            saving: '保存中…',
            saved: '已保存',
            removeTag: '移除标签',
            filterByTag: '按标签筛选',
            selectedN: '已选 {n} 项',
            selectAll: '全选',
            clearSel: '清除选择',
            copyPaths: '复制 {n} 条路径',
            copiedPaths: '已复制 {n} 条路径',
            clearFilters: '清除筛选',
            noMatch: '没有符合筛选条件的素材。',
            noMatchHint: '换个关键词，或直接清掉筛选看全部。',
            fitContain: '完整构图',
            fitCover: '填满裁切',
            play: '播放',
            pause: '暂停',
            seek: '点这条进度可以跳',
            batchTagPlaceholder: '输入标签',
            batchAdd: '加标签',
            batchRemove: '去标签',
            batchResult: '更新 {u} 项，跳过 {s} 项',
            batchHint: 'Ctrl+点击 多选，Shift+点击 范围选择，X 选中光标项',
            matched: '匹配 {m} / 共 {n} 项',
            sortAsc: '升序',
            sortDesc: '降序',
            parentDir: '上一级',
            pin: '设为参照',
            unpin: '取消参照',
            pinnedRef: '参照',
            error: '出错了',
            total: '共 {n} 项',
            hint: '点击任意资产放大查看',
        };

        const en = {
            panel: 'Asset Library',
            title: 'Asset Library',
            project: 'Project root',
            inputPath: 'Enter a path…',
            assetsRoot: 'Scanned folder',
            conventional: '(using its assets subfolder)',
            recent: 'Recent projects',
            apply: 'Switch',
            useSession: 'Use default',
            rescan: 'Rescan',
            rescanning: 'Scanning…',
            search: 'Search name or path',
            sortName: 'By name',
            sortMtime: 'By modified',
            sortSize: 'By size',
            all: 'All',
            image: 'Images',
            video: 'Video',
            audio: 'Audio',
            empty: 'No images, video or audio found in this folder.',
            emptyHint: 'Drop media under assets/ (for example assets/images, assets/video, assets/audio), or switch the project folder above.',
            loading: 'Loading…',
            loadMore: 'Load more',
            truncated: 'Too many files; only the first part is shown.',
            allFolders: 'All folders',
            collections: 'Collections',
            saveFilter: 'Save as collection',
            filterNamePlaceholder: 'Collection name, Enter to save',
            deleteFilter: 'Delete collection',
            back: 'Back',
            prev: 'Previous',
            next: 'Next',
            position: '{i} / {n}',
            size: 'Size',
            modified: 'Modified',
            dimensions: 'Resolution',
            duration: 'Duration',
            type: 'Type',
            relPath: 'Relative path',
            absPath: 'Absolute path',
            copyRelPath: 'Copy relative path',
            copyAbsPath: 'Copy absolute path',
            copied: 'Copied',
            unsaved: 'Unsaved changes',
            selectOne: 'Select',
            deselectOne: 'Deselect',
            reveal: 'Show in file manager',
            revealing: 'Opening…',
            revealFailed: 'Could not open the file manager',
            openTab: 'Open in a new tab',
            resetZoom: 'Reset zoom',
            orientationPortrait: 'Portrait',
            orientationLandscape: 'Landscape',
            tags: 'Tags',
            tagPlaceholder: 'Enter to add a tag',
            note: 'Note',
            notePlaceholder: 'What is this asset for…',
            save: 'Save',
            saving: 'Saving…',
            saved: 'Saved',
            removeTag: 'Remove tag',
            filterByTag: 'Filter by tag',
            selectedN: '{n} selected',
            selectAll: 'Select all',
            clearSel: 'Clear selection',
            copyPaths: 'Copy {n} paths',
            copiedPaths: 'Copied {n} paths',
            clearFilters: 'Clear filters',
            noMatch: 'Nothing matches these filters.',
            noMatchHint: 'Try another keyword, or clear the filters to see everything.',
            fitContain: 'Fit whole frame',
            fitCover: 'Fill and crop',
            play: 'Play',
            pause: 'Pause',
            seek: 'Click the bar to seek',
            batchTagPlaceholder: 'Tag name',
            batchAdd: 'Add tag',
            batchRemove: 'Remove tag',
            batchResult: 'Updated {u}, skipped {s}',
            batchHint: 'Ctrl+click to multi-select, Shift+click for a range, X toggles the cursor card',
            matched: 'Matching {m} of {n}',
            sortAsc: 'Ascending',
            sortDesc: 'Descending',
            parentDir: 'Parent folder',
            pin: 'Pin as reference',
            unpin: 'Unpin reference',
            pinnedRef: 'Reference',
            error: 'Something went wrong',
            total: '{n} items',
            hint: 'Click any asset to enlarge it',
        };

        /** 一次 API 调用；非 2xx 时抛出带信封 message 的错误。 */
        async function api(path, init) {
            const response = await fetch(`${API}${path}`, {
                credentials: 'same-origin',
                headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
                ...init,
            });
            let payload;
            try {
                payload = await response.json();
            } catch {
                throw new Error(`${path}: response is not JSON (HTTP ${response.status})`);
            }
            if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
            return payload;
        }

        /**
         * 媒体取源地址；`<img>/<video>/<audio>` 直接用它。
         *
         * `revision` 是"重新扫描"计数：宿主侧已经 `no-store`（不缓存），但**已经挂载**
         * 的 `<img>/<video>` 不会因为文件变了就自己重新请求，所以重扫后把 rev 拼进
         * URL，强制换一个地址、真的重新取一次。
         */
        function fileUrl(relPath, revision) {
            const base = `${API}/file?relPath=${encodeURIComponent(relPath)}`;
            return revision ? `${base}&rev=${revision}` : base;
        }

        /** 人类可读的字节数。 */
        function humanSize(bytes) {
            if (!Number.isFinite(bytes)) return '—';
            if (bytes < 1024) return `${bytes} B`;
            const units = ['KB', 'MB', 'GB', 'TB'];
            let value = bytes / 1024;
            let index = 0;
            while (value >= 1024 && index < units.length - 1) {
                value /= 1024;
                index += 1;
            }
            return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
        }

        /** 本地时间的简短表示。 */
        function humanTime(ms) {
            if (!Number.isFinite(ms)) return '—';
            const date = new Date(ms);
            const pad = (value) => String(value).padStart(2, '0');
            return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
        }

        /** 秒数 → `m:ss` / `h:mm:ss`。 */
        function humanDuration(seconds) {
            if (!Number.isFinite(seconds) || seconds <= 0) return null;
            const total = Math.round(seconds);
            const s = total % 60;
            const m = Math.floor(total / 60) % 60;
            const hours = Math.floor(total / 3600);
            const pad = (value) => String(value).padStart(2, '0');
            return hours > 0 ? `${hours}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
        }

        /** 读界面偏好；隐私模式或沙箱里没有 localStorage 时静默返回空对象。 */
        function readPrefs() {
            try {
                const raw = localStorage.getItem(PREFS_KEY);
                const parsed = raw === null ? null : JSON.parse(raw);
                return parsed !== null && typeof parsed === 'object' ? parsed : {};
            } catch {
                return {};
            }
        }

        /** 合并写入界面偏好。 */
        function writePrefs(patch) {
            try {
                localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
            } catch {
                /* 存不下就算了，纯偏好 */
            }
        }

        /** 读合集列表；损坏的存储只当空列表，不让面板打不开。 */
        function readCollections() {
            try {
                const raw = localStorage.getItem(COLLECTIONS_KEY);
                const parsed = raw === null ? null : JSON.parse(raw);
                if (!Array.isArray(parsed)) return [];
                return parsed.filter((value) => value !== null && typeof value === 'object' && typeof value.name === 'string');
            } catch {
                return [];
            }
        }

        /** 写合集列表。 */
        function writeCollections(value) {
            try {
                localStorage.setItem(COLLECTIONS_KEY, JSON.stringify(value));
            } catch {
                /* 纯便利数据，存不下就算了 */
            }
        }

        /**
         * 缩略图 LRU：`rev|relPath` → `{ url, color }`。
         *
         * 滚动/翻页/进出详情会让卡片卸载再挂载，没有这层缓存每次都要重新下载
         * 原图再降采样。容量上限让 object URL 的回收保持确定：淘汰即 revoke。
         * 搭配"滚出视口即释放"的邻近加载，同一时刻真正挂着的 object URL 远小于上限。
         */
        const thumbCache = new Map();

        function cacheGetThumb(key) {
            const hit = thumbCache.get(key);
            if (hit === undefined) return undefined;
            thumbCache.delete(key);
            thumbCache.set(key, hit);
            return hit;
        }

        function cacheSetThumb(key, value) {
            thumbCache.set(key, value);
            if (thumbCache.size <= THUMB_CACHE_MAX) return;
            const oldestKey = thumbCache.keys().next().value;
            const evicted = thumbCache.get(oldestKey);
            thumbCache.delete(oldestKey);
            if (evicted !== undefined && typeof evicted.url === 'string') {
                try {
                    URL.revokeObjectURL(evicted.url);
                } catch {
                    /* 已经释放过就算了 */
                }
            }
        }

        /**
         * 一个极简的并发闸门（没有槽位就排队）。
         *
         * 两个刻意的选择：
         *  - **有槽位就直接跑**，不进微任务队列 —— 单张卡片、单次打开详情的路径
         *    与加闸门之前完全同序，不会因为"排队"平白多等一轮；
         *  - 作业内部的异常由调用方自己 `.catch` 处理完，闸门只负责放行与计数，
         *    绝不把一个异步拒绝漏成 unhandledrejection。
         *
         * @param max - 同时进行的作业上限。
         * @returns 提交一次作业的函数，返回的 Promise 在作业结束后 resolve。
         */
        function createLimiter(max) {
            let running = 0;
            const queue = [];
            const pump = () => {
                while (running < max && queue.length > 0) {
                    const job = queue.shift();
                    running += 1;
                    Promise.resolve()
                        .then(job.task)
                        .catch(() => undefined)
                        .then(() => { running -= 1; pump(); });
                }
            };
            return (task) => new Promise((resolve) => {
                queue.push({ task, resolve });
                pump();
            });
        }

        /** 缩略图 / 视频取帧各自的闸门；模块级，跨卡片共享。 */
        const imageSlots = createLimiter(THUMB_CONCURRENCY);
        const posterSlots = createLimiter(POSTER_CONCURRENCY);

        /**
         * 持久化媒体缓存（缩略图 / 视频封面 / 放大原图）。
         *
         * 为什么不直接依赖浏览器 HTTP 缓存：host 侧对媒体强制 `no-store`（怕工作文件
         * 被覆盖后吃到旧缓存）。我们用 `relPath|mtimeMs-size` 当内容签名做键 —— 文件被
         * 改写或改名后签名变化、旧条目自然失效，于是既拿到"只加载一次"的体验，又不背
         * `no-store` 想防的那类 bug。缓存落在 Cache Storage，翻页与重开应用都直接命中。
         */
        const MEDIA_CACHE_NAME = 'dsh-asset-library-media-v1';
        /** 持久化条目上限；超出后删最旧的一部分，避免无限膨胀。 */
        const MEDIA_CACHE_MAX = 2000;
        /** 已写入的条目数（惰性初始化）。有它就够了，不必每次写入都枚举整个缓存。 */
        let mediaCacheCount;
        /** `caches.open()` 的复用句柄；环境不支持时是"已解析为 null"的 Promise。 */
        let mediaCachePromise;
        /** 持久化配额只申请一次；每张缩略图都调一次 `persist()` 纯属浪费。 */
        let persistRequested = false;

        function mediaSignature(item) {
            return `${item?.mtimeMs ?? 0}-${item?.size ?? 0}`;
        }

        function mediaCacheKey(relPath, signature) {
            return `media-v1://${signature}/${encodeURIComponent(relPath)}`;
        }

        /**
         * 打开（并复用）持久化缓存；环境不支持时返回 `null`。
         *
         * 句柄本身在一个面板生命周期里是稳定的，反复 `caches.open()` 只是多几层
         * Promise；真正贵的是 `cache.keys()`，见 `cachePutMedia`。
         */
        function openMediaCache() {
            if (mediaCachePromise === undefined) {
                mediaCachePromise = (async () => {
                    if (typeof caches === 'undefined') return null;
                    try {
                        if (!persistRequested && typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
                            persistRequested = true;
                            navigator.storage.persist().catch(() => undefined);
                        }
                        return await caches.open(MEDIA_CACHE_NAME);
                    } catch {
                        return null;
                    }
                })();
            }
            return mediaCachePromise;
        }

        /** 命中返回 blob，未命中（或环境不支持）返回 null。 */
        async function cacheGetMedia(relPath, signature) {
            const cache = await openMediaCache();
            if (cache === null) return null;
            try {
                const response = await cache.match(mediaCacheKey(relPath, signature));
                if (response === undefined || response === null) return null;
                return await response.blob();
            } catch {
                return null;
            }
        }

        /** 写入持久化缓存；配额超限等异常静默放弃，退回实时取。 */
        async function cachePutMedia(relPath, signature, blob) {
            const cache = await openMediaCache();
            if (cache === null || blob === null || blob.size === 0) return;
            try {
                // 条目数靠计数器维护：`cache.keys()` 会把整个缓存物化成 Request 列表，
                // 首屏几十张缩略图连续写入时，每次都枚举一遍是纯浪费。只有真的超限
                // 才枚举一次，删掉最旧 20%（`keys()` 按插入顺序返回）。
                if (mediaCacheCount === undefined) mediaCacheCount = (await cache.keys()).length;
                if (mediaCacheCount >= MEDIA_CACHE_MAX) {
                    const keys = await cache.keys();
                    const drop = Math.ceil(MEDIA_CACHE_MAX * 0.2);
                    for (const stale of keys.slice(0, drop)) {
                        await cache.delete(stale).catch(() => undefined);
                    }
                    mediaCacheCount = Math.max(0, keys.length - drop);
                }
                await cache.put(
                    mediaCacheKey(relPath, signature),
                    new Response(blob, { headers: { 'content-type': blob.type || 'application/octet-stream' } }),
                );
                mediaCacheCount += 1;
            } catch {
                /* 配额超限：静默放弃持久化 */
            }
        }

        /**
         * 视频 / 音频时长的浏览器侧缓存：与封面用同一套签名，避免重开还要重新探测。
         *
         * 解析后的表在模块级留一份镜像：几十张卡片同时渲染时，不该对同一份 JSON 做
         * 几十次 `JSON.parse`（表本身可能已经几百条）。
         */
        const DURATION_KEY = 'dsh-asset-library.durations.v1';

        let durationMap;

        function loadDurations() {
            if (durationMap !== undefined) return durationMap;
            durationMap = {};
            try {
                const parsed = JSON.parse(localStorage.getItem(DURATION_KEY) || '{}');
                if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) durationMap = parsed;
            } catch {
                /* 损坏就当作空表 */
            }
            return durationMap;
        }

        function readDuration(item) {
            return loadDurations()[`${mediaSignature(item)}|${item.relPath}`] ?? null;
        }

        function writeDuration(item, dur) {
            const map = loadDurations();
            map[`${mediaSignature(item)}|${item.relPath}`] = dur;
            try {
                localStorage.setItem(DURATION_KEY, JSON.stringify(map));
            } catch {
                /* 纯便利数据，存不下就算了 */
            }
        }

        /**
         * 元素是否贴近视口（±`PROXIMITY_PX`）。
         *
         * 与"只翻转一次"的旧策略不同，这里是**双向**的：滚出邻近区就把媒体卸回
         * 骨架屏，几百张卡的列表里同时挂载的 `<img>/<video>` 才有界。没有
         * IntersectionObserver 时直接当作可见，功能不受影响，只是不再省内存。
         */
        function useInView() {
            const ref = useRef(null);
            const [inView, setInView] = useState(false);
            useEffect(() => {
                const node = ref.current;
                if (node === null || typeof IntersectionObserver === 'undefined') {
                    setInView(true);
                    return undefined;
                }
                const observer = new IntersectionObserver((entries) => {
                    for (const entry of entries) setInView(entry.isIntersecting);
                }, { rootMargin: `${PROXIMITY_PX}px` });
                observer.observe(node);
                return () => observer.disconnect();
            }, []);
            return [ref, inView];
        }

        /**
         * 图片缩略图。
         *
         * 原图可能是 4K/8K，直接塞进格子会让浏览器解码几十兆像素；这里在浏览器里
         * 降采样到 `THUMB_MAX` 长边再喂给 `<img>`。结果先进内存 LRU（翻页 / 重挂载的
         * 快路径），再进 Cache Storage 持久化（翻页回去 / 重开应用都直接命中，不再向
         * 宿主重取）。任何一步失败都退回原图 URL —— 缩略图是优化，不是前提。
         */
        function useThumb(item, active, revision) {
            const [state, setState] = useState(() => {
                const preloaded = active && item.kind === 'image'
                    ? cacheGetThumb(`${revision}|${item.relPath}`)
                    : undefined;
                return preloaded !== undefined
                    ? { src: preloaded.url, color: preloaded.color ?? null, pending: false }
                    : { src: null, color: null, pending: false };
            });
            useEffect(() => {
                const signature = mediaSignature(item);
                const fromMemory = active && item.kind === 'image'
                    ? cacheGetThumb(`${revision}|${item.relPath}`)
                    : undefined;
                setState(fromMemory !== undefined
                    ? { src: fromMemory.url, color: fromMemory.color ?? null, pending: false }
                    : { src: null, color: null, pending: false });
                if (!active || item.kind !== 'image' || fromMemory !== undefined) return undefined;
                const original = fileUrl(item.relPath, revision);
                if (typeof createImageBitmap !== 'function') {
                    setState({ src: original, color: null, pending: false });
                    return undefined;
                }
                let cancelled = false;
                setState((previous) => (previous.pending ? previous : { ...previous, pending: true }));
                void imageSlots(async () => {
                    if (cancelled) return;
                    try {
                        // 先查持久化缓存：翻页回去 / 重开应用直接命中，不向宿主重取。
                        let url;
                        let color = null;
                        const cached = await cacheGetMedia(item.relPath, signature);
                        if (cached !== null) {
                            url = URL.createObjectURL(cached);
                        } else {
                            const response = await fetch(original, { credentials: 'same-origin' });
                            if (!response.ok) throw new Error(String(response.status));
                            const blob = await response.blob();
                            const bitmap = await createImageBitmap(blob);
                            const longest = Math.max(bitmap.width, bitmap.height);
                            if (!Number.isFinite(longest) || longest <= THUMB_MAX) {
                                // 小图：直接缓存原图 blob，省一次再解码。
                                if (typeof bitmap.close === 'function') bitmap.close();
                                url = URL.createObjectURL(blob);
                                await cachePutMedia(item.relPath, signature, blob);
                            } else {
                                const scale = THUMB_MAX / longest;
                                const canvas = document.createElement('canvas');
                                canvas.width = Math.max(1, Math.round(bitmap.width * scale));
                                canvas.height = Math.max(1, Math.round(bitmap.height * scale));
                                canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                                try {
                                    const tiny = document.createElement('canvas');
                                    tiny.width = 1;
                                    tiny.height = 1;
                                    const tinyCtx = tiny.getContext('2d');
                                    tinyCtx.drawImage(bitmap, 0, 0, 1, 1);
                                    const data = tinyCtx.getImageData(0, 0, 1, 1).data;
                                    color = `rgb(${data[0]},${data[1]},${data[2]})`;
                                } catch {
                                    /* 主色是装饰，canvas 读不了像素就算了 */
                                }
                                if (typeof bitmap.close === 'function') bitmap.close();
                                const thumb = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78));
                                if (thumb === null) { if (!cancelled) setState({ src: original, color: null, pending: false }); return; }
                                url = URL.createObjectURL(thumb);
                                await cachePutMedia(item.relPath, signature, thumb);
                            }
                        }
                        if (cancelled || url === undefined) return;
                        cacheSetThumb(`${revision}|${item.relPath}`, { url, color });
                        if (!cancelled) setState({ src: url, color, pending: false });
                    } catch {
                        if (!cancelled) setState({ src: original, color: null, pending: false });
                    } finally {
                        if (!cancelled) setState((previous) => (previous.pending ? { ...previous, pending: false } : previous));
                    }
                });
                return () => {
                    cancelled = true;
                };
            }, [active, item.kind, item.relPath, revision, item.mtimeMs, item.size]);
            return state;
        }

        /**
         * 视频封面：首次进视口时取首帧画到 canvas，生成一张静态封面图，持久化缓存；
         * 之后翻页 / 重开都直接显示封面，不再为每个卡片新建 `<video>` 重新请求元数据
         * （一个页面几十个 video 元素既吃内存又拖慢）。时长一并探测并随签名缓存。
         */
        function useVideoPoster(item, active, revision) {
            const [state, setState] = useState(() => {
                const preloaded = active && item.kind === 'video'
                    ? cacheGetThumb(`${revision}|${item.relPath}`)
                    : undefined;
                return preloaded !== undefined
                    ? { poster: preloaded.url, duration: preloaded.duration ?? readDuration(item), pending: false }
                    : { poster: null, duration: active && item.kind === 'video' ? readDuration(item) : null, pending: false };
            });
            useEffect(() => {
                const signature = mediaSignature(item);
                const fromMemory = active && item.kind === 'video'
                    ? cacheGetThumb(`${revision}|${item.relPath}`)
                    : undefined;
                setState(fromMemory !== undefined
                    ? { poster: fromMemory.url, duration: fromMemory.duration ?? readDuration(item), pending: false }
                    : { poster: null, duration: active && item.kind === 'video' ? readDuration(item) : null, pending: false });
                if (!active || item.kind !== 'video' || fromMemory !== undefined) return undefined;
                let cancelled = false;
                setState((previous) => (previous.pending ? previous : { ...previous, pending: true }));
                void posterSlots(async () => {
                    if (cancelled) return;
                    let video;
                    try {
                        const cached = await cacheGetMedia(item.relPath, signature);
                        if (cached !== null) {
                            const url = URL.createObjectURL(cached);
                            cacheSetThumb(`${revision}|${item.relPath}`, { url, color: null, duration: readDuration(item) });
                            if (!cancelled) setState({ poster: url, duration: readDuration(item), pending: false });
                            return;
                        }
                        video = document.createElement('video');
                        video.muted = true;
                        video.preload = 'metadata';
                        video.src = fileUrl(item.relPath, revision);
                        // 等元数据必须带超时：mkv/avi 这类容器可能永远不给
                        // `loadedmetadata`，卡住的不只是一个 Promise —— 闸门槽位也会被它占着。
                        await new Promise((resolve, reject) => {
                            const timer = setTimeout(() => { video.onloadedmetadata = null; video.onerror = null; reject(new Error('metadata timeout')); }, METADATA_TIMEOUT_MS);
                            video.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
                            video.onerror = () => { clearTimeout(timer); reject(new Error('video')); };
                        });
                        const dur = humanDuration(video.duration);
                        if (dur !== null) writeDuration(item, dur);
                        const seekTo = Math.min(Math.max(0, (video.duration || 0) * 0.1), Math.max(0, (video.duration || 1) - 0.05));
                        await new Promise((resolve) => {
                            video.onseeked = () => resolve();
                            try { video.currentTime = seekTo; } catch { resolve(); }
                        });
                        // 封面按缩略图尺寸降采样：它是给 152px 的格子用的，
                        // 按原视频分辨率画一张 4K canvas 再编码成 jpeg 是纯浪费。
                        const sourceWidth = video.videoWidth || 320;
                        const sourceHeight = video.videoHeight || 180;
                        const longest = Math.max(sourceWidth, sourceHeight);
                        const scale = longest > THUMB_MAX ? THUMB_MAX / longest : 1;
                        const canvas = document.createElement('canvas');
                        canvas.width = Math.max(1, Math.round(sourceWidth * scale));
                        canvas.height = Math.max(1, Math.round(sourceHeight * scale));
                        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                        const poster = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7));
                        if (cancelled || poster === null) return;
                        const url = URL.createObjectURL(poster);
                        cacheSetThumb(`${revision}|${item.relPath}`, { url, color: null, duration: dur });
                        await cachePutMedia(item.relPath, signature, poster);
                        if (!cancelled) setState({ poster: url, duration: dur, pending: false });
                    } catch {
                        if (!cancelled) setState({ poster: null, duration: null, pending: false });
                    } finally {
                        // 元素早一秒释放，就早一秒还回解码器内存 —— 失败路径也一样。
                        if (video !== undefined) {
                            video.removeAttribute('src');
                            video.load();
                        }
                        if (!cancelled) setState((previous) => (previous.pending ? { ...previous, pending: false } : previous));
                    }
                });
                return () => {
                    cancelled = true;
                };
            }, [active, item.kind, item.relPath, revision, item.mtimeMs, item.size]);
            return state;
        }

        /**
         * 面板样式。
         *
         * 只引用 `--dsw-alias-*` token（都带 fallback），因此浅色/深色主题自动跟随；
         * 类名统一带 `dal-` 前缀，避免和宿主页面撞名。
         */
        const CSS = `
.dal-root{display:flex;flex-direction:column;height:100%;min-height:420px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-family:var(--dsw-font-family,inherit);font-size:13px}
.dal-head{display:flex;flex-direction:column;gap:8px;padding:12px 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.dal-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dal-title{display:flex;align-items:baseline;gap:8px;white-space:nowrap}
.dal-count{font-size:12px;font-weight:400;color:var(--dsw-alias-label-tertiary,#81858c)}
.dal-sub{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px}
.dal-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dal-tools{display:flex;align-items:center;gap:4px;margin-left:auto;min-width:0}
.dal-tabs{display:flex;align-items:center;gap:2px;min-width:0;overflow:hidden}
.dal-tab{background:none;border:0;border-radius:6px;padding:4px 9px;color:var(--dsw-alias-label-tertiary,#81858c);font:inherit;line-height:18px;cursor:pointer;white-space:nowrap}
.dal-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-secondary,#4a4f57)}
.dal-tab[data-on="true"]{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115);font-weight:500}
.dal-search{display:flex;align-items:center;gap:6px;flex:1 1 170px;min-width:110px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-tertiary,#81858c)}
.dal-search:focus-within{border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-search input{flex:1;min-width:0;border:0;outline:0;background:none;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;padding:0}
.dal-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer}
.dal-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#0f1115)}
.dal-iconbtn[disabled]{opacity:.4;cursor:default}
.dal-iconbtn[data-on="true"]{color:var(--dsw-alias-label-primary,#0f1115)}
.dal-dd{position:relative;display:inline-flex;min-width:0}
.dal-ddtoggle{display:inline-flex;align-items:center;gap:5px;max-width:340px;min-width:0;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary,#4a4f57);font:inherit;line-height:18px;padding:4px 7px;cursor:pointer;white-space:nowrap}
.dal-ddtoggle:hover,.dal-ddtoggle[data-on="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary,#0f1115)}
.dal-ddtoggle[disabled]{opacity:.5;cursor:default}
.dal-caret{opacity:.5}
/* 项目切换器不参与收缩：项目名是这一行里最需要读全的信息，不能为了给搜索框让位
   被压成"短…"。宁可让 .dal-bar 整体换行。 */
.dal-project{display:flex;align-items:center;gap:6px;min-width:0;flex:none}
.dal-projectname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
.dal-projectsub{color:var(--dsw-alias-label-tertiary,#81858c)}
.dal-ddbox{position:absolute;right:0;top:calc(100% + 6px);z-index:30;display:flex;flex-direction:column;gap:1px;padding:6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);max-height:60vh;overflow:auto}
.dal-ddhead{display:flex;flex-direction:column;gap:3px;padding:2px 7px 7px}
.dal-ddk{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px}
.dal-ddv{color:var(--dsw-alias-label-secondary,#4a4f57);font-size:12px;word-break:break-all}
.dal-ddl{padding:7px 7px 2px;color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px}
.dal-ddsep{height:1px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.06));margin:5px 0}
.dal-dditem{display:flex;align-items:baseline;gap:8px;width:100%;box-sizing:border-box;border:0;border-radius:6px;background:none;color:inherit;font:inherit;text-align:left;padding:5px 8px;cursor:pointer}
.dal-dditem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dal-dditem[data-on="true"]{color:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-dditemname{flex:none;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dal-dditempath{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dal-ddinput{padding:4px 6px}
.dal-ddinput input{width:100%}
.dal-input,.dal-textarea{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;border-radius:var(--dsw-radius-sm,6px);padding:5px 8px;font:inherit;outline:none}
.dal-input:focus,.dal-textarea:focus{border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-input{flex:1;min-width:160px}
.dal-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);border-radius:var(--dsw-radius-sm,6px);padding:5px 10px;font:inherit;cursor:pointer;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.dal-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dal-btn:active{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.08))}
.dal-btn[disabled]{opacity:.5;cursor:default}
.dal-btn-primary{background:var(--dsw-alias-brand-primary,#1f6feb);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.dal-btn-primary:hover{background:var(--dsw-alias-brand-primary,#1f6feb);opacity:.9}
.dal-chips{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.dal-chip{display:inline-flex;align-items:center;gap:4px;border:0;background:none;color:var(--dsw-alias-label-secondary,#4a4f57);border-radius:6px;padding:3px 8px;cursor:pointer;font:inherit;line-height:18px}
.dal-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dal-chip[data-on="true"]{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115)}
.dal-chip[disabled]{opacity:.5;cursor:default}
a.dal-chip{text-decoration:none}
.dal-chip-x{opacity:.55;font-weight:400}
.dal-chip-x:hover{opacity:1}
.dal-facet{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
/* 组之间用发丝线分组。线要看得出来（l1 的 .07 太淡，视觉上只剩"间距大了点"，
   读不出类型/目录/标签是三个维度），但也不必加粗 —— l2 的 .13 在这套浅色 token 下
   刚好是一条看得见、不抢戏的线。 */
.dal-vsep{flex:none;width:1px;height:14px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.14));margin:0 3px}
.dal-body{flex:1;min-height:0;overflow:auto;padding:12px 16px}
.dal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(152px,1fr));gap:12px;align-items:start}
.dal-card{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,#fff);border-radius:var(--dsw-radius-md,8px);overflow:hidden;cursor:pointer;display:flex;flex-direction:column;padding:0;text-align:left;font:inherit;color:inherit;content-visibility:auto;contain-intrinsic-size:auto 180px}
.dal-card:hover{border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#1f6feb);outline-offset:1px}
.dal-cursor{outline:2px solid var(--dsw-alias-brand-primary,#1f6feb);outline-offset:1px}
.dal-selected{border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-thumb{position:relative;width:100%;aspect-ratio:4/3;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));display:flex;align-items:center;justify-content:center;overflow:hidden}
/* contain 模式：竖图不再被裁掉上下，露出完整构图。格子尺寸不变，网格照样整齐。 */
.dal-thumb[data-fit="contain"]{background:var(--dsw-alias-bg-layer-1,#fff)}
.dal-grid[data-fit="contain"] .dal-thumb img,.dal-grid[data-fit="contain"] .dal-thumb video{object-fit:contain}
.dal-thumb img,.dal-thumb video{width:100%;height:100%;object-fit:cover;display:block}
.dal-fade{animation:dal-fadein .28s ease-out}
@keyframes dal-fadein{from{opacity:0}to{opacity:1}}
/* 多选勾选框：以前是个纯装饰的 span（只会随悬停出现、点了没反应，看着像个不知名的黑点）。
   现在它自己是可点目标 —— 圆角方形 + 白描边，读得出"这是勾选框"；一旦有任意选中项
   （网格挂 .dal-selecting）就全部常显，不必再靠 Ctrl 点。 */
.dal-check{position:absolute;right:6px;top:6px;width:18px;height:18px;box-sizing:border-box;display:none;border-radius:5px;border:1.5px solid var(--dsw-static-neutral-bluish-00,#fff);background:var(--dsw-alias-bg-mask-photo,rgba(0,0,0,.45));color:var(--dsw-static-neutral-bluish-00,#fff);font-size:12px;line-height:15px;text-align:center;padding:0;cursor:pointer}
.dal-card:hover .dal-check,.dal-card:focus-within .dal-check,.dal-selected .dal-check,.dal-selecting .dal-check{display:block}
.dal-check:hover{background:var(--dsw-alias-bg-mask-photo,rgba(0,0,0,.62))}
.dal-check-on{background:var(--dsw-alias-brand-primary,#1f6feb);border-color:transparent}
.dal-check-on::after{content:'✓'}
.dal-skeleton{width:100%;height:100%;background:linear-gradient(100deg,transparent 20%,var(--dsw-alias-bg-skeleton,rgba(0,0,0,.05)) 40%,transparent 60%);animation:dal-shimmer 1.2s linear infinite}
@keyframes dal-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.dal-skeleton{animation:none}.dal-fade{animation:none}}
/*
 * 遮罩上的一切（徽标 / 勾选框 / 参照角标）刻意不用 label-primary-inverted。
 * 查过 DSH 的真实取值：inverted 在浅色主题 = --dsw-static-neutral-bluish-00(#fff)，
 * 在深色主题 = --dsw-static-neutral-bluish-800(#292929) —— 也就是**深色**。而
 * --dsw-alias-bg-mask-photo 两个主题都是深色遮罩（#000000e0 / rgba(0,0,0,.88)）。
 * 于是「深底 + inverted 文字」在深色主题下变成深底深字，等于隐形。
 * 这些元素永远压在照片上，对比度由位置决定、与页面主题无关，所以用静态色板的最浅色
 * （与 DSH 自己的 label-primary-foreground 同值），并留 #fff 兜底。
 */
.dal-badge{position:absolute;left:6px;top:6px;background:var(--dsw-alias-bg-mask-photo,rgba(0,0,0,.6));color:var(--dsw-static-neutral-bluish-00,#fff);border-radius:999px;padding:1px 7px;font-size:11px;line-height:16px}
.dal-badge-r{position:absolute;right:6px;bottom:6px;background:var(--dsw-alias-bg-mask-photo,rgba(0,0,0,.6));color:var(--dsw-static-neutral-bluish-00,#fff);border-radius:999px;padding:1px 7px;font-size:11px;line-height:16px}
.dal-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.4);font-size:26px;pointer-events:none}
.dal-meta{padding:6px 8px;display:flex;flex-direction:column;gap:2px;min-width:0}
.dal-name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dal-dim{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px}
.dal-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}
.dal-tag{border:1px solid transparent;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));border-radius:999px;padding:1px 6px;font-size:11px;color:var(--dsw-alias-label-secondary,#4a4f57)}
.dal-empty{display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;height:100%;color:var(--dsw-alias-label-tertiary,#81858c);text-align:center;padding:32px 16px}
/* 空状态里的"清除筛选"：唯一可点的出口。搜索不到时挨个去点 chip 关掉筛选太费事。 */
.dal-empty-action{margin-top:6px}
.dal-error{border:1px solid var(--dsw-alias-state-error-primary,#d93025);color:var(--dsw-alias-state-error-primary,#d93025);border-radius:var(--dsw-radius-sm,6px);padding:6px 10px;font-size:12px}
.dal-batchbar{position:sticky;bottom:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;margin-top:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff)}
/* 详情页第一行复用网格表头的排版（同样的 15px 标题 / 12px 工具 / 同样的下边发丝线），
   两个视图切换时表头位置不跳，这是"统一"里最容易被忽略、又最容易被眼睛发现的一处。 */
.dal-h1{font-size:15px;font-weight:600;letter-spacing:.01em}
.dal-detail{display:flex;flex-direction:column;height:100%;min-height:0}
.dal-detail-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:14px;padding:12px 16px}
@media (max-width:960px){.dal-detail-body{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(200px,1fr) auto}}
.dal-count{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;white-space:nowrap}
.dal-detail-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dal-stage{position:relative;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));border-radius:var(--dsw-radius-md,8px);display:flex;align-items:center;justify-content:center;overflow:hidden;min-height:220px;padding:8px}
/* 媒体列：画面 + 播放条竖排。min-width:0 是必需的 —— grid 子项默认 min-width:auto，
   长路径/大图会把这一列撑破，1fr 就失效了。
   画面 flex:1 撑满剩余高度：否则这一列按内容高度排，右边信息列一长就整块失衡。 */
.dal-media{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0}
.dal-media > .dal-stage{flex:1;min-height:0}
.dal-playerbar{display:flex;justify-content:center;flex:none}
/* 参照图钉：功能重要、但视觉上不该是最响的一块。原来是品牌色描边 + 品牌色角标 + 阴影，
   一屏里唯一的高饱和元素；改成中性描边 + 与卡片徽标同一种遮罩药丸，语义靠文字。 */
.dal-ref{position:absolute;right:10px;bottom:10px;width:104px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px;overflow:hidden;cursor:pointer;background:var(--dsw-alias-bg-layer-1,#fff)}
.dal-ref:hover{border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-ref img{width:100%;height:78px;object-fit:cover;display:block}
.dal-ref-label{position:absolute;left:5px;top:5px;background:var(--dsw-alias-bg-mask-photo,rgba(0,0,0,.45));color:var(--dsw-static-neutral-bluish-00,#fff);font-size:10px;padding:1px 6px;border-radius:999px;line-height:15px}
.dal-stage img,.dal-stage video{max-width:100%;max-height:100%;display:block}
/* 视频可点（点一下播/停），给个 pointer 提示；音频没有画面层，不加。 */
.dal-stage video{cursor:pointer}
.dal-zoomable{transform-origin:0 0;touch-action:none;user-select:none;background-image:conic-gradient(var(--dsw-alias-bg-layer-1,#fff) 25%,var(--dsw-alias-bg-layer-2,rgba(0,0,0,.08)) 0 50%,var(--dsw-alias-bg-layer-1,#fff) 0 75%,var(--dsw-alias-bg-layer-2,rgba(0,0,0,.08)) 0);background-size:16px 16px}
/* 音频没有画面，所以舞台不该是一整块灰底大盒子 —— 一个巨大的空盒子中间飘着个 ♪，
   比不放更难看。用 data-kind 让这一列不撑高、不铺底，播放条紧跟在 ♪ 下面。 */
.dal-stage-audio{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:0;padding:28px 8px;color:var(--dsw-alias-label-tertiary,#81858c)}
.dal-note{font-size:42px;line-height:1}
/* 自绘播放条：原生 controls 是一套和 DSH 完全不同的控件语言（灰色 bulky 立体条），
   整块面板里只有它不搭。这里自己画：播放/暂停 + 进度 + 时间，全部走 --dsw-alias-*。 */
.dal-player{display:flex;align-items:center;gap:10px;width:min(460px,100%);font-size:12px;color:var(--dsw-alias-label-secondary,#4a4f57)}
.dal-playbtn{flex:none;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115);cursor:pointer;padding:0}
.dal-playbtn:hover{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.1))}
.dal-playbtn[data-playing="true"]{background:var(--dsw-alias-brand-primary,#1f6feb);color:var(--dsw-alias-label-primary-foreground,#fff)}
/* 进度条本体只有 3px，靠一条 1px 的轨道承住；不做拖拽手柄，位置本身就是提示。 */
.dal-track{position:relative;flex:1;min-width:0;height:14px;display:flex;align-items:center;cursor:pointer;background:none;border:0;padding:0}
.dal-track-rail{position:absolute;left:0;right:0;height:3px;border-radius:999px;background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.12))}
.dal-track-fill{position:absolute;left:0;height:3px;border-radius:999px;background:var(--dsw-alias-label-primary,#0f1115)}
.dal-track:hover .dal-track-fill{background:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-track-dot{position:absolute;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-label-primary,#0f1115);transform:translateX(-50%)}
.dal-track:hover .dal-track-dot{background:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-time{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px;white-space:nowrap}
.dal-info{overflow:auto;display:flex;flex-direction:column;gap:12px;min-height:0;padding-right:2px}
/* 一个网格装完整列：键列宽度由最长键决定，所以"修改时间"和"相对路径"下面值都从同一条
   竖线开始（以前写死 76px，英文键和中文键都各偏一点）。分隔线作为整行网格项插进去。 */
.dal-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 12px;font-size:12px;align-items:baseline}
.dal-k{color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap}
.dal-v{color:var(--dsw-alias-label-secondary,#4a4f57);word-break:break-all;min-width:0}
/* 路径当数据看：小一号 + 松一点的行高。Windows 绝对路径本来就长，12px 在 320px 宽的列里
   会折出"最后一个字符单独占一行"那种最难看的断法。 */
.dal-pathv{font-size:11px;line-height:1.55}
/* 路径行本身就是复制按钮：点击即复制，右侧图标是"这一行可点、点了会复制"的唯一提示。
   把原来那排"复制路径 / 在资源管理器中显示 / 在新标签页打开"三个 chip 收成一个图标 +
   两个 chip —— 那排 chip 在 320px 宽的列里本来就换行成两行，是这块最乱的地方。 */
.dal-copyrow{display:flex;align-items:flex-start;justify-content:space-between;gap:6px;min-width:0;box-sizing:border-box;border:0;background:none;color:inherit;font:inherit;text-align:left;padding:1px 4px;margin:-1px -4px;border-radius:4px;cursor:pointer}
.dal-copyrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dal-copyrow > .dal-copyicon{flex:none;margin-top:2px;opacity:.45;color:var(--dsw-alias-label-tertiary,#81858c)}
.dal-copyrow:hover > .dal-copyicon,.dal-copyrow[data-done="true"] > .dal-copyicon{opacity:1;color:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-field{display:flex;flex-direction:column;gap:6px}
.dal-label{font-size:12px;color:var(--dsw-alias-label-secondary,#4a4f57)}
.dal-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
/* 保存行：状态在左、主按钮在右。以前是一个孤零零的蓝按钮贴在左边界上，右边一大片空白。 */
.dal-save{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:28px}
`;

        /** 侧边栏图标；面板条目被渲染在宿主自己的 `<button>` 里，所以这里不能再包交互元素。 */
        function Icon() {
            return h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true, style: { display: 'block' } },
                h('rect', { x: 2.5, y: 3.5, width: 19, height: 17, rx: 4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
                h('path', { d: 'M5 15.2l3.2-3.6 2.3 2.4 2.1-2.1 2.4 3.3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                h('path', { d: 'M15.2 7.6v5.4M15.2 7.6l3.6-.9v5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }));
        }

        /**
         * 面板内的小图标：与侧边栏图标同一套描边语言（1.6px、currentColor）。
         *
         * 用内联 SVG 而不是字符（`⟳` `↕` `🔍`）：字符的粗细、基线、大小完全取决于
         * 系统字体，同一行里对齐不了 —— 这正是"看着不够精致"的常见来源。
         */
        const ICON_PATHS = {
            folder: 'M3.5 6.5A1.5 1.5 0 0 1 5 5h4l1.8 2.2H19a1.5 1.5 0 0 1 1.5 1.5v8.3A1.5 1.5 0 0 1 19 18.5H5a1.5 1.5 0 0 1-1.5-1.5z',
            chevron: 'M8 10l4 4 4-4',
            search: 'M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0M16.2 16.2l4.3 4.3',
            refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.4v4.3h-4.3',
            arrowUp: 'M12 19V6M6.8 11.2L12 6l5.2 5.2',
            arrowDown: 'M12 5v13M17.2 12.8L12 18l-5.2-5.2',
            arrowBoth: 'M9 17.5V7.5M6.4 10.1L9 7.5l2.6 2.6M15 6.5v10M12.4 13.9L15 16.5l2.6-2.6',
            pin: 'M12 21s6-5.3 6-10a6 6 0 1 0-12 0c0 4.7 6 10 6 10M12 11.2a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4',
            arrowLeft: 'M15 6l-6 6 6 6',
            arrowRight: 'M9 6l6 6-6 6',
            zoom: 'M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0M16.2 16.2l4.3 4.3M8.5 11h5M11 8.5v5',
            copy: 'M9.2 9.2V6.6a1.6 1.6 0 0 1 1.6-1.6h5.8a1.6 1.6 0 0 1 1.6 1.6v5.8a1.6 1.6 0 0 1-1.6 1.6h-2.6M6.8 10.8h5.8a1.6 1.6 0 0 1 1.6 1.6v5.8a1.6 1.6 0 0 1-1.6 1.6H6.8a1.6 1.6 0 0 1-1.6-1.6v-5.8a1.6 1.6 0 0 1 1.6-1.6z',
            check: 'M5.5 12.6l4.3 4.3L18.6 8',
            close: 'M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4',
            folderOpen: 'M4 8.2A1.6 1.6 0 0 1 5.6 6.6h3.1l1.8 2.2h4.4M4 8.2v9A1.6 1.6 0 0 0 5.6 18.8h11.6a1.6 1.6 0 0 0 1.55-1.23l1.3-5.2a1 1 0 0 0-.97-1.27H7.3a1.6 1.6 0 0 0-1.55 1.23L4 18.2',
            external: 'M14.2 4.6h5.2v5.2M19.4 4.6l-6.8 6.8M17.8 14.4v4a1.6 1.6 0 0 1-1.6 1.6H5.8a1.6 1.6 0 0 1-1.6-1.6V8a1.6 1.6 0 0 1 1.6-1.6h4',
            // 播放/暂停：详情页自绘播放条用。原生 controls 的样子和 DSH 不像一套东西。
            play: 'M8.4 5.9v12.2a.6.6 0 0 0 .93.5l9.4-6.1a.6.6 0 0 0 0-1L9.33 5.4a.6.6 0 0 0-.93.5z',
            pause: 'M9.2 5.4v13.2M14.8 5.4v13.2',
            // 缩略图填充方式：contain（完整构图，能看出上下被裁掉没有）。
            fit: 'M8.4 4.6H6a1.6 1.6 0 0 0-1.6 1.6v2.4M15.6 4.6H18a1.6 1.6 0 0 1 1.6 1.6v2.4M19.4 15.4V18a1.6 1.6 0 0 1-1.6 1.6h-2.4M8.4 19.4H6A1.6 1.6 0 0 1 4.4 18v-2.4M8.2 12h7.6',
        };

        function icon(name, size, className) {
            const d = ICON_PATHS[name];
            if (d === undefined) return null;
            return h('svg', {
                viewBox: '0 0 24 24',
                width: size,
                height: size,
                'aria-hidden': true,
                ...(className === undefined ? {} : { className }),
                style: { display: 'block', flex: 'none' },
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.6,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
            }, h('path', { d }));
        }

        /** 路径的最后一段（`H:\a\b\Camera` → `Camera`）；盘根这类没有段名的情况退回全路径。 */
        function baseName(value) {
            if (typeof value !== 'string' || value.trim() === '') return '';
            const parts = value.split(/[\\/]+/u).filter((part) => part !== '');
            const last = parts[parts.length - 1] ?? '';
            return last === '' || last.endsWith(':') ? value : last;
        }

        /** 路径的父级（用于下拉里做次要说明）；取不到就返回空串。 */
        function parentPath(value) {
            if (typeof value !== 'string' || value.trim() === '') return '';
            const cut = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
            return cut <= 0 ? '' : value.slice(0, cut);
        }

        /**
         * 统一的下拉控件：一个触发按钮 + 一块贴边面板，点外面或按 Esc 关闭。
         *
         * 为什么不用原生 `<select>`：它在 Windows/Electron 下的边框、箭头、内边距都不吃
         * 这套 token，是"和 DSH 不像一套东西"的主要来源；而且它装不下"最近项目 + 当前
         * 扫描目录 + 手动输入"这种多行信息。用同一个组件承载项目切换与排序，交互语言
         * 也就只有一种。
         *
         * `children` 是渲染函数（传入 `close`），因为菜单项点完要收起面板。
         */
        function Dropdown({ className, label, title, disabled, width, children }) {
            const [open, setOpen] = useState(false);
            const boxRef = useRef(null);
            useEffect(() => {
                if (!open) return undefined;
                const onPointerDown = (event) => {
                    const node = boxRef.current;
                    // 点在自己身上（触发按钮或菜单里）不关；测试桩没有真实节点，也就不关。
                    if (node !== null && typeof node.contains === 'function' && node.contains(event.target) === true) return;
                    setOpen(false);
                };
                window.addEventListener('mousedown', onPointerDown);
                return () => window.removeEventListener('mousedown', onPointerDown);
            }, [open]);
            return h('div', {
                className: className === undefined ? 'dal-dd' : `dal-dd ${className}`,
                ref: boxRef,
                onKeyDown: (event) => { if (event.key === 'Escape') setOpen(false); },
            },
                h('button', {
                    type: 'button',
                    className: 'dal-ddtoggle',
                    'data-on': String(open),
                    title,
                    disabled: disabled === true,
                    onClick: () => setOpen((previous) => !previous),
                }, label, icon('chevron', 12, 'dal-caret')),
                open
                    ? h('div', { className: 'dal-ddbox', style: width === undefined ? undefined : { minWidth: width } }, children(() => setOpen(false)))
                    : null);
        }

        /** 焦点是否在输入类元素里；是的话网格/详情快捷键全部让路。 */
        function isEditableTarget(target) {
            return target !== null && typeof target === 'object'
                && (target.isContentEditable === true
                    || target.tagName === 'INPUT'
                    || target.tagName === 'TEXTAREA'
                    || target.tagName === 'SELECT');
        }

        /** 悬停预览是主动行为，但仍然尊重系统的减少动态偏好。 */
        const HOVER_PREVIEW = typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        /**
         * 悬停预览用的**单个**共享 `<video>`，整个面板生命周期只建一次。
         *
         * 原先每张视频卡悬停时各自 `createElement('video')`、设 src、播、卸载：来回扫过一排
         * 视频卡就是 N 次元素创建 + N 次解码器起停，而解码器起停才是最贵的那一段（编解码
         * 上下文不是零成本）。改成模块级单例后，扫过一排只复用同一个解码器，切卡只是换
         * src 并 seek。仍然 `muted + loop`，不自动出声。
         */
        const hoverPreview = {
            el: null,
            ensure() {
                if (typeof document === 'undefined') return null;
                if (this.el === null) {
                    const node = document.createElement('video');
                    node.muted = true;
                    node.loop = true;
                    node.playsInline = true;
                    node.preload = 'auto';
                    node.setAttribute('data-dal-hover', '1');
                    // 藏起来而不是不建：display:none 的 video 一样能播。
                    // 用 fixed 而不是 absolute：坐标直接取自 getBoundingClientRect（视口系），
                    // 不用管 body 有没有 margin / transform。
                    node.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;left:-9999px';
                    document.body.appendChild(node);
                    this.el = node;
                }
                return this.el;
            },
            show(item, revision, host) {
                const node = this.ensure();
                if (node === null || host === null || typeof host.getBoundingClientRect !== 'function') return;
                const box = host.getBoundingClientRect();
                if (box.width === 0 || box.height === 0) return;
                const url = fileUrl(item.relPath, revision);
                // 换资产才换 src：同一张卡反复悬停不该重新拉一次。
                if (node.dataset.dalSrc !== url) {
                    node.dataset.dalSrc = url;
                    node.src = url;
                }
                node.style.left = `${box.left}px`;
                node.style.top = `${box.top}px`;
                node.style.width = `${box.width}px`;
                node.style.height = `${box.height}px`;
                node.style.objectFit = host.dataset.fit === 'contain' ? 'contain' : 'cover';
                node.style.zIndex = '2147483000';
                node.style.opacity = '1';
                const attempt = node.play();
                if (attempt !== undefined && typeof attempt?.catch === 'function') attempt.catch(() => {});
            },
            hide() {
                if (this.el === null) return;
                this.el.pause();
                this.el.style.opacity = '0';
                this.el.style.left = '-9999px';
            },
        };

        /**
         * 网格里的一张卡片。
         *
         * 贴近视口才挂媒体；视频只在这个前提下才创建 `<video preload="metadata">`
         * （一个页面几十个 video 元素会明显吃内存），拿到元数据后把时长显示在右下角。
         * 悬停预览走模块级的**单个**共享 `<video>`（见 `hoverPreview`），卡片自己不挂。
         * 音频同理挂 `<audio preload="metadata">` 只为拿到时长。
         * 卡片统一尺寸：缩略图固定 4:3 比例，不随分辨率 / 横竖变化；默认 cover 填满保证
         * 网格整齐，竖图会被裁掉上下 —— `fit="contain"` 可以切成完整构图（格子尺寸不变）。
         *
         * 右上角是可点的多选勾选框（悬停出现，一旦有选中项就全部常显）。它以前是个纯装饰的
         * span：随悬停冒出来、点了没反应，看起来就是个不知名的黑块 —— 能看见却不能用，
         * 比看不见更糟。
         */
        function AssetCard({ item, onOpen, onToggleSelect, t, revision, selected, cursor, fit }) {
            const [ref, inView] = useInView();
            const { src, color, pending } = useThumb(item, inView, revision);
            const posterState = useVideoPoster(item, inView, revision);
            // 悬停预览走模块级共享 <video>（见 hoverPreview），这里只留"鼠标在不在卡片上"。
            const [hovered, setHovered] = useState(false);
            const thumbRef = useRef(null);
            // 时长先看浏览器侧缓存：探测过一次的音频/视频不该在每次挂载时再问一遍。
            const [duration, setDuration] = useState(() => readDuration(item));
            // 视频卡才起预览，而且必须已经贴到视口（没贴视口就没有缩略图可盖）。
            // 不按"封面是否已缓存"筛：封面还在生成时卡片里本来就是一个 metadata <video>，
            // 这时悬停直接播反而是最有用的反馈。
            const previewable = HOVER_PREVIEW && item.kind === 'video' && inView;
            useEffect(() => () => { if (hovered) hoverPreview.hide(); }, [hovered]);
            let media = null;
            if (item.kind === 'image') {
                if (src !== null) media = h('img', { src, alt: item.name, loading: 'lazy', decoding: 'async', className: 'dal-fade' });
                else if (pending || !inView) media = h('span', { className: 'dal-skeleton' });
                else media = h('span', { className: 'dal-dim', style: { fontSize: 20 } }, '▨');
            } else if (item.kind === 'video') {
                if (posterState.poster !== null) {
                    // 已有缓存封面：只放静态图。会播的那一层是共享的浮在上面的 <video>，
                    // 卡片自己不再挂媒体元素。
                    media = h('img', { src: posterState.poster, alt: item.name, loading: 'lazy', decoding: 'async', className: 'dal-fade' });
                } else if (inView) {
                    // 封面还在生成：挂一个只取元数据的 <video>（不显示），生成完即替换。
                    media = h('video', {
                        src: fileUrl(item.relPath, revision),
                        preload: 'metadata', muted: true, playsInline: true,
                    });
                } else {
                    media = h('span', { className: 'dal-skeleton' });
                }
            } else {
                // 音频：♪ 占位。时长已知（之前探过、或在详情页听过）就不再挂 `<audio>` ——
                // 一个目录里几十条音频，每条都为了读一个数字建一个媒体元素，是这一屏里
                // 最亏的开销；未知时才挂一个不显示的 `<audio preload="metadata">` 去问一次。
                media = !inView
                    ? h('span', { className: 'dal-skeleton' })
                    : duration !== null
                        ? h('span', { className: 'dal-dim', style: { fontSize: 22 } }, '♪')
                        : [
                            h('span', { className: 'dal-dim', style: { fontSize: 22 } }, '♪'),
                            h('audio', {
                                src: fileUrl(item.relPath, revision),
                                preload: 'metadata',
                                onLoadedMetadata: (event) => {
                                    const value = humanDuration(event.target.duration);
                                    if (value === null) return;
                                    writeDuration(item, value);
                                    setDuration(value);
                                },
                            }),
                        ];
            }
            const thumbStyle = {};
            if (color !== null) thumbStyle.backgroundColor = color;
            const dims = Number.isFinite(item.width) && Number.isFinite(item.height) ? ` · ${item.width}×${item.height}` : '';
            return h('button', {
                type: 'button',
                className: `dal-card${cursor === true ? ' dal-cursor' : ''}${selected === true ? ' dal-selected' : ''}`,
                ref,
                onClick: (event) => { hoverPreview.hide(); onOpen(item, event); },
                // 只有"封面已缓存"的视频卡才起预览：封面还在生成时预览也看不出什么。
                onMouseEnter: previewable ? () => { setHovered(true); hoverPreview.show(item, revision, thumbRef.current); } : undefined,
                onMouseLeave: previewable ? () => { setHovered(false); hoverPreview.hide(); } : undefined,
                title: item.relPath,
            },
                h('span', {
                    className: 'dal-thumb',
                    ref: thumbRef,
                    'data-fit': fit,
                    style: Object.keys(thumbStyle).length > 0 ? thumbStyle : undefined,
                },
                    media,
                    // 勾选框是**可点目标**：点它只切换选择，不再穿透到卡片去打开详情。
                    h('span', {
                        className: `dal-check${selected === true ? ' dal-check-on' : ''}`,
                        role: 'checkbox',
                        'aria-checked': String(selected === true),
                        'aria-label': selected === true ? t('deselectOne') : t('selectOne'),
                        title: selected === true ? t('deselectOne') : t('selectOne'),
                        tabIndex: -1,
                        onClick: (event) => { event.stopPropagation?.(); onToggleSelect(item); },
                    }),
                    item.kind === 'video' && inView ? h('span', { className: 'dal-play' }, '▶') : null,
                    h('span', { className: 'dal-badge' }, t(item.kind)),
                    (item.kind === 'video' ? posterState.duration : duration) !== null
                        ? h('span', { className: 'dal-badge-r' }, item.kind === 'video' ? posterState.duration : duration)
                        : null),
                h('span', { className: 'dal-meta' },
                    h('span', { className: 'dal-name' }, item.name),
                    h('span', { className: 'dal-dim' }, `${humanSize(item.size)}${dims}`),
                    item.tags.length > 0 ? h('span', { className: 'dal-tags' }, item.tags.slice(0, 3).map((tag) => h('span', { className: 'dal-tag', key: tag }, tag))) : null));
        }

        /**
         * 自绘播放条：播放/暂停 + 进度 + 时间，视频与音频共用。
         *
         * 不用原生 `controls` 的理由只有一个：它是一套完全独立的控件语言 —— 灰色立体条、
         * 自己的悬停态、自己的字体，在一屏极简面板里它是唯一不搭的东西。而我们要的只有
         * 三个动作（播/暂停、跳到某处、看时间），正好用现成的 `dal-iconbtn` 那套语言画得出来。
         *
         * `target` 是媒体元素的 ref。真实播放状态以元素自己的 `paused` 为准（用户可能用
         * 键盘媒体键控制），所以监听 play/pause 事件回写，而不是只信我们的按钮点击。
         */
        function MediaPlayer({ target, t, compact }) {
            const [playing, setPlaying] = useState(false);
            const [time, setTime] = useState(0);
            const [total, setTotal] = useState(null);
            const trackRef = useRef(null);
            useEffect(() => {
                const node = target.current;
                if (node === null) return undefined;
                const onPlay = () => setPlaying(true);
                const onPause = () => setPlaying(false);
                const onTime = () => setTime(node.currentTime ?? 0);
                const onMeta = () => setTotal(Number.isFinite(node.duration) ? node.duration : null);
                node.addEventListener('play', onPlay);
                node.addEventListener('pause', onPause);
                node.addEventListener('ended', onPause);
                node.addEventListener('timeupdate', onTime);
                node.addEventListener('loadedmetadata', onMeta);
                return () => {
                    node.removeEventListener('play', onPlay);
                    node.removeEventListener('pause', onPause);
                    node.removeEventListener('ended', onPause);
                    node.removeEventListener('timeupdate', onTime);
                    node.removeEventListener('loadedmetadata', onMeta);
                };
            }, [target]);
            const toggle = () => {
                const node = target.current;
                if (node === null) return;
                if (node.paused === true) { const attempt = node.play(); if (typeof attempt?.catch === 'function') attempt.catch(() => {}); }
                else node.pause();
            };
            // 点进度条 = 跳到点住的位置。测试桩没有真实节点，所以先问一句 getBoundingClientRect。
            const seek = (event) => {
                const node = target.current;
                const rail = trackRef.current;
                if (node === null || rail === null || typeof rail.getBoundingClientRect !== 'function') return;
                const box = rail.getBoundingClientRect();
                if (box.width === 0) return;
                const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
                if (Number.isFinite(node.duration)) node.currentTime = ratio * node.duration;
            };
            const ratio = total !== null && total > 0 ? Math.min(1, Math.max(0, time / total)) : 0;
            const clock = (value) => humanDuration(value) ?? '0:00';
            return h('div', { className: 'dal-player', style: compact === true ? { width: 'min(360px,100%)' } : undefined },
                h('button', {
                    type: 'button',
                    className: 'dal-playbtn',
                    'data-playing': String(playing),
                    onClick: toggle,
                    title: playing ? t('pause') : t('play'),
                    'aria-label': playing ? t('pause') : t('play'),
                }, icon(playing ? 'pause' : 'play', 15)),
                // 进度条用 div 而不是 input[range]：range 的原生滑块无法用 token 统一，
                // 而这里要的只是"一条 3px 的线 + 一个点"。
                h('div', {
                    className: 'dal-track',
                    ref: trackRef,
                    role: 'slider',
                    tabIndex: 0,
                    'aria-label': t('seek'),
                    'aria-valuemin': 0,
                    'aria-valuemax': Math.round(total ?? 0),
                    'aria-valuenow': Math.round(time),
                    title: t('seek'),
                    onClick: seek,
                    onKeyDown: (event) => {
                        const node = target.current;
                        if (node === null || !Number.isFinite(node.duration)) return;
                        if (event.key === 'ArrowRight') { event.preventDefault(); node.currentTime = Math.min(node.duration, node.currentTime + 5); }
                        else if (event.key === 'ArrowLeft') { event.preventDefault(); node.currentTime = Math.max(0, node.currentTime - 5); }
                        else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); toggle(); }
                    },
                },
                    h('span', { className: 'dal-track-rail' }),
                    h('span', { className: 'dal-track-fill', style: { width: `${(ratio * 100).toFixed(2)}%` } }),
                    h('span', { className: 'dal-track-dot', style: { left: `${(ratio * 100).toFixed(2)}%` } })),
                h('span', { className: 'dal-time' }, total === null ? clock(time) : `${clock(time)} / ${clock(total)}`));
        }

        /**
         * 放大卡片：左边媒体本体，右边详细信息与标注。
         *
         * 不是浮层也不是抽屉 —— 它直接占据面板正文，所以不会遮住别的界面元素，也就
         * 不会出现"右侧栏"那种挤压感。Esc 返回，←/→ 在当前结果里翻；图片支持滚轮
         * 缩放（以指针为锚）、拖拽平移、双击放大/还原。
         *
         * 信息列只有三块：**规格 / 位置 / 标注**，块间一条发丝线；规格与位置共用同一个
         * 网格，键列宽度由最长的键统一决定，值都从同一条竖线开始。表头直接复用网格表头的
         * `.dal-head` 排版（同样内边距、同样下边发丝线、同样 15px 标题对 12px 工具），
         * 于是两个视图来回切时表头不跳。
         */
        function AssetDetail({ item, index, count, hasMore, canReveal, revision, pinned, isPinned, onTogglePin, onOpenPinned, onBack, onPrev, onNext, onSaved, t }) {
            const [tags, setTags] = useState(item.tags);
            const [note, setNote] = useState(item.note);
            const [draftTag, setDraftTag] = useState('');
            const [state, setState] = useState('idle');
            // 记"复制了哪一条"而不是一个布尔：相对路径和绝对路径各有一行，复制反馈要落在
            // 被点的那一行上。
            const [copiedPath, setCopiedPath] = useState(null);
            const [revealState, setRevealState] = useState('idle');
            const [media, setMedia] = useState({ width: null, height: null, duration: null });
            const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
            const stageRef = useRef(null);
            const dragRef = useRef(null);
            // 视频与音频各一个：切换资产时 React 会换 src，但同一个元素复用，省一次解码器起停。
            const videoRef = useRef(null);
            const audioRef = useRef(null);

            // 换资产（或重扫过）时重置编辑态、已探测的媒体尺寸与缩放。
            useEffect(() => {
                setTags(item.tags);
                setNote(item.note);
                setState('idle');
                setCopiedPath(null);
                setRevealState('idle');
                setMedia({ width: null, height: null, duration: null });
                setZoom({ scale: 1, x: 0, y: 0 });
            }, [item.relPath, revision]);

            // 键盘：Esc 返回，←/→ 前后翻，+/−/0 缩放。焦点在输入框/文本域里时全部
            // 让路 —— 否则在标签或备注里打字会瞬间被翻页劫持。
            useEffect(() => {
                const onKey = (event) => {
                    if (isEditableTarget(event.target)) return;
                    if (event.key === 'Escape') { event.preventDefault(); onBack(); }
                    else if (event.key === 'ArrowLeft') { event.preventDefault(); onPrev(); }
                    else if (event.key === 'ArrowRight') { event.preventDefault(); onNext(); }
                    else if (item.kind === 'image' && (event.key === '+' || event.key === '=')) {
                        event.preventDefault();
                        setZoom((previous) => ({ ...previous, scale: Math.min(ZOOM_MAX, previous.scale * 1.25) }));
                    } else if (item.kind === 'image' && event.key === '-') {
                        event.preventDefault();
                        setZoom((previous) => {
                            const scale = Math.max(1, previous.scale / 1.25);
                            return scale === 1 ? { scale: 1, x: 0, y: 0 } : { ...previous, scale };
                        });
                    } else if (item.kind === 'image' && event.key === '0') {
                        event.preventDefault();
                        setZoom({ scale: 1, x: 0, y: 0 });
                    } else if (item.kind !== 'image' && event.key === ' ') {
                        // 空格 = 播放/暂停。和原生 controls 的习惯一致，只是键我们自己接。
                        event.preventDefault();
                        const node = item.kind === 'video' ? videoRef.current : audioRef.current;
                        if (node === null) return;
                        if (node.paused === true) { const attempt = node.play(); if (typeof attempt?.catch === 'function') attempt.catch(() => {}); }
                        else node.pause();
                    }
                };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, [onBack, onPrev, onNext, item.kind]);

            // 滚轮缩放（以指针为锚点）。必须用非被动监听才能 preventDefault 掉页面滚动。
            useEffect(() => {
                if (item.kind !== 'image') return undefined;
                const node = stageRef.current;
                if (node === null || typeof node.addEventListener !== 'function') return undefined;
                const onWheel = (event) => {
                    const img = node.querySelector('img');
                    if (img === null) return;
                    event.preventDefault();
                    const factor = Math.exp(-event.deltaY * 0.0015);
                    setZoom((previous) => {
                        const scale = Math.min(ZOOM_MAX, Math.max(1, previous.scale * factor));
                        if (scale === previous.scale) return previous;
                        if (scale === 1) return { scale: 1, x: 0, y: 0 };
                        const rect = img.getBoundingClientRect();
                        const contentX = (event.clientX - rect.left + previous.x) / previous.scale;
                        const contentY = (event.clientY - rect.top + previous.y) / previous.scale;
                        return {
                            scale,
                            x: event.clientX - rect.left + previous.x - contentX * scale,
                            y: event.clientY - rect.top + previous.y - contentY * scale,
                        };
                    });
                };
                node.addEventListener('wheel', onWheel, { passive: false });
                return () => node.removeEventListener('wheel', onWheel);
            }, [item.kind]);

            const source = fileUrl(item.relPath, revision);
            // 放大原图也走持久化缓存：首次打开实时取并缓存，之后翻到 / 重开应用直接命中
            // （大原图按体积阈值不持久化，避免撑爆本地存储）。
            const [cachedSource, setCachedSource] = useState(null);
            const cachedUrlRef = useRef(null);
            useEffect(() => {
                if (item.kind !== 'image') { setCachedSource(null); return undefined; }
                let cancelled = false;
                const signature = mediaSignature(item);
                (async () => {
                    const cached = await cacheGetMedia(item.relPath, signature);
                    let url;
                    if (cached !== null) {
                        url = URL.createObjectURL(cached);
                    } else {
                        try {
                            const response = await fetch(fileUrl(item.relPath, revision), { credentials: 'same-origin' });
                            if (!response.ok) throw new Error(String(response.status));
                            const blob = await response.blob();
                            url = URL.createObjectURL(blob);
                            if (blob.size <= 8 * 1024 * 1024) await cachePutMedia(item.relPath, signature, blob);
                        } catch {
                            url = undefined;
                        }
                    }
                    if (cancelled || url === undefined) { if (url !== undefined) URL.revokeObjectURL(url); return; }
                    if (cachedUrlRef.current !== null) URL.revokeObjectURL(cachedUrlRef.current);
                    cachedUrlRef.current = url;
                    setCachedSource(url);
                })();
                return () => { cancelled = true; };
            }, [item.relPath, item.kind, revision, item.mtimeMs, item.size]);
            useEffect(() => () => {
                if (cachedUrlRef.current !== null) { URL.revokeObjectURL(cachedUrlRef.current); cachedUrlRef.current = null; }
            }, []);
            const save = async () => {
                setState('saving');
                try {
                    const payload = await api('/annotate', { method: 'POST', body: JSON.stringify({ relPath: item.relPath, tags, note }) });
                    setState('saved');
                    // 以宿主回写的标注为准（它可能会归一化或丢掉不合法的标签）。只把返回值
                    // 转给上层、本地编辑态不跟着收敛的话，界面会停在一个"没存进去"的值上，
                    // 而且"未保存的改动"会一直亮着。
                    const saved = payload?.item;
                    if (saved !== undefined && saved !== null) {
                        setTags(saved.tags ?? []);
                        setNote(saved.note ?? '');
                        onSaved(saved);
                    }
                } catch (error) {
                    setState(`error:${error.message}`);
                }
            };
            const addTag = () => {
                const value = draftTag.trim();
                if (value === '' || tags.includes(value)) { setDraftTag(''); return; }
                setTags([...tags, value]);
                setDraftTag('');
            };
            const copyPath = async (value) => {
                try {
                    await navigator.clipboard.writeText(value);
                    setCopiedPath(value);
                } catch {
                    setCopiedPath(null);
                }
            };
            const reveal = async () => {
                setRevealState('busy');
                try {
                    const payload = await api('/reveal', { method: 'POST', body: JSON.stringify({ relPath: item.relPath }) });
                    setRevealState(payload.ok === true ? 'done' : `error:${payload.error ?? t('revealFailed')}`);
                } catch (error) {
                    setRevealState(`error:${error.message}`);
                }
            };

            /** 缩放 anchor 换算：屏幕点 → 内容点 → 保持锚点不动的新位移。 */
            const zoomAround = (previous, scale, clientX, clientY) => {
                const img = stageRef.current?.querySelector?.('img');
                if (img === null || img === undefined) return { scale, x: 0, y: 0 };
                const rect = img.getBoundingClientRect();
                const contentX = (clientX - rect.left + previous.x) / previous.scale;
                const contentY = (clientY - rect.top + previous.y) / previous.scale;
                return {
                    scale,
                    x: clientX - rect.left + previous.x - contentX * scale,
                    y: clientY - rect.top + previous.y - contentY * scale,
                };
            };
            const onStageDoubleClick = (event) => {
                if (item.kind !== 'image') return;
                setZoom((previous) => (previous.scale > 1
                    ? { scale: 1, x: 0, y: 0 }
                    : zoomAround(previous, 2.5, event.clientX, event.clientY)));
            };
            const onStagePointerDown = (event) => {
                if (item.kind !== 'image' || zoom.scale <= 1 || event.button !== 0) return;
                event.preventDefault();
                dragRef.current = { startX: event.clientX, startY: event.clientY, baseX: zoom.x, baseY: zoom.y };
                if (typeof event.currentTarget.setPointerCapture === 'function') event.currentTarget.setPointerCapture(event.pointerId);
            };
            const onStagePointerMove = (event) => {
                const drag = dragRef.current;
                if (drag === null) return;
                setZoom((previous) => ({
                    ...previous,
                    x: drag.baseX + (event.clientX - drag.startX),
                    y: drag.baseY + (event.clientY - drag.startY),
                }));
            };
            const onStagePointerUp = (event) => {
                dragRef.current = null;
                if (typeof event.currentTarget.releasePointerCapture === 'function') event.currentTarget.releasePointerCapture(event.pointerId);
            };

            let stage;
            if (item.kind === 'image') {
                stage = h('img', {
                    src: cachedSource ?? source,
                    alt: item.name,
                    className: 'dal-zoomable',
                    style: {
                        transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
                        cursor: zoom.scale > 1 ? 'grab' : 'zoom-in',
                    },
                    onLoad: (event) => setMedia((previous) => ({ ...previous, width: event.target.naturalWidth, height: event.target.naturalHeight })),
                    onDoubleClick: onStageDoubleClick,
                    onPointerDown: onStagePointerDown,
                    onPointerMove: onStagePointerMove,
                    onPointerUp: onStagePointerUp,
                });
            } else if (item.kind === 'video') {
                // 不加 `controls`：播放条由下面的 MediaPlayer 自绘（见那里的理由）。
                // 点画面本身 = 播放/暂停，这是所有播放器都有的预期，不需要额外控件。
                stage = h('video', {
                    ref: videoRef,
                    src: source,
                    preload: 'metadata',
                    onClick: () => {
                        const node = videoRef.current;
                        if (node === null) return;
                        if (node.paused === true) { const attempt = node.play(); if (typeof attempt?.catch === 'function') attempt.catch(() => {}); }
                        else node.pause();
                    },
                    onLoadedMetadata: (event) => {
                        setMedia({
                            width: event.target.videoWidth,
                            height: event.target.videoHeight,
                            duration: event.target.duration,
                        });
                        // 顺手把时长写进浏览器侧缓存：回到网格时卡片直接有徽标，
                        // 不用再为一个数字重新请求一次元数据。
                        const value = humanDuration(event.target.duration);
                        if (value !== null) writeDuration(item, value);
                    },
                });
            } else {
                stage = h('div', { className: 'dal-stage-audio' },
                    h('span', { className: 'dal-note' }, '♪'),
                    h('audio', {
                        ref: audioRef,
                        src: source,
                        preload: 'metadata',
                        onLoadedMetadata: (event) => {
                            setMedia((previous) => ({ ...previous, duration: event.target.duration }));
                            const value = humanDuration(event.target.duration);
                            if (value !== null) writeDuration(item, value);
                        },
                        // 不加 controls 的 `<audio>` 由浏览器 UA 样式表自行隐藏（不占位、不可见），
                        // 但仍会正常解码元数据 —— 播放条要拿时长、点播放要能出声。
                        // 刻意**不写** display:none：那种写法在部分浏览器里会连带跳过元数据解码，
                        // 表现是播放条永远停在 0:00。
                    }));
            }
            // 播放条只给音视频：图片有自己的缩放/双击，没有"时间"可言。
            const player = item.kind === 'image' ? null
                : h(MediaPlayer, { target: item.kind === 'video' ? videoRef : audioRef, t });

            // 详情里的尺寸以浏览器实测为准（覆盖 AVIF 等宿主没探测的格式）。
            const resolvedWidth = Number.isFinite(media.width) ? media.width : item.width;
            const resolvedHeight = Number.isFinite(media.height) ? media.height : item.height;
            const resolution = Number.isFinite(resolvedWidth) && Number.isFinite(resolvedHeight) && resolvedWidth > 0
                ? `${resolvedWidth} × ${resolvedHeight}${resolvedHeight > resolvedWidth ? ` · ${t('orientationPortrait')}` : resolvedWidth > resolvedHeight ? ` · ${t('orientationLandscape')}` : ''}`
                : null;
            const duration = humanDuration(media.duration);
            // 标注是"改完再保存"的：标签与备注都只在本地，所以必须让"有没有没保存的改动"
            // 看得见 —— 否则加完标签直接翻页，改动就悄悄丢了。
            const dirty = tags.join('\u0000') !== (item.tags ?? []).join('\u0000') || note !== (item.note ?? '');
            const saveStatus = state === 'saving' ? t('saving')
                : state === 'saved' && !dirty ? t('saved')
                    : dirty ? t('unsaved') : '';
            /** 一条路径 = 一个复制按钮：点整行就复制，右侧图标既是提示也是反馈。 */
            const pathRow = (key, value, copyTitle) => [
                h('span', { className: 'dal-k', key: `${key}-k` }, key),
                h('button', {
                    type: 'button',
                    key: `${key}-v`,
                    className: 'dal-copyrow dal-v dal-pathv',
                    'data-done': String(copiedPath === value),
                    title: copiedPath === value ? t('copied') : copyTitle,
                    onClick: () => void copyPath(value),
                },
                    h('span', null, value),
                    h('span', { className: 'dal-copyicon' }, icon(copiedPath === value ? 'check' : 'copy', 13))),
            ];

            return h('div', { className: 'dal-detail' },
                // 表头复用网格表头的排版（.dal-head / .dal-bar / .dal-h1）：同样的内边距、
                // 同样的下边发丝线、同样的 15px 标题对 12px 工具。
                h('div', { className: 'dal-head' },
                    h('div', { className: 'dal-bar' },
                        h('button', { type: 'button', className: 'dal-iconbtn', onClick: onBack, title: `${t('back')} · Esc` }, icon('arrowLeft', 16)),
                        h('span', { className: 'dal-h1 dal-detail-name', title: item.relPath }, item.name),
                        // 详情工具同样只保留一种语言：无边框图标按钮，语义靠 title。
                        h('div', { className: 'dal-tools' },
                            h('button', { type: 'button', className: 'dal-iconbtn', onClick: onPrev, disabled: index <= 0, title: t('prev') }, icon('arrowLeft', 16)),
                            h('span', { className: 'dal-count' }, t('position').replace('{i}', String(index + 1)).replace('{n}', `${count}${hasMore ? '+' : ''}`)),
                            h('button', { type: 'button', className: 'dal-iconbtn', onClick: onNext, disabled: index >= count - 1, title: t('next') }, icon('arrowRight', 16)),
                            item.kind === 'image'
                                ? h('button', {
                                    type: 'button',
                                    className: 'dal-iconbtn',
                                    onClick: () => setZoom({ scale: 1, x: 0, y: 0 }),
                                    disabled: zoom.scale === 1,
                                    title: t('resetZoom'),
                                }, icon('zoom', 16))
                                : null,
                            // 参照图钉：把当前资产钉住，浏览别的素材时它悬在角落方便对比。
                            h('button', {
                                type: 'button',
                                className: 'dal-iconbtn',
                                'data-on': String(isPinned === true),
                                onClick: onTogglePin,
                                title: isPinned === true ? t('unpin') : t('pin'),
                            }, icon('pin', 16))))),
                h('div', { className: 'dal-detail-body' },
                    // 媒体列 = 画面 + 播放条。播放条在画面**下面**而不是浮在上面：
                    // 浮层会盖住画面下缘（竖构图的脚、字幕都在那儿），也省掉一层显隐逻辑。
                    h('div', { className: 'dal-media' },
                        // 音频不进 .dal-stage：那个盒子是给"有画面的东西"用的，音频套进去
                        // 就是一整块空灰底。所以直接把它当媒体列的第一个孩子。
                        item.kind === 'audio'
                            ? stage
                            : h('div', { className: 'dal-stage', ref: stageRef },
                                stage,
                                pinned !== null && pinned.relPath !== item.relPath
                                    ? h('div', { className: 'dal-ref', onClick: onOpenPinned, title: pinned.relPath },
                                        h('img', { src: fileUrl(pinned.relPath, revision), alt: pinned.name }),
                                        h('span', { className: 'dal-ref-label' }, t('pinnedRef')))
                                    : null),
                        player === null ? null : h('div', { className: 'dal-playerbar' }, player)),
                    // 信息列只有一个网格：**键列宽度由最长的键统一决定**，分隔线是整行网格项。
                    // 于是"大小"和"相对路径"下面的值都从同一条竖线开始，一块一块也能读出来。
                    h('div', { className: 'dal-info' },
                        h('div', { className: 'dal-kv' },
                            h('span', { className: 'dal-k' }, t('type')),
                            h('span', { className: 'dal-v' }, `${t(item.kind)} · ${item.ext.replace(/^\./u, '').toUpperCase()}`),
                            h('span', { className: 'dal-k' }, t('size')),
                            h('span', { className: 'dal-v' }, humanSize(item.size)),
                            h('span', { className: 'dal-k' }, t('modified')),
                            h('span', { className: 'dal-v' }, humanTime(item.mtimeMs)),
                            resolution !== null ? h('span', { className: 'dal-k' }, t('dimensions')) : null,
                            resolution !== null ? h('span', { className: 'dal-v' }, resolution) : null,
                            duration !== null ? h('span', { className: 'dal-k' }, t('duration')) : null,
                            duration !== null ? h('span', { className: 'dal-v' }, duration) : null,
                            h('div', { className: 'dal-sep', style: { gridColumn: '1 / -1' } }),
                            pathRow(t('relPath'), item.relPath, t('copyRelPath')),
                            pathRow(t('absPath'), item.absolutePath, t('copyAbsPath')),
                            h('div', { className: 'dal-chips', style: { gridColumn: '1 / -1' } },
                                // 宿主没声明 reveal 能力时不渲染这个按钮（旧宿主重启前就是这种状态）。
                                canReveal === true
                                    ? h('button', { type: 'button', className: 'dal-chip', onClick: reveal, disabled: revealState === 'busy' },
                                        icon('folderOpen', 13),
                                        revealState === 'busy' ? t('revealing') : t('reveal'))
                                    : null,
                                h('a', { className: 'dal-chip', href: source, target: '_blank', rel: 'noreferrer' }, icon('external', 13), t('openTab')))),
                        typeof revealState === 'string' && revealState.startsWith('error:')
                            ? h('div', { className: 'dal-error' }, revealState.slice(6))
                            : null,
                        h('div', { className: 'dal-sep' }),
                        h('div', { className: 'dal-field' },
                            h('span', { className: 'dal-label' }, t('tags')),
                            h('div', { className: 'dal-chips' },
                                tags.map((tag) => h('button', {
                                    type: 'button',
                                    className: 'dal-chip',
                                    key: tag,
                                    title: t('removeTag'),
                                    onClick: () => setTags(tags.filter((value) => value !== tag)),
                                }, tag, h('span', { className: 'dal-chip-x' }, '×'))),
                                h('input', {
                                    className: 'dal-input',
                                    style: { flex: '0 0 150px', minWidth: 110 },
                                    value: draftTag,
                                    placeholder: t('tagPlaceholder'),
                                    onChange: (event) => setDraftTag(event.target.value),
                                    onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); addTag(); } },
                                }))),
                        h('div', { className: 'dal-field' },
                            h('span', { className: 'dal-label' }, t('note')),
                            h('textarea', {
                                className: 'dal-textarea',
                                rows: 4,
                                value: note,
                                placeholder: t('notePlaceholder'),
                                onChange: (event) => setNote(event.target.value),
                            })),
                        h('div', { className: 'dal-save' },
                            saveStatus === '' ? null : h('span', { className: 'dal-dim' }, saveStatus),
                            h('button', { type: 'button', className: 'dal-btn dal-btn-primary', disabled: state === 'saving', onClick: save },
                                state === 'saving' ? t('saving') : t('save'))),
                        typeof state === 'string' && state.startsWith('error:')
                            ? h('div', { className: 'dal-error' }, `${t('error')}: ${state.slice(6)}`)
                            : null)));
        }

        /** 面板主体：网格视图与放大卡片视图二选一。 */
        function Panel(props) {
            // 宿主如果通过注册项的 `inject` 递了翻译函数就用它；否则退回按页面语言
            // 二选一的本地字典。两者都不依赖任何 Client 包。
            const t = typeof props?.t === 'function' ? props.t : fallbackT();
            const prefs = useMemo(() => readPrefs(), []);
            const [status, setStatus] = useState(null);
            const [items, setItems] = useState([]);
            const [total, setTotal] = useState(0);
            const [hasMore, setHasMore] = useState(false);
            const [kind, setKind] = useState(prefs.kind);
            const [sort, setSort] = useState(typeof prefs.sort === 'string' ? prefs.sort : 'name');
            const [order, setOrder] = useState(prefs.order === 'asc' || prefs.order === 'desc' ? prefs.order : '');
            const [dir, setDir] = useState('');
            // 标签筛选与子目录一样属于"跟着当前项目走"的筛选，不进 localStorage ——
            // 换个项目还残留上个项目的标签只会得到一屏空结果。
            const [tag, setTag] = useState('');
            const [query, setQuery] = useState('');
            const [debounced, setDebounced] = useState('');
            const [loading, setLoading] = useState(true);
            const [error, setError] = useState(null);
            const [busy, setBusy] = useState(false);
            const [selected, setSelected] = useState(null);
            // 参照图钉：跨视图保留，浏览别的素材时角落里始终有一张可对比的图。
            const [pinned, setPinned] = useState(null);
            // 重新扫描计数：宿主不缓存，但已挂载的媒体元素不会自己失效，所以重扫后
            // 用这个计数换掉媒体 URL，强制真的重新取一次。
            const [revision, setRevision] = useState(0);
            const [rootDraft, setRootDraft] = useState('');
            const rootTouched = useRef(false);
            const searchRef = useRef(null);
            const anchorRef = useRef(-1);
            const requestId = useRef(0);
            const [gridCursor, setGridCursor] = useState(-1);
            const [selectedPaths, setSelectedPaths] = useState(() => new Set());
            const [batchTag, setBatchTag] = useState('');
            const [batchBusy, setBatchBusy] = useState(false);
            // 缩略图填充方式。属于"看图方式"而不是筛选，所以进 localStorage（跟排序一样），
            // 不进合集 —— 竖图多的项目开一次就不用再开。
            const [fit, setFit] = useState(prefs.fit === 'contain' ? 'contain' : 'cover');
            const [batchMsg, setBatchMsg] = useState('');
            const [collections, setCollections] = useState(() => readCollections());
            const [filterName, setFilterName] = useState('');

            useEffect(() => {
                const timer = setTimeout(() => setDebounced(query), 220);
                return () => clearTimeout(timer);
            }, [query]);

            useEffect(() => { writePrefs({ kind, sort, order }); }, [kind, sort, order]);
            useEffect(() => { writePrefs({ fit }); }, [fit]);

            /** 列表请求：只拉数据。状态栏由 refreshStatus 单独管，筛选/翻页因此只有一个请求。 */
            const load = useCallback(async (offset) => {
                const token = requestId.current + 1;
                requestId.current = token;
                setLoading(true);
                setError(null);
                try {
                    const params = new URLSearchParams({ sort, limit: String(PAGE_SIZE), offset: String(offset) });
                    if (kind !== undefined) params.set('kind', kind);
                    if (dir !== '') params.set('dir', dir);
                    if (tag !== '') params.set('tag', tag);
                    if (order !== '') params.set('order', order);
                    if (debounced.trim() !== '') params.set('q', debounced.trim());
                    const payload = await api(`/assets?${params.toString()}`);
                    if (requestId.current !== token) return;
                    setItems((previous) => (offset === 0 ? payload.items : [...previous, ...payload.items]));
                    setTotal(payload.total);
                    setHasMore(payload.hasMore);
                } catch (failure) {
                    if (requestId.current === token) setError(failure.message);
                } finally {
                    if (requestId.current === token) setLoading(false);
                }
            }, [kind, dir, tag, order, debounced, sort, requestId]);

            /** 状态栏（根目录、计数、facets、能力）：挂载时一次，换项目/重扫/保存后随事件刷新。 */
            const refreshStatus = useCallback(async () => {
                try {
                    setStatus(await api('/status'));
                } catch {
                    // 列表已经能用；状态刷新失败不值得一张错误横幅。
                }
            }, []);

            useEffect(() => { void load(0); }, [kind, dir, tag, order, debounced, sort]);
            useEffect(() => { void refreshStatus(); }, [refreshStatus]);

            // 输入框没被用户碰过时，跟随状态里解析出的项目根。
            useEffect(() => {
                if (!rootTouched.current && status !== null && rootDraft === '') setRootDraft(status.projectRoot ?? '');
            }, [status, rootDraft]);

            // 选中的批量集合随列表收敛：被删/被筛掉的路径自动移出选择。
            useEffect(() => {
                setSelectedPaths((previous) => {
                    if (previous.size === 0) return previous;
                    const known = new Set(items.map((item) => item.relPath));
                    const next = new Set([...previous].filter((value) => known.has(value)));
                    return next.size === previous.size ? previous : next;
                });
            }, [items]);

            // 网格键盘导航：/ 聚焦搜索，←/→/j/k 移动光标，Enter 打开，Esc 清除。
            useEffect(() => {
                if (selected !== null) return undefined;
                const onKey = (event) => {
                    if (isEditableTarget(event.target)) return;
                    if (event.key === '/') {
                        event.preventDefault();
                        if (searchRef.current !== null && typeof searchRef.current.focus === 'function') searchRef.current.focus();
                        return;
                    }
                    if (event.key === 'ArrowRight' || event.key === 'j') {
                        event.preventDefault();
                        setGridCursor((previous) => Math.min(items.length - 1, (previous === -1 ? -1 : previous) + 1));
                    } else if (event.key === 'ArrowLeft' || event.key === 'k') {
                        event.preventDefault();
                        setGridCursor((previous) => Math.max(-1, (previous === -1 ? 0 : previous) - 1));
                    } else if (event.key === 'Enter' && gridCursor >= 0 && items[gridCursor] !== undefined) {
                        event.preventDefault();
                        anchorRef.current = gridCursor;
                        setSelected(items[gridCursor]);
                    } else if ((event.key === 'x' || event.key === 'X') && gridCursor >= 0 && items[gridCursor] !== undefined) {
                        // 键盘等价于点那张卡片右上角的勾选框（Ctrl+点击 的第三种入口）。
                        event.preventDefault();
                        toggleSelect(items[gridCursor]);
                    } else if (event.key === 'Escape' && gridCursor !== -1) {
                        setGridCursor(-1);
                    }
                };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, [items, gridCursor, selected]);

            useEffect(() => {
                if (gridCursor < 0) return;
                const node = typeof document !== 'undefined' && typeof document.querySelector === 'function'
                    ? document.querySelector('.dal-cursor')
                    : null;
                if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
            }, [gridCursor]);

            // 详情打开时预取相邻图片：←/→ 翻页立刻出图（浏览器已解码 + 系统缓存已热）。
            useEffect(() => {
                if (selected === null || typeof Image !== 'function') return undefined;
                const index = items.findIndex((item) => item.relPath === selected.relPath);
                for (const neighbor of [items[index - 1], items[index + 1]]) {
                    if (neighbor !== undefined && neighbor.kind === 'image') {
                        const img = new Image();
                        img.src = fileUrl(neighbor.relPath, revision);
                    }
                }
                return undefined;
            }, [selected, items, revision]);

            const activeFilter = kind !== undefined || dir !== '' || tag !== '' || debounced.trim() !== '';
            // 空状态用的"是不是被筛掉了"：比 activeFilter 多看一眼前**未防抖**的 query。
            // 否则刚打完字的那 220ms 里，列表还没更新、query 却已经在框里了 ——
            // 这时如果恰好是空列表，会显示"这个目录里没有素材"，把人引到完全错误的方向上。
            const filtering = activeFilter || query.trim() !== '';

            const applyRoot = async (value) => {
                setBusy(true);
                setError(null);
                try {
                    const next = await api('/root', { method: 'POST', body: JSON.stringify({ root: value }) });
                    setStatus(next);
                    setRootDraft(next.projectRoot ?? '');
                    rootTouched.current = false;
                    setDir('');
                    setTag('');
                    setSelected(null);
                    setSelectedPaths(new Set());
                    setGridCursor(-1);
                    setPinned(null);
                    setRevision((previous) => previous + 1);
                    await load(0);
                } catch (failure) {
                    setError(failure.message);
                } finally {
                    setBusy(false);
                }
            };

            const rescan = async () => {
                setBusy(true);
                setError(null);
                try {
                    const next = await api('/rescan', { method: 'POST' });
                    setStatus(next);
                    setRevision((previous) => previous + 1);
                    await load(0);
                } catch (failure) {
                    setError(failure.message);
                } finally {
                    setBusy(false);
                }
            };

            /**
             * 目录 chips 渐进收窄：顶层显示一级目录；进入某目录后显示它的直接
             * 子目录（并给一个"上一级"），避免全平铺出 "a/b/c/d" 这种超长 chip。
             */
            const folders = useMemo(() => {
                const seen = new Map();
                if (dir === '') {
                    for (const item of items) {
                        if (item.dir === '') continue;
                        const top = item.dir.split('/')[0];
                        seen.set(top, (seen.get(top) ?? 0) + 1);
                    }
                } else {
                    const prefix = `${dir}/`;
                    for (const item of items) {
                        if (!item.dir.startsWith(prefix)) continue;
                        const rest = item.dir.slice(prefix.length);
                        if (rest === '') continue;
                        const next = `${dir}/${rest.split('/')[0]}`;
                        seen.set(next, (seen.get(next) ?? 0) + 1);
                    }
                }
                return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
            }, [items, dir]);

            /**
             * 选中/取消一个。Ctrl+点击、卡片右上角的勾选框、键盘 X 都走这一条路径 ——
             * 同一件事只有一种实现，改动时不会漏掉某个入口。
             */
            const toggleSelect = (item) => {
                anchorRef.current = items.findIndex((value) => value.relPath === item.relPath);
                setSelectedPaths((previous) => {
                    const next = new Set(previous);
                    if (next.has(item.relPath)) next.delete(item.relPath);
                    else next.add(item.relPath);
                    return next;
                });
            };

            /** 点卡片：普通点击进入放大卡片；Ctrl/Shift 点击做批量选择。 */
            const onCardClick = (item, event) => {
                const index = items.findIndex((value) => value.relPath === item.relPath);
                if (event !== undefined && event !== null && (event.ctrlKey === true || event.metaKey === true)) {
                    toggleSelect(item);
                    return;
                }
                if (event !== undefined && event !== null && event.shiftKey === true) {
                    const anchor = anchorRef.current === -1 ? index : anchorRef.current;
                    const from = Math.min(anchor, index);
                    const to = Math.max(anchor, index);
                    setSelectedPaths((previous) => {
                        const next = new Set(previous);
                        for (let position = from; position <= to; position += 1) {
                            if (items[position] !== undefined) next.add(items[position].relPath);
                        }
                        return next;
                    });
                    return;
                }
                anchorRef.current = index;
                setGridCursor(-1);
                setSelected(item);
            };

            const batchApply = async (mode) => {
                const value = batchTag.trim();
                if (value === '' || selectedPaths.size === 0) return;
                setBatchBusy(true);
                setBatchMsg('');
                try {
                    const tags = value.split(/[,，]/u).map((part) => part.trim()).filter((part) => part !== '');
                    const body = { relPaths: [...selectedPaths].slice(0, BATCH_MAX) };
                    if (mode === 'add') body.tagsAdd = tags;
                    else body.tagsRemove = tags;
                    const payload = await api('/annotate', { method: 'POST', body: JSON.stringify(body) });
                    setBatchMsg(t('batchResult').replace('{u}', String(payload.updated ?? 0)).replace('{s}', String(payload.skipped ?? 0)));
                    setSelectedPaths(new Set());
                    setBatchTag('');
                    await load(0);
                    void refreshStatus();
                } catch (failure) {
                    setError(failure.message);
                } finally {
                    setBatchBusy(false);
                }
            };

            /**
             * 把选中项的**相对路径**一次性写进剪贴板，一行一个。
             *
             * 这是批量操作里最常用的一件事：选十几张参考图 → 粘进剪辑软件/脚本/issue。
             * 原来只能一个一个进详情页复制。
             *
             * 用相对路径而不是绝对路径：绝对路径一长串盘符粘到别处就废了，相对路径
             * 配着项目根才能用，而项目根在面板顶部就写着。绝对路径在详情页仍然可以逐条复制。
             *
             * 顺序按**网格当前顺序**（`items` 的顺序）而不是点选的先后 —— 粘进时间线时
             * 这个顺序才是能用的顺序。
             */
            const copySelectedPaths = async () => {
                if (selectedPaths.size === 0) return;
                const ordered = items.filter((item) => selectedPaths.has(item.relPath)).map((item) => item.relPath);
                if (ordered.length === 0) return;
                setBatchBusy(true);
                try {
                    await navigator.clipboard.writeText(ordered.join('\n'));
                    setBatchMsg(t('copiedPaths').replace('{n}', String(ordered.length)));
                } catch {
                    setBatchMsg(t('revealFailed'));
                } finally {
                    setBatchBusy(false);
                }
            };

            /** 一键清掉全部筛选。搜索无结果时挨个去点 chip 关掉，太费事。 */
            const clearFilters = () => {
                setKind(undefined);
                setDir('');
                setTag('');
                setQuery('');
                setDebounced('');
                setGridCursor(-1);
                setSelectedPaths(new Set());
            };

            const persistCollections = (next) => {
                setCollections(next);
                writeCollections(next);
            };
            const saveCollection = () => {
                const name = filterName.trim();
                if (name === '') return;
                const entry = {
                    id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                    name,
                    root: status?.projectRoot ?? '',
                    filter: { kind: kind ?? '', dir, tag, q: debounced.trim() },
                };
                persistCollections([entry, ...collections.filter((value) => !(value.name === name && value.root === entry.root))].slice(0, 30));
                setFilterName('');
            };
            const applyCollection = async (entry) => {
                const filter = entry.filter ?? {};
                setKind(filter.kind === '' || filter.kind === undefined ? undefined : filter.kind);
                setDir(filter.dir ?? '');
                setTag(filter.tag ?? '');
                setQuery(filter.q ?? '');
                setGridCursor(-1);
                setSelectedPaths(new Set());
                if (typeof entry.root === 'string' && entry.root !== '' && entry.root !== status?.projectRoot) {
                    await applyRoot(entry.root);
                }
            };

            // 放大卡片视图：占满面板正文，不叠加任何浮层。
            if (selected !== null) {
                const index = Math.max(0, items.findIndex((item) => item.relPath === selected.relPath));
                const step = (delta) => {
                    const next = items[index + delta];
                    if (next !== undefined) setSelected(next);
                };
                return h('div', { className: 'dal-root' },
                    h('style', null, CSS),
                    h(AssetDetail, {
                        item: selected,
                        index,
                        count: items.length,
                        hasMore,
                        // 能力协商：老宿主的 /status 不带 capabilities，按钮就不出现。
                        canReveal: Array.isArray(status?.capabilities) && status.capabilities.includes('reveal'),
                        revision,
                        pinned,
                        isPinned: pinned !== null && pinned.relPath === selected.relPath,
                        onTogglePin: () => setPinned((previous) => (previous !== null && previous.relPath === selected.relPath ? null : selected)),
                        onOpenPinned: () => setSelected(pinned === null ? null : pinned),
                        t,
                        onBack: () => setSelected(null),
                        onPrev: () => step(-1),
                        onNext: () => step(1),
                        onSaved: (updated) => {
                            setItems((previous) => previous.map((value) => (value.relPath === updated.relPath ? updated : value)));
                            setSelected(updated);
                            // 标签可能变了，facets 要跟上。
                            void refreshStatus();
                        },
                    }));
            }

            const chips = [
                { id: undefined, label: t('all'), count: status?.counts?.total },
                { id: 'image', label: t('image'), count: status?.counts?.image },
                { id: 'video', label: t('video'), count: status?.counts?.video },
                { id: 'audio', label: t('audio'), count: status?.counts?.audio },
            ];

            const countLabel = activeFilter
                ? t('matched').replace('{m}', String(total)).replace('{n}', String(status?.counts?.total ?? 0))
                : t('total').replace('{n}', String(status?.counts?.total ?? 0));
            const currentRoot = typeof status?.projectRoot === 'string' ? status.projectRoot : '';
            // 当前根不重复列进"最近"——菜单顶部已经有一行专门显示它。
            const recentProjects = Array.isArray(status?.recentProjects)
                ? status.recentProjects.filter((project) => project !== currentRoot)
                : [];
            const sortOptions = [
                { id: 'name', label: t('sortName') },
                { id: 'mtime', label: t('sortMtime') },
                { id: 'size', label: t('sortSize') },
            ];
            const sortLabel = (sortOptions.find((option) => option.id === sort) ?? sortOptions[0]).label;
            const orderIcon = order === 'asc' ? 'arrowUp' : order === 'desc' ? 'arrowDown' : 'arrowBoth';
            const orderTitle = order === 'asc' ? t('sortAsc') : order === 'desc' ? t('sortDesc') : `${t('sortAsc')} / ${t('sortDesc')}`;
            const projectName = baseName(currentRoot);
            const hasFolders = folders.length > 0 || dir !== '';
            const hasTags = Array.isArray(status?.tagFacets) && status.tagFacets.length > 0;
            const hasCollections = collections.length > 0 || activeFilter;

            return h('div', { className: 'dal-root' },
                h('style', null, CSS),
                h('div', { className: 'dal-head' },
                    // 第一行：标题 + 计数，右侧收拢全部"面板级"操作。
                    // 只保留一种控件语言（无边框按钮 + 描边图标），不再堆一排描边按钮。
                    h('div', { className: 'dal-bar' },
                        h('div', { className: 'dal-title' },
                            t('title'),
                            h('span', { className: 'dal-count' }, countLabel)),
                        h('div', { className: 'dal-tools' },
                            // 项目切换：触发器显示当前项目名，菜单里装"当前扫描目录 + 最近项目 + 手动输入"。
                            h(Dropdown, {
                                className: 'dal-project',
                                title: currentRoot === '' ? t('project') : currentRoot,
                                width: 320,
                                // 触发器上只放"项目名"这一件事。`（自动使用 assets 子目录）` 这类
                                // 说明留在菜单里 —— 它每次都占一行宽度，却没有每次都要读的信息量。
                                label: h('span', { className: 'dal-project' },
                                    icon('folder', 14, 'dal-caret'),
                                    h('span', { className: 'dal-projectname' }, projectName === '' ? t('project') : projectName)),
                            }, (close) => [
                                h('div', { className: 'dal-ddhead', key: 'head' },
                                    h('div', { className: 'dal-ddk' }, t('assetsRoot')),
                                    h('div', { className: 'dal-ddv' }, status?.assetsRoot ?? '—'),
                                    status?.conventional ? h('div', { className: 'dal-ddk' }, t('conventional')) : null),
                                recentProjects.length > 0
                                    ? h('div', { key: 'recent' },
                                        h('div', { className: 'dal-ddl' }, t('recent')),
                                        recentProjects.slice(0, 8).map((project) => h('button', {
                                            type: 'button',
                                            className: 'dal-dditem',
                                            key: project,
                                            title: project,
                                            onClick: () => { close(); void applyRoot(project); },
                                        },
                                            h('span', { className: 'dal-dditemname' }, baseName(project)),
                                            h('span', { className: 'dal-dditempath' }, parentPath(project)))))
                                    : null,
                                h('div', { className: 'dal-ddsep', key: 'sep' }),
                                h('div', { className: 'dal-ddinput dal-row', key: 'input', style: { gap: 6, flexWrap: 'nowrap' } },
                                    h('input', {
                                        className: 'dal-input',
                                        style: { minWidth: 0 },
                                        value: rootDraft,
                                        placeholder: t('inputPath'),
                                        onChange: (event) => { rootTouched.current = true; setRootDraft(event.target.value); },
                                        onKeyDown: (event) => {
                                            if (event.key !== 'Enter') return;
                                            event.preventDefault();
                                            close();
                                            void applyRoot(rootDraft);
                                        },
                                    }),
                                    h('button', {
                                        type: 'button',
                                        className: 'dal-btn dal-btn-primary',
                                        disabled: busy,
                                        onClick: () => { close(); void applyRoot(rootDraft); },
                                    }, t('apply')),
                                    h('button', {
                                        type: 'button',
                                        className: 'dal-btn',
                                        disabled: busy,
                                        onClick: () => { close(); void applyRoot(''); },
                                    }, t('useSession'))),
                            ]),
                            h('label', { className: 'dal-search' },
                                icon('search', 14),
                                h('input', {
                                    ref: searchRef,
                                    value: query,
                                    placeholder: t('search'),
                                    onChange: (event) => setQuery(event.target.value),
                                })),
                            h(Dropdown, { title: sortLabel, label: sortLabel }, (close) => sortOptions.map((option) => h('button', {
                                type: 'button',
                                className: 'dal-dditem',
                                key: option.id,
                                'data-on': String(sort === option.id),
                                onClick: () => { close(); setSort(option.id); },
                            }, h('span', { className: 'dal-dditemname' }, option.label)))),
                            h('button', {
                                type: 'button',
                                className: 'dal-iconbtn',
                                title: orderTitle,
                                'data-on': String(order !== ''),
                                onClick: () => setOrder(order === '' ? 'asc' : order === 'asc' ? 'desc' : ''),
                            }, icon(orderIcon, 16)),
                            // 缩略图填充方式：和排序/方向并排放 —— 三个都是"怎么看这一屏"，
                            // 不是"筛掉哪些"。默认 cover（网格整齐），竖图多的项目切 contain。
                            h('button', {
                                type: 'button',
                                className: 'dal-iconbtn',
                                title: fit === 'contain' ? t('fitCover') : t('fitContain'),
                                'data-on': String(fit === 'contain'),
                                onClick: () => setFit(fit === 'contain' ? 'cover' : 'contain'),
                            }, icon('fit', 16)),
                            h('button', {
                                type: 'button',
                                className: 'dal-iconbtn',
                                title: busy ? t('rescanning') : t('rescan'),
                                disabled: busy,
                                onClick: () => void rescan(),
                            }, icon('refresh', 16)))),
                    // 第二行：筛选。刻意不做折叠隐藏 —— 折叠会让"当前筛选状态"不可见，
                    // 那才是真正的不简洁。做法是把所有可选值压成同一套 chip，靠分隔线分组。
                    h('div', { className: 'dal-facet' },
                        h('div', { className: 'dal-tabs' },
                            chips.map((chip) => h('button', {
                                type: 'button',
                                className: 'dal-tab',
                                key: chip.label,
                                'data-on': String(kind === chip.id),
                                onClick: () => { setKind(chip.id); setSelected(null); setGridCursor(-1); },
                            }, chip.count === undefined ? chip.label : `${chip.label} ${chip.count}`))),
                        hasFolders ? h('span', { className: 'dal-vsep' }) : null,
                        hasFolders
                            ? h('div', { className: 'dal-chips' },
                                h('button', { type: 'button', className: 'dal-chip', 'data-on': String(dir === ''), onClick: () => setDir('') }, t('allFolders')),
                                dir !== ''
                                    ? h('button', {
                                        type: 'button',
                                        className: 'dal-chip',
                                        title: dir,
                                        onClick: () => setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''),
                                    }, icon('arrowUp', 13), t('parentDir'))
                                    : null,
                                dir !== '' ? h('span', { className: 'dal-sub', title: dir }, baseName(dir)) : null,
                                folders.slice(0, 24).map(([name, count]) => h('button', {
                                    type: 'button',
                                    className: 'dal-chip',
                                    key: name,
                                    'data-on': String(dir === name),
                                    title: name,
                                    onClick: () => setDir(dir === name ? '' : name),
                                }, `${name} ${count}`)))
                            : null,
                        // 标签：只有宿主的 /status 带了 tagFacets 才渲染（旧宿主重启前没有这个
                        // 字段，面板自动降级，不出现一个筛不出东西的控件）。`#tag n` 自带标识，
                        // 所以不再加"按标签筛选"这类说明文字。
                        hasTags ? h('span', { className: 'dal-vsep' }) : null,
                        hasTags
                            ? h('div', { className: 'dal-chips' },
                                status.tagFacets.slice(0, 16).map((facet) => h('button', {
                                    type: 'button',
                                    className: 'dal-chip',
                                    key: facet.tag,
                                    'data-on': String(tag === facet.tag),
                                    title: `${t('filterByTag')}: #${facet.tag}`,
                                    onClick: () => setTag(tag === facet.tag ? '' : facet.tag),
                                }, `#${facet.tag} ${facet.count}`)))
                            : null,
                        // 合集：命名的筛选组合。`★` 前缀把它与标签区分开。
                        hasCollections ? h('span', { className: 'dal-vsep' }) : null,
                        hasCollections
                            ? h('div', { className: 'dal-chips' },
                                collections.map((entry) => h('button', {
                                    type: 'button',
                                    className: 'dal-chip',
                                    key: entry.id,
                                    title: `${entry.name} — ${entry.root ?? ''}`,
                                    onClick: () => void applyCollection(entry),
                                },
                                    `★ ${entry.name}`,
                                    h('span', {
                                        className: 'dal-chip-x',
                                        title: t('deleteFilter'),
                                        onClick: (event) => {
                                            event.stopPropagation();
                                            persistCollections(collections.filter((value) => value.id !== entry.id));
                                        },
                                    }, '×'))),
                                activeFilter
                                    ? h('input', {
                                        className: 'dal-input',
                                        style: { flex: '0 0 150px', minWidth: 110 },
                                        value: filterName,
                                        placeholder: t('filterNamePlaceholder'),
                                        onChange: (event) => setFilterName(event.target.value),
                                        onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); saveCollection(); } },
                                    })
                                    : null,
                                activeFilter
                                    ? h('button', { type: 'button', className: 'dal-btn', disabled: filterName.trim() === '', onClick: saveCollection }, t('saveFilter'))
                                    : null)
                            : null),
                    error !== null ? h('div', { className: 'dal-error' }, `${t('error')}: ${error}`) : null),

                h('div', { className: 'dal-body' },
                    pinned !== null && selected === null
                        ? h('div', { className: 'dal-chips', style: { marginBottom: 8 } },
                            h('span', { className: 'dal-sub' }, t('pinnedRef')),
                            h('button', {
                                type: 'button',
                                className: 'dal-chip',
                                title: pinned.relPath,
                                onClick: () => setSelected(pinned),
                            },
                                icon('pin', 13),
                                pinned.name,
                                h('span', {
                                    className: 'dal-chip-x',
                                    title: t('unpin'),
                                    onClick: (event) => {
                                        event.stopPropagation();
                                        setPinned(null);
                                    },
                                }, '×')))
                        : null,
                    items.length === 0 && !loading
                        ? h('div', { className: 'dal-empty' },
                            // "这个目录真的没有素材"和"筛选把它们全滤掉了"是两回事：
                            // 前者让人去放文件，后者只需要一个"清除筛选"。用同一块空状态
                            // 装两种文案，但不给出那个唯一能解决问题的操作，就等于让人猜。
                            h('div', null, filtering ? t('noMatch') : t('empty')),
                            h('div', { className: 'dal-sub' }, filtering ? t('noMatchHint') : t('emptyHint')),
                            filtering
                                ? h('button', {
                                    type: 'button',
                                    className: 'dal-btn dal-empty-action',
                                    onClick: clearFilters,
                                }, icon('close', 13), t('clearFilters'))
                                : null)
                        // 有任意选中项时给网格挂 .dal-selecting：所有卡片的勾选框一起常显，
                        // 于是"再加一个"不用再按住 Ctrl 猜。
                        : h('div', {
                            className: `dal-grid${selectedPaths.size > 0 ? ' dal-selecting' : ''}`,
                            'data-fit': fit,
                            title: `${t('hint')} · ${t('batchHint')}`,
                        },
                            items.map((item, index) => h(AssetCard, {
                                key: item.relPath,
                                item,
                                t,
                                revision,
                                fit,
                                onOpen: onCardClick,
                                onToggleSelect: toggleSelect,
                                selected: selectedPaths.has(item.relPath),
                                cursor: gridCursor === index,
                            }))),
                    selectedPaths.size > 0 || batchMsg !== ''
                        ? h('div', { className: 'dal-batchbar' },
                            selectedPaths.size > 0 ? h('span', { className: 'dal-sub' }, t('selectedN').replace('{n}', String(selectedPaths.size))) : null,
                            selectedPaths.size > 0
                                ? h('button', { type: 'button', className: 'dal-chip', onClick: () => setSelectedPaths(new Set(items.map((item) => item.relPath))) }, t('selectAll'))
                                : null,
                            selectedPaths.size > 0
                                ? h('button', { type: 'button', className: 'dal-chip', onClick: () => setSelectedPaths(new Set()) }, t('clearSel'))
                                : null,
                            // 复制路径放在标签输入**之前**：它不需要填任何东西，点一下就走，
                            // 属于"看一眼结果"；打标签要先想词，节奏不同。
                            selectedPaths.size > 0
                                ? h('button', {
                                    type: 'button',
                                    className: 'dal-btn',
                                    disabled: batchBusy,
                                    onClick: () => void copySelectedPaths(),
                                    title: t('copyPaths').replace('{n}', String(selectedPaths.size)),
                                }, icon('copy', 13), t('copyPaths').replace('{n}', String(selectedPaths.size)))
                                : null,
                            h('span', { className: 'dal-vsep' }),
                            h('input', {
                                className: 'dal-input',
                                style: { flex: '0 0 140px', minWidth: 110 },
                                value: batchTag,
                                placeholder: t('batchTagPlaceholder'),
                                onChange: (event) => setBatchTag(event.target.value),
                                onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void batchApply('add'); } },
                            }),
                            h('button', { type: 'button', className: 'dal-btn dal-btn-primary', disabled: batchBusy || batchTag.trim() === '', onClick: () => void batchApply('add') }, t('batchAdd')),
                            h('button', { type: 'button', className: 'dal-btn', disabled: batchBusy || batchTag.trim() === '', onClick: () => void batchApply('remove') }, t('batchRemove')),
                            batchMsg !== '' ? h('span', { className: 'dal-sub' }, batchMsg) : null)
                        : null,
                    loading && items.length === 0 ? h('div', { className: 'dal-empty' }, t('loading')) : null,
                    // 操作提示不再常驻一行（那是纯噪音），改成网格的 title：悬停即见。
                    hasMore
                        ? h('div', { className: 'dal-chips', style: { justifyContent: 'center', padding: '12px 0' } },
                            h('button', { type: 'button', className: 'dal-chip', disabled: loading, onClick: () => void load(items.length) }, t('loadMore')))
                        : null,
                    status?.truncated ? h('div', { className: 'dal-sub', style: { paddingTop: 8 } }, t('truncated')) : null));
        }

        /** 本地翻译函数：按页面语言在 zh / en 之间二选一（拿不到宿主 translator 时的兜底）。 */
        function fallbackT() {
            const language = `${document.documentElement.lang || navigator.language || 'en'}`.toLowerCase();
            const dict = language.startsWith('zh') ? zh : en;
            return (key) => dict[key] ?? en[key] ?? key;
        }

        function apply(ctx) {
            ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'asset-library: dictionaries');
            const slots = ctx.slots;
            const t = ctx.locale.bind(NS);
            slots.inject('main', function* () {
                yield slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }) }, Panel);
            });
            slots.inject('sidebar.panellist', () => slots.register({
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 21,
                label: () => t('panel'),
                locale: NS,
            }, Icon));
        }

        return {
            name: 'asset-library-client',
            inject: ['slots', 'locale'],
            apply,
        };
    },
});
