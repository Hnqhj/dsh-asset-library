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
 *   3. 插件配置里的 `root`；
 *   4. 会话工作目录（宿主提供时）；
 *   5. harness 进程的 cwd。
 *
 * 缓存按"实际扫描目录"分桶：Agent 在多个项目之间切换时不会互相把缓存冲掉。
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { folderList, scanAssets } from './scan.js';
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
    const projectsFile = join(resolveDshHome(config.dshHome), PROJECTS_FILE);

    /** 界面里显式选定的项目根。 */
    let explicitRoot;

    /** 扫描缓存：key 是实际扫描目录。 */
    const caches = new Map();

    /**
     * 尺寸备忘录：key 是实际扫描目录，值是 relPath → 探测结果。
     *
     * 故意**不**跟随 `invalidate()` 清空：重扫/换项目/写标注之后，未变更文件的
     * 尺寸依旧有效，清掉只会把"打开文件读头"的成本再付一遍。每轮扫描结束后
     * 按当前清单收敛，被删文件的条目随之消失。
     */
    const dimensionMemos = new Map();

    /** 同一目录上的并发扫描合并成一次。 */
    const inFlights = new Map();

    /** 丢掉所有扫描结果（重扫、换项目、写标注后调用）。 */
    const invalidate = () => {
        caches.clear();
        inFlights.clear();
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
     * 解析实际扫描的目录。
     *
     * 约定是 `<项目>/<assetsDir>`，但用户完全可能直接把插件指向资产目录本身。
     * 因此：子目录存在就用子目录，不存在就用该目录本身 —— "选项目"和"选资产
     * 文件夹"两种直觉都能用，且不需要额外的模式开关。
     */
    async function resolveAssetsRoot(scope) {
        const root = await resolveProjectRoot(scope);
        const conventional = join(root, config.assetsDir);
        try {
            const info = await stat(conventional);
            if (info.isDirectory()) return { projectRoot: root, assetsRoot: conventional, conventional: true };
        } catch {
            // 不存在就是"用户选的就是资产目录"，继续。
        }
        return { projectRoot: root, assetsRoot: root, conventional: false };
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
                const converged = new Map();
                for (const item of items) {
                    if (Number.isFinite(item.width)) {
                        converged.set(item.relPath, { mtimeMs: item.mtimeMs, size: item.size, width: item.width, height: item.height });
                    }
                }
                dimensionMemos.set(key, converged);
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
        /** 供路由做文件包含检查的绝对根。 */
        async rootAbs(scope) {
            return (await scan(scope)).assetsRoot;
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
         * 空字符串表示"清除显式选择"，回到会话/进程默认。路径必须存在且是目录，
         * 否则直接拒绝 —— 静默接受一个不存在的路径会让人以为插件坏了。
         */
        async setRoot(requested) {
            if (typeof requested !== 'string' || requested.trim() === '') {
                explicitRoot = undefined;
                invalidate();
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
            invalidate();
            const registryNow = await loadRegistry();
            const projects = [absolute, ...registryNow.projects.filter((value) => value !== absolute)].slice(0, PROJECT_HISTORY);
            await saveRegistry({ version: PROJECTS_VERSION, lastProject: absolute, projects });
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
