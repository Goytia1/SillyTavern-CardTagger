/**
 * 卡片内容抽取
 *
 * SillyTavern 把 PNG 里的 chara / ccv3 chunk 解析进 characters[] 后，
 * 不同版本卡片的字段落点不一致：
 *   - V1 卡：name/description/... 直接躺在顶层
 *   - V2/V3 卡：字段在 data 对象里，但 ST 在 processCharacter 时也会把
 *     一部分字段提升（assign）到顶层
 * 所以统一用「顶层优先，回落 data」的取值策略，避免版本差异踩坑。
 */

/**
 * 安全取值：先查顶层，再查 data 子对象。
 * @param {object} character characters[] 中的一个角色对象
 * @param {string} field 字段名
 * @returns {any}
 */
function pickField(character, field) {
    if (!character) return undefined;

    const top = character[field];
    if (top !== undefined && top !== null && top !== '') return top;

    const data = character.data;
    if (data && typeof data === 'object') {
        const nested = data[field];
        if (nested !== undefined && nested !== null && nested !== '') return nested;
    }

    return undefined;
}

/**
 * 取出角色已有的标签数组（无论来自本地 tagMap 还是卡片内嵌）。
 * @param {object} character
 * @returns {string[]}
 */
export function getExistingTags(character) {
    const raw = pickField(character, 'tags');
    if (Array.isArray(raw)) return raw.filter(x => typeof x === 'string' && x.trim());
    if (typeof raw === 'string' && raw.trim()) {
        return raw.split(',').map(x => x.trim()).filter(Boolean);
    }
    return [];
}

/**
 * 抽出角色知识库（character_book）里的所有关键词。
 * 这些词信息密度极高，往往直接暴露题材与设定。
 * @param {object} character
 * @returns {string[]}
 */
export function getCharacterBookKeys(character) {
    const book = pickField(character, 'character_book');
    if (!book || !Array.isArray(book.entries)) return [];

    const keys = [];
    for (const entry of book.entries) {
        if (!entry) continue;
        const sources = [entry.keys, entry.secondary_keys];
        for (const src of sources) {
            if (Array.isArray(src)) keys.push(...src);
        }
    }
    return keys
        .map(k => String(k ?? '').trim())
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i);
}

/** 掐断超长文本 */
function truncate(text, limit) {
    const str = String(text ?? '');
    if (limit > 0 && str.length > limit) {
        return `${str.slice(0, limit)}\n…(已截断)`;
    }
    return str;
}

/**
 * 按配置把角色卡的指定字段拼成一段给 AI 看的文本。
 *
 * @param {object} character characters[] 中的角色对象
 * @param {object} options
 * @param {string[]} options.fields 要抽取的字段
 * @param {Record<string, number>} options.limits 各字段字符上限
 * @returns {{ text: string, usedFields: string[], isEmpty: boolean }}
 */
export function buildCardContent(character, options) {
    const { fields = [], limits = {} } = options ?? {};
    const lines = [];
    const usedFields = [];

    for (const field of fields) {
        let value;

        if (field === 'tags') {
            const tags = getExistingTags(character);
            value = tags.length ? tags.join('、') : '';
        } else if (field === 'character_book_keys') {
            const keys = getCharacterBookKeys(character);
            value = keys.length ? keys.join('、') : '';
        } else {
            value = pickField(character, field);
        }

        if (value === undefined || value === null) continue;
        const str = truncate(value, Number(limits[field]) || 0);
        if (!str.trim()) continue;

        lines.push(`${String(field).toUpperCase()}:\n${str}`);
        usedFields.push(field);
    }

    return {
        text: lines.join('\n\n'),
        usedFields,
        isEmpty: lines.length === 0,
    };
}

/**
 * 判断角色对象里有没有「卡面内容」字段。
 *
 * 用来识别客户端返回浅层数据的场景：TauriTavern 的列表接口只给
 * name / creator / tags，描述性格场景全空（见 src/cardfile.js 文件头）。
 * 检测到浅层数据时，调用方应去拉完整卡片再抽取，否则模型只能看到
 * 角色名，必然交白卷。
 *
 * @param {object} character characters[] 中的一个角色对象
 * @returns {boolean}
 */
export function hasCardContent(character) {
    if (!character) return false;
    const CONTENT_FIELDS = [
        'description', 'personality', 'scenario', 'first_mes', 'mes_example',
        'system_prompt', 'post_history_instructions', 'creator_notes',
    ];
    return CONTENT_FIELDS.some(field => {
        const value = pickField(character, field);
        return typeof value === 'string' && value.trim().length > 0;
    });
}

/**
 * 角色显示名（优先卡片名，回落文件名）。
 * @param {object} character
 * @returns {string}
 */
export function getCharacterDisplayName(character) {
    const name = pickField(character, 'name');
    if (name && String(name).trim()) return String(name).trim();

    const avatar = character?.avatar;
    if (typeof avatar === 'string' && avatar.trim()) {
        return avatar.replace(/\.(png|webp|json)$/i, '');
    }
    return '(未命名)';
}
