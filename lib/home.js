/**
 * Harness home 定位与插件自有 JSON 存储。
 *
 * `$DSH_HOME` 的解析规则**刻意自己实现**而不是 import `@deepseek-ai/dsh-home-paths`：
 * 那个包是开发期依赖，不是 peer 依赖，运行期 import 会让插件在没被提升到
 * node_modules 顶层的 profile 里直接加载失败。规则本身很短（显式路径 →
 * `DSH_HOME` → `~/.dsh`），照抄官方文档即可，代价远小于多一个运行期依赖。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 覆盖 harness home 的环境变量名。 */
const DSH_HOME_ENV = 'DSH_HOME';

/** 默认 harness home 目录名。 */
const DSH_HOME_DIR_NAME = '.dsh';

/** 展开 `~`、`~/`、`~\`；其它值原样返回。 */
export function expandHomePath(value) {
    if (value === '~') return homedir();
    if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
    return value;
}

/**
 * 解析 harness home。
 *
 * 空白字符串按"未设置"处理：一个空的 `DSH_HOME` 绝不能把 home 解析成当前目录。
 *
 * @param configured - 显式路径（插件配置里可覆盖）。
 * @returns 绝对路径。
 */
export function resolveDshHome(configured) {
    if (typeof configured === 'string' && configured.trim() !== '') return resolve(expandHomePath(configured.trim()));
    const fromEnv = process.env[DSH_HOME_ENV];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(expandHomePath(fromEnv.trim()));
    return join(homedir(), DSH_HOME_DIR_NAME);
}

/**
 * 读取一个 JSON 文件；缺失或损坏都返回 `undefined`。
 *
 * @param file - 绝对路径。
 */
export async function readJsonFile(file) {
    try {
        const raw = await readFile(file, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 原子写入 JSON。
 *
 * 桌面端退出是直接终结 harness 进程，非原子写入会留下半截文件；先写临时文件
 * 再 rename，读者要么看到旧内容、要么看到新内容。
 *
 * @param file - 绝对路径。
 * @param value - 可序列化对象。
 */
export async function writeJsonFile(file, value) {
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temp, file);
}
