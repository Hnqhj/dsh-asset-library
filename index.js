/**
 * 资产库 —— DeepSeek Harness host 半。
 *
 * 这个插件把"项目文件夹里的素材"变成两样东西：
 *
 *  1. `/api/asset-library/*`：面板用的 HTTP 面（列表、详情、媒体流、标注、重扫）；
 *  2. 三个只读 Agent 工具：模型能自己检索资产、读元数据、拿到绝对路径去引用。
 *
 * 两者共用同一个内核（`lib/service.js`），所以"人看到的"和"模型看到的"永远是
 * 同一份数据、同一套过滤语义。
 *
 * 设计取向（借鉴 @nanmicoder/dsh-skills-hub 的成熟做法）：
 *  - `inject` 故意留空：没有任何服务是"必须存在才能加载"的。Web 服务器与工具
 *    注册表都用 `ctx.get` 懒绑定，并在 `internal/service` 事件里重试 —— 这样
 *    headless profile 里插件是静默的，而不是永久 pending 在一个 Composition
 *    根本不提供的 key 上。
 *  - 浏览器信任栅栏按请求解析，绝不快照：Connection 行可能在本插件之后激活。
 *  - 所有注册都挂在 `ctx.effect` 上，卸载即回收。
 *  - 自检状态（web / tools 是否挂上）通过 `/status` 暴露，省得靠猜。
 */
import { Config, resolveConfig } from './lib/config.js';
import { createService } from './lib/service.js';
import { registerAssetLibraryRoutes } from './lib/routes.js';
import { buildToolDefinitions } from './lib/tools.js';

/** 插件名（loader 行的 id 与它一致）。 */
export const name = 'asset-library';

/** 见文件头：没有必需服务。 */
export const inject = [];

export { Config };

/** Web 服务器服务的两种拼写，新的在前（老组合叫 `httpServer`）。 */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];

/**
 * 激活插件。
 *
 * @param ctx - host 插件上下文。
 * @param config - 已由 schema 补全的配置（缺失时这里再补一次）。
 */
export function apply(ctx, config) {
    const resolved = resolveConfig(config);
    ctx.logger.info(`asset-library: ready (root=${resolved.root === '' ? 'session/cwd' : resolved.root}, assetsDir=${resolved.assetsDir})`);

    let disposed = false;
    ctx.effect(() => () => {
        disposed = true;
    }, 'asset-library: activation state');

    /** 自检状态：`/status` 会把它带出来。 */
    const state = { web: false, tools: { registered: false, names: [], reason: 'not attempted' } };

    /**
     * 会话工作目录。
     *
     * 宿主把会话放在 `ctx.sessions` 里。这里只做保守的启发式：取列表里第一个带
     * `cwd` 的会话（宿主按最近活动排序），拿不到就返回 `undefined`，由内核回退到
     * 进程 cwd。界面里显式选过的项目根永远优先于它。
     */
    const sessionProjectRoot = async () => {
        const sessions = ctx.get('sessions');
        if (sessions === undefined || typeof sessions.list !== 'function') return undefined;
        const list = await sessions.list();
        const entries = Array.isArray(list) ? list : Array.isArray(list?.items) ? list.items : [];
        for (const entry of entries) {
            const cwd = entry?.header?.cwd ?? entry?.cwd;
            if (typeof cwd === 'string' && cwd.trim() !== '') return cwd;
        }
        return undefined;
    };

    const service = createService({
        config: resolved,
        logger: ctx.logger,
        sessionProjectRoot,
        diagnostics: () => ({ web: state.web, tools: state.tools }),
    });

    // ---- HTTP 面：懒绑定，服务出现即注册
    const registerWebSurface = () => {
        if (state.web || disposed) return;
        const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
        if (webServer === undefined) return;
        // 栅栏是"每次请求解析"的函数：Connection 行可能后于本行激活，快照会留下
        // 一个永久空洞（等于把接口开放给任意网页）。
        const gate = () => ctx.get('connection');
        // `ctx.effect` 立即执行工厂；dsh-host-webserver 对重复路径会抛错，所以
        // 只有注册真的成功后才能把标志位置真——否则一次失败会变成永久激活失败。
        ctx.effect(() => registerAssetLibraryRoutes(webServer, gate, service), 'asset-library: HTTP API');
        state.web = true;
        ctx.logger.info('asset-library: HTTP API mounted at /api/asset-library');
    };
    registerWebSurface();

    ctx.on('internal/service', (serviceName) => {
        if (serviceName === WEB_SERVER_KEYS[0] || serviceName === WEB_SERVER_KEYS[1]) registerWebSurface();
    });

    // ---- Agent 工具：懒绑定 + 懒加载 defineTool
    const registerTools = async () => {
        if (state.tools.registered || disposed) return;
        const tools = ctx.get('tools');
        if (tools === undefined || typeof tools.register !== 'function') {
            state.tools.reason = 'tools service not present';
            return;
        }
        let defineTool;
        try {
            // 动态 import：`@deepseek-ai/dsh-tools` 由 dsh 安装本体提供。万一某个
            // 部署解析不到，代价是"没有 Agent 工具"，而不是整个插件加载失败
            // （面板和 HTTP 面仍然可用）。
            ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
        } catch (error) {
            state.tools.reason = `@deepseek-ai/dsh-tools unavailable: ${String(error)}`;
            state.tools.registered = true;
            ctx.logger.warn(`asset-library: agent tools unavailable (${String(error)})`);
            return;
        }
        if (typeof defineTool !== 'function' || disposed) return;
        const definitions = buildToolDefinitions(defineTool, service, resolved);
        ctx.effect(() => {
            const disposers = definitions.map((definition) => tools.register(definition));
            return () => {
                for (const dispose of disposers) {
                    if (typeof dispose === 'function') dispose();
                }
            };
        }, 'asset-library: agent tools');
        state.tools.registered = true;
        state.tools.names = definitions.map((definition) => definition.name);
        state.tools.reason = 'ok';
        ctx.logger.info(`asset-library: registered ${definitions.length} agent tool(s)`);
    };
    void registerTools();
    ctx.on('internal/service', (serviceName) => {
        if (serviceName === 'tools') void registerTools();
    });
}
