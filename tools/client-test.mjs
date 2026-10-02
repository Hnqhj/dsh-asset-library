/**
 * Client（浏览器半）契约 + 行为测试。
 *
 * 为什么不用真 React 渲染：这份 DSH 安装里 `react` 是 18.3.1 而 `react-dom` 是
 * 19.2.8 —— 大版本不匹配，React 19 的渲染器认不出 React 18 创建的元素，真 SSR 会报
 * "Objects are not valid as a React child"。为测试联网装一套匹配的 React 不值得。
 *
 * 这里自带一个迷你渲染器：
 *  - `createElement` 产出普通对象树；
 *  - hooks 状态**按组件实例隔离**（键 = 组件名#出现序号），这只手写渲染器最容易错
 *    的地方就是让不同组件的 state 互相串位；
 *  - `useEffect` 由测试显式 flush，于是能真的驱动 fetch 与副作用；
 *  - `frame()` 模拟 React 的"渲染 → 副作用 → setState → 再渲染"循环。
 *
 * 于是可以走完整条交互链路：
 *   挂载 → 拉 /assets + /status → 网格卡片 → 点卡片 → 放大卡片（左内容/右详情）
 *   → 翻下一个 → 返回 → Esc 返回 → 复制路径 → 在资源管理器中显示 → 保存标注
 *
 * 完全离线可跑：`node tools/client-test.mjs`（DEBUG_CLIENT=1 可打印内部状态）
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '..');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
    if (ok) {
        pass += 1;
        console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`);
    } else {
        fail += 1;
        console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
    }
}
const settle = async (times = 6) => { for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
/**
 * 等**真实定时器**。
 *
 * `settle` 只排空微任务（setImmediate），而搜索框有 220ms 的防抖、用的是 setTimeout ——
 * 于是"输入关键词 → 列表变空"这条路径在测试里永远走不到，表现就是断言看着像坏了。
 * 需要跨防抖的用例必须走这里。
 */
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
        // 关键：把状态数组在 hook 调用时就捕获住。setter 常常在 await 之后才被调用，
        // 那时模块级的 currentSlots 早已指向别的组件作用域，按变量取值会把写入写丢。
        const slots = currentSlots;
        const index = hookCursor++;
        // 槽位包一层 `{ value }`，**不能**用 `slots[index] === undefined` 判"还没初始化"：
        // 状态值本身完全可能是 undefined（`kind` 的"全部"就是 undefined），那样下一次渲染
        // 会把它当新槽位重新初始化 —— 于是"点全部"看起来毫无反应，而且**不报错**。
        // 这种失败极难查：面板逻辑没错，是桩把 undefined 和"没状态"混为一谈了。
        if (slots[index] === undefined) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
        const setter = (value) => {
            const next = typeof value === 'function' ? value(slots[index].value) : value;
            slots[index] = { value: next };
        };
        return [slots[index].value, setter];
    },
    // 依赖数组必须真的比较：忽略依赖会让"重置编辑态"之类的 effect 每帧重跑，
    // 把 setCopied/setState 的结果立刻冲掉，测出来的失败是假象。
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
    // 与 React 语义一致：deps 未变时返回**同一个**函数身份。老的桩每次渲染都返回
    // 新闭包，让 `useEffect(..., [refreshStatus])` 这种"稳定回调只跑一次"的写法
    // 每帧都触发 —— 测出来的 /status 请求风暴是桩的假象，不是面板的行为。
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
 * 给 ref 一个"形状够用的"假 DOM 节点。
 *
 * 只提供面板里真正被调用到的那几个：`getBoundingClientRect`（悬停预览定位、滚轮缩放锚点）、
 * `addEventListener/removeEventListener`（媒体元素事件）、`querySelector`（缩放时找 img）。
 * 尺寸写成非零 —— 代码里常有 `if (box.width === 0) return` 这类守卫，0 尺寸会让断言
 * 看起来像"功能没实现"。
 */
function makeStubNode(tag, className, dataset) {
    const listeners = new Map();
    return {
        tagName: String(tag).toUpperCase(),
        className,
        // 真实 DOM 元素都有 dataset。这里必须给 —— 悬停预览要读 `dataset.fit`
        // 来决定 object-fit，缺了就是"读 undefined 的属性"这种看着莫名其妙的 TypeError。
        dataset: dataset ?? {},
        paused: true,
        duration: 120,
        currentTime: 0,
        play: () => Promise.resolve(),
        pause: () => {},
        addEventListener(type, handler) { listeners.set(type, handler); },
        removeEventListener(type) { listeners.delete(type); },
        dispatch(type) { listeners.get(type)?.({ target: this }); },
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 152, height: 114, right: 162, bottom: 134 }),
        querySelector: () => null,
    };
}

/** 遍历元素树；函数组件按"组件名#出现序号"取自己的 hooks 状态。 */function collect(tree) {
    const counts = new Map();
    const texts = [];
    const classes = new Set();
    const styleSheets = [];
    const elements = [];
    (function walk(node) {
        if (node === null || node === undefined || typeof node === 'boolean') return;
        if (Array.isArray(node)) { for (const child of node) walk(child); return; }
        if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
        if (typeof node.type === 'function') {
            const name = node.type.name || 'anon';
            const index = counts.get(name) ?? 0;
            counts.set(name, index + 1);
            walk(renderScoped(`${name}#${index}`, node.type, node.props));
            return;
        }
        const props = node.props ?? {};
        elements.push({ type: node.type, props });
        // 把 ref 对象挂上去：`useRef` 返回的盒子真实浏览器会填 DOM 节点，桩里没有 DOM，
        // 但**可以填一个有几何方法的假节点** —— 否则一切"先量元素再定位"的代码
        // （悬停预览盖在缩略图上、滚轮缩放以指针为锚）在测试里全都静默走不通。
        // 挂一个每次新建的对象而不是复用同一个：这样 `node !== other` 之类的判断不被骗。
        if (props.ref !== undefined && props.ref !== null && typeof props.ref === 'object') {
            props.ref.current = makeStubNode(node.type, String(props.className ?? ''), props.dataset);
        }
        // 存**类名 token** 而不是整串：`class="dal-grid dal-selecting"` 也要能被
        // `classes.has('dal-grid')` 命中。存整串时，任何一个修饰类都会让断言静默失效。
        if (typeof props.className === 'string') {
            for (const token of props.className.split(/\s+/u)) if (token !== '') classes.add(token);
        }
        if (node.type === 'style') {
            const child = props.children ?? node.children;
            styleSheets.push(Array.isArray(child) ? child.join('') : String(child ?? ''));
            // **不进 texts**：CSS 不是"用户看得见的文字"。以前把样式表内容也拼进 flat，
            // 于是注释里随便出现一个词（比如"参照"）就会撞上文案断言 —— 假失败。
            return;
        }
        walk(props.children ?? node.children);
    })(tree);
    return { texts, classes, styleSheets, elements, flat: texts.join(' | ') };
}
const byClass = (view, className) => view.elements.filter((element) => element.props.className === className);
/** className 可能带修饰（dal-card dal-selected…），按词匹配。 */
const withClass = (view, name) => view.elements.filter((element) => String(element.props.className ?? '').split(/\s+/u).includes(name));
const byText = (view, text) => view.elements.find((element) => element.type === 'button' && element.props.children === text);
/**
 * 按钮的可见文字（递归展开，但**不进入函数组件** —— 函数组件是另外的作用域）。
 *
 * 视觉重设计之后，按钮的文案不再是裸字符串：带图标的按钮是 `[图标, 文字]`，
 * 下拉菜单项是 `[名字 span, 路径 span]`，合集 chip 还多一个 `dal-chip-x` 小叉。
 * 按"用户看得见的文字"定位，比按 className 或 children 全等稳得多。
 */
function labelOf(element) {
    const parts = [];
    (function walk(node) {
        if (node === null || node === undefined || typeof node === 'boolean') return;
        if (Array.isArray(node)) { for (const child of node) walk(child); return; }
        if (typeof node === 'string' || typeof node === 'number') { parts.push(String(node)); return; }
        if (typeof node.type === 'function') return;
        walk(node.props?.children ?? node.children);
    })(element.props.children);
    return parts.join('');
}
const byLabel = (view, text) => view.elements.find((element) => element.type === 'button' && labelOf(element) === text);
/** 文案里**含**某段文字（菜单项是"名字 + 父目录"拼在一起，只能按包含匹配）。 */
const byLabelIn = (view, text) => view.elements.find((element) => element.type === 'button' && labelOf(element).includes(text));
/** 按 `title` 定位：纯图标按钮（翻页、排序方向、重扫、图钉）只用 title 表达语义。 */
const byTitle = (view, text) => view.elements.find((element) => element.type === 'button' && element.props.title === text);
/**
 * 按 `aria-label` 定位：给**读屏用**的语义。播放/暂停按钮里只有一个 svg、没有任何可见
 * 文字，所以 `labelOf` 必然是空串 —— 这类控件的语义只能从 aria-label 取。
 */
const byAriaLabel = (view, text) => view.elements.find((element) => element.props['aria-label'] === text);

// ------------------------------------------------------------------ 假数据与假服务
const assets = [
    { relPath: 'images/cover.png', kind: 'image', ext: '.png', size: 41190, mtimeMs: 1790781820954, id: 'images/cover.png', name: 'cover.png', dir: 'images', tags: ['主封面', 'ep1'], note: '竖屏封面', addedAt: '2026-09-30T15:24:00.138Z', absolutePath: 'G:\\fixture\\assets\\images\\cover.png', width: 720, height: 1280 },
    { relPath: 'video/scene-01.mp4', kind: 'video', ext: '.mp4', size: 200000, mtimeMs: 1790781821000, id: 'video/scene-01.mp4', name: 'scene-01.mp4', dir: 'video', tags: [], note: '', addedAt: null, absolutePath: 'G:\\fixture\\assets\\video\\scene-01.mp4' },
    { relPath: 'audio/theme.wav', kind: 'audio', ext: '.wav', size: 16044, mtimeMs: 1790781822000, id: 'audio/theme.wav', name: 'theme.wav', dir: 'audio', tags: ['配乐'], note: '', addedAt: null, absolutePath: 'G:\\fixture\\assets\\audio\\theme.wav' },
];
const status = {
    projectRoot: 'G:\\fixture',
    assetsRoot: 'G:\\fixture\\assets',
    conventional: true,
    counts: { image: 5, video: 2, audio: 2, total: 9 },
    truncated: false,
    scannedAt: '2026-09-30T15:29:23.633Z',
    capabilities: ['assets', 'file', 'tree', 'annotate', 'root', 'reveal'],
    folders: 4,
    recentProjects: ['G:\\fixture', 'G:\\proj2'],
    tagFacets: [{ tag: '主封面', count: 1 }, { tag: '配乐', count: 1 }, { tag: 'ep1', count: 1 }],
    diagnostics: { web: true, tools: { registered: true, names: ['asset_library_list'] } },
    config: { assetsDir: 'assets', includeHidden: false, maxDepth: 8 },
};
const fetchCalls = [];
const clipboardWrites = [];
// 悬停预览共享 <video> 的调用计数：用来断言"来回扫过一排视频卡只建一个解码器"。
const appended = [];
const videoStub = { plays: 0, pauses: 0 };
const storage = new Map();
const windowListeners = new Map();
const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload, blob: async () => ({ size: 10, type: 'image/png' }) });
async function fakeFetch(url, init) {
    const text = String(url);
    fetchCalls.push({ url: text, method: init?.method ?? 'GET', body: init?.body });
    if (text.includes('/assets?')) {
        // 假服务要**真的按 q / kind / tag 过滤**，否则"搜索无结果"这条路径根本走不到：
        // 面板会永远拿到 3 条，空状态里的"清除筛选"就永远没被验证过。
        const params = new URLSearchParams(text.slice(text.indexOf('?') + 1));
        const q = (params.get('q') ?? '').toLowerCase();
        const kindFilter = params.get('kind');
        const tagFilter = params.get('tag');
        const dirFilter = params.get('dir');
        const matched = assets.filter((item) => (q === '' || item.relPath.toLowerCase().includes(q))
            && (kindFilter === null || item.kind === kindFilter)
            && (tagFilter === null || item.tags.includes(tagFilter))
            && (dirFilter === null || item.dir === dirFilter));
        return jsonResponse({ items: matched, total: matched.length, offset: 0, limit: 60, hasMore: false, counts: status.counts, filteredCounts: status.counts, truncated: false, scannedAt: status.scannedAt, projectRoot: status.projectRoot, assetsRoot: status.assetsRoot });
    }
    if (text.includes('/status')) return jsonResponse(status);
    if (text.includes('/annotate')) {
        if (String(init?.body ?? '').includes('relPaths')) return jsonResponse({ updated: 3, skipped: 0 });
        return jsonResponse({ item: { ...assets[0], tags: ['主封面', 'ep1', '新标签'], note: '改过的备注' } });
    }
    if (text.includes('/reveal')) return jsonResponse({ ok: true, absolutePath: assets[0].absolutePath });
    if (text.includes('/file?')) return jsonResponse({});
    if (text.includes('/root') || text.includes('/rescan')) return jsonResponse(status);
    throw new Error(`unexpected fetch: ${text}`);
}

// ------------------------------------------------------------------ 以浏览器的方式加载 client.js
let captured;
const sandbox = {
    window: {
        __ModuleLoader__: { load: (definition) => { captured = definition; } },
        addEventListener: (type, handler) => { windowListeners.set(type, handler); },
        removeEventListener: (type) => { windowListeners.delete(type); },
        matchMedia: () => ({ matches: false }),
    },
    document: {
        documentElement: { lang: 'zh-CN' },
        body: { appendChild: (node) => { appended.push(node); return node; } },
        // 悬停预览会 `document.createElement('video')` 建一个**模块级单例**，它比普通元素
        // 用到的方法多得多（style/dataset/play/pause/几何）。桩给全，否则 ensure() 会在
        // appendChild 之类的调用上炸掉 —— 而那只是测试环境缺方法，不是产品有 bug。
        createElement: (tag) => (tag === 'video' ? {
            tagName: 'VIDEO',
            style: { cssText: '' },
            dataset: {},
            paused: true,
            play: () => { videoStub.plays += 1; return Promise.resolve(); },
            pause: () => { videoStub.pauses += 1; },
            setAttribute: () => {},
            // 必须是非零尺寸：`show()` 里有一道 `width === 0` 的守卫（真实的 0 尺寸元素
            // 盖上去也看不见），桩给 0 会让预览在 play 之前就返回，看起来像"没播"。
            getBoundingClientRect: () => ({ left: 10, top: 20, width: 152, height: 114 }),
        } : {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage() {} }),
            toBlob: (resolve) => resolve({ size: 1, type: 'image/jpeg' }),
        }),
    },
    navigator: { language: 'zh-CN', clipboard: { writeText: async (value) => { clipboardWrites.push(value); } } },
    localStorage: {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => { storage.set(key, value); },
    },
    IntersectionObserver: undefined,
    createImageBitmap: undefined,
    // URLSearchParams 必须给真的：面板用它构造查询串，缺了会抛错并被 load() 的 catch 吞掉，
    // 表现为"一次请求都没发"。
    URLSearchParams,
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => undefined },
    fetch: fakeFetch,
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
};
vm.createContext(sandbox);
vm.runInContext(await readFile(join(pluginDir, 'client.js'), 'utf8'), sandbox, { filename: 'client.js' });

console.log('== module contract ==');
check('module loader captured one definition', captured !== undefined);
check('id equals the package name', captured?.id === 'dsh-asset-library', String(captured?.id));
const plugin = captured.factory((id) => {
    if (id === 'react') return ReactStub;
    throw new Error(`unexpected require(${id})`);
});
check('factory returns a plugin object', typeof plugin?.apply === 'function');
check('plugin declares a name', plugin.name === 'asset-library-client', String(plugin.name));
check('plugin injects slots + locale', Array.isArray(plugin.inject) && plugin.inject.join(',') === 'slots,locale', String(plugin.inject));

console.log('== slot registration contract ==');
const dictionaries = {};
const registrations = [];
const injections = [];
const effects = [];
function drive(callback) {
    const result = typeof callback === 'function' ? callback() : undefined;
    if (result !== undefined && typeof result?.next === 'function') {
        let step = result.next();
        while (!step.done) step = result.next();
    }
}
plugin.apply({
    effect: (factory, label) => { const disposer = factory(); effects.push({ label, disposer }); return disposer; },
    locale: {
        register: (ns, dicts) => { dictionaries[ns] = dicts; return () => undefined; },
        bind: (ns) => (key) => dictionaries[ns]?.zh?.[key] ?? dictionaries[ns]?.en?.[key] ?? key,
    },
    slots: {
        inject: (slot, callback) => { injections.push(slot); drive(callback); },
        register: (options, component) => { registrations.push({ options, component }); return () => undefined; },
    },
});
check('locale dictionaries registered for both languages', dictionaries['asset-library']?.zh?.panel !== undefined && dictionaries['asset-library']?.en?.panel !== undefined);
check('registers into main and sidebar.panellist', injections.includes('main') && injections.includes('sidebar.panellist'), injections.join(','));
const mainRegistration = registrations.find((entry) => entry.options.name === 'main');
const sidebarRegistration = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
check('main slot key matches the sidebar id', mainRegistration?.options.key === 'asset-library' && sidebarRegistration?.options.id === 'asset-library', `${mainRegistration?.options.key} / ${sidebarRegistration?.options.id}`);
check('sidebar label is localized (zh)', sidebarRegistration?.options.label?.() === '资产库', String(sidebarRegistration?.options.label?.()));
check('both registrations declare the locale namespace', mainRegistration?.options.locale === 'asset-library' && sidebarRegistration?.options.locale === 'asset-library');
check('every effect returned a disposer', effects.every((entry) => typeof entry.disposer === 'function'), effects.map((entry) => entry.label).join(' | '));

// ------------------------------------------------------------------ 渲染循环
const Panel = mainRegistration.component;
let panelProps = {};
async function frame() {
    // 模拟 React 的"渲染 → 提交副作用 → setState → 再渲染"，跑几轮让异步数据落定。
    let tree = renderScoped('Panel#0', Panel, panelProps);
    for (let round = 0; round < 4; round += 1) {
        collect(tree);
        flushEffects();
        await settle(4);
        tree = renderScoped('Panel#0', Panel, panelProps);
    }
    const view = collect(tree);
    flushEffects();
    return view;
}

console.log('== mount: grid ==');
let view = await frame();
if (process.env.DEBUG_CLIENT === '1') {
    console.log('DEBUG classes:', [...view.classes].join(','));
    console.log('DEBUG fetches:', fetchCalls.map((call) => call.url).join(' '));
}
check('renders without throwing', view.classes.has('dal-root'));
check('header + body + grid containers present', view.classes.has('dal-head') && view.classes.has('dal-body') && view.classes.has('dal-grid'));
const css = view.styleSheets[0] ?? '';
check('stylesheet is a rendered element using theme tokens', view.styleSheets.length === 1 && css.includes('--dsw-alias-bg-base') && css.includes('--dsw-alias-label-primary') && css.includes('--dsw-alias-brand-primary'));
check('stylesheet keeps a minimum-height fallback', css.includes('min-height:420px'));
check('stylesheet defines the enlarged-card layout', css.includes('.dal-detail-body') && css.includes('grid-template-columns:minmax(0,1fr) 340px'));
// 头部压成两行之后不再有副标题句：标题旁边直接跟计数，工具区只留控件。
check('title + counts rendered', view.flat.includes('资产库') && view.flat.includes('共 9 项'));
check('项目切换器与排序都是统一下拉（不再用原生 select）', view.classes.has('dal-project') && view.elements.some((element) => element.props.className === 'dal-ddtoggle') && !view.elements.some((element) => element.type === 'select'), [...view.classes].join(','));
check('kind chips carry server counts', view.flat.includes('图片 5') && view.flat.includes('视频 2') && view.flat.includes('音频 2'));
check('assets fetched from the host API', fetchCalls.some((call) => call.url.includes('/api/asset-library/assets?')));
check('three cards rendered for three assets', byClass(view, 'dal-card').length === 3, String(byClass(view, 'dal-card').length));
check('cards show name, size and tags', view.flat.includes('cover.png') && view.flat.includes('40 KB') && view.flat.includes('主封面'));
check('no right-hand drawer exists anywhere', !view.classes.has('dal-drawer') && !css.includes('.dal-drawer'));
check('no undefined/NaN leaked into text', !view.flat.includes('undefined') && !view.flat.includes('NaN'));

console.log('== tag filter chips ==');
check('status tag facets render as chips', Boolean(byText(view, '#主封面 1')) && Boolean(byText(view, '#配乐 1')), view.flat.slice(0, 400));
check('cards declare content-visibility for cheap scrolling', css.includes('content-visibility:auto'));
byText(view, '#主封面 1').props.onClick();
view = await frame();
check('clicking a tag chip re-queries with the tag parameter', fetchCalls.some((call) => call.url.includes('&tag=')), fetchCalls.map((call) => call.url).join(' '));
const activeTagChip = view.elements.find((element) => element.props.className === 'dal-chip' && element.props['data-on'] === 'true' && String(element.props.children ?? '').startsWith('#'));
check('active tag chip is highlighted', activeTagChip !== undefined && String(activeTagChip.props.children) === '#主封面 1', String(activeTagChip?.props.children));
byText(view, '#主封面 1').props.onClick();
view = await frame();
check('clicking the active tag again clears the filter', view.elements.filter((element) => element.props.className === 'dal-chip' && element.props['data-on'] === 'true' && String(element.props.children ?? '').startsWith('#')).length === 0);

console.log('== tag chips degrade when the host does not send facets ==');
const declaredFacets = status.tagFacets;
delete status.tagFacets;
scopes.clear();
view = await frame();
check('tag chips hidden without tagFacets', !view.flat.includes('#主封面'));
status.tagFacets = declaredFacets;
scopes.clear();
view = await frame();

console.log('== /status is fetched once per mount, not per filter change ==');
const statusCallsBefore = fetchCalls.filter((call) => call.url.includes('/status')).length;
byText(view, '视频 2').props.onClick();
view = await frame();
byText(view, '全部 9').props.onClick();
view = await frame();
const statusCallsAfter = fetchCalls.filter((call) => call.url.includes('/status')).length;
check('filter changes do not refetch /status', statusCallsAfter === statusCallsBefore, `${statusCallsBefore} -> ${statusCallsAfter}`);

console.log('== probed dimensions, uniform thumb frames, tag tokens ==');
// 竖图不再单独换 3:4 画框：整个网格统一 4:3 + cover，行高才齐。这是刻意的设计取舍，
// 所以断言改成"只有一种画框比例"，而不是"竖图有专门比例"。
const thumb = withClass(view, 'dal-thumb')[0];
check('thumbnail frame uses one uniform aspect ratio', thumb !== undefined && css.includes('aspect-ratio:4/3') && !css.includes('dal-thumb-portrait'));
check('probed dimensions appear on cards', view.flat.includes('720×1280'));
// 标签不再按字符串算色相（那正是"配色乱"的来源）：一律走主题 token。
const tagPills = byClass(view, 'dal-tag');
check('tag pills render with theme tokens (no computed hues)', tagPills.length > 0 && css.includes('.dal-tag{') && !css.includes('hsla('), String(tagPills.length));

console.log('== collections (named filter presets) ==');
byText(view, '#主封面 1').props.onClick();
view = await frame();
const nameInput = view.elements.find((element) => element.type === 'input' && element.props.placeholder === '合集名称，回车保存');
check('save UI appears while a filter is active', nameInput !== undefined);
nameInput.props.onChange({ target: { value: 'EP1 封面' } });
view = await frame();
view.elements.find((element) => element.type === 'input' && element.props.placeholder === '合集名称，回车保存')
    .props.onKeyDown({ key: 'Enter', preventDefault() {} });
view = await frame();
check('collection saved to storage', String(storage.get('dsh-asset-library.collections.v1')).includes('EP1 封面'));
check('collection rendered as a chip', view.flat.includes('★ EP1 封面'));
byText(view, '#主封面 1').props.onClick();
view = await frame();
const collectionChip = view.elements.find((element) => element.type === 'button' && String(element.props.children?.[0] ?? '').startsWith('★ EP1 封面'));
check('collection chip survives the filter being cleared', collectionChip !== undefined);
collectionChip.props.onClick();
view = await frame();
check('applying a collection re-applies its tag filter', fetchCalls.some((call) => call.url.includes('tag=')), fetchCalls.map((call) => call.url).join(' '));
const chipX = view.elements.find((element) => element.props.className === 'dal-chip-x');
chipX.props.onClick({ stopPropagation() {} });
view = await frame();
check('collection chip can be deleted', !view.flat.includes('★ EP1 封面') && !String(storage.get('dsh-asset-library.collections.v1')).includes('EP1 封面'));
// 假服务现在**真的**按筛选过滤（否则"搜索无结果"那条路径永远走不到），所以这个用例
// 留下的 tag 筛选会一直生效、把列表缩到 1 条。显式清干净再往下走 —— 靠"后面的用例
// 碰巧不介意"续命，改一条断言就会连环出假失败。
byText(view, '#主封面 1').props.onClick();
view = await frame();
check('filters are back to a clean slate for the next block', byClass(view, 'dal-card').length === 3, String(byClass(view, 'dal-card').length));

console.log('== multi-select and batch tagging ==');
withClass(view, 'dal-card')[0].props.onClick({ ctrlKey: true });
view = await frame();
withClass(view, 'dal-card')[2].props.onClick({ ctrlKey: true });
view = await frame();
check('ctrl+click selects two cards', view.flat.includes('已选 2 项'));
byText(view, '全选').props.onClick();
view = await frame();
check('select all covers the loaded results', view.flat.includes('已选 3 项'));
view.elements.find((element) => element.type === 'input' && element.props.placeholder === '输入标签')
    .props.onChange({ target: { value: '批量标签' } });
view = await frame();
byText(view, '加标签').props.onClick();
view = await frame();
check('batch add posts one annotate call with all paths', fetchCalls.some((call) => call.url.includes('/annotate') && call.method === 'POST' && String(call.body).includes('relPaths') && String(call.body).includes('tagsAdd')));
check('batch result is reported', view.flat.includes('更新 3 项，跳过 0 项'));
check('selection cleared after a batch', !view.flat.includes('已选'));
withClass(view, 'dal-card')[0].props.onClick({ ctrlKey: true });
view = await frame();
withClass(view, 'dal-card')[2].props.onClick({ shiftKey: true });
view = await frame();
check('shift+click selects a range', view.flat.includes('已选 3 项'));
byText(view, '清除选择').props.onClick();
view = await frame();
check('selection can be cleared', !view.flat.includes('已选'));

console.log('== batch copy paths ==');
// 批量条原来只能打标签，"把选中这十几个素材的路径一次性粘走"这个最高频的动作没有入口。
clipboardWrites.length = 0;
withClass(view, 'dal-card')[0].props.onClick({ ctrlKey: true });
view = await frame();
withClass(view, 'dal-card')[2].props.onClick({ ctrlKey: true });
view = await frame();
const copyPathsButton = byLabelIn(view, '复制 2 条路径');
check('batch bar offers to copy the selected paths', copyPathsButton !== undefined);
// 顺序必须跟网格一致（cover → theme），而不是点选先后 —— 粘进时间线时前者才有用。
copyPathsButton?.props.onClick();
await frame(); await frame();
check('copies one relative path per line, in grid order',
    clipboardWrites.at(-1) === 'images/cover.png\naudio/theme.wav', JSON.stringify(clipboardWrites));
// 用 withClass 而不是 byClass：选中的卡片 className 变成 "dal-card dal-selected"，
// byClass 只在全等时命中，于是**被选中的那几张反而数不到**（3 张里只数出 1 张没选中的）。
// 断言卡片数时永远用 withClass。
check('copying does not clear the selection or change the list', view.classes.has('dal-grid') && withClass(view, 'dal-card').length === 3);
view = await frame();
check('the selection survives the copy (paths can be copied then acted on)', view.flat.includes('已选 2 项'));
byText(view, '清除选择').props.onClick();
view = await frame();

console.log('== empty state offers to clear the filters ==');
// "这个目录真的没素材"和"筛选把它们全滤掉了"原来共用一句话 + 一句"去放文件"的提示，
// 搜索无结果时会把人引到完全错误的方向。
const searchInput = () => view.elements.find((element) => element.type === 'input' && element.props.placeholder === '搜索文件名或路径');
searchInput().props.onChange({ target: { value: '不存在的关键词zzz' } });
// 顺序很要紧：搜索防抖的 setTimeout 是在 **effect 里**注册的，而 effect 只在 frame() 内部
// 提交。所以顺序必须是「改输入 → frame()（effect 挂上定时器）→ 等真实时间过去 → frame()
// （防抖生效、重新查询、结果落定）」。先等再 frame 的话，定时器根本还没被安排。
view = await frame();
await wait(280);
view = await frame();
check('no results shows the "nothing matches" copy, not the "empty folder" copy',
    view.flat.includes('没有符合筛选条件的素材。') && !view.flat.includes('这个目录里没有找到'), view.flat.slice(0, 160));
// 按钮带图标，children 是 [svg, 文字] 而不是裸字符串 —— byText 只在 children 全等时命中，
// 这种带图标的按钮必须用 byLabelIn（按可见文字匹配）。
const clearFiltersButton = byLabelIn(view, '清除筛选');
check('the no-results state offers a way out', clearFiltersButton !== undefined);
clearFiltersButton?.props.onClick();
view = await frame();
await wait(280);
view = await frame();
check('clearing the filters brings the results back and empties the search box',
    withClass(view, 'dal-card').length === 3 && searchInput().props.value === '', view.flat.slice(0, 160));

console.log('== thumbnail fit toggle (cover / contain) ==');
// 竖图在 cover 下被裁掉上下三分之一；contain 让它露出完整构图，格子尺寸不变。
check('grid defaults to cover', withClass(view, 'dal-grid')[0].props['data-fit'] === 'cover');
check('thumbnails carry the fit mode for the shared hover preview', view.elements.some((element) => String(element.props.className ?? '').includes('dal-thumb') && element.props['data-fit'] === 'cover'));
const fitButton = byTitle(view, '完整构图');
check('toolbar has a fit toggle', fitButton !== undefined);
fitButton?.props.onClick();
view = await frame();
check('toggling switches the grid to contain', withClass(view, 'dal-grid')[0].props['data-fit'] === 'contain');
check('the toggle offers the way back', byTitle(view, '填满裁切') !== undefined);
check('contain is persisted as a preference', String(storage.get('dsh-asset-library.prefs.v1')).includes('contain'));
byTitle(view, '填满裁切')?.props.onClick();
view = await frame();
check('toggling back restores cover', withClass(view, 'dal-grid')[0].props['data-fit'] === 'cover');

console.log('== card checkbox (top-right corner) ==');
// 这个角落以前是个纯装饰的 span：悬停冒出来、点了没反应 —— 能看见却不能用。
const boxes = () => view.elements.filter((element) => element.props.role === 'checkbox');
check('every card carries a real checkbox', boxes().length === 3);
check('checkbox exposes its state', boxes()[0].props['aria-checked'] === 'false' && boxes()[0].props['aria-label'] === '选中');
check('checkboxes stay hidden until needed', !view.classes.has('dal-selecting'));
boxes()[0].props.onClick({ stopPropagation() {} });
view = await frame();
check('clicking the checkbox selects without opening the detail',
    view.flat.includes('已选 1 项') && view.classes.has('dal-grid') && !view.classes.has('dal-detail'));
check('checkbox reflects the selected state', boxes()[0].props['aria-checked'] === 'true'
    && boxes()[0].props['aria-label'] === '取消选中'
    && String(boxes()[0].props.className).includes('dal-check-on'));
check('grid flags the selecting state so every checkbox stays visible', view.classes.has('dal-selecting'));
boxes()[1].props.onClick({ stopPropagation() {} });
view = await frame();
check('a second checkbox click adds to the selection without penetrating the card',
    view.flat.includes('已选 2 项') && !view.classes.has('dal-detail'));
boxes()[1].props.onClick({ stopPropagation() {} });
view = await frame();
check('clicking it again deselects', view.flat.includes('已选 1 项') && view.classes.has('dal-selecting'));
byText(view, '清除选择').props.onClick();
view = await frame();

console.log('== grid keyboard navigation ==');
windowListeners.get('keydown')({ key: 'ArrowRight', target: { tagName: 'BODY' }, preventDefault() {} });
view = await frame();
check('arrow moves the grid cursor to the first card', withClass(view, 'dal-cursor').length === 1);
windowListeners.get('keydown')({ key: 'x', target: { tagName: 'BODY' }, preventDefault() {} });
view = await frame();
check('X selects the cursor card without opening it', view.flat.includes('已选 1 项') && !view.classes.has('dal-detail'));
windowListeners.get('keydown')({ key: 'X', target: { tagName: 'BODY' }, preventDefault() {} });
view = await frame();
check('X on the same card toggles it back off', !view.flat.includes('已选'));
windowListeners.get('keydown')({ key: 'ArrowRight', target: { tagName: 'BODY' }, preventDefault() {} });
view = await frame();
windowListeners.get('keydown')({ key: 'Enter', target: { tagName: 'BODY' }, preventDefault() {} });
view = await frame();
check('Enter opens the cursor card', view.classes.has('dal-detail') && view.flat.includes('scene-01.mp4'));
windowListeners.get('keydown')({ key: 'Escape', preventDefault() {} });
view = await frame();
check('Esc returns to the grid', view.classes.has('dal-grid'));
windowListeners.get('keydown')({ key: 'Escape', target: { tagName: 'BODY' }, preventDefault() {} });
view = await frame();
check('Esc clears the grid cursor', withClass(view, 'dal-cursor').length === 0);

console.log('== orientation labels are localized and use probed dims ==');
check('orientation strings live in both dictionaries', dictionaries['asset-library'].zh.orientationPortrait === '竖屏' && dictionaries['asset-library'].en.orientationPortrait === 'Portrait');
byClass(view, 'dal-card')[0].props.onClick({});
view = await frame();
check('detail falls back to probed dimensions with orientation', view.flat.includes('720 × 1280') && view.flat.includes('竖屏'));
byTitle(view, '返回 · Esc').props.onClick();
view = await frame();

console.log('== matched count in the header ==');
byText(view, '图片 5').props.onClick();
view = await frame();
// 夹具里只有 1 张图片（3 个资产：图/视频/音频），所以"图片"筛选命中的是 1 条。
// 以前假服务不真的过滤、永远回 3 条，这里就写成了 3 —— 那是桩的假象，不是面板的行为。
check('header shows the matched count while filtering', view.flat.includes('匹配 1 / 共 9 项'), view.flat.slice(0, 200));
check('the filter actually narrows the grid', withClass(view, 'dal-card').length === 1);
byText(view, '全部 9').props.onClick();
view = await frame();
check('clearing the type filter brings everything back', withClass(view, 'dal-card').length === 3 && view.flat.includes('共 9 项'));

console.log('== sort direction toggle ==');
// 方向按钮是纯图标按钮：语义在 title 上（升序 / 降序 / 升序 / 降序 表示未设方向）。
let dirToggle = byTitle(view, '升序 / 降序');
check('direction toggle sits next to the sort select', dirToggle !== undefined);
dirToggle.props.onClick();
view = await frame();
check('ascending order reaches the API', fetchCalls.some((call) => call.url.includes('order=asc')));
dirToggle = byTitle(view, '升序');
dirToggle.props.onClick();
view = await frame();
check('descending order reaches the API', fetchCalls.some((call) => call.url.includes('order=desc')));
dirToggle = byTitle(view, '降序');
dirToggle.props.onClick();
view = await frame();
check('direction cycles back to the default', !fetchCalls.some((call) => call.url.includes('order=asc') && call.url.endsWith(String(fetchCalls.length))));

console.log('== media extras (hover preview, audio duration) ==');
// 悬停预览挂在卡片按钮上（只有进视口才挂媒体），不是挂在 <video> 上 —— 后者在
// 懒加载模型下根本不存在"已挂载的 video 等着被 hover"。
const hoverableCards = view.elements.filter((element) => String(element.props.className ?? '').split(/\s+/u).includes('dal-card') && typeof element.props.onMouseEnter === 'function');
check('only in-view video cards accept hover preview', hoverableCards.length === 1, `got ${hoverableCards.length}`);
hoverableCards[0]?.props.onMouseEnter();
// 关键回归：来回扫过 N 张视频卡**不能**建 N 个 <video>。整个面板只有一个共享实例。
check('hover preview reuses one shared video element', appended.filter((node) => node.tagName === 'VIDEO').length === 1, `appended ${appended.length}`);
check('hover preview plays the shared video', videoStub.plays === 1, `plays ${videoStub.plays}`);
hoverableCards[0]?.props.onMouseLeave();
check('leaving the card pauses the shared video', videoStub.pauses === 1, `pauses ${videoStub.pauses}`);
hoverableCards[0]?.props.onMouseEnter();
check('re-entering the same card reuses the same element (no second append)', appended.filter((node) => node.tagName === 'VIDEO').length === 1);
hoverableCards[0]?.props.onMouseLeave();
check('audio cards mount a metadata audio element', view.elements.some((element) => element.type === 'audio' && element.props.preload === 'metadata'));

console.log('== reference pin ==');
byClass(view, 'dal-card')[0].props.onClick();
view = await frame();
const pinButton = byTitle(view, '设为参照');
check('pin button sits in the detail bar', pinButton !== undefined);
pinButton.props.onClick();
view = await frame();
check('pin toggles to unpin', byTitle(view, '取消参照') !== undefined);
byTitle(view, '返回 · Esc').props.onClick();
view = await frame();
const pinnedChip = view.elements.find((element) => element.props.className === 'dal-chip' && labelOf(element).startsWith('cover.png'));
check('pinned strip shows above the grid', view.flat.includes('参照') && pinnedChip !== undefined);
byClass(view, 'dal-card')[1].props.onClick();
view = await frame();
check('reference thumbnail overlays the stage', view.elements.some((element) => element.props.className === 'dal-ref'));
view.elements.find((element) => element.props.className === 'dal-ref').props.onClick();
view = await frame();
check('clicking the reference swaps the detail view', view.flat.includes('cover.png'));
byTitle(view, '取消参照').props.onClick();
view = await frame();
byTitle(view, '返回 · Esc').props.onClick();
view = await frame();
check('pinned strip gone after unpinning', !view.flat.includes('参照'));

console.log('== folder chips narrow progressively ==');
check('top-level chips show first-level folders', Boolean(byText(view, 'audio 1')));
byText(view, 'audio 1').props.onClick();
view = await frame();
check('parent navigation appears inside a folder', view.flat.includes('上一级'));
const upChip = byLabel(view, '上一级');
upChip.props.onClick();
view = await frame();
check('parent click returns to the top level', !view.flat.includes('上一级'));

console.log('== click a card -> enlarged card (left media / right details) ==');
byClass(view, 'dal-card')[0].props.onClick();
view = await frame();
check('detail view replaces the grid', view.classes.has('dal-detail') && !view.classes.has('dal-grid'));
check('two-column layout present', view.classes.has('dal-detail-body') && view.classes.has('dal-stage') && view.classes.has('dal-info'));
// 详情原图走"持久化缓存优先"：命中就是 blob，未命中才直连 /file 并顺手缓存。
// 两种 src 都是同一张图，所以断言看的是"确实为这个文件取了媒体"，而不是某个 URL 形状。
const stageImg = view.elements.find((element) => element.type === 'img' && String(element.props.className ?? '').includes('dal-zoomable'));
check('media stage shows the image itself', stageImg !== undefined
    && (String(stageImg.props.src).includes('/file?relPath=images%2Fcover.png') || String(stageImg.props.src).startsWith('blob:'))
    && fetchCalls.some((call) => call.url.includes('/file?relPath=images%2Fcover.png')), String(stageImg?.props?.src));
check('details show type, size, modified and both paths', view.flat.includes('图片 · PNG') && view.flat.includes('40 KB') && view.flat.includes('images/cover.png') && view.flat.includes('G:\\fixture\\assets\\images\\cover.png'));
check('detail header reuses the grid header recipe (same .dal-h1 title, hairline head)',
    view.elements.some((element) => String(element.props.className ?? '').split(/\s+/u).includes('dal-h1') && String(element.props.className ?? '').includes('dal-detail-name'))
    && view.classes.has('dal-head') && css.includes('.dal-h1{') && css.includes('.dal-detail-body{'));
check('tags are editable in the detail view', view.elements.some((element) => element.type === 'input' && element.props.placeholder === '回车添加标签'));
check('note is editable in the detail view', view.elements.some((element) => element.type === 'textarea'));
check('each path row is its own copy button', view.elements.filter((element) => String(element.props.className ?? '').includes('dal-copyrow')).length === 2);
check('detail offers reveal / open-in-tab next to the paths',
    Boolean(byLabel(view, '在资源管理器中显示')) && view.elements.some((element) => element.type === 'a' && element.props.target === '_blank'));
// 键列宽度由最长的键统一决定（写死 76px 时英文键和中文键都各偏一点）。
check('key/value grid sizes the key column by content', css.includes('grid-template-columns:max-content minmax(0,1fr)'));
check('position indicator shows the index', view.flat.includes('1 / 3'));
check('keyboard listener registered for Esc/arrows', typeof windowListeners.get('keydown') === 'function');

console.log('== navigation inside the enlarged card ==');
const prevButton = byTitle(view, '上一个');
const nextButton = byTitle(view, '下一个');
check('prev disabled on the first asset, next enabled', prevButton?.props.disabled === true && nextButton?.props.disabled === false);
nextButton.props.onClick();
view = await frame();
check('next shows the following asset', view.flat.includes('scene-01.mp4') && view.flat.includes('2 / 3'));
check('video asset does not use the native controls bar', !view.elements.some((element) => element.type === 'video' && element.props.controls === true));
check('video asset renders the self-drawn player', withClass(view, 'dal-player').length === 1 && withClass(view, 'dal-playbtn').length === 1 && withClass(view, 'dal-track').length === 1);
check('player exposes play/pause as an aria-labelled button', byAriaLabel(view, '播放') !== undefined);
check('player shows a seekable progress track', withClass(view, 'dal-track')[0].props.role === 'slider');
byTitle(view, '返回 · Esc').props.onClick();
view = await frame();
check('back button returns to the grid', view.classes.has('dal-grid') && byClass(view, 'dal-card').length === 3);

console.log('== Esc returns from the enlarged card ==');
byClass(view, 'dal-card')[2].props.onClick();
view = await frame();
check('audio asset opened', view.flat.includes('theme.wav') && view.classes.has('dal-detail'));
check('audio asset does not use the native controls bar', !view.elements.some((element) => element.type === 'audio' && element.props.controls === true));
check('audio asset renders the self-drawn player too', withClass(view, 'dal-player').length === 1 && withClass(view, 'dal-playbtn').length === 1);
// 音频不能套在 .dal-stage 里：那个灰底盒子是给"有画面的东西"准备的，套上去就是一整块
// 空灰底中间飘一个 ♪。所以断言结构是「.dal-media 的孩子里直接有 .dal-stage-audio，
// 且这一列里没有 .dal-stage」。
const audioStage = withClass(view, 'dal-stage-audio')[0];
const stageWrapper = withClass(view, 'dal-stage')[0];
check('audio is not wrapped in the grey media stage',
    audioStage !== undefined && stageWrapper === undefined, `stage=${stageWrapper !== undefined}`);
windowListeners.get('keydown')({ key: 'Escape', preventDefault() {} });
view = await frame();
check('Esc closes the enlarged card', view.classes.has('dal-grid') && !view.classes.has('dal-detail'));

console.log('== keyboard shortcuts yield to typing ==');
byClass(view, 'dal-card')[0].props.onClick();
view = await frame();
const flatBeforeArrow = view.flat;
windowListeners.get('keydown')({ key: 'ArrowRight', target: { tagName: 'INPUT' }, preventDefault() {} });
view = await frame();
check('arrow keys while typing in an input do not page the detail view', view.flat === flatBeforeArrow);
windowListeners.get('keydown')({ key: 'ArrowRight', target: { tagName: 'TEXTAREA' }, preventDefault() {} });
view = await frame();
check('textarea keystrokes do not page either', view.flat === flatBeforeArrow);
windowListeners.get('keydown')({ key: 'ArrowRight', target: { tagName: 'BODY' }, preventDefault() {} });
view = await frame();
check('arrow keys outside inputs still page the detail view', view.flat.includes('scene-01.mp4') && view.flat.includes('2 / 3'));
byTitle(view, '返回 · Esc').props.onClick();
view = await frame();
check('back button returns to the grid', view.classes.has('dal-grid') && byClass(view, 'dal-card').length === 3);

console.log('== detail actions ==');
byClass(view, 'dal-card')[0].props.onClick();
view = await frame();
const copyRows = withClass(view, 'dal-copyrow');
check('path rows are ordered relative → absolute', labelOf(copyRows[0]).includes('images/cover.png') && labelOf(copyRows[1]).includes('G:\\fixture\\assets\\images\\cover.png'));
// 点整行即复制绝对路径（第二行）。
await copyRows[1].props.onClick();
view = await frame();
check('copy writes the absolute path to the clipboard', clipboardWrites.includes('G:\\fixture\\assets\\images\\cover.png'), clipboardWrites.join(','));
const doneRows = withClass(view, 'dal-copyrow').filter((element) => element.props['data-done'] === 'true');
check('copy feedback lands on the clicked row only', doneRows.length === 1
    && labelOf(doneRows[0]).includes('G:\\fixture\\assets\\images\\cover.png')
    && doneRows[0].props.title === '已复制');
await byLabel(view, '在资源管理器中显示').props.onClick();
await settle();
check('reveal posts to the host endpoint', fetchCalls.some((call) => call.url.includes('/api/asset-library/reveal') && call.method === 'POST'));
view = await frame();
// 标注是"改完再保存"的：不给提示的话，加完标签直接翻页改动就悄悄丢了。
check('no unsaved hint while the annotation is untouched', !view.flat.includes('未保存的改动'));
view.elements.find((element) => element.type === 'textarea').props.onChange({ target: { value: '改过的备注' } });
view = await frame();
check('editing the note flags unsaved changes', view.flat.includes('未保存的改动'));
await byText(view, '保存').props.onClick();
view = await frame();
check('save posts annotations and confirms', fetchCalls.some((call) => call.url.includes('/annotate') && call.method === 'POST') && view.flat.includes('已保存'));
check('the unsaved hint clears after saving', !view.flat.includes('未保存的改动'));

console.log('== capability negotiation ==');
// 旧宿主的 /status 不带 capabilities：面板必须自动降级，不能给一个点了就报错的按钮。
const declaredCapabilities = status.capabilities;
delete status.capabilities;
scopes.clear();
byClass(view, 'dal-card').length; // no-op，保持可读性
view = await frame();
byClass(view, 'dal-card')[0]?.props.onClick();
view = await frame();
check('reveal button hidden when the host does not declare it', byLabel(view, '在资源管理器中显示') === undefined && withClass(view, 'dal-copyrow').length === 2);
check('open-in-tab still works without the capability', view.elements.some((element) => element.type === 'a' && element.props.target === '_blank'));
status.capabilities = declaredCapabilities;
scopes.clear();
view = await frame();

console.log('== thumbnails and lazy loading ==');
byTitle(view, '返回 · Esc')?.props.onClick();
view = await frame();
check('image cards render an image element once in view', view.elements.some((element) => element.type === 'img' && String(element.props.src).includes('/file?relPath=')));
check('every media request stays same-origin', fetchCalls.every((call) => !/^https?:/u.test(call.url)));

console.log('== rescan changes the media URL (never show stale media) ==');
const gridSrcBefore = view.elements.find((element) => element.type === 'img')?.props.src ?? '';
await byTitle(view, '重新扫描').props.onClick();
view = await frame();
const gridSrcAfter = view.elements.find((element) => element.type === 'img')?.props.src ?? '';
check('grid media URL carries a revision after rescan', gridSrcAfter.includes('&rev=1') && gridSrcAfter !== gridSrcBefore, gridSrcAfter);
byClass(view, 'dal-card')[0].props.onClick();
view = await frame();
const detailSrc = view.elements.find((element) => element.type === 'img' && String(element.props.className ?? '').includes('dal-zoomable'))?.props.src ?? '';
// 详情原图有两条合法路径：直连带新 rev 的 /file URL，或签名键控的 blob
// （签名含 mtime+size，内容一变必然 miss）—— 两条都不会落回旧内容。
check('enlarged card never serves stale media', detailSrc.startsWith('blob:') || detailSrc.includes('&rev=1'), detailSrc);
check('rescan did reach the host', fetchCalls.filter((call) => call.url.includes('/rescan')).length >= 1);

console.log('== preferences persistence ==');
storage.set('dsh-asset-library.prefs.v1', JSON.stringify({ kind: 'video', sort: 'mtime' }));
scopes.clear();
view = await frame();
// 排序不再用原生 <select>：当前值就写在触发器按钮的 title 上（也就是本地化后的排序名）。
const sortToggle = byTitle(view, '按修改时间');
check('stored sort preference is restored', sortToggle !== undefined);
const activeChip = view.elements.find((element) => element.props.className === 'dal-tab' && element.props['data-on'] === 'true');
check('stored kind preference selects that chip', String(activeChip?.props.children).startsWith('视频'), String(activeChip?.props.children));
check('preference written back to storage', String(storage.get('dsh-asset-library.prefs.v1')).includes('mtime'));
storage.clear();

console.log('== locale fallback (no translator prop) ==');
sandbox.document.documentElement.lang = 'zh-CN';
scopes.clear();
const zhView = await frame();
check('falls back to Chinese for zh-CN', zhView.flat.includes('资产库'));
sandbox.document.documentElement.lang = 'en-US';
sandbox.navigator.language = 'en-US';
scopes.clear();
const enView = await frame();
check('falls back to English for en-US', enView.flat.includes('Asset Library') && !enView.flat.includes('资产库'));

console.log('== sidebar icon ==');
const iconTree = renderScoped('Icon#0', sidebarRegistration.component, {});
check('icon renders an svg', iconTree?.type === 'svg', String(iconTree?.type));
check('icon uses currentColor so the shell themes it', JSON.stringify(iconTree?.props ?? {}).includes('currentColor') || JSON.stringify(collect(iconTree).elements.map((element) => element.props)).includes('currentColor'));
check('icon is aria-hidden (decorative)', iconTree?.props?.['aria-hidden'] === true);

console.log('== recent projects dropdown ==');
sandbox.document.documentElement.lang = 'zh-CN';
sandbox.navigator.language = 'zh-CN';
scopes.clear();
view = await frame();
// 最近项目藏在项目下拉里：触发器标题就是当前项目根，菜单项一行显示名字 + 父目录。
const projectToggle = byTitle(view, 'G:\\fixture');
check('project switcher renders as a dropdown', projectToggle !== undefined);
projectToggle.props.onClick();
view = await frame();
const proj2Item = byLabelIn(view, 'proj2');
check('recent project is listed in the menu', proj2Item !== undefined, view.flat.slice(0, 200));
proj2Item.props.onClick();
view = await frame();
check('picking a recent project posts /root', fetchCalls.some((call) => call.url.includes('/root') && call.method === 'POST' && String(call.body).includes('proj2')));
byTitle(view, 'G:\\fixture').props.onClick();
view = await frame();
byLabel(view, '用默认目录').props.onClick();
view = await frame();

console.log('== thumbnail LRU survives remount ==');
sandbox.createImageBitmap = () => Promise.resolve({ width: 2000, height: 1200, close() {} });
scopes.clear();
view = await frame();
const blobSrc = view.elements.find((element) => element.type === 'img')?.props.src ?? '';
check('thumbnail generated through the bitmap path', blobSrc.startsWith('blob:'), blobSrc);
const fileFetchesBefore = fetchCalls.filter((call) => call.url.includes('/file?')).length;
scopes.clear();
view = await frame();
const fileFetchesAfter = fetchCalls.filter((call) => call.url.includes('/file?')).length;
const remountSrc = view.elements.find((element) => element.type === 'img')?.props.src ?? '';
check('remounted card reuses the cached thumbnail without re-fetching', fileFetchesAfter === fileFetchesBefore && remountSrc.startsWith('blob:'), `${fileFetchesBefore} -> ${fileFetchesAfter} src=${remountSrc}`);
sandbox.createImageBitmap = undefined;

console.log('');
console.log('note: real react-dom SSR is unavailable in this installation (react 18 vs react-dom 19),');
console.log('      so rendering and interaction are verified against a mini renderer.');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
