/**
 * 目录扫描：把一个项目文件夹变成一份资产清单。
 *
 * 扫描是**只读**的，也是无状态的：清单是文件系统的派生结果，索引文件只保存
 * 用户标注（标签/备注）。这样"资产"永远以磁盘为准 —— 你在资源管理器里删掉
 * 或重命名文件，资产库下一次扫描就跟着变，不会留下幽灵条目。
 *
 * 遍历规则：
 *  - 默认跳过点开头的目录（`.git`、`.dsh-assets` 等），`includeHidden` 可放开；
 *  - 跳过依赖与系统目录（`node_modules`、回收站等）；
 *  - 限制深度与文件总数，避免误把一个盘符当项目根时把进程拖死。
 */
import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { classify } from './kinds.js';
import { DIMENSION_EXTS, probeDimensions } from './dimensions.js';

/** 永不进入的目录名（无论是否允许隐藏文件）。 */
const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    '$RECYCLE.BIN',
    'System Volume Information',
]);

/** 默认遍历上限：这些数字是"防呆"，不是产品限制。 */
export const SCAN_DEFAULTS = {
    includeHidden: false,
    maxDepth: 8,
    maxFiles: 20_000,
};

/**
 * 统一的相对路径表示：始终用 `/` 分隔。
 *
 * 索引文件会被 git 提交、也可能被别的平台读，所以磁盘上的 `\` 不能进索引。
 *
 * @param root - 绝对根目录。
 * @param absolute - 绝对文件路径。
 * @returns 以 `/` 分隔的相对路径。
 */
export function toRelative(root, absolute) {
    return relative(root, absolute).split(sep).join('/');
}

/**
 * 递归扫描一个根目录下的全部资产文件。
 *
 * @param root - 绝对根目录（通常是 `<项目>/assets`）。
 * @param options - `includeHidden` / `maxDepth` / `maxFiles` 覆盖。
 * @returns `{ items, truncated }`；`items` 按相对路径排序，`truncated` 表示触到上限。
 */
export async function scanAssets(root, options = {}) {
    const includeHidden = options.includeHidden ?? SCAN_DEFAULTS.includeHidden;
    const maxDepth = options.maxDepth ?? SCAN_DEFAULTS.maxDepth;
    const maxFiles = options.maxFiles ?? SCAN_DEFAULTS.maxFiles;
    // 尺寸备忘录：relPath → { mtimeMs, size, width, height }。文件没变（mtime/size
    // 都相同）就复用上次探测结果，不再打开文件 —— 首次扫描付出一次头读取，之后
    // 每轮扫描对未变更文件是零成本。备忘录由调用方持有并按扫描结果收敛。
    const memo = options.memo instanceof Map ? options.memo : undefined;

    const items = [];
    let truncated = false;

    /**
     * 深度优先遍历。
     *
     * 目录读取失败（权限、被占用、扫描中途被删）只是跳过该分支：资产库是浏览
     * 工具，不该因为一个子目录读不了就整体失败。
     */
    async function walk(dir, depth) {
        if (items.length >= maxFiles) {
            truncated = true;
            return;
        }
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (items.length >= maxFiles) {
                truncated = true;
                return;
            }
            const name = entry.name;
            if (!includeHidden && name.startsWith('.')) continue;
            const absolute = join(dir, name);
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(name) || depth >= maxDepth) continue;
                await walk(absolute, depth + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            const ext = extname(name).toLowerCase();
            const kind = classify(ext);
            if (kind === undefined) continue;
            let info;
            try {
                info = await stat(absolute);
            } catch {
                continue;
            }
            const record = {
                relPath: toRelative(root, absolute),
                kind,
                ext,
                size: info.size,
                mtimeMs: Math.round(info.mtimeMs),
            };
            if (kind === 'image' && DIMENSION_EXTS.has(ext)) {
                const prior = memo?.get(record.relPath);
                const dims = prior !== undefined && prior.mtimeMs === record.mtimeMs && prior.size === record.size
                    ? { width: prior.width, height: prior.height }
                    : await probeDimensions(absolute, ext);
                if (dims !== undefined) {
                    record.width = dims.width;
                    record.height = dims.height;
                }
            }
            items.push(record);
        }
    }

    await walk(root, 0);
    items.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    return { items, truncated };
}

/**
 * 汇总各目录的直接子项，供界面的文件夹树使用。
 *
 * @param items - 扫描结果条目。
 * @returns 形如 `'images/封面' → { count, kinds }` 的映射（根目录用 `''`）。
 */
export function folderFacets(items) {    const facets = new Map();
    const bump = (dir, kind) => {
        let entry = facets.get(dir);
        if (entry === undefined) {
            entry = { count: 0, kinds: { image: 0, video: 0, audio: 0 } };
            facets.set(dir, entry);
        }
        entry.count += 1;
        entry.kinds[kind] += 1;
    };
    for (const item of items) {
        const cut = item.relPath.lastIndexOf('/');
        const dir = cut === -1 ? '' : item.relPath.slice(0, cut);
        bump(dir, item.kind);
        // 同时累加到每一级祖先，父目录的计数要包含子目录。
        let parent = dir;
        while (parent !== '') {
            const next = parent.lastIndexOf('/');
            parent = next === -1 ? '' : parent.slice(0, next);
            if (parent === '' && dir === '') break;
            bump(parent, item.kind);
            if (parent === '') break;
        }
    }
    return Object.fromEntries([...facets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/**
 * 与 {@link folderFacets} 同源，但输出**数组**。
 *
 * HTTP 面用数组而不是对象映射，理由很实际：根目录的键是空串，而
 * `{"": {...}}` 这类载荷会让 Windows PowerShell 5.1 的 `ConvertFrom-Json`
 * 直接报错（"the value of argument name is not valid"），任何用 PS 写脚本的
 * 用户都会踩到。数组还能保证顺序稳定，客户端不必自己排序。
 *
 * @param items - 扫描结果条目。
 * @returns `[{ dir, count, kinds }]`，按 `dir` 升序；根目录的 `dir` 为空串。
 */
export function folderList(items) {
    return Object.entries(folderFacets(items))
        .map(([dir, value]) => ({ dir, count: value.count, kinds: value.kinds }))
        .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}
