/**
 * 把工作区的源码覆盖到已安装的 desktop profile。
 *
 * 为什么需要这个脚本：`package.json` 是用 `file:` 规格安装的，pnpm 会把插件**复制**
 * 成实体目录（不是 junction），也不会按内容哈希检测变更 —— 所以改了工作区的源码，
 * 已安装的那一份保持原样，表现为"改了没反应"。必须手动同步。
 *
 * 为什么不用 `tools/sync-all.ps1`：它在某些环境里会被沙箱拦掉写入且不返回日志，
 * 看起来像"脚本坏了"。这里用 Node 直接做文件级覆盖拷贝，并且：
 *   - **不先删目录**，避免副本出现"文件缺失"的时间窗（插件是热加载的）；
 *   - 拷完逐个比对字节，只有全部一致才算成功；
 *   - `tools/` 与 `docs/` 不进交付面（`package.json` 的 `files` 里也没有它们）。
 *
 * 用法：
 *   node tools/sync-dev.mjs                    # 同步到默认 profile
 *   node tools/sync-dev.mjs "C:/some/other/node_modules/dsh-asset-library"
 *   node tools/sync-dev.mjs --check            # 只比对，不写入
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..');
const DEFAULT_TARGET = 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-asset-library';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const target = args.find((value) => !value.startsWith('--')) ?? DEFAULT_TARGET;

/** 交付面：与 `package.json` 的 `files` 保持一致，另加文档。 */
const ROOTS = ['index.js', 'client.js', 'icon.svg', 'cordis.patch.yml', 'LICENSE', 'README.md', 'CHANGELOG.md'];
const DIRS = ['lib', 'locale'];

async function listFiles() {
    const out = [];
    for (const file of ROOTS) {
        if (existsSync(join(source, file))) out.push(file);
    }
    for (const dir of DIRS) {
        const base = join(source, dir);
        if (!existsSync(base)) continue;
        for (const entry of await readdir(base, { withFileTypes: true })) {
            if (entry.isFile()) out.push(join(dir, entry.name));
        }
    }
    return out.map((value) => value.split(sep).join('/'));
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

const files = await listFiles();
if (files.length === 0) throw new Error('没有找到任何可同步的文件');
if (!existsSync(target)) throw new Error(`目标目录不存在：${target}`);

const changed = [];
const same = [];
for (const file of files) {
    const buffer = await readFile(join(source, file));
    const destination = join(target, file);
    const existing = existsSync(destination) ? await readFile(destination).catch(() => null) : null;
    if (existing !== null && sha(existing) === sha(buffer)) { same.push(file); continue; }
    changed.push(file);
    if (!checkOnly) {
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, buffer);
    }
}

// 覆盖完必须回读校验：拷贝成功但内容不同（编码、换行、写到别的地方）是最难发现的失败。
const mismatched = [];
for (const file of files) {
    const buffer = await readFile(join(source, file));
    const destination = join(target, file);
    const written = existsSync(destination) ? await readFile(destination).catch(() => null) : null;
    if (written === null || sha(written) !== sha(buffer)) mismatched.push(file);
}

console.log(`${checkOnly ? '比对' : '同步'} ${target}`);
console.log(`  文件 ${files.length} 个：一致 ${same.length}，${checkOnly ? '待更新' : '已更新'} ${changed.length}`);
if (changed.length > 0 && changed.length <= 12) console.log(`  ${checkOnly ? '待更新' : '已更新'}：${changed.join(', ')}`);
if (checkOnly && changed.length > 12) console.log(`  待更新（前 12 个）：${changed.slice(0, 12).join(', ')}…`);
if (mismatched.length > 0) {
    console.error(`  逐字节校验失败：${mismatched.join(', ')}`);
    process.exit(1);
}
console.log(mismatched.length === 0 ? '  逐字节校验：全部一致' : '');
