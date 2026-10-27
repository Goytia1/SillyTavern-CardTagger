/**
 * CardTagger - 默认配置与静态常量
 */

export const EXTENSION_NAME = 'card-tagger';

/** 设置键名（挂在 extension_settings 下） */
export const SETTINGS_KEY = 'card-tagger';

/** i18n 命名空间 */
export const I18N_NAMESPACE = 'cardTagger';

/**
 * 可被抽取喂给 AI 的角色卡字段。
 * key 为内部字段名，label 用于 UI 展示，hint 说明该字段的实际内容。
 */
export const EXTRACTABLE_FIELDS = [
    { key: 'name', label: '角色名', hint: '卡片的 name' },
    { key: 'creator', label: '创作者', hint: '卡片的 creator（有时含来源站信息）' },
    { key: 'creator_notes', label: '创作者注释', hint: 'creator_notes，常含标签/设定说明' },
    { key: 'description', label: '描述', hint: 'description，通常信息量最大' },
    { key: 'personality', label: '性格', hint: 'personality' },
    { key: 'scenario', label: '场景', hint: 'scenario' },
    { key: 'first_mes', label: '开场白', hint: 'first_mes' },
    { key: 'mes_example', label: '示例对话', hint: 'mes_example' },
    { key: 'system_prompt', label: '系统提示词', hint: 'system_prompt' },
    { key: 'post_history_instructions', label: '历史后指令', hint: 'post_history_instructions' },
    { key: 'tags', label: '已有标签', hint: '卡上已带的 tags，作为上下文给 AI 参考' },
    { key: 'character_book_keys', label: '知识库关键词', hint: 'character_book 里所有条目的 key，信息密度高' },
];

/** 默认参与抽取的字段 */
export const DEFAULT_SELECTED_FIELDS = [
    'name',
    'description',
    'personality',
    'scenario',
    'character_book_keys',
];

/** 每个字段默认最大字符数 */
export const DEFAULT_FIELD_LIMITS = {
    name: 100,
    creator: 60,
    creator_notes: 800,
    description: 3000,
    personality: 800,
    scenario: 800,
    first_mes: 800,
    mes_example: 800,
    system_prompt: 500,
    post_history_instructions: 500,
    tags: 300,
    character_book_keys: 600,
};

/** 默认标签池：角色卡社区通用分类词，用户可自由增删 */
export const DEFAULT_TAG_POOL = [
    // 身份 / 职业
    '总裁', '富豪', 'CEO', '医生', '护士', '教师', '学生', '警官', '侦探', '律师',
    '秘书', '演员', '偶像', '歌手', '作家', '画家', '厨师', '保镖', '杀手', '特工',
    '军人', '骑士', '贵族', '王族', '神职', '魔法师', '剑士', '忍者', '阴阳师', '研究员',
    '程序员', '咖啡店长', '图书管理员', '兽医', '理发师', '模特', '舞者', '运动员',

    // 关系
    '骨科', '伪骨科', '师生', '青梅竹马', '同事', '上司下属', '主仆', '契约婚姻', '包养',
    '邻居', '室友', '网友', '偶像粉丝', '医患', '警匪', '敌对', '宿敌', '搭档', '婚约者',
    '前男女友', '暗恋', '单恋', '双向奔赴', '重逢', '陌生人', '同桌', '天降',

    // 属性 / 性格
    '傲娇', '病娇', '占有欲强', '温柔', '腹黑', '毒舌', '天然呆', '元气', '冷淡', '三无',
    '娇羞', '女王', '抖S', '抖M', '猫系', '犬系', '年上', '年下', '妹系', '姐系',
    '兄系', '弟系', '成熟稳重', '幼稚', '理性', '感性', '社恐', '社交牛杂', '中二',
    '优等生', '不良', '不良少女', '优柔寡断', '果断', '洁癖', '懒惰', '勤勉', '自信', '自卑',

    // 题材 / 氛围
    '校园', '职场', '都市', '古代', '宫廷', '和风', '西幻', '赛博朋克', '末世', '废土',
    '悬疑', '惊悚', '克苏鲁', '灵异', '热血战斗', '日常', '治愈', '致郁', '虐恋',
    '公路片', '海盗', '武侠', '仙侠', '机战', '蒸汽朋克',
];

/**
 * 可选的成人向分类词，默认不启用。
 * 用户在设置面板点「追加 NSFW 词表」时可引入。
 */
export const OPTIONAL_NSFW_TAG_POOL = [
    '纯爱', '强制爱', '监禁', '调教', '露出', '兽耳', '触手', '多人', 'SM', '孕妇',
    '淫乱', '自慰', '口交', '性冷淡', '性瘾',
];

/** 面向 AI 的系统提示词模板 */
export const SYSTEM_PROMPT_TEMPLATE = `你是一个专业的角色卡（Character Card）分类助手，服务于 SillyTavern 用户的私人卡片库整理工作。

你的任务：阅读一张虚构角色卡的选材字段，为它打上最贴切的检索标签，方便用户日后用标签筛选、分组。

工作模式（混合模式）：
1. 优先使用下面《可用标签池》中的现成标签。直接复制原词，不要改动用字。
2. 只有当标签池里确实找不到合适词条时，才在 new_tags 里提出新标签。新标签要求：中文、2-6 字、简洁准确、通用可复用（不要造只在单卡成立的词）。
3. 数量控制：pick 最多 {{MAX_TAGS}} 个，new_tags 最多 {{MAX_NEW_TAGS}} 个。宁缺毋滥，不要硬凑。
4. 依据必须来自卡面内容。信息不足就少打，禁止脑补无关标签。
5. 如果内容明显涉及成人向题材，正常打标签即可，不要回避、也不要输出任何露骨描写。

严格只输出 JSON，不要任何解释、不要 Markdown 代码块包裹。`;

/** 用户消息模板 */
export const USER_PROMPT_TEMPLATE = `《可用标签池》
{{TAG_POOL}}

《待分类角色卡》
{{CARD_CONTENT}}

按约定输出 JSON。`;

export const DEFAULT_SETTINGS = {
    // ---- AI 数据源 ----
    /** 'custom' = 独立配置 OpenAI 兼容接口；'st' = 复用 SillyTavern 当前连接 */
    ai_source: 'custom',
    api_url: 'https://api.deepseek.com/v1',
    api_key: '',
    model: 'deepseek-chat',
    temperature: 0.2,
    // 只限制输出长度。300 会把 JSON 从中间切断（尤其 reason 写得长的模型），
    // 表现就是「模型没给出任何标签」——解析到半截 JSON 必失败。给到 800 才稳。
    max_tokens: 800,
    /** 自定义请求头（JSON 字符串），用于中转/反代场景 */
    extra_headers: '',
    /** 自定义额外 body 字段（JSON 字符串） */
    extra_body: '',

    // ---- 标签池 ----
    tag_pool: [],           // 初始化时填入 DEFAULT_TAG_POOL
    max_tags: 4,            // 每张卡从池里最多选几个
    max_new_tags: 2,        // 每张卡最多新建几个标签
    allow_new_tags: true,

    // ---- 抽取范围 ----
    selected_fields: [],    // 初始化时填入 DEFAULT_SELECTED_FIELDS
    field_limits: {},       // 初始化时填入 DEFAULT_FIELD_LIMITS

    // ---- 执行 ----
    concurrency: 4,
    retry_times: 2,
    request_delay_ms: 200,
    skip_tagged: true,      // 跳过已经有本地标签的角色

    // ---- 写入目标 ----
    write_to_local_tags: true,      // 写 settings.tag_map（ST 原生筛选）
    write_to_card_tags: false,      // 回填卡片内嵌 data.tags
    overwrite_card_tags: false,     // 回填时是否覆盖原有卡片标签（false = 合并）

    // ---- 提示词 ----
    system_prompt: '',              // 空则用模板
    extra_instruction: '',
};

/** 生成 JSON Schema，用于支持结构化输出的接口 */
export function buildJsonSchema() {
    return {
        name: 'card_tags_result',
        description: '角色卡标签分类结果',
        strict: true,
        value: {
            type: 'object',
            properties: {
                pick: {
                    type: 'array',
                    description: '从标签池中选出的标签原文',
                    items: { type: 'string' },
                },
                new_tags: {
                    type: 'array',
                    description: '标签池之外必须新建的标签',
                    items: { type: 'string' },
                },
                reason: {
                    type: 'string',
                    description: '一句话说明打标依据',
                },
            },
            required: ['pick', 'new_tags', 'reason'],
            additionalProperties: false,
        },
    };
}
