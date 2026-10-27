/**
 * 完整卡片数据拉取（跨客户端兼容层）
 *
 * 为什么需要这个文件：
 *   TauriTavern（SillyTavern 的 Rust/Tauri 原生移植版）的角色列表接口
 *   `/api/characters/all` 返回的是「浅层数据」——其源码的 into_shallow()
 *   会把 description / personality / scenario / first_mes / mes_example /
 *   system_prompt / post_history_instructions 全部清空，只留名字、作者、
 *   标签等列表渲染所需字段，完整卡片要另外调 `/api/characters/get` 拉。
 *   官方 SillyTavern 的列表接口默认返回完整数据 —— 所以同一个扩展在官方
 *   酒馆上能读到卡面内容、在 TauriTavern 上只能读到角色名，表现就是
 *   「模型交白卷」。
 *
 * 拉取链路（两级兜底）：
 *   1. POST /api/characters/get {avatar_url} —— 官方 SillyTavern 与
 *      TauriTavern 都有这个路由（TauriTavern 还特意兼容第三方扩展的
 *      旧版端点），返回归一化后的完整角色对象
 *   2. GET /characters/<avatar> —— 直接拿卡片文件自己解析：PNG 的
 *      chara / ccv3 tEXt 数据块（V1/V2/V3 卡），或 .json 卡原文。
 *      两个平台都把 /characters/* 作为静态资源端点提供
 *
 * 两条路都失败就返回 null，调用方继续用拿到的（浅层）数据，
 * 不会比不拉取更糟。
 */

/** PNG 文件签名 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * base64 → UTF-8 字符串。
 * atob 出来的是 latin1，必须再走一遍 TextDecoder，否则中文全乱码。
 * @param {string} b64
 * @returns {string}
 */
function base64ToUtf8(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * 读取一个 tEXt / iTXt 数据块，是角色卡就 parse 成对象。
 *
 * tEXt: keyword \0 text（text 为 base64，keyword 为 chara 或 ccv3）
 * iTXt: keyword \0 compFlag compMethod langTag \0 transKeyword \0 text
 *       （compFlag != 0 是压缩过的，罕见，直接跳过）
 *
 * @param {Uint8Array} bytes 整个 PNG 的字节
 * @param {number} start 数据块 data 的起始偏移
 * @param {number} length 数据块 data 的长度
 * @param {string} type 'tEXt' | 'iTXt'
 * @returns {object|null}
 */
function readCardTextChunk(bytes, start, length, type) {
    const end = start + length;
    let pos = start;

    // keyword 读到 \0 为止
    let keyword = '';
    while (pos < end && bytes[pos] !== 0) {
        keyword += String.fromCharCode(bytes[pos]);
        pos++;
    }
    pos++; // 跳过 \0

    if (type === 'iTXt') {
        const compFlag = bytes[pos] ?? 1;
        pos += 2; // compFlag + compMethod
        if (compFlag !== 0) return null; // 压缩的 iTXt 不碰
        while (pos < end && bytes[pos] !== 0) pos++; // language tag
        pos++;
        while (pos < end && bytes[pos] !== 0) pos++; // translated keyword
        pos++;
    }

    if (pos >= end) return null;
    if (keyword !== 'chara' && keyword !== 'ccv3') return null;

    // 载荷是 ASCII base64；个别工具可能直接塞 UTF-8 文本，做个兜底
    const raw = String.fromCharCode(...bytes.subarray(pos, end));
    let jsonText;
    try {
        jsonText = base64ToUtf8(raw);
    } catch {
        jsonText = raw;
    }

    try {
        const card = JSON.parse(jsonText);
        return card && typeof card === 'object' ? card : null;
    } catch {
        return null;
    }
}

/**
 * 从 PNG 字节里解析角色卡 JSON。
 *
 * PNG 结构：8 字节签名 + 若干 [length(4 BE) | type(4) | data | crc(4)]。
 * 角色卡元数据在 tEXt / iTXt 块里（keyword 为 chara 或 ccv3）。
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {object|null} 卡片 JSON（V1 平铺 / V2、V3 带 data 对象），失败返回 null
 */
export function parsePngCard(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
    if (bytes.length < 8 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;

    while (offset + 8 <= bytes.length) {
        const length = view.getUint32(offset);
        const type = String.fromCharCode(
            bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7],
        );
        const dataStart = offset + 8;
        // 块长度越界（文件损坏或被截断）就停，别死循环
        if (length > bytes.length || dataStart + length + 4 > bytes.length) break;

        if (type === 'tEXt' || type === 'iTXt') {
            const card = readCardTextChunk(bytes, dataStart, length, type);
            if (card) return card;
        }

        offset = dataStart + length + 4; // 跳过 data + CRC
    }
    return null;
}

/**
 * 拉取单个角色的完整卡片数据（浅层数据的兜底，见文件头说明）。
 *
 * @param {object} params
 * @param {string} params.avatar 角色文件名（如 姜域.png）
 * @param {() => Record<string, string>} [params.getRequestHeaders] 取请求头（CSRF 等），没有就跳过
 * @returns {Promise<{ card: object, via: 'api'|'file' }|null>}
 */
export async function fetchFullCharacter({ avatar, getRequestHeaders }) {
    if (!avatar) return null;
    const headers = typeof getRequestHeaders === 'function' ? (getRequestHeaders() ?? {}) : {};

    // 第一级：/api/characters/get（官方与 TauriTavern 均有此路由）
    try {
        const res = await fetch('/api/characters/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({ avatar_url: avatar }),
        });
        if (res.ok) {
            const data = await res.json().catch(() => null);
            if (data && typeof data === 'object' && !data.error) {
                return { card: data, via: 'api' };
            }
        }
    } catch {
        // 落到文件兜底
    }

    // 第二级：直接读卡片文件（PNG 解析 或 .json 原文）
    try {
        const res = await fetch(`/characters/${encodeURIComponent(avatar)}`);
        if (res.ok) {
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.length > 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
                const card = parsePngCard(bytes);
                if (card) return { card, via: 'file' };
            } else {
                // .json 卡：正文就是卡片 JSON
                const text = new TextDecoder('utf-8').decode(bytes);
                const card = JSON.parse(text);
                if (card && typeof card === 'object') return { card, via: 'file' };
            }
        }
    } catch {
        // 两级都不行，返回 null
    }

    return null;
}
