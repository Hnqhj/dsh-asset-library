/**
 * 索引文件（`<项目>/<indexDir>/index.json`）的读写。
 *
 * 索引**不是**资产清单的权威来源，磁盘才是。它只保存两类东西：
 *
 *  1. `roots` —— 这个项目用过的根目录（通常就是 `assets`），方便界面记住上次的选择；
 *  2. `annotations` —— 按相对路径索引的用户标注（标签、备注、加入时间）。
 *
 * 这样设计的原因：资产清单可以随时重扫得到，而标签是人的输入、丢了就没了。
 * 也因此索引必须能容忍"文件已经被删"的情况 —— 读取时不会去校验路径是否存在。
 *
 * 写入一律走"临时文件 + rename"，避免进程被杀（DSH 桌面端退出就是直接终结
 * harness 进程）时留下半截 JSON 把整个索引弄坏。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 索引文件名，固定放在 `<项目>/<indexDir>/` 下。 */
export const INDEX_FILE = 'index.json';

/** 索引结构版本；字段语义变化时递增。 */
export const INDEX_VERSION = 1;

/**
 * 索引文件绝对路径。
 *
 * @param root - 项目根目录（绝对）。
 * @param indexDir - 索引目录名（默认 `.dsh-assets`）。
 */
export function indexPath(root, indexDir) {
    return join(root, indexDir, INDEX_FILE);
}

/** 一份空索引。 */
function emptyIndex() {
    return { version: INDEX_VERSION, updatedAt: null, roots: [], annotations: {} };
}

/**
 * 读取索引；文件缺失或损坏时返回空索引而不是抛错。
 *
 * 损坏的索引（手改坏了、被别的工具写坏了）不该让资产库整个打不开：标注是可
 * 再生成的次要数据，而扫描完全不依赖它。
 *
 * @param root - 项目根目录。
 * @param indexDir - 索引目录名。
 * @returns 规范化后的索引对象。
 */
export async function readIndex(root, indexDir) {
    let raw;
    try {
        raw = await readFile(indexPath(root, indexDir), 'utf8');
    } catch {
        return emptyIndex();
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return emptyIndex();
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyIndex();
    const annotations = parsed.annotations !== null && typeof parsed.annotations === 'object' && !Array.isArray(parsed.annotations)
        ? parsed.annotations
        : {};
    const roots = Array.isArray(parsed.roots) ? parsed.roots.filter((value) => typeof value === 'string') : [];
    return {
        version: typeof parsed.version === 'number' ? parsed.version : INDEX_VERSION,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        roots,
        annotations,
    };
}

/**
 * 原子写入索引。
 *
 * @param root - 项目根目录。
 * @param indexDir - 索引目录名。
 * @param index - 完整索引对象。
 */
export async function writeIndex(root, indexDir, index) {
    const target = indexPath(root, indexDir);
    await mkdir(dirname(target), { recursive: true });
    const payload = { ...index, version: INDEX_VERSION, updatedAt: new Date().toISOString() };
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(temp, target);
    return payload;
}

/**
 * 合并一条标注。
 *
 * 只覆盖显式传入的字段：`tags` 与 `note` 各自独立，界面改备注不会清掉标签。
 *
 * @param index - 现有索引。
 * @param relPath - 资产的相对路径（作为标注的键）。
 * @param patch - `{ tags?, note? }`。
 * @returns 新的索引对象（不修改入参）。
 */
export function mergeAnnotation(index, relPath, patch) {
    const previous = index.annotations[relPath] ?? {};
    const next = { ...previous };
    if (Array.isArray(patch.tags)) {
        const seen = new Set();
        const tags = [];
        for (const tag of patch.tags) {
            if (typeof tag !== 'string') continue;
            const value = tag.trim();
            if (value === '' || seen.has(value)) continue;
            seen.add(value);
            tags.push(value.slice(0, 64));
            if (tags.length >= 32) break;
        }
        next.tags = tags;
    }
    if (typeof patch.note === 'string') next.note = patch.note.slice(0, 2000);
    if (previous.addedAt === undefined) next.addedAt = new Date().toISOString();
    return { ...index, annotations: { ...index.annotations, [relPath]: next } };
}

/**
 * 增量合并一条标注（批量打标签用）。
 *
 * 与 {@link mergeAnnotation} 的"整体替换"不同，这里只做并集/差集：给一批资产
 * **加**一个标签或从一批资产**去掉**一个标签，是批量场景里仅有的两种合理语义
 * —— "把这批的标签整体设成同一个"只会摧毁彼此不同的既有标注。
 *
 * @param index - 现有索引。
 * @param relPath - 资产的相对路径（作为标注的键）。
 * @param patch - `{ tagsAdd?, tagsRemove? }`。
 * @returns 新的索引对象（不修改入参）。
 */
export function mergeAnnotationDelta(index, relPath, patch) {
    const previous = index.annotations[relPath] ?? {};
    const next = { ...previous };
    const tags = Array.isArray(next.tags) ? [...next.tags] : [];
    if (Array.isArray(patch.tagsAdd)) {
        const seen = new Set(tags);
        for (const raw of patch.tagsAdd) {
            if (typeof raw !== 'string') continue;
            const value = raw.trim().slice(0, 64);
            if (value === '' || seen.has(value)) continue;
            seen.add(value);
            tags.push(value);
            if (tags.length >= 32) break;
        }
        next.tags = tags;
    }
    if (Array.isArray(patch.tagsRemove)) {
        const drop = new Set(patch.tagsRemove
            .filter((value) => typeof value === 'string')
            .map((value) => value.trim())
            .filter((value) => value !== ''));
        if (drop.size > 0) next.tags = tags.filter((value) => !drop.has(value));
    }
    if (previous.addedAt === undefined) next.addedAt = new Date().toISOString();
    return { ...index, annotations: { ...index.annotations, [relPath]: next } };
}

/**
 * 记住一个用过的根目录。
 *
 * @param index - 现有索引。
 * @param rootPath - 相对项目根的根目录（`/` 分隔）。
 * @returns 新的索引对象。
 */
export function rememberRoot(index, rootPath, limit = 8) {
    const roots = [rootPath, ...index.roots.filter((value) => value !== rootPath)].slice(0, limit);
    return { ...index, roots };
}
