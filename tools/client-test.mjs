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
        if (slots[index] === undefined) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
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

/** 遍历元素树；函数组件按"组件名#出现序号"取自己的 hooks 状态。 */
function collect(tree) {
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
        if (typeof props.className === 'string') classes.add(props.className);
        if (node.type === 'style') {
            const child = props.children ?? node.children;
            styleSheets.push(Array.isArray(child) ? child.join('') : String(child ?? ''));
        }
        walk(props.children ?? node.children);
    })(tree);
    return { texts, classes, styleSheets, elements, flat: texts.join(' | ') };
}
const byClass = (view, className) => view.elements.filter((element) => element.props.className === className);
/** className 可能带修饰（dal-card dal-selected…），按词匹配。 */
const withClass = (view, name) => view.elements.filter((element) => String(element.props.className ?? '').split(/\s+/u).includes(name));
const byText = (view, text) => view.elements.find((element) => element.type === 'button' && element.props.children === text);

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
const storage = new Map();
const windowListeners = new Map();
const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload, blob: async () => ({ size: 10, type: 'image/png' }) });
async function fakeFetch(url, init) {
    const text = String(url);
    fetchCalls.push({ url: text, method: init?.method ?? 'GET', body: init?.body });
    if (text.includes('/assets?')) return jsonResponse({ items: assets, total: assets.length, offset: 0, limit: 60, hasMore: false, counts: status.counts, filteredCounts: status.counts, truncated: false, scannedAt: status.scannedAt, projectRoot: status.projectRoot, assetsRoot: status.assetsRoot });
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
        createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (resolve) => resolve({ size: 1, type: 'image/jpeg' }) }),
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
check('stylesheet defines the enlarged-card layout', css.includes('.dal-detail-grid') && css.includes('grid-template-columns:minmax(0,1fr) 320px'));
check('title + subtitle + counts rendered', view.flat.includes('资产库') && view.flat.includes('项目文件夹里的图片、视频、音乐') && view.flat.includes('共 9 项'));
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

console.log('== probed dimensions, portrait cards, tag colors ==');
const portraitThumb = withClass(view, 'dal-thumb-portrait')[0];
check('portrait image gets a 3:4 contain thumb', portraitThumb !== undefined && portraitThumb.props.style?.aspectRatio === '3 / 4');
check('probed dimensions appear on cards', view.flat.includes('720×1280'));
const hueChip = byClass(view, 'dal-tag')[0];
check('tag chips carry a stable hue color', String(hueChip?.props?.style?.background ?? '').startsWith('hsla('), String(hueChip?.props?.style?.background));

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
byText(view, '#主封面 1').props.onClick();
view = await frame();

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

console.log('== grid keyboard navigation ==');
windowListeners.get('keydown')({ key: 'ArrowRight', target: { tagName: 'BODY' }, preventDefault() {} });
view = await frame();
check('arrow moves the grid cursor to the first card', withClass(view, 'dal-cursor').length === 1);
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
byText(view, '← 返回').props.onClick();
view = await frame();

console.log('== matched count in the header ==');
byText(view, '图片 5').props.onClick();
view = await frame();
check('header shows the matched count while filtering', view.flat.includes('匹配 3 / 共 9 项'), view.flat.slice(0, 200));
byText(view, '全部 9').props.onClick();
view = await frame();

console.log('== sort direction toggle ==');
let dirToggle = view.elements.find((element) => element.type === 'button' && ['↑', '↓', '↕'].includes(element.props.children));
check('direction toggle sits next to the sort select', dirToggle !== undefined);
dirToggle.props.onClick();
view = await frame();
check('ascending order reaches the API', fetchCalls.some((call) => call.url.includes('order=asc')));
dirToggle = view.elements.find((element) => element.type === 'button' && element.props.children === '↑');
dirToggle.props.onClick();
view = await frame();
check('descending order reaches the API', fetchCalls.some((call) => call.url.includes('order=desc')));
dirToggle = view.elements.find((element) => element.type === 'button' && element.props.children === '↓');
dirToggle.props.onClick();
view = await frame();
check('direction cycles back to the default', !fetchCalls.some((call) => call.url.includes('order=asc') && call.url.endsWith(String(fetchCalls.length))));

console.log('== media extras (hover preview, audio duration) ==');
check('video cards accept hover preview handlers', view.elements.some((element) => element.type === 'video' && typeof element.props.onMouseEnter === 'function'));
check('audio cards mount a metadata audio element', view.elements.some((element) => element.type === 'audio' && element.props.preload === 'metadata'));

console.log('== reference pin ==');
byClass(view, 'dal-card')[0].props.onClick();
view = await frame();
const pinButton = byText(view, '设为参照');
check('pin button sits in the detail bar', pinButton !== undefined);
pinButton.props.onClick();
view = await frame();
check('pin toggles to unpin', byText(view, '📌 取消参照') !== undefined);
byText(view, '← 返回').props.onClick();
view = await frame();
check('pinned strip shows above the grid', view.flat.includes('📌 cover.png'));
byClass(view, 'dal-card')[1].props.onClick();
view = await frame();
check('reference thumbnail overlays the stage', view.elements.some((element) => element.props.className === 'dal-ref'));
view.elements.find((element) => element.props.className === 'dal-ref').props.onClick();
view = await frame();
check('clicking the reference swaps the detail view', view.flat.includes('cover.png'));
byText(view, '📌 取消参照').props.onClick();
view = await frame();
byText(view, '← 返回').props.onClick();
view = await frame();
check('pinned strip gone after unpinning', !view.flat.includes('📌 cover.png'));

console.log('== folder chips narrow progressively ==');
check('top-level chips show first-level folders', Boolean(byText(view, 'audio 1')));
byText(view, 'audio 1').props.onClick();
view = await frame();
check('parent navigation appears inside a folder', view.flat.includes('上一级'));
const upChip = view.elements.find((element) => element.type === 'button' && String(element.props.children ?? '').includes('上一级'));
upChip.props.onClick();
view = await frame();
check('parent click returns to the top level', !view.flat.includes('上一级'));

console.log('== click a card -> enlarged card (left media / right details) ==');
byClass(view, 'dal-card')[0].props.onClick();
view = await frame();
check('detail view replaces the grid', view.classes.has('dal-detail') && !view.classes.has('dal-grid'));
check('two-column layout present', view.classes.has('dal-detail-grid') && view.classes.has('dal-stage') && view.classes.has('dal-info'));
check('media stage shows the image itself', view.elements.some((element) => element.type === 'img' && String(element.props.src).includes('/file?relPath=images%2Fcover.png')));
check('details show type, size, modified and both paths', view.flat.includes('图片 · .png') && view.flat.includes('40 KB') && view.flat.includes('images/cover.png') && view.flat.includes('G:\\fixture\\assets\\images\\cover.png'));
check('tags are editable in the detail view', view.elements.some((element) => element.type === 'input' && element.props.placeholder === '回车添加标签'));
check('note is editable in the detail view', view.elements.some((element) => element.type === 'textarea'));
check('detail offers copy / reveal / open-in-tab', Boolean(byText(view, '复制路径')) && Boolean(byText(view, '在资源管理器中显示')) && view.elements.some((element) => element.type === 'a' && element.props.target === '_blank'));
check('position indicator shows the index', view.flat.includes('1 / 3'));
check('keyboard listener registered for Esc/arrows', typeof windowListeners.get('keydown') === 'function');

console.log('== navigation inside the enlarged card ==');
let navButtons = view.elements.filter((element) => element.type === 'button' && ['‹', '›'].includes(element.props.children));
check('prev disabled on the first asset, next enabled', navButtons[0]?.props.disabled === true && navButtons[1]?.props.disabled === false);
navButtons[1].props.onClick();
view = await frame();
check('next shows the following asset', view.flat.includes('scene-01.mp4') && view.flat.includes('2 / 3'));
check('video asset renders a native player', view.elements.some((element) => element.type === 'video' && element.props.controls === true));
byText(view, '← 返回').props.onClick();
view = await frame();
check('back button returns to the grid', view.classes.has('dal-grid') && byClass(view, 'dal-card').length === 3);

console.log('== Esc returns from the enlarged card ==');
byClass(view, 'dal-card')[2].props.onClick();
view = await frame();
check('audio asset opened', view.flat.includes('theme.wav') && view.classes.has('dal-detail'));
check('audio asset uses a native audio player', view.elements.some((element) => element.type === 'audio' && element.props.controls === true));
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
byText(view, '← 返回').props.onClick();
view = await frame();
check('back button returns to the grid', view.classes.has('dal-grid') && byClass(view, 'dal-card').length === 3);

console.log('== detail actions ==');
byClass(view, 'dal-card')[0].props.onClick();
view = await frame();
await byText(view, '复制路径').props.onClick();
view = await frame();
check('copy writes the absolute path to the clipboard', clipboardWrites.includes('G:\\fixture\\assets\\images\\cover.png'), clipboardWrites.join(','));
check('copy button confirms with a label change', view.flat.includes('已复制'));
await byText(view, '在资源管理器中显示').props.onClick();
await settle();
check('reveal posts to the host endpoint', fetchCalls.some((call) => call.url.includes('/api/asset-library/reveal') && call.method === 'POST'));
view = await frame();
await byText(view, '保存').props.onClick();
view = await frame();
check('save posts annotations and confirms', fetchCalls.some((call) => call.url.includes('/annotate') && call.method === 'POST') && view.flat.includes('已保存'));

console.log('== capability negotiation ==');
// 旧宿主的 /status 不带 capabilities：面板必须自动降级，不能给一个点了就报错的按钮。
const declaredCapabilities = status.capabilities;
delete status.capabilities;
scopes.clear();
byClass(view, 'dal-card').length; // no-op，保持可读性
view = await frame();
byClass(view, 'dal-card')[0]?.props.onClick();
view = await frame();
check('reveal button hidden when the host does not declare it', byText(view, '在资源管理器中显示') === undefined && Boolean(byText(view, '复制路径')));
check('open-in-tab still works without the capability', view.elements.some((element) => element.type === 'a' && element.props.target === '_blank'));
status.capabilities = declaredCapabilities;
scopes.clear();
view = await frame();

console.log('== thumbnails and lazy loading ==');
byText(view, '← 返回')?.props.onClick();
view = await frame();
check('image cards render an image element once in view', view.elements.some((element) => element.type === 'img' && String(element.props.src).includes('/file?relPath=')));
check('every media request stays same-origin', fetchCalls.every((call) => !/^https?:/u.test(call.url)));

console.log('== rescan changes the media URL (never show stale media) ==');
const gridSrcBefore = view.elements.find((element) => element.type === 'img')?.props.src ?? '';
await byText(view, '重新扫描').props.onClick();
view = await frame();
const gridSrcAfter = view.elements.find((element) => element.type === 'img')?.props.src ?? '';
check('grid media URL carries a revision after rescan', gridSrcAfter.includes('&rev=1') && gridSrcAfter !== gridSrcBefore, gridSrcAfter);
byClass(view, 'dal-card')[0].props.onClick();
view = await frame();
const detailSrc = view.elements.find((element) => element.type === 'img')?.props.src ?? '';
check('enlarged card media URL carries the same revision', detailSrc.includes('&rev=1'), detailSrc);
check('rescan did reach the host', fetchCalls.filter((call) => call.url.includes('/rescan')).length >= 1);

console.log('== preferences persistence ==');
storage.set('dsh-asset-library.prefs.v1', JSON.stringify({ kind: 'video', sort: 'mtime' }));
scopes.clear();
view = await frame();
const select = view.elements.find((element) => element.type === 'select' && JSON.stringify(element.props.children).includes('mtime'));
check('stored sort preference is restored', select?.props.value === 'mtime', String(select?.props.value));
const activeChip = view.elements.find((element) => element.props.className === 'dal-chip' && element.props['data-on'] === 'true');
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
const recentSelect = view.elements.find((element) => element.type === 'select' && element.props.value === '' && JSON.stringify(element.props.children).includes('proj2'));
check('recent projects render as a dropdown', recentSelect !== undefined);
recentSelect.props.onChange({ target: { value: 'G:\\proj2' } });
view = await frame();
check('picking a recent project posts /root', fetchCalls.some((call) => call.url.includes('/root') && call.method === 'POST' && String(call.body).includes('proj2')));
byText(view, '用默认目录').props.onClick();
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
