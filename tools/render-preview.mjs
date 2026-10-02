/**
 * 面板离屏预览生成器（开发用，不进交付产物）。
 *
 * 为什么需要它：`client.js` 是给 DSH 宿主在浏览器里跑的，没有构建、没有可独立打开的
 * 页面。改完视觉如果只跑断言，只能证明"结构还在"，证明不了"看起来是否干净"。
 *
 * 做法：用 `tools/client-test.mjs` 里同一套迷你渲染器把 `<Panel>` 渲染成一棵
 * 宿主元素树，再序列化成静态 HTML，配上 DSH 的浅色 token 与真实 CSS。于是"视觉"
 * 变成一个可以用无头浏览器截图、逐像素看的产物，而不是凭代码想象。
 *
 * 五个视图：
 *   grid   默认网格（表头 + 筛选行 + 卡片）
 *   menu   项目下拉展开（最近项目 / 手动输入）
 *   detail 放大卡片（详情工具条 + 左媒体右信息）
 *   filter 标签筛选态（匹配计数 + 高亮 chip）
 *   batch  批量选择态（卡片选中 + 批量操作条）
 *
 * 状态注入的小技巧：迷你渲染器的 hook 槽位是 `组件名#序号` 的数组，`useState` 只在
 * `slots[i] === undefined` 时初始化 —— 所以直接往槽位里预置值，就能跳过"模拟点击"
 * 直接渲染出目标状态（下拉展开、详情打开）。这比在无头浏览器里模拟交互可靠得多。
 * 槽位下标一律用 `panelHookIndex(变量名)` 从源码解析，不要写死数字。
 *
 * 用法：
 *   node tools/render-preview.mjs             # 生成全部 html
 *   node tools/render-preview.mjs grid        # 只生成一个
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '..');
const outDirArg = process.argv.indexOf('--out-dir');
const outDir = outDirArg === -1 ? join(pluginDir, 'docs', 'preview') : resolve(process.argv[outDirArg + 1]);

// ------------------------------------------------------------------ 迷你渲染器
const scopes = new Map();
let currentSlots = [];
let hookCursor = 0;
let currentKey = 'root';
let pendingEffects = [];

function beginScope(key) {
    currentKey = key;
    if (!scopes.has(key)) scopes.set(key, []);
    currentSlots = scopes.get(key);
    hookCursor = 0;
}
function renderScoped(key, component, props) {
    const previousKey = currentKey;
    const previousSlots = currentSlots;
    beginScope(key);
    try {
        return component(props);
    } finally {
        currentKey = previousKey;
        currentSlots = previousSlots;
    }
}
function createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) };
    const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
    if (flat !== undefined) merged.children = merged.children === undefined ? flat : [merged.children, flat].flat(Infinity);
    return { type, props: merged, children: flat };
}
const ReactStub = {
    createElement,
    useState(initial) {
        const slots = currentSlots;
        const index = hookCursor++;
        // 槽位包一层 `{ value }`：状态值本身可能是 undefined（`kind` 的"全部"就是 undefined），
        // 用 `slots[index] === undefined` 判"没初始化"会把两者混同 —— 表现为"点了全部没反应"。
        if (slots[index] === undefined) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
        const setter = (value) => {
            const next = typeof value === 'function' ? value(slots[index].value) : value;
            slots[index] = { value: next };
        };
        return [slots[index].value, setter];
    },
    useEffect(fn, deps) {
        const slots = currentSlots;
        const index = hookCursor++;
        const previous = slots[index];
        const first = previous === undefined;
        const changed = first || deps === undefined || previous.deps === undefined
            || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]));
        if (!changed) return;
        slots[index] = { deps, cleanup: first ? undefined : previous.cleanup, pending: fn };
        pendingEffects.push(() => {
            const entry = slots[index];
            if (entry === undefined || typeof entry.pending !== 'function') return;
            if (typeof entry.cleanup === 'function') entry.cleanup();
            const cleanup = entry.pending();
            entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
            entry.pending = undefined;
        });
    },
    useCallback(fn, deps) {
        const slots = currentSlots;
        const index = hookCursor++;
        const previous = slots[index];
        const changed = previous === undefined || deps === undefined
            || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]));
        if (!changed) return previous.fn;
        slots[index] = { deps, fn };
        return fn;
    },
    useMemo(fn) { hookCursor += 1; return fn(); },
    useRef(initial) {
        const index = hookCursor++;
        if (currentSlots[index] === undefined) currentSlots[index] = { current: initial };
        return currentSlots[index];
    },
};
function flushEffects() {
    const queue = pendingEffects.splice(0);
    for (const fn of queue) fn();
}
/**
 * 遍历元素树并展开函数组件。
 *
 * `counts` 必须是**每次调用新建**的 Map：它决定 `组件名#序号` 这个 hook 槽位的键，
 * 一旦跨调用复用，第二次遍历就会把 `AssetCard#0` 算成 `AssetCard#4`，状态全部读错
 * （表现为"卡片一个都不渲染"这种看起来毫不相干的症状）。
 */
function forEachNode(tree, onElement, onText) {
    const counts = new Map();
    (function step(node) {
        if (node === null || node === undefined || typeof node === 'boolean') return;
        if (Array.isArray(node)) { for (const child of node) step(child); return; }
        if (typeof node === 'string' || typeof node === 'number') { onText(String(node)); return; }
        if (typeof node.type === 'function') {
            const name = node.type.name || 'anon';
            const index = counts.get(name) ?? 0;
            counts.set(name, index + 1);
            step(renderScoped(`${name}#${index}`, node.type, node.props));
            return;
        }
        onElement(node);
        step(node.props?.children ?? node.children);
    })(tree);
}
function collect(tree) {
    const elements = [];
    const texts = [];
    const styleSheets = [];
    forEachNode(tree, (node) => {
        const props = node.props ?? {};
        elements.push({ type: node.type, props });
        if (node.type === 'style') styleSheets.push(Array.isArray(props.children) ? props.children.join('') : String(props.children ?? ''));
    }, (text) => texts.push(text));
    return { elements, texts, styleSheets, flat: texts.join(' | ') };
}

// ------------------------------------------------------------------ 假数据
const palette = ['#4c6ef5', '#f06c3c', '#12b886', '#e8590c', '#7048e8', '#f59f00', '#1098ad', '#d6336c'];
const dataUri = (index, w, h) => {
    const a = palette[index % palette.length];
    const b = palette[(index + 3) % palette.length];
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>`
        + `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>`
        + `<stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs>`
        + `<rect width='100%' height='100%' fill='url(#g)'/>`
        + `<circle cx='${w * 0.7}' cy='${h * 0.35}' r='${Math.round(Math.min(w, h) * 0.18)}' fill='rgba(255,255,255,.35)'/>`
        + `<rect x='${w * 0.1}' y='${h * 0.72}' width='${w * 0.5}' height='${Math.max(6, h * 0.05)}' rx='4' fill='rgba(255,255,255,.5)'/>`
        + '</svg>';
    // 必须整段百分号编码：SVG 里的 `#`（`stop-color='#4c6ef5'`）在 data URI 里是片段分隔符，
    // 不编码就会把 URI 从第一个 `#` 处截断，<img> 加载失败并显示 alt 文本 —— 看起来像
    // "文件名被画在了缩略图上"，其实是预览夹具自己的问题。
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const names = [
    ['images', 'cover-ep01.png', 'image', 1920, 1080],
    ['images', 'cover-ep01-portrait.png', 'image', 1080, 1920],
    ['images', 'char-chen-shi-ref.png', 'image', 1600, 900],
    ['images', 'char-lu-chenyuan-ref.png', 'image', 1600, 900],
    ['images', 'location-old-house.png', 'image', 2400, 1200],
    ['images', 'location-corridor.png', 'image', 2048, 1024],
    ['images', 'prop-lantern.png', 'image', 1200, 1200],
    ['video', 'scene-01.mp4', 'video', 1920, 1080],
    ['video', 'scene-02.mp4', 'video', 1920, 1080],
    ['video', 'opening-shot.mp4', 'video', 3840, 2160],
    ['video', 'bts-walkthrough.mov', 'video', 1920, 1080],
    ['audio', 'theme-main.wav', 'audio', 0, 0],
    ['audio', 'ambience-rain.wav', 'audio', 0, 0],
    ['audio', 'sfx-door-close.wav', 'audio', 0, 0],
    ['images', 'storyboard-sheet-01.png', 'image', 3200, 1800],
    ['images', 'storyboard-sheet-02.png', 'image', 3200, 1800],
];
const tagPool = [['主封面', 'ep1'], ['人物设定'], ['人物设定'], ['人物设定'], ['场景'], ['场景'], ['道具'], [], ['分镜'], ['分镜'], [], ['配乐'], ['环境声'], [], ['分镜', '待定'], ['分镜']];
const assets = names.map(([dir, name, kind, width, height], index) => ({
    relPath: `${dir}/${name}`,
    kind,
    ext: name.slice(name.lastIndexOf('.')),
    size: 220000 + index * 41190,
    mtimeMs: Date.now() - index * 3600_000,
    id: `${dir}/${name}`,
    name,
    dir,
    tags: tagPool[index] ?? [],
    note: '',
    addedAt: null,
    absolutePath: `G:\\工作\\短剧A\\assets\\${dir}\\${name}`,
    width,
    height,
}));
const counts = { image: 8, video: 4, audio: 3, total: 15 };
const status = {
    projectRoot: 'G:\\工作\\短剧A',
    assetsRoot: 'G:\\工作\\短剧A\\assets',
    conventional: true,
    counts,
    truncated: false,
    scannedAt: new Date().toISOString(),
    capabilities: ['assets', 'file', 'tree', 'annotate', 'root', 'reveal'],
    folders: counts.image + counts.video + counts.audio,
    recentProjects: ['G:\\工作\\短剧A', 'G:\\工作\\短片B-醒来', 'G:\\工作\\OPHELIA-FELIX'],
    tagFacets: [
        { tag: '分镜', count: 4 },
        { tag: '主封面', count: 1 },
        { tag: '人物设定', count: 3 },
        { tag: '场景', count: 2 },
    ],
    diagnostics: { web: true, tools: { registered: true, names: ['asset_library_list'] } },
    config: { assetsDir: 'assets', includeHidden: false, maxDepth: 8 },
};

const fetchCalls = [];
const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });
async function fakeFetch(url, init) {
    const text = String(url);
    fetchCalls.push({ url: text, method: init?.method ?? 'GET' });
    if (text.includes('/status')) return jsonResponse(status);
    if (text.includes('/assets?')) {
        const params = new URLSearchParams(text.slice(text.indexOf('?') + 1));
        const kind = params.get('kind');
        const tag = params.get('tag');
        const limit = Number(params.get('limit') ?? 60);
        const filtered = assets
            .filter((item) => kind === null || item.kind === kind)
            .filter((item) => tag === null || item.tags.includes(tag));
        return jsonResponse({ items: filtered.slice(0, limit), total: filtered.length, hasMore: filtered.length > limit });
    }
    if (text.includes('/file?')) return { ok: true, status: 200, blob: async () => ({ size: 240000, type: 'image/jpeg' }) };
    if (text.includes('/annotate')) return jsonResponse({ ok: true });
    if (text.includes('/root') || text.includes('/rescan')) return jsonResponse(status);
    throw new Error(`unexpected fetch: ${text}`);
}

// ------------------------------------------------------------------ 以浏览器的方式加载 client.js
let captured;
const sandbox = {
    window: {
        __ModuleLoader__: { load: (definition) => { captured = definition; } },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        matchMedia: () => ({ matches: false }),
    },
    document: {
        documentElement: { lang: 'zh-CN' },
        createElement: (tag) => {
            if (tag === 'video') {
                return {
                    duration: 12.5,
                    videoWidth: 1920,
                    videoHeight: 1080,
                    currentTime: 0,
                    muted: false,
                    preload: '',
                    set src(_value) { setTimeout(() => { if (typeof this.onloadedmetadata === 'function') this.onloadedmetadata(); }, 0); },
                    get src() { return ''; },
                    set onseeked(fn) { this._seeked = fn; setTimeout(() => fn?.(), 0); },
                    get onseeked() { return this._seeked; },
                    removeAttribute() {},
                    load() {},
                };
            }
            return {
                width: 0,
                height: 0,
                getContext: () => ({
                    drawImage() {},
                    getImageData: (x, y, w, h) => ({ data: [76, 110, 245, 255], width: w, height: h }),
                }),
                toBlob: (resolve) => resolve({ size: 100, type: 'image/jpeg' }),
            };
        },
    },
    navigator: { language: 'zh-CN', storage: undefined, clipboard: { writeText: async () => undefined } },
    localStorage: { getItem: () => null, setItem: () => undefined },
    IntersectionObserver: undefined,
    // 有 createImageBitmap 才会走"浏览器里降采样"这条路（也就是真实产品路径）；
    // 没有的话直接退回原图 URL，预览里会是一片空白，看不出卡片长什么样。
    createImageBitmap: async () => ({ width: 1920, height: 1080, close() {} }),
    URLSearchParams,
    URL: {
        // 预览页要让 <img> 真的显示东西，所以给出内联 SVG data URI（Node 的 blob: URL
        // 在浏览器里不认识，换成 data: 才能被无头浏览器画出来）。
        //
        // 缩略图按**资产自己的宽高比**出图（上限 480 长边），而不是一律 480×320 ——
        // 全用同一个比例的话，竖图在 contain 模式下看起来和 cover 一模一样，
        // 截出来的对照图就证明不了任何事。
        createObjectURL: (() => {
            let n = 0;
            return () => {
                const item = assets[n] ?? assets[0];
                n += 1;
                const long = 480;
                const w = item.width > 0 && item.height > 0 && item.width >= item.height ? long : Math.round((item.width || 3) / (item.height || 4) * long);
                const h = item.width > 0 && item.height > 0 && item.width >= item.height ? Math.round((item.height / item.width) * long) : long;
                return dataUri(n, Math.max(120, w), Math.max(120, h));
            };
        })(),
        revokeObjectURL: () => undefined,
    },
    fetch: fakeFetch,
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
};
// `--client <路径>` 可以渲染任意一版 client.js（例如 `git show HEAD:client.js` 导出的旧版），
// 用来出前后对比图。默认渲染工作区里当前这一份。
const clientArgIndex = process.argv.indexOf('--client');
const clientPath = clientArgIndex === -1 ? join(pluginDir, 'client.js') : resolve(process.argv[clientArgIndex + 1]);
vm.createContext(sandbox);
const clientSource = await readFile(clientPath, 'utf8');
vm.runInContext(clientSource, sandbox, { filename: clientPath });

/**
 * 按变量名解析 `<Panel>` 里某个 hook 的槽位下标。
 *
 * 为什么不在调用处写死数字：槽位下标 = hook 在函数体里的出现次序，任何一次
 * "在中间加一个 useState" 都会把后面全部错位，而且**错位是静默的** —— 预置到
 * 错的槽位上，渲染出来只是"少了那条批量操作条"，不会报错。写名字则由源码保证一致。
 */
function panelHookIndex(name) {
    const start = clientSource.indexOf('function Panel(props) {');
    if (start === -1) throw new Error('client.js 里找不到 Panel 函数定义');
    // 从函数体的 `{` 开始配平花括号，切出 Panel 的完整代码块。
    let depth = 0;
    let end = -1;
    for (let i = clientSource.indexOf('{', start); i < clientSource.length; i += 1) {
        const char = clientSource[i];
        if (char === '{') depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) { end = i; break; }
        }
    }
    if (end === -1) throw new Error('Panel 函数体花括号不配平');
    const body = clientSource.slice(start, end);
    // 依次匹配三类 hook：useState 解构、useMemo/useCallback/useRef 赋值、裸 useEffect。
    const pattern = /const\s*\[\s*(\w+)\s*,[^\]]*\]\s*=\s*useState\(|const\s+(\w+)\s*=\s*use(?:Memo|Callback|Ref)\s*\(|useEffect\(/gu;
    let index = 0;
    for (const match of body.matchAll(pattern)) {
        const declared = match[1] ?? match[2];
        if (declared === name) return index;
        index += 1;
    }
    throw new Error(`Panel 里找不到名为 ${name} 的 hook 槽位`);
}

const registrations = [];

/**
 * 预置一个 hook 槽位。
 *
 * 槽位存的是 `{ value }`（见下面 ReactStub.useState 的注释），所以**不能**写裸值：
 * 写 `slots[i] = 'cover'` 的话，读的时候拿到的是 `undefined`，预置被静默丢弃 ——
 * 而且不报错，只是"截图里看不到我预置的那个状态"，非常难查。
 */
const preset = (slots, index, value) => { slots[index] = { value }; };
let dictionary = {};
captured.factory((id) => {
    if (id === 'react') return ReactStub;
    throw new Error(`unexpected require: ${id}`);
}).apply({
    effect: (factory) => factory(),
    locale: {
        // 宿主注入的翻译函数就是"在这个命名空间的字典里查表"，这里照做即可。
        register: (_ns, dicts) => { dictionary = dicts; return () => undefined; },
        bind: () => (key) => dictionary.zh?.[key] ?? key,
    },
    slots: {
        inject: (_slot, callback) => {
            const result = typeof callback === 'function' ? callback() : undefined;
            if (result !== undefined && typeof result?.next === 'function') {
                let step = result.next();
                while (!step.done) step = result.next();
            }
        },
        register: (options, component) => { registrations.push({ options, component }); return () => undefined; },
    },
});
const Panel = registrations.find((entry) => entry.options.name === 'main')?.component;
if (Panel === undefined) throw new Error('Panel 未注册');
const t = (key) => dictionary.zh?.[key] ?? key;

// ------------------------------------------------------------------ 渲染
const settle = async (times = 8) => { for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/**
 * 跑"渲染 → 提交副作用 → setState → 再渲染"若干轮，让异步数据落定，最后返回元素树。
 *
 * `seed.panel` 在第一帧之前写槽位，适合"挂载时就该在的状态"（下拉展开、详情打开、
 * 筛选条件）。`seed.latePanel` 等到第 3 轮（items 已加载）之后才写 —— 因为 Panel 里
 * 有一条 effect 会在 items 变化时把选择集合收敛成"仍然存在的路径"，首帧 items 为空，
 * 此时写进去的选择会被那次收敛清空，必须等数据到位再写。
 *
 * `seed.player` 预置 MediaPlayer 的三个 state（正在播 / 当前时间 / 总时长）。槽位值
 * 要写成 `{ value }` —— 和上面 useState 的存法一致；直接写裸值会被读成"没初始化"然后
 * 被初始值覆盖，预置就静默失效了。
 */
async function renderTree(seed) {
    scopes.clear();
    if (seed?.panel !== undefined) scopes.set('Panel#0', seed.panel);
    if (seed?.dropdown !== undefined) scopes.set(`Dropdown#${seed.dropdown.index}`, seed.dropdown.slots);
    if (seed?.player !== undefined) scopes.set(`MediaPlayer#${seed.player.index}`, seed.player.slots);
    let tree = renderScoped('Panel#0', Panel, { t });
    for (let round = 0; round < 6; round += 1) {
        collect(tree);
        flushEffects();
        await settle(6);
        if (round === 2 && seed?.latePanel !== undefined) {
            const slots = scopes.get('Panel#0');
            for (const [index, value] of Object.entries(seed.latePanel)) slots[Number(index)] = value;
        }        tree = renderScoped('Panel#0', Panel, { t });
    }
    collect(tree);
    flushEffects();
    await settle(6);
    return renderScoped('Panel#0', Panel, { t });
}

// ------------------------------------------------------------------ 序列化成 HTML
const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'source', 'meta', 'link']);
const ATTR_ALIAS = { className: 'class', htmlFor: 'for', tabIndex: 'tabindex' };
const escapeText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (value) => escapeText(value).replace(/"/g, '&quot;');
/**
 * React 的 `style={{minWidth: 320}}` 会补成 `320px`，序列化时必须照做。
 * 漏了单位会写出被浏览器整条丢弃的 `min-width:320`，表现为"这个样式完全没生效"
 * （比如下拉面板宽度塌掉、输入框被挤成 0 宽），很容易误判成产品 bug。
 */
const UNITLESS_PROPS = new Set([
    'opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink',
    'order', 'zoom', 'aspectRatio', 'tabSize', 'columnCount', 'gridColumn', 'gridRow',
]);
function styleToCss(style) {
    return Object.entries(style).map(([key, value]) => {
        const prop = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        const css = typeof value === 'number' && value !== 0 && !UNITLESS_PROPS.has(key) ? `${value}px` : value;
        return `${prop}:${css}`;
    }).join(';');
}
/**
 * 把元素树序列化成 HTML。
 *
 * 必须自己展开函数组件（而不是交给 `collect`）——否则 `<AssetCard>` 这类组件会
 * 被整棵丢掉，截出来是一个空网格，看着像"卡片没渲染"，其实只是序列化器跳过了它。
 * 展开用的 `组件名#序号` 计数规则必须与 `forEachNode` 一致，预置的 hook 槽位才对得上。
 */
/**
 * 把指向宿主媒体端点的 `<img src>` 换成同一张资产的占位图。
 *
 * 缩略图走的是"缓存优先"路径（夹具里 `URL.createObjectURL` 返回内联 SVG），所以网格里的
 * 图都是好的；但参照图钉这类直接用 `fileUrl()` 的地方会指向一个预览里不存在的端点，
 * 于是截图上出现"碎图 + alt 文本"。按 relPath 找回同一个资产的配色，观感就对上了。
 */
function previewSrc(value) {
    if (typeof value !== 'string' || !value.includes('/file?')) return value;
    const match = /relPath=([^&]+)/u.exec(value);
    if (match === null) return dataUri(0, 320, 180);
    const relPath = decodeURIComponent(match[1]);
    const index = assets.findIndex((asset) => asset.relPath === relPath);
    return dataUri(index === -1 ? 0 : index, 320, 180);
}

function serializeTree(tree) {
    const counts = new Map();
    return serialize(tree);

    function serialize(node) {
        if (node === null || node === undefined || typeof node === 'boolean') return '';
        if (Array.isArray(node)) return node.map(serialize).join('');
        if (typeof node === 'string' || typeof node === 'number') return escapeText(node);
        if (typeof node.type === 'function') {
            const name = node.type.name || 'anon';
            const index = counts.get(name) ?? 0;
            counts.set(name, index + 1);
            return serialize(renderScoped(`${name}#${index}`, node.type, node.props));
        }
        return element(node);
    }

    function element(node) {
        const props = node.props ?? {};
        const attrs = [];
        for (const [key, value] of Object.entries(props)) {
            if (key === 'children' || key === 'key' || key === 'ref' || key === 'dangerouslySetInnerHTML') continue;
            if (/^on[A-Z]/.test(key)) continue;
            if (value === undefined || value === null || value === false) continue;
            if (key === 'style') { if (typeof value === 'object') attrs.push(`style="${escapeAttr(styleToCss(value))}"`); continue; }
            if (value === true) { attrs.push(key); continue; }
            // 预览里没有宿主的媒体端点：凡是直接指向 `/file?...` 的 <img>（参照图钉、
            // 用不到缓存路径的那些）换成本地占位图。否则截图里会出现"碎图 + alt 文本"，
            // 看起来像面板坏了，其实只是预览夹具的短板。
            if (key === 'src') { attrs.push(`src="${escapeAttr(previewSrc(value))}"`); continue; }
            attrs.push(`${ATTR_ALIAS[key] ?? key}="${escapeAttr(value)}"`);
        }
        const tag = node.type;
        const open = `<${tag}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`;
        if (VOID_TAGS.has(tag)) return open;
        return `${open}${serialize(props.children ?? node.children)}</${tag}>`;
    }
}

// DSH 浅色主题（neutral-bluish）的 token 取值；只为了预览真实观感，不做精确复刻。
const TOKENS = `
:root{
  --dsw-font-family:'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,'Microsoft YaHei UI',sans-serif;
  --dsw-radius-sm:6px;--dsw-radius-md:8px;
  --dsw-alias-bg-base:#ffffff;
  --dsw-alias-bg-layer-1:#ffffff;
  --dsw-alias-bg-layer-2:#f2f3f5;
  --dsw-alias-bg-skeleton:rgba(15,17,21,.05);
  --dsw-alias-bg-mask-photo:rgba(15,17,21,.45);
  --dsw-alias-label-primary:#14171c;
  --dsw-alias-label-secondary:#4a4f57;
  --dsw-alias-label-tertiary:#82868d;
  --dsw-alias-label-primary-inverted:#ffffff;
  --dsw-alias-label-primary-foreground:#ffffff;
  --dsw-alias-border-l1:rgba(15,17,21,.07);
  --dsw-alias-border-l2:rgba(15,17,21,.13);
  --dsw-alias-border-inverted:rgba(255,255,255,.7);
  --dsw-alias-interactive-bg-hover:rgba(15,17,21,.045);
  --dsw-alias-interactive-bg-active:rgba(15,17,21,.085);
  --dsw-alias-brand-primary:#1f6feb;
  --dsw-alias-state-error-primary:#d93025;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#eceef1}
body{display:flex;align-items:flex-start;justify-content:center;padding:24px;font-family:var(--dsw-font-family)}
#frame{width:1180px;height:720px;overflow:hidden;border:1px solid rgba(15,17,21,.1);border-radius:10px;background:var(--dsw-alias-bg-base)}
`;

function page({ title, body, css }) {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeText(title)}</title>
<style>${TOKENS}</style>
<style>${css}</style>
</head><body><div id="frame">${body}</div></body></html>`;
}

// ------------------------------------------------------------------ 生成
const VIEW_NAMES = ['grid', 'menu', 'detail', 'player', 'audio', 'fit', 'filter', 'batch'];
const requested = process.argv.slice(2).filter((value) => VIEW_NAMES.includes(value));
const want = (name) => requested.length === 0 || requested.includes(name);

async function emit(name, { seed, title }) {
    const tree = await renderTree(seed);
    const view = collect(tree);
    const html = page({ title, css: view.styleSheets.join('\n'), body: serializeTree(tree) });
    await writeFile(join(outDir, `${name}.html`), html, 'utf8');
    const cards = (html.match(/class="dal-card/g) ?? []).length;
    console.log(`wrote ${join(outDir, `${name}.html`)}  (${html.length} bytes, ${cards} cards)`);
}

await mkdir(outDir, { recursive: true });
if (want('grid')) await emit('grid', { title: '资产库 · 网格' });
// 预置 `Dropdown#0` 的第一个 hook 槽位（也就是它的 `open` state）为 true，直接把菜单渲染成展开态。
if (want('menu')) await emit('menu', { title: '资产库 · 项目下拉', seed: { dropdown: { index: 0, slots: [{ value: true }] } } });
// `selected` / `pinned` 都是 Panel 的 state，按源码里的变量名定位槽位后预置。
if (want('detail')) {
    const seed = [];
    preset(seed, panelHookIndex('selected'), assets[0]);
    preset(seed, panelHookIndex('pinned'), assets[4]);
    await emit('detail', { title: '资产库 · 放大卡片', seed: { panel: seed } });
}
// 视频详情：自绘播放条在这里看（原生 controls 已经不再使用）。播放/暂停与进度都是
// MediaPlayer 自己的 state，预置它们才能截到"正在播"的样子而不是永远 0%。
if (want('player') || want('audio')) {
    const seed = [];
    preset(seed, panelHookIndex('selected'), want('audio') ? assets[11] : assets[7]);
    await emit(want('audio') ? 'audio' : 'player', {
        title: want('audio') ? '资产库 · 音频播放条' : '资产库 · 视频播放条',
        seed: { panel: seed, player: { index: 0, slots: [{ value: true }, { value: 71 }, { value: 372 }] } },
    });
}
// contain 模式：竖图（cover-ep01-portrait.png）露出完整构图，不再被裁掉上下。
if (want('fit')) {
    const seed = [];
    preset(seed, panelHookIndex('fit'), 'contain');
    await emit('fit', { title: '资产库 · 完整构图', seed: { panel: seed } });
}
// 预置 `tag` 就能渲染出"点了 #分镜"的筛选态。
if (want('filter')) {
    const seed = [];
    preset(seed, panelHookIndex('tag'), '分镜');
    await emit('filter', { title: '资产库 · 标签筛选', seed: { panel: seed } });
}
// 预置 `selectedPaths`（一个 Set）就是批量操作条 + 卡片的选中态。必须走 latePanel：
// 该 state 会被一条依赖 items 的 effect 收敛，首帧 items 为空会把预置清掉。
if (want('batch')) {
    const seed = [];
    seed[panelHookIndex('selectedPaths')] = { value: new Set([assets[0].relPath, assets[1].relPath, assets[4].relPath, assets[5].relPath]) };
    await emit('batch', { title: '资产库 · 批量打标', seed: { latePanel: seed } });
}
