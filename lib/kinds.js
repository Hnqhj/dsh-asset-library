/**
 * 文件类型目录：哪些扩展名算"资产"，以及流式返回时该用什么 MIME。
 *
 * 这份清单是**封闭**的：资产库只声明浏览器能原生解码预览的文件，这样扫描时
 * 遇到的其它文件会被跳过，而不是在网格里变成一个打不开的破图。新增类型只在
 * 确认浏览器原生支持后才加进来。
 */

/** 图片：浏览器可原生解码的位图与矢量格式。 */
const IMAGE_MIME = new Map([
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.jpe', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
    ['.gif', 'image/gif'],
    ['.avif', 'image/avif'],
    ['.bmp', 'image/bmp'],
    ['.svg', 'image/svg+xml'],
    ['.ico', 'image/x-icon'],
    ['.tif', 'image/tiff'],
    ['.tiff', 'image/tiff'],
]);

/** 视频：容器格式；能否播放取决于浏览器对该容器+编码的支持。 */
const VIDEO_MIME = new Map([
    ['.mp4', 'video/mp4'],
    ['.m4v', 'video/x-m4v'],
    ['.mov', 'video/quicktime'],
    ['.webm', 'video/webm'],
    ['.mkv', 'video/x-matroska'],
    ['.avi', 'video/x-msvideo'],
    ['.ogv', 'video/ogg'],
]);

/** 音频。 */
const AUDIO_MIME = new Map([
    ['.mp3', 'audio/mpeg'],
    ['.wav', 'audio/wav'],
    ['.flac', 'audio/flac'],
    ['.m4a', 'audio/mp4'],
    ['.aac', 'audio/aac'],
    ['.ogg', 'audio/ogg'],
    ['.oga', 'audio/ogg'],
    ['.opus', 'audio/opus'],
    ['.aif', 'audio/aiff'],
    ['.aiff', 'audio/aiff'],
    ['.wma', 'audio/x-ms-wma'],
]);

/** 资产种类，顺序即界面上的默认排序。 */
export const KINDS = ['image', 'video', 'audio'];

/** 种类 → 扩展名→MIME 表。 */
const TABLES = { image: IMAGE_MIME, video: VIDEO_MIME, audio: AUDIO_MIME };

/**
 * 判断扩展名属于哪种资产。
 *
 * @param ext - 含点的小写扩展名（例如 `.png`）。
 * @returns 资产种类，未收录时返回 `undefined`。
 */
export function classify(ext) {
    for (const kind of KINDS) {
        if (TABLES[kind].has(ext)) return kind;
    }
    return undefined;
}

/**
 * 取扩展名对应的 MIME。
 *
 * @param ext - 含点的小写扩展名。
 * @returns MIME 字符串；未收录时退化为 `application/octet-stream`。
 */
export function mimeOf(ext) {
    for (const kind of KINDS) {
        const mime = TABLES[kind].get(ext);
        if (mime !== undefined) return mime;
    }
    return 'application/octet-stream';
}

/**
 * 该 MIME 是否属于"可以安全内联进页面"的类型。
 *
 * SVG 是唯一需要额外处理的一类：它能携带脚本，直接在新标签页打开就等于在 DSH
 * 页面所属源里执行第三方脚本，因此流式返回时会额外加 CSP 限制（见 routes.js）。
 */
export function isInlineSafe(ext) {
    return ext !== '.svg';
}
