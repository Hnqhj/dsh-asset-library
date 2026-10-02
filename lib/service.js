/**
 * 资产库内核：根目录解析、扫描缓存、查询、标注。
 *
 * HTTP 面与 Agent 工具都是这一层的薄封装 —— 同一个 `list()` 既服务面板的网格，
 * 也服务模型调用，所以"AI 看到的"和"人看到的"永远是同一份数据、同一套过滤语义。
 *
 * 权威来源是磁盘：扫描结果是派生缓存，索引文件只存标注。任何一次 `rescan()`、
 * `setRoot()`、标注写入都会让缓存失效。
 *
 * 根目录按作用域解析，优先级从高到低：
 *   1. 单次调用的显式作用域（Agent 工具传进来的 `root`，或会话的 cwd）；
 *   2. 界面里选定的项目根（`setRoot`，进程内有效）；
 *   3. 上次选过的项目根（`setRoot` 时写进登记表，重启后读回）；
 *   4. 插件配置里的 `root`；
 *   5. 会话工作目录（宿主提供时）；
 *   6. harness 进程的 cwd。
 *
 * 缓存按"实际扫描目录"分桶：Agent 在多个项目之间切换时不会互相把缓存冲掉。
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { folderList, scanAssets } from './scan.js';
import { DIMENSION_EXTS } from './dimensions.js';
import { mergeAnnotation, mergeAnnotationDelta, readIndex, writeIndex } from './store.js';
import { normalizeRelPath } from './paths.js';
import { readJsonFile, resolveDshHome, writeJsonFile } from './home.js';

/** 项目登记表文件名（放在 harness home 下，不污染项目目录）。 */
const PROJECTS_FILE = 'asset-library.json';

/** 登记表结构版本。 */
const PROJECTS_VERSION = 1;

/** 项目历史最多记几个。 */
const PROJECT_HISTORY = 12;

/**
 * 尺寸备忘录的落盘文件名。
 *
 * 备忘录是"扫描的派生缓存"，不是标注，所以它进 `<DSH_HOME>` 而不是项目里的
 * `index.json` —— 后者会被 git 提交，只能放人的输入。
 */
const SCAN_CACHE_FILE = 'asset-library-scan-cache.json';

/** 落盘备忘录的结构版本。 */
const SCAN_CACHE_VERSION = 1;

/** 单个根目录最多落盘多少条尺寸记录；超过就整个跳过（防呆，正常项目够用）。 */
const SCAN_CACHE_MAX_ENTRIES = 60_000;

/** 最多为几个根目录保留落盘备忘录（按条目数取最大的几个）。 */
const SCAN_CACHE_MAX_ROOTS = 8;

/** 落盘节流的间隔（毫秒）：一次扫描后攒够再写，不跟着每个请求写盘。 */
const SCAN_CACHE_WRITE_DELAY_MS = 1500;

/**
 * 把一个可能带 `~` 或相对路径的用户输入解析成绝对路径。
 *
 * @param value - 用户输入。
 * @param base - 相对路径的解析基准（通常是 harness 进程的 cwd）。
 */
export function toAbsolute(value, base) {
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    let text = value.trim();
    if (text === '~') text = homedir();
    else if (text.startsWith('~/') || text.startsWith('~\\')) text = join(homedir(), text.slice(2));
    return isAbsolute(text) ? resolve(text) : resolve(base, text);
}

/**
 * 创建资产库内核。
 *
 * @param options - `config`（已归一化）、`logger`、`sessionProjectRoot`（可选，
 *   返回当前会话的工作目录）、`diagnostics`（可选，返回插件自检信息）。
 */
export function createService(options) {
    const { config, logger } = options;
    const sessionProjectRoot = options.sessionProjectRoot;
    const diagnostics = options.diagnostics;
    const home = resolveDshHome(config.dshHome);
    const projectsFile = join(home, PROJECTS_FILE);
    const scanCacheFile = join(home, SCAN_CACHE_FILE);

    /** 界面里显式选定的项目根。 */
    let explicitRoot;

    /**
     * 上次选过的项目根（从登记表读回）。
     *
     * `undefined` = 还没读过；`null` = 读过但没有可用的（文件不存在、路径已失效、
     * 或者用户按过"用默认目录"）。用一个"读没读过"的标志而不是 `undefined` 判断，
     * 是因为"读过但确实没有"和"还没读"必须区分：前者要一直回退到配置/会话，
     * 后者才需要去读盘。
     */
    let rememberedRoot;
    let rememberedRead = false;

    /** 扫描缓存：key 是实际扫描目录。 */
    const caches = new Map();

    /**
     * 已解析的资产根：`projectRoot → { projectRoot, assetsRoot, conventional }`。
     *
     * 媒体端点（`/file`、`/reveal`）只需要知道"根在哪"，为此走一遍整棵目录树
     * 是纯粹的浪费 —— 几十张卡片同时进视口就是几十次全量扫描，宿主和文件流抢
     * 同一个线程池，表现就是滚动/切类型卡顿。换项目、重扫时清空。
     */
    const rootMemos = new Map();

    /**
     * 尺寸备忘录：key 是实际扫描目录，值是 relPath → 探测结果。
     *
     * 故意**不**跟随 `invalidate()` 清空：重扫/换项目/写标注之后，未变更文件的
     * 尺寸依旧有效，清掉只会把"打开文件读头"的成本再付一遍。每轮扫描结束后
     * 按当前清单收敛，被删文件的条目随之消失。
     *
     * "探测过但没探出来"（头不符合魔数、罕见 PNG 变体）也照样记：不记的话，
     * 这些文件每一轮扫描都会被重新打开读一遍 —— 一个大目录里只要有一批
     * AVIF/异常图，每张缩略图请求都要付这个代价。
     */
    const dimensionMemos = new Map();

    /** 同一目录上的并发扫描合并成一次。 */
    const inFlights = new Map();

    /** 丢掉所有扫描结果（重扫、换项目、写标注后调用）。 */
    const invalidate = () => {
        caches.clear();
        inFlights.clear();
        rootMemos.clear();
    };

    /** 读取项目登记表（lastProject + 历史列表）；每次都读文件，不留进程内记忆。 */
    async function loadRegistry() {
        const raw = await readJsonFile(projectsFile);
        const projects = Array.isArray(raw?.projects) ? raw.projects.filter((value) => typeof value === 'string') : [];
        return {
            version: PROJECTS_VERSION,
            lastProject: typeof raw?.lastProject === 'string' ? raw.lastProject : undefined,
            projects,
        };
    }

    /** 写入项目登记表。 */
    async function saveRegistry(next) {
        await writeJsonFile(projectsFile, next);
    }

    /**
     * 记住（或清除）当前项目根。
     *
     * 登记表只是"下次开面板用哪个目录"的便利数据：写不进去（家目录只读、配额、
     * 刚好杀进程）不该让"切换项目"这个动作本身失败，所以这里的错误一律降级成
     * 警告 —— 本次进程内的选择照常生效。
     *
     * @param projectRoot - 要记住的绝对路径；空串表示清除记忆。
     */
    async function rememberProject(projectRoot) {
        try {
            const registryNow = await loadRegistry();
            const projects = projectRoot === ''
                ? registryNow.projects
                : [projectRoot, ...registryNow.projects.filter((value) => value !== projectRoot)].slice(0, PROJECT_HISTORY);
            await saveRegistry({ version: PROJECTS_VERSION, lastProject: projectRoot, projects });
        } catch (error) {
            logger?.warn?.(`asset-library: could not remember project root: ${String(error)}`);
        }
    }

    /**
     * 读回上次选过的项目根（每个进程只读一次）。
     *
     * 只认"仍然存在且确实是目录"的路径：项目被删、改名、移动之后静静退回默认
     * 解析链，而不是把一个不存在的路径当成生效根（那会让人以为插件坏了）。
     * 这就是"重启不用再选一次项目"的落点。
     */
    async function loadRememberedRoot() {
        if (rememberedRead) return rememberedRoot;
        rememberedRead = true;
        try {
            const registryNow = await loadRegistry();
            const candidate = toAbsolute(registryNow.lastProject, process.cwd());
            if (candidate !== undefined) {
                const info = await stat(candidate).catch(() => undefined);
                if (info !== undefined && info.isDirectory()) rememberedRoot = candidate;
            }
        } catch (error) {
            logger?.warn?.(`asset-library: remembered project root unavailable: ${String(error)}`);
        }
        return rememberedRoot;
    }

    /**
     * 解析本次调用生效的项目根。
     *
     * @param scope - 单次调用的显式项目根（Agent 工具的 `root` 参数或会话 cwd）。
     */
    async function resolveProjectRoot(scope) {
        if (typeof scope === 'string' && scope.trim() !== '') {
            const absolute = toAbsolute(scope, process.cwd());
            if (absolute !== undefined) return absolute;
        }
        if (explicitRoot !== undefined) return explicitRoot;
        const remembered = await loadRememberedRoot();
        if (typeof remembered === 'string') return remembered;
        if (typeof config.root === 'string' && config.root.trim() !== '') {
            const absolute = toAbsolute(config.root, process.cwd());
            if (absolute !== undefined) return absolute;
        }
        if (sessionProjectRoot !== undefined) {
            try {
                const fromSession = await sessionProjectRoot();
                if (typeof fromSession === 'string' && fromSession.trim() !== '') return resolve(fromSession);
            } catch (error) {
                logger?.warn?.(`asset-library: session project root unavailable: ${String(error)}`);
            }
        }
        return process.cwd();
    }

    /**
     * 解析某个项目根对应的实际扫描目录（带进程内记忆）。
     *
     * 约定是 `<项目>/<assetsDir>`，但用户完全可能直接把插件指向资产目录本身。
     * 因此：子目录存在就用子目录，不存在就用该目录本身 —— "选项目"和"选资产
     * 文件夹"两种直觉都能用，且不需要额外的模式开关。
     *
     * 记忆的动机很具体：媒体端点每个请求都要问"根在哪"，而解析只需要一次
     * `<root>/<assetsDir>` 的存在性判断。不记的话，几十张卡片同时进视口就是
     * 几十次 stat，还会被误当成"要全量扫描一遍"。
     */
    async function assetsRootFor(root) {
        const hit = rootMemos.get(root);
        if (hit !== undefined) return hit;
        let resolved;
        try {
            const info = await stat(join(root, config.assetsDir));
            resolved = info.isDirectory()
                ? { projectRoot: root, assetsRoot: join(root, config.assetsDir), conventional: true }
                : { projectRoot: root, assetsRoot: root, conventional: false };
        } catch {
            // 不存在就是"用户选的就是资产目录"，继续。
            resolved = { projectRoot: root, assetsRoot: root, conventional: false };
        }
        rootMemos.set(root, resolved);
        return resolved;
    }

    /** 解析实际扫描的目录。 */
    async function resolveAssetsRoot(scope) {
        return assetsRootFor(await resolveProjectRoot(scope));
    }

    // ---- 尺寸备忘录落盘：重启后首扫直接命中，不再把每张图打开读一遍文件头

    let scanCacheLoaded = false;
    let scanCacheWriting = false;
    let scanCacheWrittenAt = 0;
    /** 待落盘的根（assetsRoot）；空集表示这一轮没有任何变化。 */
    const dirtyScanRoots = new Set();

    /** 读入落盘备忘录；文件缺失、损坏、版本不符都安静地当作空。 */
    async function loadScanCache() {
        if (scanCacheLoaded) return;
        scanCacheLoaded = true;
        const raw = await readJsonFile(scanCacheFile).catch(() => undefined);
        if (raw === undefined || raw.version !== SCAN_CACHE_VERSION) return;
        const buckets = raw.roots;
        if (buckets === null || typeof buckets !== 'object' || Array.isArray(buckets)) return;
        for (const [root, bucket] of Object.entries(buckets)) {
            if (dimensionMemos.has(root)) continue;
            const entries = Array.isArray(bucket?.entries) ? bucket.entries : [];
            const memo = new Map();
            for (const entry of entries) {
                if (!Array.isArray(entry) || entry.length < 5) continue;
                const [relPath, mtimeMs, size, width, height] = entry;
                if (typeof relPath !== 'string' || !Number.isFinite(mtimeMs) || !Number.isFinite(size)) continue;
                // 0 是"探测过但没探出来"的哨兵（真实尺寸永远 > 0，见 dimensions.js）。
                memo.set(relPath, {
                    mtimeMs,
                    size,
                    width: width === 0 ? undefined : width,
                    height: height === 0 ? undefined : height,
                });
            }
            if (memo.size > 0) dimensionMemos.set(root, memo);
        }
    }

    /**
     * 备忘录是否真的变了。
     *
     * 只在变了的时候才落盘 —— 没变还写一遍等于每个请求都在写盘。比较的是
     * `(relPath, mtimeMs, size)` 三元组，与复用判据完全一致：这里判定"没变"，
     * 就等于下次扫描还能命中同一批条目。
     */
    function memoDiffers(previous, next) {
        if (previous === undefined || previous.size !== next.size) return true;
        for (const [relPath, value] of next) {
            const prior = previous.get(relPath);
            if (prior === undefined || prior.mtimeMs !== value.mtimeMs || prior.size !== value.size) return true;
        }
        return false;
    }

    /** 攒一会儿再写：一轮扫描只落一次盘。 */
    function scheduleScanCacheWrite() {
        if (scanCacheWriting) return;
        scanCacheWriting = true;
        const delay = Math.max(0, SCAN_CACHE_WRITE_DELAY_MS - (Date.now() - scanCacheWrittenAt));
        setTimeout(() => { void flushScanCache(); }, delay);
    }

    /** 把当前备忘录里最大的几个根写进 `<DSH_HOME>`；失败只警告。 */
    async function flushScanCache() {
        scanCacheWriting = false;
        if (dirtyScanRoots.size === 0) return;
        dirtyScanRoots.clear();
        const buckets = [...dimensionMemos.entries()]
            .filter(([, memo]) => memo instanceof Map && memo.size > 0 && memo.size <= SCAN_CACHE_MAX_ENTRIES)
            .sort((a, b) => b[1].size - a[1].size)
            .slice(0, SCAN_CACHE_MAX_ROOTS);
        const roots = {};
        for (const [root, memo] of buckets) {
            roots[root] = {
                savedAt: new Date().toISOString(),
                // 紧凑的数组元组：`[relPath, mtimeMs, size, width, height]`，尺寸 0 = 探测过但未知。
                entries: [...memo].map(([relPath, value]) => [relPath, value.mtimeMs, value.size, value.width ?? 0, value.height ?? 0]),
            };
        }
        try {
            await writeJsonFile(scanCacheFile, { version: SCAN_CACHE_VERSION, roots });
            scanCacheWrittenAt = Date.now();
        } catch (error) {
            logger?.warn?.(`asset-library: could not persist scan memo: ${String(error)}`);
        }
    }

    /** 把扫描条目与标注合并成对外条目。 */
    function decorate(item, index, assetsRoot) {
        const annotation = index.annotations[item.relPath] ?? {};
        return {
            ...item,
            id: item.relPath,
            name: item.relPath.slice(item.relPath.lastIndexOf('/') + 1),
            dir: item.relPath.includes('/') ? item.relPath.slice(0, item.relPath.lastIndexOf('/')) : '',
            tags: Array.isArray(annotation.tags) ? annotation.tags : [],
            note: typeof annotation.note === 'string' ? annotation.note : '',
            addedAt: typeof annotation.addedAt === 'string' ? annotation.addedAt : null,
            absolutePath: join(assetsRoot, item.relPath),
        };
    }

    /**
     * 执行（或复用）一次扫描。
     *
     * @param scope - 单次调用的项目根覆盖。
     * @param force - 忽略缓存。
     */
    async function scan(scope, force = false) {
        const roots = await resolveAssetsRoot(scope);
        const key = roots.assetsRoot;
        const cached = caches.get(key);
        const now = Date.now();
        if (!force && cached !== undefined && now - cached.at < config.cacheMs) return cached;
        const running = inFlights.get(key);
        if (!force && running !== undefined) return running;
        const run = (async () => {
            let items = [];
            let truncated = false;
            try {
                // 落盘备忘录是"重启后免于重读每个图片文件头"的唯一来源，先装上。
                await loadScanCache();
                let memo = dimensionMemos.get(key);
                if (memo === undefined) {
                    memo = new Map();
                    dimensionMemos.set(key, memo);
                }
                const result = await scanAssets(key, {
                    includeHidden: config.includeHidden,
                    maxDepth: config.maxDepth,
                    maxFiles: config.maxFiles,
                    memo,
                });
                items = result.items;
                truncated = result.truncated;
                // 按本轮清单收敛备忘录：被删/改名文件的探测结果随之丢弃。
                // 记录条件是"这个扩展名本来就要探测"，而不是"探测成功了" —— 见
                // dimensionMemos 的注释：没探出结果的文件尤其不能再探一遍。
                const converged = new Map();
                for (const item of items) {
                    if (item.kind !== 'image' || !DIMENSION_EXTS.has(item.ext)) continue;
                    converged.set(item.relPath, { mtimeMs: item.mtimeMs, size: item.size, width: item.width, height: item.height });
                }
                dimensionMemos.set(key, converged);
                // 只有真的变了才落盘：复盘没变化时写一遍纯属浪费 IO。
                if (memoDiffers(memo, converged)) {
                    dirtyScanRoots.add(key);
                    scheduleScanCacheWrite();
                }
            } catch (error) {
                logger?.warn?.(`asset-library: scan failed for ${key}: ${String(error)}`);
            }
            const index = await readIndex(roots.projectRoot, config.indexDir);
            const next = {
                at: Date.now(),
                scannedAt: new Date().toISOString(),
                ...roots,
                items: items.map((item) => decorate(item, index, roots.assetsRoot)),
                truncated,
                index,
            };
            caches.set(key, next);
            return next;
        })();
        inFlights.set(key, run);
        try {
            return await run;
        } finally {
            if (inFlights.get(key) === run) inFlights.delete(key);
        }
    }

    /** 计数。 */
    function countsOf(items) {
        const counts = { image: 0, video: 0, audio: 0, total: items.length };
        for (const item of items) counts[item.kind] += 1;
        return counts;
    }

    /**
     * 标签聚合：当前扫描里每个标签各有多少资产。
     *
     * 只统计**扫描结果里真实存在**的条目 —— 文件被删后残留的索引标注不算数，
     * 这样 facets 的数字和 `list({ tag })` 过滤出来的数量永远一致。按使用次数
     * 降序取前 30 个，给界面的标签筛选行用。
     */
    function tagFacets(scanned) {
        const counts = new Map();
        for (const item of scanned.items) {
            for (const tag of item.tags) {
                counts.set(tag, (counts.get(tag) ?? 0) + 1);
            }
        }
        return [...counts.entries()]
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => (b.count - a.count) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
            .slice(0, 30);
    }

    /**
     * 查询：过滤 → 排序 → 分页。
     *
     * 关键词不只匹配路径：标签和备注是人给资产起的"另一套名字"（"主封面"、
     * "竖屏封面图"），用名字找素材时它们恰恰是最顺手的入口。
     * 排序方向缺省时沿用既有语义：名称升序、修改时间/大小降序。
     */
    function query(scanned, params) {
        const needle = (params.q ?? '').trim().toLowerCase();
        const tag = (params.tag ?? '').trim().toLowerCase();
        const dir = (params.dir ?? '').trim().replace(/\\/gu, '/').replace(/\/+$/u, '');
        let items = scanned.items;
        if (params.kind !== undefined) items = items.filter((item) => item.kind === params.kind);
        if (dir !== '') items = items.filter((item) => item.dir === dir || item.dir.startsWith(`${dir}/`));
        if (needle !== '') {
            items = items.filter((item) => item.relPath.toLowerCase().includes(needle)
                || item.tags.some((value) => value.toLowerCase().includes(needle))
                || (item.note !== '' && item.note.toLowerCase().includes(needle)));
        }
        if (tag !== '') items = items.filter((item) => item.tags.some((value) => value.toLowerCase() === tag));
        const ascending = params.order === 'asc' ? true : params.order === 'desc' ? false : params.sort === 'name';
        const sorted = [...items];
        if (params.sort === 'mtime') sorted.sort((a, b) => (ascending ? a.mtimeMs - b.mtimeMs : b.mtimeMs - a.mtimeMs));
        else if (params.sort === 'size') sorted.sort((a, b) => (ascending ? a.size - b.size : b.size - a.size));
        else sorted.sort((a, b) => {
            const byName = a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
            return ascending ? byName : -byName;
        });
        const offset = params.offset ?? 0;
        const limit = params.limit ?? config.pageSize;
        const page = sorted.slice(offset, offset + limit);
        return {
            items: page,
            total: sorted.length,
            offset,
            limit,
            hasMore: offset + page.length < sorted.length,
            counts: countsOf(scanned.items),
            filteredCounts: countsOf(sorted),
            truncated: scanned.truncated,
            scannedAt: scanned.scannedAt,
            projectRoot: scanned.projectRoot,
            assetsRoot: scanned.assetsRoot,
        };
    }

    const service = {
        /**
         * 供路由做文件包含检查的绝对根。
         *
         * 刻意**不**走 `scan()`：媒体端点每个请求都只要这一个字符串，为它遍历
         * 整棵目录树（几十张卡片同时进视口 = 几十次全量扫描）正是"切类型很卡"的
         * 主要来源。根目录本身变了（换项目、重扫）由 `invalidate()` 清记忆兜住。
         */
        async rootAbs(scope) {
            return (await resolveAssetsRoot(scope)).assetsRoot;
        },
        /** 面板首屏与轮询用的状态。 */
        async status() {
            const scanned = await scan(undefined);
            const registryNow = await loadRegistry();
            return {
                projectRoot: scanned.projectRoot,
                assetsRoot: scanned.assetsRoot,
                conventional: scanned.conventional,
                indexDir: config.indexDir,
                assetsDir: config.assetsDir,
                counts: countsOf(scanned.items),
                truncated: scanned.truncated,
                scannedAt: scanned.scannedAt,
                folders: folderList(scanned.items).length,
                tagFacets: tagFacets(scanned),
                knownRoots: scanned.index.roots,
                lastProject: registryNow.lastProject,
                recentProjects: registryNow.projects,
                explicit: explicitRoot !== undefined,
                config: {
                    assetsDir: config.assetsDir,
                    includeHidden: config.includeHidden,
                    maxDepth: config.maxDepth,
                },
                diagnostics: typeof diagnostics === 'function' ? diagnostics() : undefined,
            };
        },
        async list(params, scope) {
            return query(await scan(scope), params);
        },
        async detail(relPath, scope) {
            const normalized = normalizeRelPath(relPath);
            if (normalized === undefined) return undefined;
            const scanned = await scan(scope);
            return scanned.items.find((item) => item.relPath === normalized);
        },
        async tree(scope) {
            const scanned = await scan(scope);
            return {
                folders: folderList(scanned.items),
                projectRoot: scanned.projectRoot,
                assetsRoot: scanned.assetsRoot,
            };
        },
        async rescan() {
            invalidate();
            await scan(undefined, true);
            return service.status();
        },
        /**
         * 写入标注（标签/备注）。
         *
         * 只允许标注"当前扫描里真实存在"的资产：索引因此不会积累幽灵条目。
         */
        async annotate(relPath, patch, scope) {
            const normalized = normalizeRelPath(relPath);
            if (normalized === undefined) return undefined;
            const scanned = await scan(scope);
            const entry = scanned.items.find((item) => item.relPath === normalized);
            if (entry === undefined) return undefined;
            const index = await readIndex(scanned.projectRoot, config.indexDir);
            const saved = await writeIndex(scanned.projectRoot, config.indexDir, mergeAnnotation(index, normalized, patch));
            invalidate();
            return decorate(entry, saved, scanned.assetsRoot);
        },
        /**
         * 批量打标签：对一批资产做增量并集/差集。
         *
         * 一次读盘、一次写盘，绕过"逐条 annotate"的 N 次 IO。只统计当前扫描里
         * 真实存在的路径，其余计入 skipped —— 批量选择和磁盘之间隔了一次渲染，
         * 中间被删掉的文件不算错误。
         */
        async annotateMany(relPaths, patch) {
            const requested = Array.isArray(relPaths) ? relPaths : [];
            const unique = [...new Set(requested
                .filter((value) => typeof value === 'string')
                .map((value) => normalizeRelPath(value))
                .filter((value) => value !== undefined))];
            if (unique.length === 0) return { updated: 0, skipped: 0 };
            const scanned = await scan(undefined);
            const known = new Set(scanned.items.map((item) => item.relPath));
            const targets = unique.filter((value) => known.has(value));
            if (targets.length === 0) return { updated: 0, skipped: unique.length };
            let index = await readIndex(scanned.projectRoot, config.indexDir);
            for (const relPath of targets) {
                index = mergeAnnotationDelta(index, relPath, patch);
            }
            await writeIndex(scanned.projectRoot, config.indexDir, index);
            invalidate();
            return { updated: targets.length, skipped: unique.length - targets.length };
        },
        /**
         * 切换项目根。
         *
         * 空字符串表示"清除显式选择"，回到会话/进程默认（同时清掉"上次的项目"
         * 记忆，否则重启后又会跳回刚被放弃的那个目录）。路径必须存在且是目录，
         * 否则直接拒绝 —— 静默接受一个不存在的路径会让人以为插件坏了。
         */
        async setRoot(requested) {
            if (typeof requested !== 'string' || requested.trim() === '') {
                explicitRoot = undefined;
                rememberedRoot = null;
                rememberedRead = true;
                invalidate();
                await rememberProject('');
                return service.status();
            }
            const absolute = toAbsolute(requested, process.cwd());
            if (absolute === undefined) throw new Error('Invalid path');
            let info;
            try {
                info = await stat(absolute);
            } catch {
                throw new Error(`Path does not exist: ${absolute}`);
            }
            if (!info.isDirectory()) throw new Error(`Not a directory: ${absolute}`);
            explicitRoot = absolute;
            rememberedRoot = absolute;
            rememberedRead = true;
            invalidate();
            await rememberProject(absolute);
            return service.status();
        },
        /** 只读的目录速览，供 Agent 工具描述"这个项目里有什么"。 */
        async overview(scope) {
            const scanned = await scan(scope);
            return {
                projectRoot: scanned.projectRoot,
                assetsRoot: scanned.assetsRoot,
                counts: countsOf(scanned.items),
                truncated: scanned.truncated,
                folders: folderList(scanned.items).slice(0, 50),
                scannedAt: scanned.scannedAt,
            };
        },
    };
    return service;
}
