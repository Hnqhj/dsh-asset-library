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
 *  - 图片在浏览器里降采样到 480px 长边，顺手取主色做加载占位；
 *  - 卡片 `content-visibility: auto`，视口外跳过布局与绘制；
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
        /** 一次批量标注允许的资产数（与 host 端上限一致）。 */
        const BATCH_MAX = 500;
        /** 缩放上限。 */
        const ZOOM_MAX = 12;

        const zh = {
            panel: '资产库',
            title: '资产库',
            subtitle: '项目文件夹里的图片、视频、音乐，点开就是一张大卡片。',
            project: '项目根目录',
            assetsRoot: '扫描目录',
            conventional: '（自动使用 assets 子目录）',
            rootPlaceholder: '粘贴项目文件夹的绝对路径，例如 G:\\工作\\短剧A',
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
            copy: '复制路径',
            copied: '已复制',
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
            batchTagPlaceholder: '输入标签',
            batchAdd: '加标签',
            batchRemove: '去标签',
            batchResult: '更新 {u} 项，跳过 {s} 项',
            batchHint: 'Ctrl+点击 多选，Shift+点击 范围选择',
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
            subtitle: 'Images, video and audio from a project folder — click one to enlarge it.',
            project: 'Project root',
            assetsRoot: 'Scanned folder',
            conventional: '(using its assets subfolder)',
            rootPlaceholder: 'Paste an absolute project folder path, e.g. G:\\work\\drama-a',
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
            copy: 'Copy path',
            copied: 'Copied',
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
            batchTagPlaceholder: 'Tag name',
            batchAdd: 'Add tag',
            batchRemove: 'Remove tag',
            batchResult: 'Updated {u}, skipped {s}',
            batchHint: 'Ctrl+click to multi-select, Shift+click for a range',
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

        function mediaSignature(item) {
            return `${item?.mtimeMs ?? 0}-${item?.size ?? 0}`;
        }

        function mediaCacheKey(relPath, signature) {
            return `media-v1://${signature}/${encodeURIComponent(relPath)}`;
        }

        async function openMediaCache() {
            if (typeof caches === 'undefined') return null;
            try {
                if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
                    navigator.storage.persist().catch(() => undefined);
                }
                return await caches.open(MEDIA_CACHE_NAME);
            } catch {
                return null;
            }
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
                const keys = await cache.keys();
                if (keys.length >= MEDIA_CACHE_MAX) {
                    for (const stale of keys.slice(0, Math.ceil(MEDIA_CACHE_MAX * 0.2))) {
                        await cache.delete(stale).catch(() => undefined);
                    }
                }
                await cache.put(
                    mediaCacheKey(relPath, signature),
                    new Response(blob, { headers: { 'content-type': blob.type || 'application/octet-stream' } }),
                );
            } catch {
                /* 配额超限：静默放弃持久化 */
            }
        }

        /** 视频时长的浏览器侧缓存：与封面用同一套签名，避免重开还要重新探测。 */
        const DURATION_KEY = 'dsh-asset-library.durations.v1';

        function readDuration(item) {
            const signature = mediaSignature(item);
            try {
                const map = JSON.parse(localStorage.getItem(DURATION_KEY) || '{}');
                return map[`${signature}|${item.relPath}`] ?? null;
            } catch {
                return null;
            }
        }

        function writeDuration(item, dur) {
            const signature = mediaSignature(item);
            try {
                const map = JSON.parse(localStorage.getItem(DURATION_KEY) || '{}');
                map[`${signature}|${item.relPath}`] = dur;
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
                (async () => {
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
                })();
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
                (async () => {
                    try {
                        const cached = await cacheGetMedia(item.relPath, signature);
                        if (cached !== null) {
                            const url = URL.createObjectURL(cached);
                            cacheSetThumb(`${revision}|${item.relPath}`, { url, color: null, duration: readDuration(item) });
                            if (!cancelled) setState({ poster: url, duration: readDuration(item), pending: false });
                            return;
                        }
                        const video = document.createElement('video');
                        video.muted = true;
                        video.preload = 'metadata';
                        video.src = fileUrl(item.relPath, revision);
                        await new Promise((resolve, reject) => {
                            video.onloadedmetadata = () => resolve();
                            video.onerror = () => reject(new Error('video'));
                        });
                        const dur = humanDuration(video.duration);
                        if (dur !== null) writeDuration(item, dur);
                        const seekTo = Math.min(Math.max(0, (video.duration || 0) * 0.1), Math.max(0, (video.duration || 1) - 0.05));
                        await new Promise((resolve) => {
                            video.onseeked = () => resolve();
                            try { video.currentTime = seekTo; } catch { resolve(); }
                        });
                        const canvas = document.createElement('canvas');
                        canvas.width = video.videoWidth || 320;
                        canvas.height = video.videoHeight || 180;
                        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                        const poster = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7));
                        video.removeAttribute('src');
                        video.load();
                        if (cancelled || poster === null) return;
                        const url = URL.createObjectURL(poster);
                        cacheSetThumb(`${revision}|${item.relPath}`, { url, color: null, duration: dur });
                        await cachePutMedia(item.relPath, signature, poster);
                        if (!cancelled) setState({ poster: url, duration: dur, pending: false });
                    } catch {
                        if (!cancelled) setState({ poster: null, duration: null, pending: false });
                    } finally {
                        if (!cancelled) setState((previous) => (previous.pending ? { ...previous, pending: false } : previous));
                    }
                })();
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
.dal-head{display:flex;flex-direction:column;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.dal-title{display:flex;align-items:baseline;gap:8px;font-size:15px;font-weight:600}
.dal-sub{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px}
.dal-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dal-path{color:var(--dsw-alias-label-secondary,#4a4f57);font-size:12px;word-break:break-all;flex:1;min-width:0}
.dal-input,.dal-select,.dal-textarea{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;border-radius:var(--dsw-radius-sm,6px);padding:5px 8px;font:inherit;outline:none}
.dal-input:focus,.dal-select:focus,.dal-textarea:focus{border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-input{flex:1;min-width:160px}
.dal-btn{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);border-radius:var(--dsw-radius-sm,6px);padding:5px 10px;font:inherit;cursor:pointer;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
.dal-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dal-btn:active{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.08))}
.dal-btn[disabled]{opacity:.5;cursor:default}
.dal-btn-primary{background:var(--dsw-alias-brand-primary,#1f6feb);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.dal-btn-primary:hover{background:var(--dsw-alias-brand-primary,#1f6feb);opacity:.9}
.dal-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.dal-chip{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#4a4f57);border-radius:999px;padding:3px 10px;cursor:pointer;font:inherit;line-height:18px}
.dal-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}
.dal-chip[data-on="true"]{background:var(--dsw-alias-bg-layer-2,rgba(31,111,235,.08));color:var(--dsw-alias-label-primary,#0f1115);border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-chip-x{opacity:.55;font-weight:400}
.dal-chip-x:hover{opacity:1}
.dal-body{flex:1;min-height:0;overflow:auto;padding:12px 16px}
.dal-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(152px,1fr));gap:12px;align-items:start}
.dal-card{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-alias-bg-layer-1,#fff);border-radius:var(--dsw-radius-md,8px);overflow:hidden;cursor:pointer;display:flex;flex-direction:column;padding:0;text-align:left;font:inherit;color:inherit;content-visibility:auto;contain-intrinsic-size:auto 180px}
.dal-card:hover{border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#1f6feb);outline-offset:1px}
.dal-cursor{outline:2px solid var(--dsw-alias-brand-primary,#1f6feb);outline-offset:1px}
.dal-selected{border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dal-thumb{position:relative;width:100%;aspect-ratio:4/3;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));display:flex;align-items:center;justify-content:center;overflow:hidden}
.dal-thumb img,.dal-thumb video{width:100%;height:100%;object-fit:cover;display:block}
.dal-fade{animation:dal-fadein .28s ease-out}
@keyframes dal-fadein{from{opacity:0}to{opacity:1}}
.dal-check{position:absolute;right:6px;top:6px;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-inverted,rgba(255,255,255,.7));background:var(--dsw-alias-bg-mask-photo,rgba(0,0,0,.4));display:none}
.dal-card:hover .dal-check,.dal-selected .dal-check{display:block}
.dal-check-on{background:var(--dsw-alias-brand-primary,#1f6feb);border-color:transparent}
.dal-check-on::after{content:'✓';color:#fff;font-size:12px;display:block;text-align:center;line-height:15px}
.dal-skeleton{width:100%;height:100%;background:linear-gradient(100deg,transparent 20%,var(--dsw-alias-bg-skeleton,rgba(0,0,0,.05)) 40%,transparent 60%);animation:dal-shimmer 1.2s linear infinite}
@keyframes dal-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.dal-skeleton{animation:none}.dal-fade{animation:none}}
.dal-badge{position:absolute;left:6px;top:6px;background:var(--dsw-alias-bg-mask-photo,rgba(0,0,0,.6));color:var(--dsw-alias-label-primary-inverted,#fff);border-radius:999px;padding:1px 7px;font-size:11px;line-height:16px}
.dal-badge-r{position:absolute;right:6px;bottom:6px;background:var(--dsw-alias-bg-mask-photo,rgba(0,0,0,.6));color:var(--dsw-alias-label-primary-inverted,#fff);border-radius:999px;padding:1px 7px;font-size:11px;line-height:16px}
.dal-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.4);font-size:26px;pointer-events:none}
.dal-meta{padding:6px 8px;display:flex;flex-direction:column;gap:2px;min-width:0}
.dal-name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dal-dim{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px}
.dal-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}
.dal-tag{border:1px solid transparent;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));border-radius:999px;padding:1px 6px;font-size:11px;color:var(--dsw-alias-label-secondary,#4a4f57)}
.dal-empty{display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;height:100%;color:var(--dsw-alias-label-tertiary,#81858c);text-align:center;padding:32px 16px}
.dal-error{border:1px solid var(--dsw-alias-state-error-primary,#d93025);color:var(--dsw-alias-state-error-primary,#d93025);border-radius:var(--dsw-radius-sm,6px);padding:6px 10px;font-size:12px}
.dal-batchbar{position:sticky;bottom:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;margin-top:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff)}
.dal-detail{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;padding:12px 16px}
.dal-detail-bar{display:flex;align-items:center;gap:8px;min-width:0}
.dal-count{color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;white-space:nowrap}
.dal-detail-name{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dal-detail-grid{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px}
@media (max-width:960px){.dal-detail-grid{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(200px,1fr) auto}}
.dal-stage{position:relative;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));border-radius:var(--dsw-radius-md,8px);display:flex;align-items:center;justify-content:center;overflow:hidden;min-height:220px;padding:8px}
.dal-ref{position:absolute;right:10px;bottom:10px;width:96px;border:1px solid var(--dsw-alias-brand-primary,#1f6feb);border-radius:6px;overflow:hidden;cursor:pointer;box-shadow:0 1px 6px rgba(0,0,0,.16)}
.dal-ref img{width:100%;height:72px;object-fit:cover;display:block}
.dal-ref-label{position:absolute;left:0;top:0;background:var(--dsw-alias-brand-primary,#1f6feb);color:#fff;font-size:10px;padding:0 5px;line-height:14px;border-radius:0 0 4px 0}
.dal-stage img,.dal-stage video{max-width:100%;max-height:100%;display:block}
.dal-zoomable{transform-origin:0 0;touch-action:none;user-select:none;background-image:conic-gradient(var(--dsw-alias-bg-layer-1,#fff) 25%,var(--dsw-alias-bg-layer-2,rgba(0,0,0,.08)) 0 50%,var(--dsw-alias-bg-layer-1,#fff) 0 75%,var(--dsw-alias-bg-layer-2,rgba(0,0,0,.08)) 0);background-size:16px 16px}
.dal-stage-audio{display:flex;flex-direction:column;align-items:center;gap:12px;color:var(--dsw-alias-label-tertiary,#81858c)}
.dal-note{font-size:42px;line-height:1}
.dal-info{overflow:auto;display:flex;flex-direction:column;gap:12px;min-height:0;padding-right:2px}
.dal-kv{display:grid;grid-template-columns:76px 1fr;gap:5px 10px;font-size:12px}
.dal-k{color:var(--dsw-alias-label-tertiary,#81858c)}
.dal-v{word-break:break-all;color:var(--dsw-alias-label-secondary,#4a4f57)}
.dal-field{display:flex;flex-direction:column;gap:6px}
.dal-label{font-size:12px;color:var(--dsw-alias-label-secondary,#4a4f57)}
.dal-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
`;

        /** 侧边栏图标；面板条目被渲染在宿主自己的 `<button>` 里，所以这里不能再包交互元素。 */
        function Icon() {
            return h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true, style: { display: 'block' } },
                h('rect', { x: 2.5, y: 3.5, width: 19, height: 17, rx: 4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
                h('path', { d: 'M5 15.2l3.2-3.6 2.3 2.4 2.1-2.1 2.4 3.3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                h('path', { d: 'M15.2 7.6v5.4M15.2 7.6l3.6-.9v5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }));
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
         * 网格里的一张卡片。
         *
         * 贴近视口才挂媒体；视频只在这个前提下才创建 `<video preload="metadata">`
         * （一个页面几十个 video 元素会明显吃内存），拿到元数据后把时长显示在右下角，
         * 悬停时静音预览首段；音频同理挂 `<audio preload="metadata">` 只为拿到时长。
         * 卡片统一尺寸：缩略图固定 4:3 比例 + object-fit:cover，不随分辨率 / 横竖变化；
         * 竖图也因此裁切填满，保证网格整齐（要保留完整构图改回 contain 即可）。
         */
        function AssetCard({ item, onOpen, t, revision, selected, cursor }) {
            const [ref, inView] = useInView();
            const { src, color, pending } = useThumb(item, inView, revision);
            const posterState = useVideoPoster(item, inView, revision);
            const [hovered, setHovered] = useState(false);
            const [duration, setDuration] = useState(null);
            let media = null;
            if (item.kind === 'image') {
                if (src !== null) media = h('img', { src, alt: item.name, loading: 'lazy', decoding: 'async', className: 'dal-fade' });
                else if (pending || !inView) media = h('span', { className: 'dal-skeleton' });
                else media = h('span', { className: 'dal-dim', style: { fontSize: 20 } }, '▨');
            } else if (item.kind === 'video') {
                if (posterState.poster !== null) {
                    // 已有缓存封面：直接显示图片；只有悬停时才临时挂一个会播放的 <video>。
                    media = [
                        h('img', { src: posterState.poster, alt: item.name, loading: 'lazy', decoding: 'async', className: 'dal-fade' }),
                        HOVER_PREVIEW && hovered ? h('video', {
                            src: fileUrl(item.relPath, revision),
                            autoPlay: true, muted: true, loop: true, playsInline: true,
                            style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' },
                        }) : null,
                    ];
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
                // 音频：♪ 占位 + 一个不显示的 <audio>，只为拿到时长做徽标。
                media = inView
                    ? [
                        h('span', { className: 'dal-dim', style: { fontSize: 22 } }, '♪'),
                        h('audio', {
                            src: fileUrl(item.relPath, revision),
                            preload: 'metadata',
                            onLoadedMetadata: (event) => setDuration(humanDuration(event.target.duration)),
                        }),
                    ]
                    : h('span', { className: 'dal-skeleton' });
            }
            const thumbStyle = {};
            if (color !== null) thumbStyle.backgroundColor = color;
            const dims = Number.isFinite(item.width) && Number.isFinite(item.height) ? ` · ${item.width}×${item.height}` : '';
            return h('button', {
                type: 'button',
                className: `dal-card${cursor === true ? ' dal-cursor' : ''}${selected === true ? ' dal-selected' : ''}`,
                ref,
                onClick: (event) => onOpen(item, event),
                onMouseEnter: HOVER_PREVIEW ? () => setHovered(true) : undefined,
                onMouseLeave: () => setHovered(false),
                title: item.relPath,
            },
                h('span', { className: 'dal-thumb', style: Object.keys(thumbStyle).length > 0 ? thumbStyle : undefined },
                    media,
                    h('span', { className: `dal-check${selected === true ? ' dal-check-on' : ''}`, 'aria-hidden': true }),
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
         * 放大卡片：左边媒体本体，右边详细信息与标注。
         *
         * 不是浮层也不是抽屉 —— 它直接占据面板正文，所以不会遮住别的界面元素，也就
         * 不会出现"右侧栏"那种挤压感。Esc 返回，←/→ 在当前结果里翻；图片支持滚轮
         * 缩放（以指针为锚）、拖拽平移、双击放大/还原。
         */
        function AssetDetail({ item, index, count, hasMore, canReveal, revision, pinned, isPinned, onTogglePin, onOpenPinned, onBack, onPrev, onNext, onSaved, t }) {
            const [tags, setTags] = useState(item.tags);
            const [note, setNote] = useState(item.note);
            const [draftTag, setDraftTag] = useState('');
            const [state, setState] = useState('idle');
            const [copied, setCopied] = useState(false);
            const [revealState, setRevealState] = useState('idle');
            const [media, setMedia] = useState({ width: null, height: null, duration: null });
            const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
            const stageRef = useRef(null);
            const dragRef = useRef(null);

            // 换资产（或重扫过）时重置编辑态、已探测的媒体尺寸与缩放。
            useEffect(() => {
                setTags(item.tags);
                setNote(item.note);
                setState('idle');
                setCopied(false);
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
                    onSaved(payload.item);
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
            const copyPath = async () => {
                try {
                    await navigator.clipboard.writeText(item.absolutePath);
                    setCopied(true);
                } catch {
                    setCopied(false);
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
                stage = h('video', {
                    src: source,
                    controls: true,
                    preload: 'metadata',
                    onLoadedMetadata: (event) => setMedia({
                        width: event.target.videoWidth,
                        height: event.target.videoHeight,
                        duration: event.target.duration,
                    }),
                });
            } else {
                stage = h('div', { className: 'dal-stage-audio' },
                    h('span', { className: 'dal-note' }, '♪'),
                    h('audio', {
                        src: source,
                        controls: true,
                        onLoadedMetadata: (event) => setMedia((previous) => ({ ...previous, duration: event.target.duration })),
                        style: { width: 'min(420px,80%)' },
                    }));
            }

            // 详情里的尺寸以浏览器实测为准（覆盖 AVIF 等宿主没探测的格式）。
            const resolvedWidth = Number.isFinite(media.width) ? media.width : item.width;
            const resolvedHeight = Number.isFinite(media.height) ? media.height : item.height;
            const resolution = Number.isFinite(resolvedWidth) && Number.isFinite(resolvedHeight) && resolvedWidth > 0
                ? `${resolvedWidth} × ${resolvedHeight}${resolvedHeight > resolvedWidth ? ` · ${t('orientationPortrait')}` : resolvedWidth > resolvedHeight ? ` · ${t('orientationLandscape')}` : ''}`
                : null;
            const duration = humanDuration(media.duration);

            return h('div', { className: 'dal-detail' },
                h('div', { className: 'dal-detail-bar' },
                    h('button', { type: 'button', className: 'dal-btn', onClick: onBack, title: 'Esc' }, `← ${t('back')}`),
                    h('span', { className: 'dal-detail-name', title: item.relPath }, item.name),
                    h('button', { type: 'button', className: 'dal-btn', onClick: onPrev, disabled: index <= 0, title: '←' }, '‹'),
                    h('span', { className: 'dal-count' }, t('position').replace('{i}', String(index + 1)).replace('{n}', `${count}${hasMore ? '+' : ''}`)),
                    h('button', { type: 'button', className: 'dal-btn', onClick: onNext, disabled: index >= count - 1, title: '→' }, '›'),
                    item.kind === 'image'
                        ? h('button', {
                            type: 'button',
                            className: 'dal-btn',
                            onClick: () => setZoom({ scale: 1, x: 0, y: 0 }),
                            disabled: zoom.scale === 1,
                            title: '0',
                        }, t('resetZoom'))
                        : null,
                    // 参照图钉：把当前资产钉住，浏览别的素材时它悬在角落方便对比。
                    isPinned === true
                        ? h('button', { type: 'button', className: 'dal-btn', onClick: onTogglePin, title: t('unpin') }, `📌 ${t('unpin')}`)
                        : h('button', { type: 'button', className: 'dal-btn', onClick: onTogglePin, title: t('pin') }, t('pin'))),
                h('div', { className: 'dal-detail-grid' },
                    h('div', { className: 'dal-stage', ref: stageRef },
                        stage,
                        pinned !== null && pinned.relPath !== item.relPath
                            ? h('div', { className: 'dal-ref', onClick: onOpenPinned, title: pinned.relPath },
                                h('img', { src: fileUrl(pinned.relPath, revision), alt: pinned.name }),
                                h('span', { className: 'dal-ref-label' }, t('pinnedRef')))
                            : null),
                    h('div', { className: 'dal-info' },
                        h('div', { className: 'dal-kv' },
                            h('span', { className: 'dal-k' }, t('type')),
                            h('span', { className: 'dal-v' }, `${t(item.kind)} · ${item.ext}`),
                            h('span', { className: 'dal-k' }, t('size')),
                            h('span', { className: 'dal-v' }, humanSize(item.size)),
                            h('span', { className: 'dal-k' }, t('modified')),
                            h('span', { className: 'dal-v' }, humanTime(item.mtimeMs)),
                            resolution !== null ? h('span', { className: 'dal-k' }, t('dimensions')) : null,
                            resolution !== null ? h('span', { className: 'dal-v' }, resolution) : null,
                            duration !== null ? h('span', { className: 'dal-k' }, t('duration')) : null,
                            duration !== null ? h('span', { className: 'dal-v' }, duration) : null,
                            h('span', { className: 'dal-k' }, t('relPath')),
                            h('span', { className: 'dal-v' }, item.relPath),
                            h('span', { className: 'dal-k' }, t('absPath')),
                            h('span', { className: 'dal-v' }, item.absolutePath)),
                        h('div', { className: 'dal-row' },
                            h('button', { type: 'button', className: 'dal-btn', onClick: copyPath }, copied ? t('copied') : t('copy')),
                            // 宿主没声明 reveal 能力时不渲染这个按钮（旧宿主重启前就是这种状态）。
                            canReveal === true
                                ? h('button', { type: 'button', className: 'dal-btn', onClick: reveal, disabled: revealState === 'busy' },
                                    revealState === 'busy' ? t('revealing') : t('reveal'))
                                : null,
                            h('a', { className: 'dal-btn', href: source, target: '_blank', rel: 'noreferrer' }, t('openTab'))),
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
                                }, `${tag} ×`)),
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
                        h('div', { className: 'dal-row' },
                            h('button', { type: 'button', className: 'dal-btn dal-btn-primary', disabled: state === 'saving', onClick: save },
                                state === 'saving' ? t('saving') : state === 'saved' ? t('saved') : t('save'))),
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
            const [batchMsg, setBatchMsg] = useState('');
            const [collections, setCollections] = useState(() => readCollections());
            const [filterName, setFilterName] = useState('');

            useEffect(() => {
                const timer = setTimeout(() => setDebounced(query), 220);
                return () => clearTimeout(timer);
            }, [query]);

            useEffect(() => { writePrefs({ kind, sort, order }); }, [kind, sort, order]);

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

            /** 点卡片：普通点击进入放大卡片；Ctrl/Shift 点击做批量选择。 */
            const onCardClick = (item, event) => {
                const index = items.findIndex((value) => value.relPath === item.relPath);
                if (event !== undefined && event !== null && (event.ctrlKey === true || event.metaKey === true)) {
                    anchorRef.current = index;
                    setSelectedPaths((previous) => {
                        const next = new Set(previous);
                        if (next.has(item.relPath)) next.delete(item.relPath);
                        else next.add(item.relPath);
                        return next;
                    });
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

            return h('div', { className: 'dal-root' },
                h('style', null, CSS),
                h('div', { className: 'dal-head' },
                    h('div', { className: 'dal-title' }, t('title'), h('span', { className: 'dal-sub' },
                        activeFilter
                            ? t('matched').replace('{m}', String(total)).replace('{n}', String(status?.counts?.total ?? 0))
                            : t('total').replace('{n}', String(status?.counts?.total ?? 0)))),
                    h('div', { className: 'dal-sub' }, t('subtitle')),
                    h('div', { className: 'dal-row' },
                        h('span', { className: 'dal-sub' }, t('assetsRoot')),
                        h('span', { className: 'dal-path', title: status?.assetsRoot ?? '' }, status?.assetsRoot ?? '—'),
                        status?.conventional ? h('span', { className: 'dal-sub' }, t('conventional')) : null),
                    h('div', { className: 'dal-row' },
                        Array.isArray(status?.recentProjects) && status.recentProjects.length > 0
                            ? h('select', {
                                className: 'dal-select',
                                style: { maxWidth: 220 },
                                value: '',
                                title: t('recent'),
                                onChange: (event) => {
                                    const value = event.target.value;
                                    if (value !== '') void applyRoot(value);
                                },
                            },
                                h('option', { value: '' }, t('recent')),
                                status.recentProjects.map((project) => h('option', { key: project, value: project }, project.slice(Math.max(project.lastIndexOf('\\'), project.lastIndexOf('/')) + 1))))
                            : null,
                        h('input', {
                            className: 'dal-input',
                            value: rootDraft,
                            placeholder: t('rootPlaceholder'),
                            onChange: (event) => { rootTouched.current = true; setRootDraft(event.target.value); },
                            onKeyDown: (event) => { if (event.key === 'Enter') void applyRoot(rootDraft); },
                        }),
                        h('button', { type: 'button', className: 'dal-btn', disabled: busy, onClick: () => void applyRoot(rootDraft) }, t('apply')),
                        h('button', { type: 'button', className: 'dal-btn', disabled: busy, onClick: () => void applyRoot('') }, t('useSession')),
                        h('button', { type: 'button', className: 'dal-btn', disabled: busy, onClick: () => void rescan() }, busy ? t('rescanning') : t('rescan'))),
                    h('div', { className: 'dal-row' },
                        h('div', { className: 'dal-chips' },
                            chips.map((chip) => h('button', {
                                type: 'button',
                                className: 'dal-chip',
                                key: chip.label,
                                'data-on': String(kind === chip.id),
                                onClick: () => { setKind(chip.id); setSelected(null); setGridCursor(-1); },
                            }, chip.count === undefined ? chip.label : `${chip.label} ${chip.count}`))),
                        h('input', {
                            className: 'dal-input',
                            ref: searchRef,
                            value: query,
                            placeholder: t('search'),
                            onChange: (event) => setQuery(event.target.value),
                        }),
                        h('select', { className: 'dal-select', value: sort, onChange: (event) => setSort(event.target.value) },
                            h('option', { value: 'name' }, t('sortName')),
                            h('option', { value: 'mtime' }, t('sortMtime')),
                            h('option', { value: 'size' }, t('sortSize'))),
                        h('button', {
                            type: 'button',
                            className: 'dal-btn',
                            title: order === 'asc' ? t('sortAsc') : order === 'desc' ? t('sortDesc') : `${t('sortName')} ↑ / ${t('sortMtime')} ↓`,
                            onClick: () => setOrder(order === '' ? 'asc' : order === 'asc' ? 'desc' : ''),
                        }, order === 'asc' ? '↑' : order === 'desc' ? '↓' : '↕')),
                    // 标签筛选行：只有宿主的 /status 带了 tagFacets 才渲染（旧宿主重启前
                    // 没有这个字段，面板自动降级，不出现一个筛不出东西的控件）。
                    Array.isArray(status?.tagFacets) && status.tagFacets.length > 0
                        ? h('div', { className: 'dal-chips' },
                            h('span', { className: 'dal-sub' }, t('filterByTag')),
                            status.tagFacets.map((facet) => h('button', {
                                type: 'button',
                                className: 'dal-chip',
                                key: facet.tag,
                                'data-on': String(tag === facet.tag),
                                title: `${t('filterByTag')}: #${facet.tag}`,
                                onClick: () => setTag(tag === facet.tag ? '' : facet.tag),
                            }, `#${facet.tag} ${facet.count}`)))
                        : null,
                    // 合集行：命名的筛选组合。有合集、或当前有可保存的筛选时才出现。
                    (collections.length > 0 || activeFilter)
                        ? h('div', { className: 'dal-chips' },
                            h('span', { className: 'dal-sub' }, t('collections')),
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
                                }, ' ×'))),
                            activeFilter
                                ? h('input', {
                                    className: 'dal-input',
                                    style: { flex: '0 0 170px', minWidth: 120 },
                                    value: filterName,
                                    placeholder: t('filterNamePlaceholder'),
                                    onChange: (event) => setFilterName(event.target.value),
                                    onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); saveCollection(); } },
                                })
                                : null,
                            activeFilter
                                ? h('button', { type: 'button', className: 'dal-btn', disabled: filterName.trim() === '', onClick: saveCollection }, t('saveFilter'))
                                : null)
                        : null,
                    (folders.length > 0 || dir !== '')
                        ? h('div', { className: 'dal-chips' },
                            h('button', { type: 'button', className: 'dal-chip', 'data-on': String(dir === ''), onClick: () => setDir('') }, t('allFolders')),
                            dir !== ''
                                ? h('button', {
                                    type: 'button',
                                    className: 'dal-chip',
                                    title: t('parentDir'),
                                    onClick: () => setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''),
                                }, `⬆ ${t('parentDir')}`)
                                : null,
                            dir !== '' ? h('span', { className: 'dal-sub' }, dir) : null,
                            folders.slice(0, 24).map(([name, count]) => h('button', {
                                type: 'button',
                                className: 'dal-chip',
                                key: name,
                                'data-on': String(dir === name),
                                title: name,
                                onClick: () => setDir(dir === name ? '' : name),
                            }, `${name} ${count}`)))
                        : null,
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
                                `📌 ${pinned.name}`,
                                h('span', {
                                    className: 'dal-chip-x',
                                    title: t('unpin'),
                                    onClick: (event) => {
                                        event.stopPropagation();
                                        setPinned(null);
                                    },
                                }, ' ×')))
                        : null,
                    items.length === 0 && !loading
                        ? h('div', { className: 'dal-empty' },
                            h('div', null, t('empty')),
                            h('div', { className: 'dal-sub' }, t('emptyHint')))
                        : h('div', { className: 'dal-grid' },
                            items.map((item, index) => h(AssetCard, {
                                key: item.relPath,
                                item,
                                t,
                                revision,
                                onOpen: onCardClick,
                                selected: selectedPaths.has(item.relPath),
                                cursor: gridCursor === index,
                            }))),
                    selectedPaths.size > 0 || batchMsg !== ''
                        ? h('div', { className: 'dal-batchbar' },
                            selectedPaths.size > 0 ? h('span', { className: 'dal-sub' }, t('selectedN').replace('{n}', String(selectedPaths.size))) : null,
                            selectedPaths.size > 0
                                ? h('button', { type: 'button', className: 'dal-btn', onClick: () => setSelectedPaths(new Set(items.map((item) => item.relPath))) }, t('selectAll'))
                                : null,
                            selectedPaths.size > 0
                                ? h('button', { type: 'button', className: 'dal-btn', onClick: () => setSelectedPaths(new Set()) }, t('clearSel'))
                                : null,
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
                    items.length > 0 ? h('div', { className: 'dal-sub', style: { paddingTop: 10 } }, `${t('hint')} · ${t('batchHint')}`) : null,
                    hasMore
                        ? h('div', { className: 'dal-row', style: { justifyContent: 'center', padding: '12px 0' } },
                            h('button', { type: 'button', className: 'dal-btn', disabled: loading, onClick: () => void load(items.length) }, t('loadMore')))
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
