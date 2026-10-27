/**
 * 冒烟测试：验证纯逻辑部分（抽取 / 解析 / 分流 / 本地标签写入）
 * 运行： node smoke-test.mjs
 */

import { buildCardContent, getExistingTags, getCharacterBookKeys, getCharacterDisplayName, hasCardContent, isShallowCharacter, findSameNameCharacters, countSameNameGroups } from './src/extract.js';
import { parseTagResult, stripCodeFence, normalizeResult, parseModelList, AbortedError, salvageTagsFromText, TagParseError, isEmptyTagResult, requestCardTags } from './src/api.js';
import { parsePngCard, fetchFullCharacter } from './src/cardfile.js';
import { assignLocalTags, findLocalTag, ensureLocalTag } from './src/writer.js';
import { DEFAULT_FIELD_LIMITS, DEFAULT_SELECTED_FIELDS, DEFAULT_TAG_POOL, SYSTEM_PROMPT_TEMPLATE, USER_PROMPT_TEMPLATE } from './src/defaults.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

console.log('\n=== 1. 卡片字段抽取（V1 / V2 / V3 兼容） ===');

// SillyTavern 加载后：V2/V3 的 data 会被提升一部分到顶层，这里模拟最坏情况
const v2Card = {
    avatar: 'ceo.png',
    name: '陆沉渊',
    description: '跨国集团总裁，冷漠寡言，对女主有着病态的占有欲。',
    personality: '冷淡、控制欲强',
    scenario: '雨夜的办公室',
    tags: ['总裁'],
    data: {
        name: '陆沉渊',
        description: '跨国集团总裁，冷漠寡言，对女主有着病态的占有欲。',
        creator_notes: 'tag: 骨科 伪骨科',
        character_book: {
            entries: [
                { keys: ['妹妹', '义妹'], content: '...' },
                { keys: ['契约'], secondary_keys: ['婚姻'], content: '...' },
            ],
        },
    },
};

const v3OnlyNested = {
    avatar: 'teacher.json.png',
    data: {
        name: '沈予安',
        description: '高中语文老师，温柔但疏离。',
        personality: '温柔、疏离',
        tags: ['教师'],
    },
};

const v1Flat = {
    avatar: 'old.png',
    name: '无名氏',
    description: '一张很老的 V1 卡，字段直接平铺。',
    personality: '沉默',
};

const opts = {
    fields: [...DEFAULT_SELECTED_FIELDS, 'creator_notes'],
    limits: DEFAULT_FIELD_LIMITS,
};

const r2 = buildCardContent(v2Card, opts);
check('V2：抽出多个字段', r2.usedFields.length >= 5, JSON.stringify(r2.usedFields));
check('V2：能读到嵌套在 data 里的 creator_notes', r2.text.includes('骨科'));
check('V2：展开知识库关键词', r2.text.includes('妹妹') && r2.text.includes('婚姻'));

const r3 = buildCardContent(v3OnlyNested, opts);
check('V3：只嵌在 data 里也能读到 name', r3.text.includes('沈予安'));
check('V3：只嵌在 data 里也能读到 description', r3.text.includes('高中语文老师'));

const r1 = buildCardContent(v1Flat, opts);
check('V1：平铺字段可读', r1.text.includes('无名氏') && !r1.isEmpty);

console.log('\n=== 2. 长度截断 ===');
const longCard = { avatar: 'l.png', data: { name: 'A', description: '描'.repeat(5000) } };
const rLong = buildCardContent(longCard, { fields: ['name', 'description'], limits: { description: 300 } });
const descLine = rLong.text.split('\n').filter(Boolean).at(-1);
check('超长字段被截断', descLine.length <= 310, `实际长度 ${descLine.length}`);
check('截断处有标记', descLine.includes('已截断'));

console.log('\n=== 3. AI 输出解析 ===');
check('剥掉 ```json 围栏', stripCodeFence('```json\n{"pick":["总裁"]}\n```') === '{"pick":["总裁"]}');
check('半截围栏也能救回来', JSON.parse(stripCodeFence('```json\n{"pick":["总裁"]}')).pick[0] === '总裁');
check('无围栏纯 JSON', parseTagResult('{"pick":["骨科"],"new_tags":["伪骨科"],"reason":"x"}').pick[0] === '骨科');
check('容忍 newTags 驼峰写法', parseTagResult('{"pick":[],"newTags":["师生"]}').newTags[0] === '师生');
check('完全垃圾输入不炸', parseTagResult('抱歉我无法回答').pick.length === 0);
check('空字符串不炸', parseTagResult('').pick.length === 0);
check('null 不炸', parseTagResult(null).pick.length === 0);
check('中文顿号分隔的字符串也能接', parseTagResult('{"pick":"总裁、骨科"}').pick.length === 2);

console.log('\n=== 4. 混合模式分流 ===');
const settings = {
    tag_pool: [...DEFAULT_TAG_POOL],
    max_tags: 3,
    max_new_tags: 2,
    allow_new_tags: true,
};

// AI 把自创词塞进了 pick（真实模型常见行为）
const messy = normalizeResult({ pick: ['总裁', '骨科', '义妹禁断恋'], newTags: ['师生'] }, settings);
check('池内词留在 pick', messy.pick.includes('总裁') && messy.pick.includes('骨科'));
check('混入 pick 的自创词被捞到 newTags', messy.newTags.includes('义妹禁断恋'), JSON.stringify(messy));
check('AI 主动申请的新标签保留', messy.newTags.includes('师生'));
check('pick 与 newTags 不重复', !messy.pick.some(t => messy.newTags.includes(t)));

const overLimit = normalizeResult({ pick: ['总裁', '骨科', '青梅竹马', '硬凑的'], newTags: ['a', 'b', 'c'] }, settings);
check('pick 受 max_tags 限制', overLimit.pick.length === 3, `实际 ${overLimit.pick.length}`);
check('newTags 受 max_new_tags 限制', overLimit.newTags.length === 2, `实际 ${overLimit.newTags.length}`);

const noNew = normalizeResult({ pick: ['总裁'], newTags: ['自创词'] }, { ...settings, allow_new_tags: false });
check('关闭新建时 newTags 为空', noNew.newTags.length === 0);
check('关闭新建时 pick 不受影响', noNew.pick.length === 1);

console.log('\n=== 5. 本地标签写入 ===');
const fakeContext = {
    tags: [],
    tagMap: {},
    uuidv4: () => `id-${Math.random().toString(16).slice(2)}`,
    saved: false,
    saveSettingsDebounced() { this.saved = true; },
};

assignLocalTags(fakeContext, 'ceo.png', ['总裁', '骨科']);
check('往 tagMap 写了记录', (fakeContext.tagMap['ceo.png'] ?? []).length === 2);
check('自动建了 2 个 Tag 定义', fakeContext.tags.length === 2);
check('Tag 带 id / name / sort_order', Boolean(fakeContext.tags[0].id && fakeContext.tags[0].name && fakeContext.tags[0].sort_order !== undefined));
check('Tag 字段结构完整', 'folder_type' in fakeContext.tags[0] && 'filter_state' in fakeContext.tags[0] && 'create_date' in fakeContext.tags[0]);

assignLocalTags(fakeContext, 'ceo.png', ['总裁', '青梅竹马']);
check('重复打同一个标签不会重复占 id', fakeContext.tagMap['ceo.png'].length === 3);
check('同名 Tag 不会重复创建', fakeContext.tags.length === 3);
const ids = fakeContext.tagMap['ceo.png'];
check('tagMap 里 id 不重复', new Set(ids).size === ids.length);

assignLocalTags(fakeContext, 'teacher.png', ['师生']);
check('不同角色互不影响', fakeContext.tagMap['ceo.png'].length === 3 && fakeContext.tagMap['teacher.png'].length === 1);

assignLocalTags(fakeContext, 'ceo.png', ['病娇'], { replace: true });
check('replace 模式会清空旧标签', fakeContext.tagMap['ceo.png'].length === 1);

console.log('\n=== 6. 模型列表解析（各平台 /models 返回格式） ===');
check('OpenAI 标准 {data:[{id}]}', parseModelList('{"object":"list","data":[{"id":"gpt-4o","object":"model"}]}').join() === 'gpt-4o');
check('DeepSeek 格式', parseModelList('{"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}').join() === 'deepseek-chat,deepseek-reasoner');
check('data 是纯字符串数组', parseModelList('{"data":["a-1","b-2"]}').length === 2);
check('Gemini 的 models/ 前缀被剥掉', parseModelList('{"models":[{"name":"models/gemini-2.0-flash"}]}')[0] === 'gemini-2.0-flash');
check('map 形态 {模型名:{详情}}', parseModelList('{"data":{"qwen-max":{"x":1},"qwen-turbo":{"y":2}}}').length === 2);
check('顶层就是数组', parseModelList('[{"id":"m1"},{"id":"m2"}]').length === 2);
check('容器键不会被当成模型名',
    !parseModelList('{"object":"list","data":{"list":["real-model"],"count":9}}').includes('list')
    && !parseModelList('{"object":"list","data":{"list":["real-model"],"count":9}}').includes('count'));
check('去重后排序', parseModelList('{"data":[{"id":"b"},{"id":"a"},{"id":"a"}]}').join() === 'a,b');
check('非 JSON 返回空数组不炸', parseModelList('<html>502 Bad Gateway</html>').length === 0);
check('空响应不炸', parseModelList('').length === 0);
check('null 字段不炸', parseModelList('{"data":[null,{"id":"x"},{}]}').join() === 'x');

console.log('\n=== 7. 边界情况 ===');
check('空对象角色不炸', buildCardContent({}, opts).isEmpty);
check('null 角色不炸', buildCardContent(null, opts).isEmpty);
check('无 avatar 时回落', getCharacterDisplayName({}) === '(未命名)');
check('avatar 去扩展名作名', getCharacterDisplayName({ avatar: '某某.png' }) === '某某');
check('tags 为逗号字符串也认', getExistingTags({ tags: '总裁, 骨科' }).length === 2);
check('tags 为数组也认', getExistingTags({ data: { tags: ['师生'] } })[0] === '师生');
check('没有知识库返回空数组', getCharacterBookKeys({}).length === 0);
check('AbortedError 可识别', new AbortedError() instanceof Error);
check('sort_order 不会被覆盖回 0', fakeContext.tags.every(t => t.sort_order > 0));
check('findLocalTag 命中', findLocalTag(fakeContext, '总裁')?.name === '总裁');
check('findLocalTag 未命中返回 undefined', findLocalTag(fakeContext, '不存在的词') === undefined);
check('ensureLocalTag 幂等', ensureLocalTag(fakeContext, '总裁').id === findLocalTag(fakeContext, '总裁').id);

// ============================================================================
console.log('\n=== 7. 模型拒答 / 原文抢救（手机上「模型没给出任何标签」的主因）===');

// 典型死法一：审核拦截，模型回一段自然语言
const refusalText = '抱歉，我无法按照这个角色设定生成内容。该请求可能包含不适宜的内容。';
check('拒答时 pick 为空', parseTagResult(refusalText).pick.length === 0);
check('拒答时原文必须保留', parseTagResult(refusalText).raw === refusalText);
check('拒答时 newTags 为空', parseTagResult(refusalText).newTags.length === 0);

// 典型死法二：max_tokens 截断，JSON 只写一半
const truncated = '{"pick":["总裁","骨科"],"newTags":[],"reason":"这是一位掌控集团';
const t = parseTagResult(truncated);
check('半截 JSON 解析不出标签', t.pick.length === 0);
check('半截 JSON 原文仍保留', t.raw === truncated);

// 典型死法三：模型把标签写进散文里（没按格式答）
const prose = '这个角色给我的印象是：总裁，带点骨科设定，还有青梅竹马的元素，性格偏傲娇。';
const pool = ['总裁', '骨科', '青梅竹马', '傲娇', '学生'];
check('散文里能抢救出词表标签',
    salvageTagsFromText(prose, pool).join() === '总裁,骨科,青梅竹马,傲娇');
check('抢救时空原文不炸', salvageTagsFromText('', pool).length === 0);
check('抢救时空词表不炸', salvageTagsFromText(prose, []).length === 0);
check('抢救不会重复命中', salvageTagsFromText('总裁总裁总裁', pool).length === 1);
check('单字标签不参与抢救（误命中率太高）',
    salvageTagsFromText('这个故事里有王，还有总裁', ['王', '总裁']).join() === '总裁');
check('拒答文本也可能顺带捞到词', salvageTagsFromText(refusalText, pool).length === 0);

// TagParseError 要带着原文，UI 才能「看原文」
const tpe = new TagParseError('模型未返回有效标签', refusalText);
check('TagParseError 带原文', tpe.raw === refusalText && tpe.name === 'TagParseError');
check('TagParseError 是 Error', tpe instanceof Error);

console.log('\n=== 8. 交白卷识别（合法 JSON 但两个数组都空）===');
// 典型死法四：模型看懂了格式，却一个标签都不给
const blankSheet = '{"pick": [], "new_tags": []}';
check('空数组 JSON 判定为交白卷', isEmptyTagResult(blankSheet) === true);
check('交白卷时 pick 为空', parseTagResult(blankSheet).pick.length === 0);
check('交白卷时原文保留', parseTagResult(blankSheet).raw === blankSheet);
check('带围栏的空数组也认', isEmptyTagResult('```json\n{"pick":[],"new_tags":[]}\n```') === true);
check('驼峰 newTags 空数组也认', isEmptyTagResult('{"pick":[],"newTags":[]}') === true);
check('有 pick 不算交白卷', isEmptyTagResult('{"pick":["总裁"]}') === false);
check('只有 new_tags 不算交白卷', isEmptyTagResult('{"pick":[],"new_tags":["新词"]}') === false);
check('缺 pick 字段不算交白卷', isEmptyTagResult('{"new_tags":[]}') === false);
check('拒答文本不算交白卷', isEmptyTagResult(refusalText) === false);
check('半截 JSON 不算交白卷', isEmptyTagResult(truncated) === false);
check('空字符串不炸', isEmptyTagResult('') === false);
check('null 不炸', isEmptyTagResult(null) === false);

console.log('\n=== 9. 提示词强化（防交白卷）===');
check('系统提示词要求至少 1 个标签', /至少给出 1 个标签/.test(SYSTEM_PROMPT_TEMPLATE));
check('系统提示词明确禁止空列表', /禁止返回空的标签列表/.test(SYSTEM_PROMPT_TEMPLATE));
check('系统提示词带输出示例', SYSTEM_PROMPT_TEMPLATE.includes('{"pick"'));
check('用户提示词带输出示例', USER_PROMPT_TEMPLATE.includes('{"pick"'));
check('成人向题材仍要求正常打标', /正常打标签即可，不要回避/.test(SYSTEM_PROMPT_TEMPLATE));

console.log('\n=== 10. 空结果重试会「推一把」（打桩 fetch）===');
const nudgeCalls = [];
const realFetch = globalThis.fetch;
const BLANK = '{"pick": [], "new_tags": []}';
const TAGS = '{"pick":["总裁"],"new_tags":[],"reason":"集团总裁设定"}';
const DOCTOR = '{"pick":["医生"],"new_tags":[],"reason":"x"}';
// 0 = 先交白卷、再给标签；1 = 一直交白卷；2 = 先网络错误、再给标签
let stubRound = 0;
let netAttempts = 0;
globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    nudgeCalls.push(body);
    let content;
    if (stubRound === 0) {
        content = nudgeCalls.length === 1 ? BLANK : TAGS;
    } else if (stubRound === 1) {
        content = BLANK;
    } else {
        netAttempts++;
        if (netAttempts === 1) throw new TypeError('Failed to fetch');
        content = DOCTOR;
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
};

const nudgeSettings = {
    ai_source: 'custom',
    api_url: 'https://example.com/v1',
    api_key: 'k',
    model: 'm',
    temperature: 0,
    max_tokens: 800,
    max_tags: 4,
    tag_pool: ['总裁'],
};

try {
    const nudged = await requestCardTags({
        systemPrompt: 's',
        userPrompt: 'u',
        settings: nudgeSettings,
        context: {},
        retryTimes: 2,
    });
    check('白卷后重试拿到标签', nudged.pick.join() === '总裁');
    check('第一次原样发送', nudgeCalls[0].messages[1].content === 'u');
    check('重试时用户消息追加了推一把提示', nudgeCalls.length === 2 && nudgeCalls[1].messages[1].content.includes('上一次'));
    check('推一把提示带上了 max_tags', nudgeCalls[1].messages[1].content.includes('1-4'));
    check('重试时系统提示不变', nudgeCalls[1].messages[0].content === 's');

    // 一直交白卷：重试耗尽后返回空结果（由 UI 层标记失败），且每次都推一把
    nudgeCalls.length = 0;
    stubRound = 1;
    const exhausted = await requestCardTags({
        systemPrompt: 's',
        userPrompt: 'u',
        settings: nudgeSettings,
        context: {},
        retryTimes: 2,
    });
    check('重试耗尽返回空结果而不抛错', exhausted.pick.length === 0 && exhausted.newTags.length === 0);
    check('空结果仍带原文', exhausted.raw.includes('pick'));
    check('三次请求（1 + 2 次重试）', nudgeCalls.length === 3);
    check('第 2、3 次都追加了推一把', nudgeCalls[1].messages[1].content.includes('⚠️') && nudgeCalls[2].messages[1].content.includes('⚠️'));
    check('推一把逐次加码（第二次措辞不同）', nudgeCalls[1].messages[1].content !== nudgeCalls[2].messages[1].content);

    // 网络错误重试不推一把：原样再发
    nudgeCalls.length = 0;
    netAttempts = 0;
    stubRound = 2;
    const afterNet = await requestCardTags({
        systemPrompt: 's',
        userPrompt: 'u',
        settings: nudgeSettings,
        context: {},
        retryTimes: 2,
    });
    check('网络错误恢复后拿到标签', afterNet.pick.join() === '医生');
    check('网络错误重试不追加推一把', nudgeCalls.length === 2 && nudgeCalls[1].messages[1].content === 'u');
} finally {
    globalThis.fetch = realFetch;
}

// ============================================================================
console.log('\n=== 11. PNG 直读卡片（TauriTavern 浅层数据兜底）===');

// 合成一个带正确 CRC32 的 PNG：签名 + IHDR + tEXt/iTXt + IEND
function crc32(bytes) {
    let table = crc32.table;
    if (!table) {
        table = crc32.table = [];
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
        }
    }
    let c = 0xffffffff;
    for (const b of bytes) c = (table[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBytes = [...type].map(ch => ch.charCodeAt(0));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, data.length, false);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32([...typeBytes, ...data]), false);
    return new Uint8Array([...len, ...typeBytes, ...data, ...crc]);
}

function makeCardPng(card, { keyword = 'chara', itxt = false } = {}) {
    const b64 = Buffer.from(JSON.stringify(card), 'utf-8').toString('base64');
    const kw = [...keyword].map(ch => ch.charCodeAt(0));
    const payload = [...b64].map(ch => ch.charCodeAt(0));
    // tEXt: keyword \0 base64；iTXt: keyword \0 compFlag compMethod langTag\0 transKeyword\0 text
    const data = itxt ? [...kw, 0, 0, 0, 0, 0, ...payload] : [...kw, 0, ...payload];
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const ihdr = pngChunk('IHDR', [0, 0, 0, 1, 8, 2, 0, 0, 0]);
    const text = pngChunk(itxt ? 'iTXt' : 'tEXt', data);
    const iend = pngChunk('IEND', []);
    return new Uint8Array([...sig, ...ihdr, ...text, ...iend]);
}

const v3Card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
        name: '姜域',
        description: '姜家少爷，外表冷淡内心偏执，与义妹有婚约。',
        personality: '冷淡、占有欲强',
        tags: ['骨科', '婚约者'],
        character_book: { entries: [{ keys: ['姜家', '婚约'] }] },
    },
};

const pngBytes = makeCardPng(v3Card, { keyword: 'ccv3' });
check('ccv3 (V3) tEXt 块能解析', parsePngCard(pngBytes)?.data?.name === '姜域');
check('中文描述 base64 解码不乱码', parsePngCard(pngBytes)?.data?.description?.includes('姜家少爷'));
check('chara (V1/V2) 块能解析',
    parsePngCard(makeCardPng({ spec: 'chara_card_v2', data: { name: '陆沉渊', description: '总裁' } }))?.data?.name === '陆沉渊');
check('V1 平铺卡能解析', parsePngCard(makeCardPng({ name: '无名氏', description: '老卡' }))?.name === '无名氏');
check('iTXt 未压缩块能解析', parsePngCard(makeCardPng(v3Card, { keyword: 'ccv3', itxt: true }))?.data?.name === '姜域');
check('ArrayBuffer 输入也认', parsePngCard(pngBytes.buffer)?.data?.name === '姜域');
check('非 PNG 输入返回 null', parsePngCard(new Uint8Array([1, 2, 3])) === null);
check('空输入不炸', parsePngCard(new Uint8Array(0)) === null);
check('null 输入不炸', parsePngCard(null) === null);
check('截断的 PNG 不炸', parsePngCard(pngBytes.slice(0, 30)) === null);
check('块长度越界的损坏 PNG 不炸', (() => {
    const broken = pngBytes.slice();
    new DataView(broken.buffer).setUint32(8, 0xffffff, false); // IHDR 长度改成天文数字
    return parsePngCard(broken) === null;
})());
check('无关 keyword 的 tEXt 被忽略', parsePngCard(makeCardPng(v3Card, { keyword: 'other' })) === null);

// 大卡回归：几十万字符的卡面很常见。旧实现用 String.fromCharCode(...bytes)
// 展开传参，payload 一大就抛 RangeError（Maximum call stack size exceeded），
// 且抛在 try/catch 外面，会把整个文件兜底打断。iOS WebKit 栈上限更敏感。
const hugeDescription = '姜'.repeat(300000); // base64 后约 40 万字符
const hugeCard = { spec: 'chara_card_v3', data: { name: '姜域', description: hugeDescription } };
let hugeParsed = null;
let hugeThrew = null;
try {
    hugeParsed = parsePngCard(makeCardPng(hugeCard, { keyword: 'ccv3' }));
} catch (err) {
    hugeThrew = err;
}
check('30 万字符大卡解析不炸（分块解码）', hugeThrew === null && hugeParsed?.data?.description === hugeDescription);

console.log('\n=== 12. 浅层数据识别（TauriTavern 列表接口只给名字）===');
check('完整角色判定有内容', hasCardContent({ name: 'x', description: '总裁设定' }) === true);
check('嵌套在 data 里也算', hasCardContent({ name: 'x', data: { description: '总裁设定' } }) === true);
check('只有名字 = 浅层数据', hasCardContent({ name: '姜域', tags: ['骨科'] }) === false);
check('只有 creator/tags = 浅层数据', hasCardContent({ name: 'x', creator: 'someone', tags: ['a'], creator_notes: '' }) === false);
// v1.3.x 的回归测试：TauriTavern 的 into_shallow() 保留 creator_notes，
// 把它算作内容会让浅层检测永远误判为「有内容」、完整卡片兜底从不触发
check('只有 creator_notes = 浅层数据（回归：v1.3.x 误判）', hasCardContent({ name: 'x', creator_notes: 'tag: 骨科' }) === false);
check('creator_notes + 空内容字段 = 浅层（TauriTavern 实际形状）',
    hasCardContent({ name: '姜域', creator: 'a', tags: ['都市'], creator_notes: '备注', description: '', personality: '', scenario: '', first_mes: '', mes_example: '' }) === false);
check('空字符串不算', hasCardContent({ name: 'x', description: '   ' }) === false);
check('null 不炸', hasCardContent(null) === false);

console.log('\n=== 12b. isShallowCharacter（显式标记 + 内容判据）===');
check('显式 shallow 标记即浅层', isShallowCharacter({ name: 'x', shallow: true, description: '有描述但标了浅层' }) === true);
check('无标记但有描述 = 完整', isShallowCharacter({ name: 'x', description: '总裁设定' }) === false);
check('只有 creator_notes = 浅层', isShallowCharacter({ name: 'x', creator_notes: '备注' }) === true);
check('TauriTavern 浅层形状 = 浅层', isShallowCharacter({ name: '姜域', shallow: true, tags: ['都市'], creator_notes: '备注' }) === true);
check('null 不炸', isShallowCharacter(null) === false);

console.log('\n=== 12c. 同名角色识别（同名标签同步）===');
const sameNameCtx = {
    characters: [
        { avatar: '谢嬴.png', name: '谢嬴' },
        { avatar: '谢嬴-v2.png', name: '谢嬴' },
        { avatar: '谢嬴（另一个作者）.png', name: '谢嬴' },
        { avatar: '姜域.png', name: '姜域' },
        { avatar: '谢嬴.json', name: '谢嬴' },
    ],
};
check('同名角色全部找出', findSameNameCharacters(sameNameCtx, '谢嬴', '谢嬴.png').length === 3);
check('排除自己', findSameNameCharacters(sameNameCtx, '谢嬴', '谢嬴.png').every(c => c.avatar !== '谢嬴.png'));
check('只此一个同名返回空', findSameNameCharacters(sameNameCtx, '姜域', '姜域.png').length === 0);
check('换一个当源结果一致', findSameNameCharacters(sameNameCtx, '谢嬴', '谢嬴-v2.png').length === 3);
check('空名字不炸', findSameNameCharacters(sameNameCtx, '', 'x.png').length === 0);
check('没有 characters 不炸', findSameNameCharacters({}, '谢嬴', 'x.png').length === 0);
check('浅层数据也能识别同名（只有 name 字段）',
    findSameNameCharacters({ characters: [{ avatar: 'a.png', name: '谢嬴' }, { avatar: 'b.png', name: '谢嬴' }] }, '谢嬴', 'a.png').length === 1);
check('同名分组计数', countSameNameGroups([{ name: '谢嬴' }, { name: '谢嬴' }, { name: '姜域' }]) === 1);
check('没有同名组返回 0', countSameNameGroups([{ name: 'a' }, { name: 'b' }]) === 0);
check('三个一组也算一组', countSameNameGroups([{ name: 'x' }, { name: 'x' }, { name: 'x' }]) === 1);
check('空列表不炸', countSameNameGroups([]) === 0);

console.log('\n=== 13. 完整卡片拉取（/api/characters/get + 文件兜底）===');
const realFetch2 = globalThis.fetch;
let routeMode = 'api';
let lastPostInit = null;
globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/characters/get')) {
        lastPostInit = init;
        if (routeMode !== 'api') throw new TypeError('Failed to fetch');
        // routeMode==='fake'：客户端仍旧返回浅层对象（防御「假完整」）
        if (routeMode === 'fake') {
            return {
                ok: true,
                json: async () => ({ name: '姜域', shallow: true, tags: ['都市'], creator_notes: '备注' }),
            };
        }
        return {
            ok: true,
            json: async () => ({ name: '姜域', description: '完整数据', data: { name: '姜域', description: '完整数据' } }),
        };
    }
    if (u.startsWith('/characters/')) {
        if (routeMode === 'file' || routeMode === 'fake') {
            return { ok: true, arrayBuffer: async () => makeCardPng(v3Card, { keyword: 'ccv3' }).buffer };
        }
        if (routeMode === 'json') {
            const text = JSON.stringify({ name: 'JSON卡', description: 'json 卡原文' });
            return { ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
        }
        return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    throw new Error(`unexpected url ${u}`);
};

try {
    routeMode = 'api';
    const viaApi = await fetchFullCharacter({ avatar: '姜域.png', getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }) });
    check('优先走 /api/characters/get', viaApi?.via === 'api' && viaApi?.card?.description === '完整数据');
    check('POST 带 Content-Type: application/json',
        lastPostInit?.headers?.['Content-Type'] === 'application/json' && lastPostInit?.method === 'POST');

    routeMode = 'fake';
    const viaFake = await fetchFullCharacter({ avatar: '姜域.png' });
    check('/get 返回浅层对象时不收下，继续走文件兜底', viaFake?.via === 'file' && viaFake?.card?.data?.name === '姜域');

    routeMode = 'file';
    const viaFile = await fetchFullCharacter({ avatar: '姜域.png' });
    check('/get 失败时兜底读 PNG 文件', viaFile?.via === 'file' && viaFile?.card?.data?.name === '姜域');
    check('PNG 兜底拿到的卡可直接抽取',
        buildCardContent(viaFile.card, { fields: ['name', 'description'], limits: {} }).text.includes('姜家少爷'));

    routeMode = 'json';
    const viaJson = await fetchFullCharacter({ avatar: 'card.json' });
    check('.json 卡直接读原文', viaJson?.via === 'file' && viaJson?.card?.name === 'JSON卡');

    routeMode = 'fail';
    check('两级都失败返回 null', await fetchFullCharacter({ avatar: 'x.png' }) === null);
    check('没有 avatar 返回 null', await fetchFullCharacter({ avatar: '' }) === null);
} finally {
    globalThis.fetch = realFetch2;
}

console.log(`\n${'─'.repeat(46)}`);
console.log(fail === 0 ? `全部通过：${pass} 项` : `通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
