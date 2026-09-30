/**
 * 路径安全：所有来自浏览器的相对路径都必须落在项目根内。
 *
 * 威胁模型很具体：`/file?id=` 的参数完全由页面（以及任何能构造这个 URL 的
 * 东西）控制，而它的作用是"打开磁盘上的文件并流给调用方"。如果只做
 * `path.join(root, relPath)`，`../../` 与指向外部的符号链接都能读走任意文件。
 *
 * 因此每次打开文件都要过两道：
 *  1. **词法包含**：`path.resolve` 之后相对路径不得以 `..` 开头、不得是绝对路径；
 *  2. **真实路径包含**：`realpath` 解析软链接后再判一次，防止根目录里某个条目
 *     是指向外部文件的软链。
 */
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * 归一化成索引里使用的相对路径形式（`/` 分隔、无前导斜杠）。
 *
 * @param value - 任意用户输入。
 * @returns 规范化结果，非法输入返回 `undefined`。
 */
export function normalizeRelPath(value, maxLength = 1024) {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (trimmed === '' || trimmed.length > maxLength) return undefined;
    if (trimmed.includes('\0')) return undefined;
    const segments = trimmed.split('/');
    for (const segment of segments) {
        if (segment === '' || segment === '.' || segment === '..') return undefined;
    }
    return segments.join('/');
}

/**
 * 词法包含判断：候选路径是否位于根目录之内。
 *
 * @param root - 绝对根目录。
 * @param candidate - 绝对候选路径。
 * @returns 是否包含（根目录自身算包含）。
 */
export function isInside(root, candidate) {
    const rel = relative(resolve(root), resolve(candidate));
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * 打开一个用于流式返回的资产文件，并完成全部安全检查。
 *
 * @param root - 绝对根目录。
 * @param relPath - 已归一化的相对路径。
 * @returns `{ absolute, size, mtimeMs }`；文件不存在、不是普通文件、或逃出根目录时返回 `undefined`。
 */
export async function openAsset(root, relPath) {
    const absolute = resolve(root, relPath);
    if (!isInside(root, absolute)) return undefined;
    let info;
    try {
        // lstat 而不是 stat：根目录内的软链接本身就不该被当作资产打开。
        info = await lstat(absolute);
    } catch {
        return undefined;
    }
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    let real;
    let realRoot;
    try {
        real = await realpath(absolute);
        realRoot = await realpath(root);
    } catch {
        return undefined;
    }
    if (!isInside(realRoot, real)) return undefined;
    // 用 realpath 之后再 stat：拿到的是最终目标的大小与时间。
    try {
        const target = await stat(real);
        return { absolute: real, size: target.size, mtimeMs: Math.round(target.mtimeMs) };
    } catch {
        return undefined;
    }
}
