/**
 * 无头截图（CDP 版）。
 *
 * 为什么不用 `msedge --screenshot=`：`--window-size` 是**窗口**尺寸，含浏览器 chrome，
 * 实际视口比它小，截图底部会多出一条 html 底色 —— 那会让你以为"页面底部有一条色带"，
 * 其实是截图工具的假象。CDP 用 `Emulation.setDeviceMetricsOverride` 精确设定视口，
 * 还能顺手把 DOM 测量结果打回终端。
 *
 * 用法：
 *   node .workbuddy/verify/shot.mjs --url "file:///D:/.../grid.html" --out _s1.png --w 1228 --h 768
 *   ... --dpr 2 --clip "16,16,600,200" --eval "document.querySelectorAll('.dal-card').length"
 *
 * 参数：--url --out --w --h --dpr --clip x,y,w,h --wait ms --full --eval <js>
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const BROWSER_CANDIDATES = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\Microsoft Edge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

function parseArgs(argv) {
    const out = { evals: [], wait: 1800, dpr: 1, w: 1228, h: 768 };
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i];
        const value = argv[i + 1];
        if (key === '--url') { out.url = value; i += 1; }
        else if (key === '--out') { out.out = value; i += 1; }
        else if (key === '--w') { out.w = Number(value); i += 1; }
        else if (key === '--h') { out.h = Number(value); i += 1; }
        else if (key === '--dpr') { out.dpr = Number(value); i += 1; }
        else if (key === '--wait') { out.wait = Number(value); i += 1; }
        else if (key === '--clip') { out.clip = value.split(',').map(Number); i += 1; }
        else if (key === '--eval') { out.evals.push(value); i += 1; }
        else if (key === '--full') { out.full = true; }
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.url === undefined || args.out === undefined) {
    console.error('need --url and --out');
    process.exit(2);
}
const browserPath = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
if (browserPath === undefined) {
    console.error('no chromium-based browser found');
    process.exit(2);
}

// profile 必须放数据盘：反复用 %TEMP% 起无头浏览器会把 C 盘写满。
const profileDir = resolve('.workbuddy/verify/.edge-tmp');
await mkdir(profileDir, { recursive: true });
const port = 9333 + (process.pid % 400);

const child = spawn(browserPath, [
    '--headless',
    '--no-proxy-server',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-prefers-reduced-motion',
    `--user-data-dir=${profileDir}`,
    `--disk-cache-dir=${profileDir}/cache`,
    `--remote-debugging-port=${port}`,
    'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserEndpoint() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            const payload = await response.json();
            if (payload.webSocketDebuggerUrl !== undefined) return payload.webSocketDebuggerUrl;
        } catch { /* 还没起来 */ }
        await sleep(200);
    }
    throw new Error('browser did not expose a debugging endpoint');
}

function connect(url) {
    const socket = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const events = [];
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== undefined) {
            const entry = pending.get(message.id);
            if (entry !== undefined) {
                pending.delete(message.id);
                if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)));
                else entry.resolve(message.result);
            }
            return;
        }
        events.push(message);
    });
    const ready = new Promise((resolveReady, rejectReady) => {
        socket.addEventListener('open', () => resolveReady());
        socket.addEventListener('error', (error) => rejectReady(error));
    });
    const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve: resolveSend, reject: rejectSend });
        socket.send(JSON.stringify({ id, method, params }));
    });
    return { send, ready, events, close: () => socket.close() };
}

try {
    const browserWs = await browserEndpoint();
    const browser = connect(browserWs);
    await browser.ready;
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((entry) => entry.id === targetId);
    const session = connect(page.webSocketDebuggerUrl);
    await session.ready;

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable');
    // 改了文件却没变化，十次有九次是缓存 —— 直接关掉，别靠"删 profile 重跑"。
    await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    await session.send('Emulation.setDeviceMetricsOverride', {
        width: args.w,
        height: args.h,
        deviceScaleFactor: args.dpr,
        mobile: false,
    });
    await session.send('Page.navigate', { url: args.url });
    await sleep(args.wait);

    for (const expression of args.evals) {
        // 不能直接 JSON.stringify：表达式返回 Promise 时会被同步序列化成 "{}"，
        // awaitPromise 就白设了。先摊平再序列化。
        const wrapped = 'Promise.resolve((function(){ try { return (' + expression + '); } '
            + 'catch(e){ return "ERR " + e.message; } })()).then('
            + 'function(v){ return typeof v === "string" ? v : JSON.stringify(v); },' 
            + 'function(e){ return "ERR " + (e && e.message); })';
        const result = await session.send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
        console.log(`eval> ${expression}\n  => ${result.result?.value}`);
    }

    const shotArgs = { format: 'png', captureBeyondViewport: args.full === true };
    if (args.clip !== undefined) {
        // clip.scale 不能再乘一次 DPR：deviceScaleFactor 已经让整页按 DPR 渲染，
        // 再乘一次会得到 dpr² 倍图，按 ×dpr 换算采样坐标就全错一倍。
        shotArgs.clip = { x: args.clip[0], y: args.clip[1], width: args.clip[2], height: args.clip[3], scale: 1 };
    }
    const shot = await session.send('Page.captureScreenshot', shotArgs);
    await writeFile(args.out, Buffer.from(shot.data, 'base64'));
    console.log(`wrote ${args.out}`);
    session.close();
    browser.close();
} finally {
    child.kill();
    await sleep(300);
    if (process.env.KEEP_EDGE_PROFILE !== '1') await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
}
