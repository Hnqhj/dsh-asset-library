/**
 * 资产库的 HTTP 面。
 *
 * 一条 `prefix` 路由（`/api/asset-library`）承载全部端点，全部 JSON（媒体流除
 * 外），并且**先过浏览器信任栅栏再做任何工作**：裸 Web 路由不继承 Connection
 * 服务的 Host/Origin 栅栏，不查这一步就等于把这个接口开放给任意网页。
 *
 * 栅栏是按请求解析的（`gate()` 每次调用），因为 Connection 行可能在本路由注册
 * 之后才激活 —— 快照式捕获会永久留一个空洞。
 *
 * 媒体流走原生 `req`/`res`，因此能实现 HTTP Range：视频拖动进度条的前提。
 */
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { classify, mimeOf } from './kinds.js';
import { normalizeRelPath, openAsset } from './paths.js';

/** 整条 API 的路径前缀。 */
export const ROUTE_PREFIX = '/api/asset-library';

/** 请求体上限：端点只收两个字段的 JSON，超过就是攻击。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 列表分页上限。 */
const MAX_LIMIT = 200;

/** 批量标注一次允许的资产数。 */
const MAX_BATCH = 500;

/** 搜索串长度上限。 */
const MAX_QUERY_LENGTH = 200;

/** 一个 HTTP 语义错误：状态码 + 信封里的 code。 */
class RouteError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'RouteError';
        this.status = status;
        this.code = code;
    }
}

/** 唯一的 JSON 出口；带 `no-store`，因为面板轮询的都是实时状态。 */
function sendJson(res, status, payload, extraHeaders) {
    if (res.headersSent) {
        res.destroy();
        return;
    }
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...extraHeaders,
    });
    res.end(JSON.stringify(payload));
}

/** 错误信封；与面板客户端的约定。 */
function errorPayload(code, message) {
    return { error: { code, message } };
}

/** 把任意抛出物映射成状态码 + code，意外错误不回显内部细节。 */
function toFailure(error) {
    if (error instanceof RouteError) return { status: error.status, code: error.code, message: error.message };
    return { status: 500, code: 'INTERNAL_ERROR', message: 'internal error' };
}

/** 抛出物的统一出口。 */
function sendFailure(res, error) {
    const failure = toFailure(error);
    sendJson(res, failure.status, errorPayload(failure.code, failure.message));
}

/** 方法校验：不匹配就是 405 并带 `Allow`。 */
function requireMethod(method, expected) {
    if (method !== expected) {
        const error = new RouteError(405, 'METHOD_NOT_ALLOWED', `Use ${expected}`);
        error.allow = expected;
        throw error;
    }
}

/** 有上限的 JSON 请求体读取；超限立刻停止缓冲并排空 socket。 */
async function readJsonBody(req) {
    const raw = await new Promise((resolve, reject) => {
        let size = 0;
        let settled = false;
        const chunks = [];
        const finish = (error) => {
            if (settled) return;
            settled = true;
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('aborted', onAborted);
            req.off('error', onError);
            if (error !== undefined) {
                chunks.length = 0;
                req.once('error', () => undefined);
                req.resume();
                reject(error);
                return;
            }
            resolve(Buffer.concat(chunks).toString('utf8'));
        };
        const onData = (chunk) => {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += part.length;
            if (size > MAX_BODY_BYTES) finish(new RouteError(400, 'BAD_REQUEST', `Request body exceeds ${MAX_BODY_BYTES} bytes`));
            else chunks.push(part);
        };
        const onEnd = () => finish();
        const onAborted = () => finish(new RouteError(400, 'BAD_REQUEST', 'Request body was aborted'));
        const onError = () => finish(new RouteError(400, 'BAD_REQUEST', 'Invalid request body'));
        req.on('data', onData);
        req.once('end', onEnd);
        req.once('aborted', onAborted);
        req.once('error', onError);
    });
    if (raw.trim() === '') return {};
    let value;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new RouteError(400, 'BAD_REQUEST', 'Invalid JSON body');
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RouteError(400, 'BAD_REQUEST', 'Body must be a JSON object');
    return value;
}

/** 栅栏返回值归一化：`true`/`undefined` 之外的都算拒绝。 */
function evaluateGate(gate, req, res) {
    const outcome = gate.requestRejection(req, res);
    if (outcome === undefined || outcome === false || outcome === null) return undefined;
    return typeof outcome === 'number' ? outcome : 403;
}

/** 解析单个字节区间；`'unsatisfiable'` 表示要回 416，`undefined` 表示"忽略 Range"。 */
function parseRange(header, total) {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
    if (match === null) return undefined;
    const [, rawStart, rawEnd] = match;
    if (rawStart === '' && rawEnd === '') return undefined;
    if (rawStart === '') {
        // 后缀区间：bytes=-500 表示最后 500 字节。
        const suffix = Number(rawEnd);
        if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
        return { start: Math.max(0, total - suffix), end: total - 1 };
    }
    const start = Number(rawStart);
    if (!Number.isFinite(start) || start >= total) return 'unsatisfiable';
    const end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
    if (!Number.isFinite(end) || end < start) return 'unsatisfiable';
    return { start, end };
}

/** 取含点的小写扩展名；没有扩展名时返回空串。 */
function extOf(relPath) {
    const cut = relPath.lastIndexOf('.');
    return cut === -1 ? '' : relPath.slice(cut).toLowerCase();
}

/**
 * 在系统文件管理器里定位一个文件。
 *
 * 只用 `spawn` + 参数数组，不经 shell：路径里的一切字符都不会被当成命令解释。失败
 * （没有桌面会话、没有 explorer、策略拦截）只回报错误，不抛异常 —— 一个便利按钮
 * 不该让整个请求变成 500。
 *
 * @param absolute - 已经过包含检查与扩展名收口的绝对路径。
 * @returns `{ ok, error? }`。
 */
function revealInFileManager(absolute) {
    const platform = process.platform;
    let command;
    let args;
    if (platform === 'win32') {
        // explorer 要求 `/select,<path>` 紧跟，中间不能有空格。
        command = 'explorer.exe';
        args = [`/select,${absolute}`];
    } else if (platform === 'darwin') {
        command = 'open';
        args = ['-R', absolute];
    } else {
        command = 'xdg-open';
        args = [dirname(absolute)];
    }
    try {
        const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => undefined);
        child.unref();
        return { ok: true };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}

/**
 * 流式返回一个资产文件。
 *
 * 同时承担两个职责：`<img>`/`<audio>`/`<video>` 的取源、以及视频拖动（Range）。
 * 响应**不做任何缓存**（`no-store`）：素材是会被反复覆盖的工作文件，改名/换图之后
 * 还吃旧缓存是最烦人的一类 bug。SVG 与其它可执行内容另外加了 CSP，避免"直接打开
 * 这个 URL"变成在 DSH 页面所属源里执行第三方脚本。
 */
async function sendFile(req, res, root, relPath) {
    const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
    // 只服务资产目录里收录的扩展名。包含检查已经挡住了目录外的文件，这一层挡住
    // 的是"目录内的非资产文件"（`.env`、私钥、脚本…）被 URL 直接读走 —— 媒体
    // 端点没有任何理由能打开它们。
    if (classify(ext) === undefined) throw new RouteError(404, 'NOT_FOUND', 'Not an asset file');
    const file = await openAsset(root, relPath);
    if (file === undefined) throw new RouteError(404, 'NOT_FOUND', 'Asset not found');
    const headers = {
        'content-type': mimeOf(ext),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; sandbox",
    };
    let start = 0;
    let end = Math.max(0, file.size - 1);
    let status = 200;
    const rangeHeader = req.headers.range;
    if (typeof rangeHeader === 'string') {
        const parsed = parseRange(rangeHeader, file.size);
        if (parsed === 'unsatisfiable') {
            res.writeHead(416, { ...headers, 'content-range': `bytes */${file.size}` });
            res.end();
            return;
        }
        if (parsed !== undefined) {
            start = parsed.start;
            end = parsed.end;
            status = 206;
            headers['content-range'] = `bytes ${start}-${end}/${file.size}`;
        }
    }
    headers['content-length'] = String(end - start + 1);
    if (req.method === 'HEAD') {
        res.writeHead(status, headers);
        res.end();
        return;
    }
    res.writeHead(status, headers);
    const stream = createReadStream(file.absolute, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
}

/** 读取列表查询参数并做范围校验。 */
function parseListQuery(url) {
    const kind = url.searchParams.get('kind');
    if (kind !== null && kind !== '' && !['image', 'video', 'audio'].includes(kind)) throw new RouteError(400, 'BAD_REQUEST', `Unknown kind: ${kind}`);
    const q = (url.searchParams.get('q') ?? '').slice(0, MAX_QUERY_LENGTH);
    const dir = url.searchParams.get('dir') ?? '';
    const tag = url.searchParams.get('tag') ?? '';
    const sort = url.searchParams.get('sort') ?? 'name';
    if (!['name', 'mtime', 'size'].includes(sort)) throw new RouteError(400, 'BAD_REQUEST', `Unknown sort: ${sort}`);
    const orderRaw = url.searchParams.get('order') ?? '';
    const order = orderRaw === '' ? undefined : orderRaw;
    if (order !== undefined && !['asc', 'desc'].includes(order)) throw new RouteError(400, 'BAD_REQUEST', `Unknown order: ${order}`);
    const limitRaw = Number(url.searchParams.get('limit') ?? '60');
    const offsetRaw = Number(url.searchParams.get('offset') ?? '0');
    const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limitRaw))) : 60;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;
    return { kind: kind === null || kind === '' ? undefined : kind, q, dir, tag, sort, order, limit, offset };
}

/**
 * 注册资产库路由。
 *
 * @param webServer - `webServer`/`httpServer` 服务（调用方用 `ctx.get` 守卫）。
 * @param gate - 每次请求解析浏览器信任栅栏（`ctx.get('connection')`），`undefined` 表示无栅栏。
 * @param service - 资产库内核（扫描、标注、根目录解析）；见 `index.js`。
 * @returns 路由 disposer，交给 `ctx.effect` 回收。
 */
export function registerAssetLibraryRoutes(webServer, gate, service) {
    const handle = async (req, res) => {
        const resolvedGate = gate();
        if (resolvedGate !== undefined) {
            const rejection = evaluateGate(resolvedGate, req, res);
            if (rejection !== undefined) {
                sendJson(res, rejection, errorPayload(rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', rejection === 401 ? 'unauthorized' : 'forbidden'));
                return;
            }
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/gu, '');
        const segments = path === '' ? [] : path.split('/');
        const [head] = segments;

        if (segments.length === 0) {
            requireMethod(method, 'GET');
            sendJson(res, 200, { name: 'asset-library', endpoints: ['status', 'assets', 'asset', 'file', 'tree', 'rescan', 'annotate', 'root', 'reveal'] });
            return;
        }

        if (head === 'status' && segments.length === 1) {
            requireMethod(method, 'GET');
            // `capabilities` 是宿主与面板之间的能力协商：面板据此决定要不要显示
            // "在资源管理器中显示"这类依赖较新宿主的按钮。旧宿主的 /status 没有这个
            // 字段，面板自动降级，而不是给用户一个点了就报错的按钮。
            sendJson(res, 200, { ...(await service.status()), capabilities: ['assets', 'file', 'tree', 'annotate', 'root', 'reveal'] });
            return;
        }
        if (head === 'assets' && segments.length === 1) {
            requireMethod(method, 'GET');
            sendJson(res, 200, await service.list(parseListQuery(url)));
            return;
        }
        if (head === 'asset' && segments.length === 1) {
            requireMethod(method, 'GET');
            const item = await service.detail((url.searchParams.get('relPath') ?? '').trim());
            if (item === undefined) throw new RouteError(404, 'NOT_FOUND', 'Asset not found');
            sendJson(res, 200, { item });
            return;
        }
        if (head === 'tree' && segments.length === 1) {
            requireMethod(method, 'GET');
            sendJson(res, 200, await service.tree());
            return;
        }
        if (head === 'rescan' && segments.length === 1) {
            requireMethod(method, 'POST');
            sendJson(res, 200, await service.rescan());
            return;
        }
        if (head === 'root' && segments.length === 1) {
            requireMethod(method, 'POST');
            const body = await readJsonBody(req);
            const requested = typeof body.root === 'string' ? body.root.trim() : '';
            sendJson(res, 200, await service.setRoot(requested));
            return;
        }
        if (head === 'reveal' && segments.length === 1) {
            requireMethod(method, 'POST');
            const body = await readJsonBody(req);
            const relPath = normalizeRelPath(body.relPath);
            if (relPath === undefined) throw new RouteError(400, 'BAD_REQUEST', 'Invalid relPath');
            const root = await service.rootAbs();
            if (root === undefined) throw new RouteError(409, 'NO_ROOT', 'No asset root configured');
            const file = await openAsset(root, relPath);
            // 与媒体端点同样的收口：只认资产扩展名。否则这个端点会变成"用资源管理器
            // 打开项目里任意文件"的通用能力（.env、私钥、脚本都不该出现在这里）。
            if (file === undefined || classify(extOf(relPath)) === undefined) throw new RouteError(404, 'NOT_FOUND', 'Asset not found');
            const outcome = revealInFileManager(file.absolute);
            sendJson(res, 200, { ok: outcome.ok, absolutePath: file.absolute, error: outcome.error });
            return;
        }
        if (head === 'annotate' && segments.length === 1) {
            requireMethod(method, 'POST');
            const body = await readJsonBody(req);
            const patch = {
                tags: Array.isArray(body.tags) ? body.tags : undefined,
                tagsAdd: Array.isArray(body.tagsAdd) ? body.tagsAdd : undefined,
                tagsRemove: Array.isArray(body.tagsRemove) ? body.tagsRemove : undefined,
                note: typeof body.note === 'string' ? body.note : undefined,
            };
            // 批量形态：relPaths 数组 + tagsAdd/tagsRemove（增量并集/差集）。
            if (Array.isArray(body.relPaths)) {
                if (body.relPaths.length > MAX_BATCH) throw new RouteError(400, 'BAD_REQUEST', `relPaths limited to ${MAX_BATCH} entries`);
                sendJson(res, 200, await service.annotateMany(body.relPaths, patch));
                return;
            }
            const relPath = normalizeRelPath(body.relPath);
            if (relPath === undefined) throw new RouteError(400, 'BAD_REQUEST', 'Invalid relPath');
            const item = await service.annotate(relPath, patch);
            if (item === undefined) throw new RouteError(404, 'NOT_FOUND', 'Asset not found');
            sendJson(res, 200, { item });
            return;
        }
        if (head === 'file' && segments.length === 1) {
            if (method !== 'GET' && method !== 'HEAD') throw new RouteError(405, 'METHOD_NOT_ALLOWED', 'Use GET');
            const relPath = normalizeRelPath(url.searchParams.get('relPath'));
            if (relPath === undefined) throw new RouteError(400, 'BAD_REQUEST', 'Invalid relPath');
            const root = await service.rootAbs();
            if (root === undefined) throw new RouteError(409, 'NO_ROOT', 'No asset root configured');
            await sendFile(req, res, root, relPath);
            return;
        }
        throw new RouteError(404, 'NOT_FOUND', `Unknown route: ${url.pathname}`);
    };

    return webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
            try {
                await handle(req, res);
            } catch (error) {
                // 所有拒绝都收敛成约定的信封，传输层才能继续服务下一个请求。
                sendFailure(res, error);
            }
        },
    });
}
