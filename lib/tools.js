/**
 * Agent 工具定义。
 *
 * 单独成模块是为了可测：工具的 `execute()` 是纯逻辑 + 内核调用，用 `defineTool`
 * 的替身（恒等函数）就能在 Node 里直接驱动，不需要起 GUI、不需要模型。
 *
 * 三个工具都是**只读**的：模型能检索、读元数据、拿绝对路径去引用，但不能改文件、
 * 不能打标签。写入只发生在界面里由人操作 —— 这条界线让"AI 动过我的素材"这件事
 * 永远不发生。
 */

/** 把一条资产格式化成模型读得懂的一行。 */
function formatLine(item) {
    const tags = item.tags.length > 0 ? `  [${item.tags.join(', ')}]` : '';
    return `${item.kind}\t${item.relPath}\t${item.size} B\t${new Date(item.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}${tags}`;
}

/**
 * 解析一次工具调用的作用域（项目根）。
 *
 * 优先级：显式 `root` 参数 → 当前会话的工作目录（`exec.agent.session.header.cwd`，
 * 这是"我正在这个项目里干活"最可靠的信号）→ `undefined`（交给内核按界面选择、
 * 配置、进程 cwd 回退）。
 *
 * @param args - 模型给的参数。
 * @param exec - 工具执行上下文（`{ agent?, signal? }`）。
 */
export function resolveScope(args, exec) {
    if (typeof args.root === 'string' && args.root.trim() !== '') return args.root.trim();
    const cwd = exec?.agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined;
}

/** 统一输出形态：一串给模型读的文本。 */
function asText() {
    return { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };
}

/**
 * 构造 Agent 工具定义。
 *
 * @param defineTool - `@deepseek-ai/dsh-tools` 的构造器（测试里传恒等函数）。
 * @param service - 资产库内核（`lib/service.js`）。
 * @param config - 已解析配置。
 * @returns 三个工具定义，交给 `ctx.tools.register()`。
 */
export function buildToolDefinitions(defineTool, service, config) {
    const rootParam = { type: 'string', description: '项目根目录绝对路径；省略时用当前会话的工作目录，或界面里选定的项目。' };

    const definitions = [
        defineTool({
            name: 'asset_library_list',
            description: '列出某个项目资产库里的图片、视频、音频。可按类型、关键词、标签、子目录过滤，并分页。返回每条资产的相对路径、类型、大小、修改时间与标签。',
            parameters: {
                root: rootParam,
                kind: { type: 'string', enum: ['image', 'video', 'audio'], description: '只看某一类资产；省略表示全部。' },
                q: { type: 'string', description: '关键词，匹配相对路径、标签或备注（大小写不敏感）。' },
                tag: { type: 'string', description: '只看带某个标签的资产。' },
                dir: { type: 'string', description: '只看某个子目录（相对扫描根，例如 images/封面）。' },
                sort: { type: 'string', enum: ['name', 'mtime', 'size'], description: '排序方式，默认 name。' },
                order: { type: 'string', enum: ['asc', 'desc'], description: '排序方向；省略时名称升序、修改时间与大小降序。' },
                limit: { type: 'number', description: `返回条数上限，默认 ${config.pageSize}，最大 200。` },
                offset: { type: 'number', description: '分页偏移，默认 0。' },
            },
            output: asText(),
            async execute(args, exec) {
                const payload = await service.list({
                    kind: args.kind,
                    q: typeof args.q === 'string' ? args.q : '',
                    tag: typeof args.tag === 'string' ? args.tag : '',
                    dir: typeof args.dir === 'string' ? args.dir : '',
                    sort: typeof args.sort === 'string' ? args.sort : 'name',
                    order: args.order === 'asc' || args.order === 'desc' ? args.order : undefined,
                    limit: Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.trunc(args.limit))) : config.pageSize,
                    offset: Number.isFinite(args.offset) ? Math.max(0, Math.trunc(args.offset)) : 0,
                }, resolveScope(args, exec));
                if (payload.items.length === 0) {
                    return `没有匹配的资产。\n扫描目录：${payload.assetsRoot}\n（该目录下现有 ${payload.counts.total} 个资产）`;
                }
                return [
                    `扫描目录：${payload.assetsRoot}`,
                    `匹配 ${payload.total} 项，返回第 ${payload.offset + 1}-${payload.offset + payload.items.length} 项${payload.hasMore ? '（还有更多，可加大 offset）' : ''}`,
                    `类型统计：图片 ${payload.filteredCounts.image} / 视频 ${payload.filteredCounts.video} / 音频 ${payload.filteredCounts.audio}`,
                    '类型\t相对路径\t大小\t修改时间\t标签',
                    ...payload.items.map(formatLine),
                ].join('\n');
            },
        }),
        defineTool({
            name: 'asset_library_get',
            description: '按相对路径读取单个资产的元数据，并返回它的绝对路径（可直接用于引用、读取或附带给用户）。',
            parameters: {
                root: rootParam,
                relPath: { type: 'string', required: true, description: '资产相对路径，来自 asset_library_list。' },
            },
            output: asText(),
            async execute(args, exec) {
                const item = await service.detail(String(args.relPath), resolveScope(args, exec));
                if (item === undefined) return `没有找到资产：${args.relPath}（可能已被移动或删除，可用 asset_library_list 重新查看）`;
                return [
                    `名称：${item.name}`,
                    `类型：${item.kind}（${item.ext}）`,
                    `大小：${item.size} B`,
                    Number.isFinite(item.width) && Number.isFinite(item.height) ? `尺寸：${item.width} × ${item.height}` : undefined,
                    `修改时间：${new Date(item.mtimeMs).toISOString()}`,
                    `相对路径：${item.relPath}`,
                    `绝对路径：${item.absolutePath}`,
                    `标签：${item.tags.length > 0 ? item.tags.join(', ') : '（无）'}`,
                    `备注：${item.note === '' ? '（无）' : item.note}`,
                ].filter((line) => line !== undefined).join('\n');
            },
        }),
        defineTool({
            name: 'asset_library_overview',
            description: '概览一个项目的资产库：扫描目录、各类资产数量、包含哪些子目录（每个子目录的计数）。不确定项目里有什么素材时先用它。',
            parameters: { root: rootParam },
            output: asText(),
            async execute(args, exec) {
                const payload = await service.overview(resolveScope(args, exec));
                const lines = [
                    `项目根目录：${payload.projectRoot}`,
                    `扫描目录：${payload.assetsRoot}`,
                    `合计：${payload.counts.total} 项（图片 ${payload.counts.image} / 视频 ${payload.counts.video} / 音频 ${payload.counts.audio}）`,
                    `扫描时间：${payload.scannedAt}${payload.truncated ? '（文件过多，结果被截断）' : ''}`,
                ];
                if (payload.folders.length > 0) {
                    lines.push('子目录：');
                    for (const folder of payload.folders) {
                        lines.push(`  ${folder.dir === '' ? '(根目录)' : folder.dir}\t${folder.count} 项\t图 ${folder.kinds.image} / 视 ${folder.kinds.video} / 音 ${folder.kinds.audio}`);
                    }
                }
                return lines.join('\n');
            },
        }),
    ];

    // 标注工具默认不注册：写入的默认界线是"人操作界面"。配置显式打开
    // `allowAgentAnnotate` 后模型才能改标注 —— 且仍然只能改标注，不能动文件。
    if (config.allowAgentAnnotate === true) {
        definitions.push(defineTool({
            name: 'asset_library_annotate',
            description: '给某个资产写标注（标签/备注）。只在用户明确要求整理或标注素材时使用；资产必须当前存在于扫描结果里。标签会被整体替换，备注同理。',
            parameters: {
                root: rootParam,
                relPath: { type: 'string', required: true, description: '资产相对路径，来自 asset_library_list。' },
                tags: { type: 'string', description: '逗号分隔的标签列表；提供时整体替换现有标签。' },
                note: { type: 'string', description: '备注文本；提供时替换现有备注。' },
            },
            output: asText(),
            async execute(args, exec) {
                const patch = {};
                if (typeof args.tags === 'string') {
                    const tags = args.tags.split(/[,，]/u).map((value) => value.trim()).filter((value) => value !== '');
                    if (tags.length > 0) patch.tags = tags;
                }
                if (typeof args.note === 'string' && args.note.trim() !== '') patch.note = args.note;
                if (patch.tags === undefined && patch.note === undefined) {
                    return '没有提供有效的标签或备注，什么都没有改。';
                }
                const item = await service.annotate(String(args.relPath ?? ''), patch, resolveScope(args, exec));
                if (item === undefined) return `没有找到资产：${args.relPath}（可能已被移动或删除，可用 asset_library_list 重新查看）`;
                return [
                    '已写入标注：',
                    `相对路径：${item.relPath}`,
                    `标签：${item.tags.length > 0 ? item.tags.join(', ') : '（无）'}`,
                    `备注：${item.note === '' ? '（无）' : item.note}`,
                ].join('\n');
            },
        }));
    }

    return definitions;
}
