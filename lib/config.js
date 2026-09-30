/**
 * 资产库配置。
 *
 * 每个字段都带默认值：profile 里那行插件写成 `{}`、或者测试里直接调用 `apply()`，
 * 都不该因为缺 key 而启动失败。
 *
 * `root` 为空串表示"没有显式指定项目根"，此时按 会话工作目录 → 进程 cwd 逐级回退。
 * 之所以用空串而不是 `null`：这个值会被写进 `cordis.patch.yml`，字符串在 YAML 里
 * 最不容易写错。
 */
import z from '@deepseek-ai/schemastery';

/** 出厂默认值；`apply()` 用它补齐未经 schema 的配置。 */
export const ASSET_LIBRARY_DEFAULTS = {
    root: '',
    assetsDir: 'assets',
    indexDir: '.dsh-assets',
    includeHidden: false,
    maxDepth: 8,
    maxFiles: 20_000,
    // 扫描缓存默认**关闭**：面板任何时候看到的都是磁盘当下的状态，改了文件、
    // 加了素材立刻就能看到。想省一次遍历可以显式给个毫秒数。
    cacheMs: 0,
    pageSize: 60,
    dshHome: '',
    // Agent 标注工具默认关闭：写入的界线仍然是"人操作界面"。显式打开后模型才
    // 拿到 asset_library_annotate，且只能改标注、永远不能动文件。
    allowAgentAnnotate: false,
};

/**
 * 配置 schema。
 *
 * `assetsDir` / `indexDir` 都是相对项目根的路径片段，不做绝对路径校验：用户在
 * `cordis.patch.yml` 里写什么都行，但只有实际存在（或写不进去）时才会体现出来，
 * 这比提前拒绝更难用错。
 */
export const Config = z.object({
    root: z.string().default(ASSET_LIBRARY_DEFAULTS.root),
    assetsDir: z.string().default(ASSET_LIBRARY_DEFAULTS.assetsDir),
    indexDir: z.string().default(ASSET_LIBRARY_DEFAULTS.indexDir),
    includeHidden: z.boolean().default(ASSET_LIBRARY_DEFAULTS.includeHidden),
    maxDepth: z.natural().min(1).max(32).default(ASSET_LIBRARY_DEFAULTS.maxDepth),
    maxFiles: z.natural().min(1).max(200_000).default(ASSET_LIBRARY_DEFAULTS.maxFiles),
    cacheMs: z.natural().max(600_000).default(ASSET_LIBRARY_DEFAULTS.cacheMs),
    pageSize: z.natural().min(1).max(200).default(ASSET_LIBRARY_DEFAULTS.pageSize),
    dshHome: z.string().default(ASSET_LIBRARY_DEFAULTS.dshHome),
    allowAgentAnnotate: z.boolean().default(ASSET_LIBRARY_DEFAULTS.allowAgentAnnotate),
});

/**
 * 把可能不完整的配置补成完整配置。
 *
 * 只要"调用方绕过了 schema"这一条存在（直接组合、单元测试），就需要这层归一化；
 * 顺带把空串 trim 掉，避免 `path.join(root, '')` 这类意外。
 *
 * @param config - `apply()` 收到的原始配置。
 * @returns 每个字段都存在的配置对象。
 */
export function resolveConfig(config) {
    const merged = { ...ASSET_LIBRARY_DEFAULTS, ...(config ?? {}) };
    return {
        ...merged,
        root: typeof merged.root === 'string' ? merged.root.trim() : '',
        assetsDir: typeof merged.assetsDir === 'string' && merged.assetsDir.trim() !== '' ? merged.assetsDir.trim() : ASSET_LIBRARY_DEFAULTS.assetsDir,
        indexDir: typeof merged.indexDir === 'string' && merged.indexDir.trim() !== '' ? merged.indexDir.trim() : ASSET_LIBRARY_DEFAULTS.indexDir,
        dshHome: typeof merged.dshHome === 'string' ? merged.dshHome.trim() : '',
        allowAgentAnnotate: merged.allowAgentAnnotate === true,
    };
}
