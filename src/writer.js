/**
 * 标签写入层
 *
 * 两条互不干扰的通道：
 *
 * A. 本地标签（settings.tags / settings.tag_map）
 *    - SillyTavern 角色管理面板里真正用于筛选、虚拟文件夹的就是这一套
 *    - 实体 key = character.avatar（头像文件名）
 *    - 纯内存操作 + 最后一次 saveSettingsDebounced()，几百张卡秒完成
 *    - 不碰 PNG，零风险
 *
 * B. 卡片内嵌标签（PNG 里的 data.tags）
 *    - 走 POST /api/characters/merge-attributes 单条模式
 *    - 该端点不走 charaFormatData，保留 V3 spec，只做 deepMerge
 *    - 代价：ST 会用 tryReadImage 重新编码一遍 PNG（可能按头像设置缩放）
 *    - 因此默认关闭，且执行前强制用户确认
 */

/**
 * 按名字找本地已有标签。
 * @param {object} context getContext()
 * @param {string} name
 * @returns {object|undefined}
 */
export function findLocalTag(context, name) {
    const target = String(name).trim();
    if (!target) return undefined;
    const list = context?.tags;
    if (!Array.isArray(list)) return undefined;
    return list.find(t => t && t.name === target);
}

/**
 * 取一个本地标签，没有就新建（不落盘）。
 * 字段结构对齐 SillyTavern 的 newTag()：缺少关键字段会让 UI 渲染异常。
 * @param {object} context getContext()
 * @param {string} name
 * @returns {object} Tag 对象（已 push 进 context.tags）
 */
export function ensureLocalTag(context, name) {
    const existing = findLocalTag(context, name);
    if (existing) return existing;

    const list = context.tags;
    const template = Array.isArray(list) && list.length ? list[0] : null;

    // tags 量大时不能展开运算符（会爆栈），这里用 reduce
    const maxSort = (list ?? []).reduce((m, t) => Math.max(m, Number(t?.sort_order) || 0), 0);

    const tag = {
        id: context.uuidv4 ? context.uuidv4() : crypto.randomUUID(),
        name: String(name).trim(),
        folder_type: template?.folder_type ?? 'NONE',
        filter_state: template?.filter_state ?? 'UNDEFINED',
        sort_order: maxSort + 1,
        is_hidden_on_character_card: false,
        color: '',
        color2: '',
        create_date: Date.now(),
    };

    list.push(tag);
    return tag;
}

/**
 * 给一个角色挂上本地标签（内存操作，不落盘）。
 * @param {object} context
 * @param {string} avatar 角色 key（即 character.avatar）
 * @param {string[]} tagNames
 * @param {{ replace?: boolean }} options replace=true 时先清空原有标签
 * @returns {string[]} 该角色最终的标签名列表
 */
export function assignLocalTags(context, avatar, tagNames, options = {}) {
    const key = String(avatar);
    const map = context.tagMap;
    if (!map) return [];

    const clean = tagNames
        .map(x => String(x).trim())
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i);

    const ids = options.replace ? [] : (Array.isArray(map[key]) ? [...map[key]] : []);

    for (const name of clean) {
        const tag = ensureLocalTag(context, name);
        if (!ids.includes(tag.id)) ids.push(tag.id);
    }

    map[key] = ids;
    return clean;
}

/**
 * 落盘本地标签并刷新角色列表。
 * @param {object} context
 */
export function persistLocalTags(context) {
    context?.saveSettingsDebounced?.();
}

/**
 * 取带 CSRF token 的请求头。
 * SillyTavern 把 token 藏在 script.js 的模块作用域里，扩展拿不到，
 * 但 getContext() 暴露了 getRequestHeaders()，直接复用即可。
 * @param {object} context
 * @returns {object}
 */
function buildHeaders(context) {
    if (typeof context?.getRequestHeaders === 'function') {
        return context.getRequestHeaders();
    }
    // 兜底：老版本没有该方法时至少要带上 Content-Type
    return { 'Content-Type': 'application/json' };
}

/**
 * 通过 merge-attributes 把标签回填进 PNG 卡片本体。
 *
 * 服务端会用 request.body 整体 deepMerge 进卡片 JSON，
 * deepMerge 对数组是「整体替换」语义，所以必须在这里就把
 * 「原标签 + 新标签」算成最终数组再整包提交。
 *
 * @param {object} params
 * @param {object} params.context getContext()
 * @param {string} params.avatar 头像文件名（必须是 .png）
 * @param {string[]} params.allTags 该卡最终的完整标签列表
 * @returns {Promise<boolean>} 是否成功写入
 */
export async function writeCardTags({ context, avatar, allTags }) {
    if (!/\.png$/i.test(String(avatar))) {
        throw new Error('只有 .png 卡片支持回填，已跳过');
    }

    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: buildHeaders(context),
        body: JSON.stringify({
            avatar,
            // 顶层 tags 照顾 V1/V2 卡，data.tags 才是规范的 Spec V2 位置
            tags: allTags,
            data: { tags: allTags },
        }),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        // 纯 V3 卡会被 TavernCardValidator 拦下（该校验器只接受 V1/V2），
        // 服务端此时不会写任何东西，文件保持原样，提示清楚即可
        if (response.status === 400 && /valid/i.test(detail)) {
            throw new Error('卡片格式不受支持（多为纯 V3 卡），未做改动');
        }
        throw new Error(`HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }
    return true;
}

/**
 * 批量回填卡片内嵌标签（自带并发控制）。
 * @param {object} params
 * @param {object} params.context getContext()
 * @param {Array<{ avatar: string, allTags: string[] }>} params.items
 * @param {number} [params.concurrency]
 * @param {(done: number, total: number) => void} [params.onProgress]
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Array<{ avatar: string, ok: boolean, error?: string }>>}
 */
export async function writeCardTagsBulk({ context, items, concurrency = 3, onProgress, signal }) {
    const results = new Array(items.length);
    let cursor = 0;
    let done = 0;

    const worker = async () => {
        while (true) {
            if (signal?.aborted) {
                for (let i = cursor; i < items.length; i++) {
                    results[i] = results[i] ?? { avatar: items[i].avatar, ok: false, error: '已中断' };
                }
                return;
            }
            const index = cursor++;
            if (index >= items.length) return;

            const item = items[index];
            try {
                await writeCardTags({ context, ...item });
                results[index] = { avatar: item.avatar, ok: true };
            } catch (err) {
                results[index] = { avatar: item.avatar, ok: false, error: String(err?.message ?? err) };
            } finally {
                done++;
                onProgress?.(done, items.length);
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, worker),
    );
    return results;
}
