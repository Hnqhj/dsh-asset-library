/**
 * 图片尺寸探测：只读文件头，零依赖。
 *
 * 浏览器里 `<img>` 加载完才知道分辨率，但列表/卡片/Agent 工具希望在**不解码整个
 * 图片**的前提下就拿到宽高。PNG/GIF/BMP/WEBP 的尺寸都在头部固定偏移上；JPEG 把
 * 尺寸放在 SOF 段里，需要顺着 marker 链找 —— EXIF 缩略图可能把 SOF 推到几十 KB
 * 之后，所以 JPEG 最多读 64KB，其它格式 32 字节就够。
 *
 * 明确不支持的格式返回 `undefined`，调用方当作"未知"处理：AVIF/TIFF 的盒子结构
 * 值得做但不值得为它引入解析器；SVG 是矢量，宽高由 viewBox 和布局共同决定。
 * 魔数校验以文件实际字节为准，扩展名只用来决定读多少 —— 扩展名骗人的文件安全
 * 落在"未知"里。
 */
import { open } from 'node:fs/promises';

/** 支持头解析的扩展名；扫描用它决定要不要多读一次文件。 */
export const DIMENSION_EXTS = new Set(['.png', '.jpg', '.jpeg', '.jpe', '.gif', '.webp', '.bmp']);

/** JPEG 的 SOF 段可能躲在 EXIF 后面，给它放宽读取窗口。 */
const JPEG_READ_BYTES = 64 * 1024;

/** 合理尺寸上限：防御把随机文件当图片解析出天文数字。 */
function plausible(width, height) {
    return Number.isFinite(width) && Number.isFinite(height)
        && Number.isInteger(width) && Number.isInteger(height)
        && width > 0 && height > 0 && width <= 1_000_000 && height <= 1_000_000;
}

function parseDimensions(buffer, ext) {
    if (ext === '.png' && buffer.length >= 24
        && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        return plausible(width, height) ? { width, height } : undefined;
    }
    if (ext === '.gif' && buffer.length >= 10 && buffer.subarray(0, 3).toString('latin1') === 'GIF') {
        const width = buffer.readUInt16LE(6);
        const height = buffer.readUInt16LE(8);
        return plausible(width, height) ? { width, height } : undefined;
    }
    if (ext === '.bmp' && buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
        // 高度为负表示自顶向下的行序，尺寸取绝对值。
        const width = Math.abs(buffer.readInt32LE(18));
        const height = Math.abs(buffer.readInt32LE(22));
        return plausible(width, height) ? { width, height } : undefined;
    }
    if (ext === '.webp' && buffer.length >= 30
        && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
        && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
        const chunk = buffer.subarray(12, 16).toString('latin1');
        if (chunk === 'VP8 ') {
            // 有损帧：sync 0x9D 0x01 0x2A 之后是 14bit 宽 + 14bit 高。
            if (buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
                const width = buffer.readUInt16LE(26) & 0x3fff;
                const height = buffer.readUInt16LE(28) & 0x3fff;
                return plausible(width, height) ? { width, height } : undefined;
            }
            return undefined;
        }
        if (chunk === 'VP8L') {
            // 无损帧：payload 首字节是 0x2F 签名，随后 u32LE 里 14bit 宽-1、14bit 高-1。
            if (buffer.length >= 25 && buffer[20] === 0x2f) {
                const bits = buffer.readUInt32LE(21);
                const width = (bits & 0x3fff) + 1;
                const height = ((bits >>> 14) & 0x3fff) + 1;
                return plausible(width, height) ? { width, height } : undefined;
            }
            return undefined;
        }
        if (chunk === 'VP8X') {
            // 扩展格式：canvas 尺寸是 24bit 的"值-1"。
            const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
            const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
            return plausible(width, height) ? { width, height } : undefined;
        }
        return undefined;
    }
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.jpe') {
        if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
        let offset = 2;
        while (offset + 4 <= buffer.length) {
            if (buffer[offset] !== 0xff) { offset += 1; continue; }
            const marker = buffer[offset + 1];
            // 独立 marker（无长度字段）：填充、重启、TEM。
            if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
            const segmentLength = buffer.readUInt16BE(offset + 2);
            const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isSof) {
                if (offset + 9 > buffer.length) return undefined;
                const height = buffer.readUInt16BE(offset + 5);
                const width = buffer.readUInt16BE(offset + 7);
                return plausible(width, height) ? { width, height } : undefined;
            }
            offset += 2 + segmentLength;
        }
        return undefined;
    }
    return undefined;
}

/**
 * 读取文件头并解析尺寸。
 *
 * @param absolute - 绝对路径。
 * @param ext - 含点的小写扩展名。
 * @returns `{ width, height }`；文件读不了或格式不认识时返回 `undefined`。
 */
export async function probeDimensions(absolute, ext) {
    if (!DIMENSION_EXTS.has(ext)) return undefined;
    let handle;
    try {
        handle = await open(absolute, 'r');
    } catch {
        return undefined;
    }
    try {
        const readLength = ext === '.jpg' || ext === '.jpeg' || ext === '.jpe' ? JPEG_READ_BYTES : 32;
        const buffer = Buffer.alloc(readLength);
        const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
        if (bytesRead <= 0) return undefined;
        return parseDimensions(buffer.subarray(0, bytesRead), ext);
    } catch {
        return undefined;
    } finally {
        try {
            await handle.close();
        } catch {
            // 句柄关不掉就关不掉，文件描述符泄漏不该让探测失败。
        }
    }
}
