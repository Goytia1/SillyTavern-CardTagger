/**
 * AI 调用层
 *
 * 两个通道：
 *   custom - 扩展自己配置的 OpenAI 兼容接口（推荐，便宜 + 可并发 + 不占用主连接额度）
 *   st     - 复用 SillyTavern 当前连接（generateRaw），零配置但串行且贵
 */

/** 自定义错误，便于 UI 区分「被用户中断」和「真的失败了」 */
export class AbortedError extends Error {
    constructor(message = '已中断') {
        super(message);
        this.name = 'AbortedError';
    }
}

/**
 * 模型回了东西但没能解析出标签。
 * 带着原文，UI 才能告诉用户「模型到底说了什么」——
 * 常见是审核拦截、破限失败、或者 JSON 被 max_tokens 截断。
 */
export class TagParseError extends Error {
    constructor(message, raw = '') {
        super(message);
        this.name = 'TagParseError';
        this.raw = typeof raw === 'string' ? raw : String(raw ?? '');
    }
}

/**
 * 把 LLM 返回的文本里可能包裹的 ```json 代码块剥掉。
 * @param {string} raw
 * @returns {string}
 */
export function stripCodeFence(raw) {
    if (typeof raw !== 'string') return '';
    let text = raw.trim();

    // ```json ... ```
    const fenced = text.match(/^```(?:json|JSON)?\s*([\s\S]*?)```$/);
    if (fenced) return fenced[1].trim();

    // 半截 fence（模型输出超长被截断时常见）
    if (text.startsWith('```')) {
        text = text.replace(/^```(?:json|JSON)?\s*/, '');
    }
    // 兜底：直接从第一个 { 取到最后一个 }
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
        return text.slice(first, last + 1);
    }
    return text;
}

/**
 * 解析 AI 输出为 { pick, newTags, reason, raw }。
 * 容忍字段名不一致（有些模型会写成 newTags / tags / new）。
 *
 * 解析失败时**必须保留 raw**：模型很可能返回了自然语言（被内容审核拦下、
 * 破限失败、或者压根没按 JSON 格式答），这时候原文是唯一能定位问题的线索，
 * 丢掉它就只剩一句「模型没给出任何标签」，用户和我都无从下手。
 *
 * @param {string} raw
 * @returns {{ pick: string[], newTags: string[], reason: string, raw: string }}
 */
export function parseTagResult(raw) {
    const text = typeof raw === 'string' ? raw : '';
    const fallback = { pick: [], newTags: [], reason: '', raw: text };
    const cleaned = stripCodeFence(text);
    if (!cleaned) return fallback;

    let obj;
    try {
        obj = JSON.parse(cleaned);
    } catch {
        return fallback;
    }
    if (!obj || typeof obj !== 'object') return fallback;

    const toStringArray = (v) => {
        if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
        if (typeof v === 'string' && v.trim()) {
            return v.split(/[,，、]/).map(x => x.trim()).filter(Boolean);
        }
        return [];
    };

    return {
        pick: toStringArray(obj.pick ?? obj.tags ?? obj.existing ?? []),
        newTags: toStringArray(obj.new_tags ?? obj.newTags ?? obj.new ?? []),
        reason: typeof obj.reason === 'string' ? obj.reason.trim() : '',
        raw: text,
    };
}

/**
 * 从模型的自然语言回复里尽量抢救出标签。
 *
 * 破限/审核被拦时模型不会答 JSON，而是回一段「抱歉，我无法…」之类的话；
 * 也有模型会直接把标签写在散文里。这里用词表去正文里做子串匹配，
 * 能捞回几个是几个 —— 总比整张卡判失败好。
 *
 * @param {string} raw
 * @param {string[]} pool 标签池
 * @returns {string[]}
 */
export function salvageTagsFromText(raw, pool) {
    const text = String(raw ?? '');
    if (!text || !Array.isArray(pool) || !pool.length) return [];
    const hits = [];
    for (const tag of pool) {
        const t = String(tag).trim();
        // 单字标签误命中率太高，跳过
        if (!t || t.length < 2) continue;
        if (text.includes(t) && !hits.includes(t)) hits.push(t);
    }
    return hits;
}

/**
 * 走独立配置的 OpenAI 兼容接口。
 * @param {object} params
 * @param {string} params.systemPrompt
 * @param {string} params.userPrompt
 * @param {object} params.settings 扩展设置
 * @param {AbortSignal} [params.signal]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<string>} 模型返回的原始文本
 */
async function callCustomApi({ systemPrompt, userPrompt, settings, signal, timeoutMs = 120000 }) {
    const base = String(settings.api_url || '').replace(/\/+$/, '');
    if (!base) throw new Error('未配置 API 地址');
    if (!settings.api_key) throw new Error('未配置 API Key');

    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.api_key}`,
    };

    // 反代/中转站常要求额外的鉴权头
    if (settings.extra_headers) {
        try {
            Object.assign(headers, JSON.parse(settings.extra_headers));
        } catch {
            throw new Error('自定义请求头不是合法 JSON');
        }
    }

    const body = {
        model: settings.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: Number(settings.temperature) || 0,
        max_tokens: Number(settings.max_tokens) || 300,
    };

    // 先尝试 JSON 模式，模型不支持时会在下面自动降级
    let hasJsonMode = true;
    if (settings.extra_body) {
        try {
            Object.assign(body, JSON.parse(settings.extra_body));
        } catch {
            throw new Error('自定义请求体不是合法 JSON');
        }
    }
    body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
        const attempt = async () => {
            const payload = { ...body };
            if (!hasJsonMode) delete payload.response_format;

            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                // 400 且疑似不支持 response_format → 关掉 JSON 模式再试一次
                if (res.status === 400 && hasJsonMode && /response_format|json_object|json_schema/i.test(errText)) {
                    hasJsonMode = false;
                    return attempt();
                }
                throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
            }

            const data = await res.json();
            const content = data?.choices?.[0]?.message?.content;
            if (typeof content === 'string') return content;
            if (typeof content === 'object' && content !== null) return JSON.stringify(content);
            throw new Error(`接口返回格式异常：${JSON.stringify(data).slice(0, 200)}`);
        };

        return await attempt();
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
}

/**
 * 复用 SillyTavern 当前连接的接口。
 * @param {object} params
 * @returns {Promise<string>}
 */
async function callSillyTavernApi({ systemPrompt, userPrompt, context }) {
    const { generateRaw } = context;
    if (typeof generateRaw !== 'function') {
        throw new Error('当前 SillyTavern 版本不支持 generateRaw，请改用独立 API 配置');
    }

    const result = await generateRaw({
        systemPrompt,
        prompt: userPrompt,
    });

    if (typeof result === 'string') return result;
    return JSON.stringify(result ?? '');
}

/**
 * 统一入口：按 ai_source 分发，带重试。
 *
 * @param {object} params
 * @param {string} params.systemPrompt
 * @param {string} params.userPrompt
 * @param {object} params.settings 扩展设置
 * @param {object} params.context SillyTavern.getContext()
 * @param {AbortSignal} [params.signal]
 * @param {number} [params.retryTimes]
 * @returns {Promise<{ pick: string[], newTags: string[], reason: string, raw: string }>>
 *          raw 是模型返回的原文，解析失败时靠它定位问题（拒答、格式跑偏等）
 */
export async function requestCardTags({
    systemPrompt,
    userPrompt,
    settings,
    context,
    signal,
    retryTimes = 2,
}) {
    let lastError;

    for (let attempt = 0; attempt <= retryTimes; attempt++) {
        if (signal?.aborted) throw new AbortedError();

        try {
            const raw = settings.ai_source === 'st'
                ? await callSillyTavernApi({ systemPrompt, userPrompt, context })
                : await callCustomApi({ systemPrompt, userPrompt, settings, signal });

            if (signal?.aborted) throw new AbortedError();

            const parsed = parseTagResult(raw);
            // 空结果算失败，值得重试一次；但原文要一路带着，别丢
            if (!parsed.pick.length && !parsed.newTags.length && attempt < retryTimes) {
                lastError = new TagParseError('模型未返回有效标签', raw);
                throw lastError;
            }
            return parsed;
        } catch (err) {
            if (err instanceof AbortedError) throw err;
            if (err?.name === 'AbortError') throw new AbortedError();
            lastError = err;

            if (attempt < retryTimes) {
                // 指数退避：1s、2s、4s…
                await new Promise(r => setTimeout(r, 1000 * (2 ** attempt)));
            }
        }
    }

    throw lastError ?? new Error('未知错误');
}

/**
 * 把 AI 返回结果按「标签池」重新分流，并套用数量上限。
 *
 * 模型并不总是老实：有时会把自己造的新词塞进 pick 里。
 * 与其静默丢弃，不如按「是否在词表中」重新归位 —— 这样混合模式才真的兜得住。
 *
 * @param {{ pick: string[], newTags: string[] }} result
 * @param {object} settings 扩展设置
 * @returns {{ pick: string[], newTags: string[] }}
 */
export function normalizeResult(result, settings) {
    const poolSet = new Set(settings.tag_pool ?? []);
    const limit = Number(settings.max_tags) || 4;
    const newLimit = settings.allow_new_tags ? (Number(settings.max_new_tags) || 0) : 0;

    const pick = (result.pick ?? []).filter(x => poolSet.has(x));
    const pickedSet = new Set(pick);

    // pick 里混入的新词 + AI 主动申请的 new_tags，合流后去重
    const newTags = [
        ...(result.pick ?? []).filter(x => !poolSet.has(x)),
        ...(result.newTags ?? []),
    ].filter(x => !pickedSet.has(x));

    return {
        pick: Array.from(new Set(pick)).slice(0, limit),
        newTags: Array.from(new Set(newTags)).slice(0, newLimit),
    };
}

/**
 * 极简并发池：保证同时在飞的任务不超过 limit 个。
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} limit
 * @param {(done: number, total: number) => void} [onProgress]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ status: string, value?: any, reason?: any }>>}
 */
export async function runPool(tasks, limit = 4, onProgress, signal) {
    const results = new Array(tasks.length);
    let cursor = 0;
    let done = 0;

    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (true) {
            if (signal?.aborted) return;
            const index = cursor++;
            if (index >= tasks.length) return;

            try {
                results[index] = { status: 'fulfilled', value: await tasks[index]() };
            } catch (err) {
                results[index] = { status: 'rejected', reason: err };
            } finally {
                done++;
                onProgress?.(done, tasks.length);
            }
        }
    });

    await Promise.all(workers);
    return results;
}

/**
 * 从平台拉取可用模型列表（OpenAI 兼容的 `/models` 端点）。
 *
 * 各家的返回格式五花八门，解析器要能同时吃下：
 *   - `{data: [{id: 'x'}]}`            OpenAI / DeepSeek / 硅基流动
 *   - `{data: ['x', 'y']}`             某些中转站
 *   - `{models: [{name: 'models/x'}]}` Gemini（name 带 models/ 前缀）
 *   - `{models: {x: {...}}}`           key 即模型名
 *   - 顶层就是数组
 *
 * @param {object} params
 * @param {string} params.apiUrl 用户填的 API 地址（可带 /v1，也可不带）
 * @param {string} params.apiKey
 * @param {string} [params.extraHeaders] JSON 字符串
 * @returns {Promise<string[]>} 去重排序后的模型 id
 */
export async function fetchModelList({ apiUrl, apiKey, extraHeaders = '' }) {
    const base = String(apiUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('请先填 API 地址');
    if (!apiKey) throw new Error('请先填 API Key');

    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (extraHeaders) {
        try {
            Object.assign(headers, JSON.parse(extraHeaders));
        } catch {
            // 请求头还没填对就别阻塞拉模型，让真正的调用去报错
        }
    }

    // 有人填 https://api.deepseek.com，有人填 https://api.deepseek.com/v1，
    // 两种情况都得能拉到，所以按需补 /v1 再试一次。
    const candidates = [`${base}/models`];
    if (!/\/v\d+$/.test(base)) candidates.push(`${base}/v1/models`);

    const failures = [];
    for (const url of candidates) {
        try {
            const res = await fetch(url, { method: 'GET', headers });
            const text = await res.text();

            if (!res.ok) {
                // 401/403 基本就是 key 的问题，直接把服务端的话带回去给用户看
                failures.push(describeHttpFailure(res.status, url, text));
                continue;
            }

            const models = parseModelList(text);
            if (models.length) return models;
            failures.push(`${url} 返回 200 但解析不出模型列表`);
        } catch (err) {
            failures.push(describeNetworkFailure(err, url));
        }
    }

    throw new Error(failures.join('；') || '拉取失败');
}

/**
 * HTTP 层失败（有状态码）转成能直接照做的话。
 * @param {number} status
 * @param {string} url
 * @param {string} body 服务端返回的原文
 * @returns {string}
 */
function describeHttpFailure(status, url, body) {
    const detail = summarizeError(body);
    switch (status) {
        case 401:
        case 403:
            return `${url} → ${status}，Key 无效或没权限（${detail}）`;
        case 404:
            return `${url} → 404，这个平台可能没有 /models 端点，请直接手打模型名`;
        case 429:
            return `${url} → 429 被限流了，稍等一下再试`;
        default:
            return `${url} → HTTP ${status}（${detail}）`;
    }
}

/**
 * 网络层失败（fetch 直接抛，没有状态码）。
 *
 * 手机浏览器里跑到这儿，九成是这两种：
 *  1. CORS —— 浏览器拦了跨域，控制台会有红色 CORS 报错
 *  2. 网络不通 —— 手机当前 WiFi/流量到不了该 API 域名（境外 API 最常见）
 * 必须分开说，因为解决办法完全不同。
 *
 * @param {any} err
 * @param {string} url
 * @returns {string}
 */
function describeNetworkFailure(err, url) {
    const msg = String(err?.message ?? err);
    // TypeError: Failed to fetch 是浏览器对「请求没发出去」的统一说法，
    // 背后可能是 CORS、DNS、TLS、断网，只能并列让用户自己排
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        return `${url} 请求没发出去（浏览器报 ${msg}）`
            + '。手机上通常是：① 当前网络到不了这个 API 域名（境外 API 需要能访问它的网络）'
            + '；② 该平台的 CORS 不允许浏览器直连。'
            + '两种情况都可以先在输入框里手打模型名，能聊天就说明只是拉列表不行';
    }
    if (/abort|timeout/i.test(msg)) return `${url} 超时了，检查网络或稍后重试`;
    return `${url} → ${msg}`;
}

/** 把服务端的错误响应压成一句人话，避免一坨 HTML 糊在 UI 上 */
function summarizeError(text) {
    if (!text) return '';
    try {
        const json = JSON.parse(text);
        const msg = json?.error?.message ?? json?.message ?? json?.error;
        if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 160);
    } catch {
        // 不是 JSON，走下面
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** @param {string} text @returns {string[]} */
export function parseModelList(text) {
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        return [];
    }
    if (!json || typeof json !== 'object') return [];

    const ids = new Set();
    const add = (v) => {
        const s = typeof v === 'string' ? v.trim() : '';
        // Gemini 的 name 长这样：models/gemini-2.0-flash
        if (s) ids.add(s.replace(/^models\//, ''));
    };

    const walkArray = (arr) => {
        for (const item of arr) {
            if (!item) continue;
            if (typeof item === 'string') {
                add(item);
            } else if (typeof item === 'object') {
                add(item.id ?? item.model ?? item.model_name ?? item.name ?? item.modelId);
            }
        }
    };

    // 少数中转把模型列表包成 { "gpt-4": {...} } 的 map，这时 key 才是模型名。
    // 但要挡住 list / data 这种容器键，否则会往下拉里塞垃圾项。
    const WRAPPER_KEYS = new Set([
        'object', 'list', 'data', 'models', 'model', 'model_list', 'code', 'msg',
        'message', 'status', 'success', 'error', 'errors', 'total', 'count',
        'page', 'limit', 'has_more', 'type', 'created', 'owned_by', 'id',
    ]);
    const walkMap = (obj) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
        for (const key of Object.keys(obj)) {
            if (!WRAPPER_KEYS.has(key)) add(key);
        }
    };

    if (Array.isArray(json)) walkArray(json);
    if (Array.isArray(json.data)) walkArray(json.data);
    else walkMap(json.data);
    if (Array.isArray(json.models)) walkArray(json.models);
    else walkMap(json.models);
    if (Array.isArray(json.model_list)) walkArray(json.model_list);
    if (Array.isArray(json.list)) walkArray(json.list);

    return [...ids].sort();
}
