/**
 * 冒烟测试：验证纯逻辑部分（抽取 / 解析 / 分流 / 本地标签写入）
 * 运行： node smoke-test.mjs
 */

import { buildCardContent, getExistingTags, getCharacterBookKeys, getCharacterDisplayName } from './src/extract.js';
import { parseTagResult, stripCodeFence, normalizeResult, parseModelList, AbortedError } from './src/api.js';
import { assignLocalTags, findLocalTag, ensureLocalTag } from './src/writer.js';
import { DEFAULT_FIELD_LIMITS, DEFAULT_SELECTED_FIELDS, DEFAULT_TAG_POOL } from './src/defaults.js';

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

console.log(`\n${'─'.repeat(46)}`);
console.log(fail === 0 ? `全部通过：${pass} 项` : `通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
