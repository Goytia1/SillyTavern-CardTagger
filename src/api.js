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
 * 解析 AI 输出为 { pick, newTags, reason }。
 * 容忍字段名不一致（有些模型会写成 newTags / tags / new）。
 * @param {string} raw
 * @returns {{ pick: string[], newTags: string[], reason: string }}
 */
export function parseTagResult(raw) {
    const fallback = { pick: [], newTags: [], reason: '' };
    const cleaned = stripCodeFence(raw);
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
    };
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
 * @returns {Promise<{ pick: string[], newTags: string[], reason: string }>}
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
            // 空结果算失败，值得重试一次
            if (!parsed.pick.length && !parsed.newTags.length && attempt < retryTimes) {
                throw new Error('模型未返回有效标签');
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
