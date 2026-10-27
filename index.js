/**
 * CardTagger · SillyTavern 角色卡批量标签助手
 *
 * 入口文件。职责：
 *   1. 设置持久化（挂在 extension_settings 下）
 *   2. 渲染设置面板 + 主操作面板
 *   3. 编排「抽取 → 问 AI → 预览 → 落库」的完整流程
 */

import {
    EXTENSION_NAME,
    DEFAULT_TAG_POOL,
    OPTIONAL_NSFW_TAG_POOL,
    EXTRACTABLE_FIELDS,
    DEFAULT_SELECTED_FIELDS,
    DEFAULT_FIELD_LIMITS,
    DEFAULT_SETTINGS,
    SYSTEM_PROMPT_TEMPLATE,
    USER_PROMPT_TEMPLATE,
} from './src/defaults.js';
import { buildCardContent, getExistingTags, getCharacterDisplayName } from './src/extract.js';
import { requestCardTags, runPool, AbortedError, normalizeResult, fetchModelList, salvageTagsFromText, isEmptyTagResult } from './src/api.js';
import { assignLocalTags, persistLocalTags, writeCardTagsBulk } from './src/writer.js';

const context = SillyTavern.getContext();

/** 运行时状态 */
const state = {
    /** @type {Array<object>} 每个待处理角色的作业对象 */
    jobs: [],
    running: false,
    controller: null,
    panelRoot: null,
    /** 已列出候选角色的标记；null 表示还没列过，此时不许直接开跑 */
    candidates: null,
};

// ============================================================================
// 设置读写
// ============================================================================

function ensureDefaults() {
    if (!context.extensionSettings[EXTENSION_NAME]) {
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
    }

    const s = context.extensionSettings[EXTENSION_NAME];

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) s[key] = structuredClone(value);
    }

    // 首次初始化时才填充这些「内容型」默认值
    if (!Array.isArray(s.tag_pool) || s.tag_pool.length === 0) {
        s.tag_pool = [...DEFAULT_TAG_POOL];
    }
    if (!Array.isArray(s.selected_fields) || s.selected_fields.length === 0) {
        s.selected_fields = [...DEFAULT_SELECTED_FIELDS];
    }
    if (!s.field_limits || Object.keys(s.field_limits).length === 0) {
        s.field_limits = { ...DEFAULT_FIELD_LIMITS };
    }

    return s;
}

function getSettings() {
    return context.extensionSettings[EXTENSION_NAME];
}

function saveSettings() {
    context.saveSettingsDebounced();
}

// ============================================================================
// 模板加载：用 import.meta.url 定位扩展自身目录，无需硬编码文件夹名
// ============================================================================

async function loadTemplate(file) {
    const url = new URL(`./${file}`, import.meta.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`模板加载失败：${file} (${res.status})`);
    return await res.text();
}

// ============================================================================
// 提示词构造
// ============================================================================

function buildPrompts(cardText) {
    const s = getSettings();
    const pool = Array.isArray(s.tag_pool) ? s.tag_pool : [];

    const system = (s.system_prompt || SYSTEM_PROMPT_TEMPLATE)
        .replaceAll('{{MAX_TAGS}}', String(s.max_tags ?? 4))
        .replaceAll('{{MAX_NEW_TAGS}}', String(s.max_new_tags ?? 2));

    let user = USER_PROMPT_TEMPLATE
        .replaceAll('{{TAG_POOL}}', pool.length ? pool.join('、') : '（池子为空，请全部用 new_tags 提出）')
        .replaceAll('{{CARD_CONTENT}}', cardText);

    if (s.extra_instruction?.trim()) {
        user += `\n\n额外要求：\n${s.extra_instruction.trim()}`;
    }

    return { system, user };
}

// ============================================================================
// 目标角色筛选
// ============================================================================

/**
 * 读取当前 ST 角色管理面板里实际在展示的角色。
 * 依赖 ST 内部 DOM，随时可能因版本变动失效，所以做多重选择器兜底，
 * 全部失败就返回 null，调用方回落到「全部角色」。
 * @returns {Set<string>|null}
 */
function readVisibleAvatars() {
    const selectors = [
        '#rm_print_characters_block div[avatar]',
        '#rm_print_characters_block .character_select[avatar]',
        '.character_select[avatar]',
        'div[avatar].bogus_folder_select',
    ];

    for (const sel of selectors) {
        const nodes = document.querySelectorAll(sel);
        if (!nodes.length) continue;

        const set = new Set();
        for (const node of nodes) {
            const avatar = node.getAttribute('avatar');
            if (avatar) set.add(avatar);
        }
        if (set.size) return set;
    }
    return null;
}

/**
 * 按面板上的范围选项挑出要处理的角色。
 * @returns {{ targets: object[], note?: string }}
 */
function resolveTargets() {
    const s = getSettings();
    const all = Array.isArray(context.characters) ? context.characters : [];
    let targets = all;
    let note;

    // 面板还没建好时无从谈范围，按「全部」处理
    const scope = state.ui?.scope?.value ?? 'all';
    const keyword = state.ui?.scopeKeyword?.value ?? '';

    switch (scope) {
        case 'untagged': {
            const map = context.tagMap ?? {};
            targets = all.filter(c => {
                const ids = map[String(c?.avatar)];
                return !Array.isArray(ids) || ids.length === 0;
            });
            break;
        }
        case 'keyword': {
            const kw = keyword.trim().toLowerCase();
            if (!kw) break;
            const map = context.tagMap ?? {};
            const localNameOf = (id) => (context.tags ?? []).find(t => t?.id === id)?.name ?? '';
            targets = all.filter(c => {
                if (getCharacterDisplayName(c).toLowerCase().includes(kw)) return true;
                if (getExistingTags(c).join('、').toLowerCase().includes(kw)) return true;
                const names = (map[String(c?.avatar)] ?? []).map(localNameOf).join('、').toLowerCase();
                return names.includes(kw);
            });
            break;
        }
        case 'filtered': {
            const visible = readVisibleAvatars();
            if (visible === null) {
                note = '读不到 ST 当前列表，已回退到「全部角色」';
                targets = all;
            } else {
                targets = all.filter(c => visible.has(String(c?.avatar)));
                if (!targets.length) note = '当前 ST 列表里没有匹配项';
            }
            break;
        }
        default:
            targets = all;
    }

    // 跳过已有本地标签的角色
    if (s.skip_tagged && scope !== 'untagged') {
        const map = context.tagMap ?? {};
        targets = targets.filter(c => {
            const ids = map[String(c?.avatar)];
            return !Array.isArray(ids) || ids.length === 0;
        });
    }

    return { targets, note };
}

// ============================================================================
// 主流程
// ============================================================================

function setProgress(current, total, message) {
    const wrap = state.ui.progressWrap;
    const fill = state.ui.progressFill;
    const text = state.ui.progressText;

    wrap.hidden = false;
    fill.style.width = `${total ? Math.round((current / total) * 100) : 0}%`;
    text.textContent = message || `${current} / ${total}`;
}

function hideProgress() {
    state.ui.progressWrap.hidden = true;
}

/** 根据 AI 源做前置校验，避免开跑一张才发现配置没填 */
function validateBeforeRun() {
    const s = getSettings();
    if (s.ai_source === 'custom') {
        if (!String(s.api_url || '').trim()) return '还没配置 API 地址';
        if (!String(s.api_key || '').trim()) return '还没配置 API Key';
        if (!String(s.model || '').trim()) return '还没配置模型名';
    }
    const fields = s.selected_fields ?? [];
    if (!fields.length) return '至少选一个要读取的卡片字段';
    // 只勾了「角色名」是没意义的，AI 只能瞎猜
    if (fields.length === 1 && fields[0] === 'name') {
        return '只勾了「角色名」，AI 没有足够信息可用';
    }
    return null;
}

/**
 * 第一步：把当前范围命中的角色列出来，填满结果区。
 *
 * 之前点「开始分析」就直接调 AI，中间一大块全是空白，跑完才有内容 ——
 * 既没法确认范围对不对，几十张卡跑完发现选错了也来不及。
 * 现在先列候选：每行显示角色名、卡片内嵌标签、本地标签，
 * 全部默认勾选，用户手动排除后再点底部的「开始分析」。
 */
async function listCandidates() {
    if (state.running) return;

    const invalid = validateBeforeRun();
    if (invalid) {
        toastr.warning(invalid, 'CardTagger');
        return;
    }

    const { targets, note } = resolveTargets();
    if (!targets.length) {
        state.jobs = [];
        state.candidates = null;
        renderRows();
        updateFooterStats();
        toastr.warning(note || '没有符合条件的角色', 'CardTagger');
        return;
    }

    const s = getSettings();
    const skippedTagged = s.skip_tagged && state.ui.scope.value !== 'untagged';

    state.jobs = targets.map((character, index) => ({
        index,
        avatar: String(character.avatar ?? ''),
        name: getCharacterDisplayName(character),
        existingTags: getExistingTags(character),
        cardTags: [...getExistingTags(character)],
        status: 'candidate',
        pick: [],
        newTags: [],
        removedTags: new Set(),
        reason: '',
        selected: true,
        error: '',
        raw: '',
        salvaged: false,
    }));

    state.candidates = { count: targets.length, skippedTagged, note: note ?? '' };
    renderRows();
    updateFooterStats();

    // 候选条：说清这次会处理多少张、以及为什么
    const parts = [`命中 ${targets.length} 个角色`];
    if (skippedTagged) parts.push('已自动跳过有本地标签的');
    if (note) parts.push(note);
    state.ui.candidateText.textContent = `${parts.join(' · ')}。取消勾选可排除单个角色，确认后点右下角「开始分析」。`;
    state.ui.candidateBar.hidden = false;
    state.ui.confirmRun.hidden = false;

    // 有内容了就收起空状态提示
    state.ui.emptyState.hidden = true;
    state.ui.table.hidden = false;

    toastr.info(`已列出 ${targets.length} 个角色，勾完点「开始分析」`, 'CardTagger');
}

async function runAnalysis() {
    if (state.running) return;

    // 没列过候选就不许开跑 —— 用户必须先看到会处理哪些角色
    if (!state.candidates) {
        listCandidates();
        return;
    }

    const invalid = validateBeforeRun();
    if (invalid) {
        toastr.warning(invalid, 'CardTagger');
        return;
    }

    // 只跑勾中的；没勾选的一律不动
    const chosen = state.jobs.filter(j => j.selected);
    if (!chosen.length) {
        toastr.warning('一个角色都没勾选', 'CardTagger');
        return;
    }

    const s = getSettings();
    const all = Array.isArray(context.characters) ? context.characters : [];
    const byAvatar = new Map(all.map(c => [String(c?.avatar), c]));
    const targets = chosen
        .map(j => byAvatar.get(j.avatar))
        .filter(Boolean);
    if (!targets.length) {
        toastr.warning('选中的角色已不存在，请重新列出', 'CardTagger');
        return;
    }

    state.running = true;
    state.controller = new AbortController();
    const signal = state.controller.signal;

    // 候选阶段结束：确认按钮藏起来，避免跑一半又被点一次
    state.ui.confirmRun.hidden = true;
    state.ui.start.hidden = true;
    state.ui.abort.hidden = false;
    state.ui.retryFailed.hidden = true;
    state.ui.applyLocal.disabled = true;
    state.ui.applyCard.disabled = true;
    state.ui.emptyState.hidden = true;
    state.ui.table.hidden = false;

    // 作业表沿用 listCandidates 建好的行，只把状态从 candidate 推到 pending，
    // 不重新建 —— 否则用户刚取消的勾选会被重置回全选。
    // index 必须与 targets 对齐（任务里用的是 targets[job.index]）
    state.jobs = chosen.map((job, i) => ({ ...job, index: i, status: 'pending', error: '' }));

    renderRows();

    let done = 0;
    const startedAt = Date.now();

    const tasks = state.jobs.map((job) => async () => {
        if (signal.aborted) throw new AbortedError();

        const character = targets[job.index];
        const { text, isEmpty } = buildCardContent(character, {
            fields: s.selected_fields,
            limits: s.field_limits,
        });

        if (isEmpty) {
            job.status = 'failed';
            job.error = '选中的字段在卡上是空的';
            refreshRow(job);
            return;
        }

        try {
            const { system, user } = buildPrompts(text);
            // 留档「模型到底看到了什么」：交白卷时，raw 弹窗里展示发送内容，
            // 这是区分「没抽到内容」和「模型不给力」的第一现场
            job.sentLength = text.length;
            job.sentPreview = text.slice(0, 600);
            const result = await requestCardTags({
                systemPrompt: system,
                userPrompt: user,
                settings: s,
                context,
                signal,
                retryTimes: Number(s.retry_times) || 0,
            });

            job.raw = result.raw ?? '';

            let { pick, newTags } = normalizeResult(result, s);

            // 模型没按 JSON 答（被审核拦、破限失败、格式跑偏）时，
            // 拿词表去原文里做子串匹配，能捞回几个是几个。
            // 不然整张卡只会显示一句「模型没给出任何标签」，白白浪费一次调用。
            if (!pick.length && !newTags.length && job.raw) {
                const salvaged = salvageTagsFromText(job.raw, s.tag_pool ?? []);
                if (salvaged.length) {
                    pick = salvaged.slice(0, Number(s.max_tags) || 4);
                    job.salvaged = true;
                }
            }

            job.pick = pick;
            job.newTags = newTags;
            job.reason = result.reason;
            job.status = 'ok';

            if (!job.pick.length && !job.newTags.length) {
                job.status = 'failed';
                job.error = describeEmptyResult(job);
            }
        } catch (err) {
            job.status = 'failed';
            if (err instanceof AbortedError) {
                job.error = '已中断';
            } else {
                job.raw = err?.raw ?? job.raw ?? '';
                job.error = describeEmptyResult(job, err);
            }
        } finally {
            if (s.request_delay_ms > 0 && !signal.aborted) {
                await new Promise(r => setTimeout(r, Number(s.request_delay_ms) || 0));
            }
        }

        done++;
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        setProgress(done, state.jobs.length,
            `处理中 ${done} / ${state.jobs.length} · 已耗时 ${elapsed}s · 成功 ${state.jobs.filter(j => j.status === 'ok').length}`);
        refreshRow(job);
    });

    await runPool(tasks, Number(s.concurrency) || 4, null, signal);

    const succeeded = state.jobs.filter(j => j.status === 'ok').length;
    const failed = state.jobs.filter(j => j.status === 'failed').length;

    state.running = false;
    state.controller = null;
    state.ui.start.hidden = false;
    state.ui.abort.hidden = true;
    state.ui.retryFailed.hidden = failed === 0;
    hideProgress();
    updateFooterStats();

    toastr.info(`完成：成功 ${succeeded}，失败 ${failed}`, 'CardTagger');
}

async function retryFailed() {
    const failures = state.jobs.filter(j => j.status === 'failed');
    if (!failures.length) return;

    const s = getSettings();
    const targetMap = new Map(context.characters.map(c => [String(c?.avatar), c]));

    state.running = true;
    state.controller = new AbortController();
    const signal = state.controller.signal;
    state.ui.start.hidden = true;
    state.ui.abort.hidden = false;

    let done = 0;
    const tasks = failures.map((job) => async () => {
        job.status = 'pending';
        job.error = '';
        refreshRow(job);

        const character = targetMap.get(job.avatar);
        if (!character) {
            job.status = 'failed';
            job.error = '角色已不存在';
            refreshRow(job);
            return;
        }

        const { text } = buildCardContent(character, {
            fields: s.selected_fields,
            limits: s.field_limits,
        });

        try {
            const { system, user } = buildPrompts(text);
            // 同 runAnalysis：留档发送内容，供「看原文」排查交白卷
            job.sentLength = text.length;
            job.sentPreview = text.slice(0, 600);
            const result = await requestCardTags({
                systemPrompt: system,
                userPrompt: user,
                settings: s,
                context,
                signal,
                retryTimes: Number(s.retry_times) || 0,
            });
            job.raw = result.raw ?? '';

            let { pick, newTags } = normalizeResult(result, s);
            if (!pick.length && !newTags.length && job.raw) {
                const salvaged = salvageTagsFromText(job.raw, s.tag_pool ?? []);
                if (salvaged.length) {
                    pick = salvaged.slice(0, Number(s.max_tags) || 4);
                    job.salvaged = true;
                }
            }

            job.pick = pick;
            job.newTags = newTags;
            job.reason = result.reason;
            job.status = (job.pick.length || job.newTags.length) ? 'ok' : 'failed';
            if (job.status === 'failed') job.error = describeEmptyResult(job);
        } catch (err) {
            job.status = 'failed';
            if (err instanceof AbortedError) {
                job.error = '已中断';
            } else {
                job.raw = err?.raw ?? job.raw ?? '';
                job.error = describeEmptyResult(job, err);
            }
        }

        done++;
        setProgress(done, failures.length, `重试中 ${done} / ${failures.length}`);
        refreshRow(job);
    });

    await runPool(tasks, Number(s.concurrency) || 4, null, signal);

    state.running = false;
    state.controller = null;
    state.ui.start.hidden = false;
    state.ui.abort.hidden = true;
    hideProgress();
    updateFooterStats();
}

// ============================================================================
// 结果表格渲染
// ============================================================================

/**
 * 生成空结果的失败原因。
 *
 * 直接说「模型没给出任何标签」等于没说 —— 真实原因通常是那几样：
 * 审核拦截、破限失败、max_tokens 截断、或者模型压根没按格式答。
 * 用原文做个粗判，把可能性点出来，用户才知道该往哪调。
 *
 * @param {{ raw?: string }} job
 * @param {Error} [err]
 * @returns {string}
 */
function describeEmptyResult(job, err) {
    const raw = String(job?.raw ?? '').trim();
    const msg = err ? String(err?.message ?? '') : '';

    // 网络/HTTP 层错误：模型根本没答话，跟内容无关
    if (err && !/TagParseError/.test(err?.name ?? '')) {
        const net = /fetch|network|Failed/i.test(msg);
        return net
            ? `请求没发出去或没响应（${msg.slice(0, 80)}）—— 检查网络/API 地址，或看「拉取模型」能不能通`
            : msg.slice(0, 100);
    }

    if (!raw) return '模型返回了空内容 —— 可能是超时或被限流，把「重试次数」调到 2 试试';

    // 合法 JSON 但俩数组都空：模型「稳妥」交了白卷。
    // 手机上「模型没给出任何标签」最常见的死法之一——模型看懂了格式，
    // 却一个标签都不给。跟拒答、截断的解决办法完全不同，必须分开说。
    if (isEmptyTagResult(raw)) {
        const sent = job?.sentLength
            ? `（本次发给模型的内容约 ${job.sentLength} 字符${job.sentLength < 200 ? '，明显偏少，优先去检查抽取字段' : ''}）`
            : '';
        return `模型返回了合法 JSON，但 pick / new_tags 都是空的${sent} —— 模型看懂了格式却交白卷。`
            + '常见原因：① 抽取到的卡面内容太少或字段没选对；② 模型太保守或太弱；③ 卡面内容敏感被软拒。'
            + '已自动用加强提示词重试仍为空。可尝试：换更强的模型、只保留「描述」字段、'
            + '或在「附加指令」里写「至少给出 1 个标签」。点「看原文」可核对发给模型的内容。';
    }

    const lower = raw.toLowerCase();

    // 审核/拒答：这是跑 NSFW 卡最常见的死法
    const refusal = [
        '抱歉', '对不起', '无法', '不能', 'sorry', "can't", 'cannot', 'unable',
        'not able', 'i am unable', 'against my', 'content policy', 'policy',
        '违反', '敏感', '违规', '不适宜', ' inappropriate',
    ].find(k => lower.includes(k.toLowerCase()));

    // JSON 被 max_tokens 从中间切断：开头像 JSON 但 parse 不过
    const looksTruncatedJson = /^[[{]/.test(raw) && !/[\]}]\s*$/.test(raw);

    if (refusal) {
        return `模型拒答了（返回的是自然语言，不是 JSON）—— 疑似内容审核/破限失败。点「看原文」确认`;
    }
    if (looksTruncatedJson) {
        return `模型回答被截断（JSON 只写了一半）—— 把「单次最大 token」从 300 提到 800 以上`;
    }
    return `模型没给出有效标签（返回的不是 JSON）—— 点「看原文」看看它说了什么`;
}

/** 该卡最终要写入的标签（剔除用户手动删掉的） */
function activeTags(job) {
    const removed = job.removedTags ?? new Set();
    return [...job.pick, ...job.newTags].filter(x => !removed.has(x));
}

/**
 * 展示模型的原始返回。
 *
 * 这一屏是排查「模型没给出任何标签」的主要手段：
 * 看到「抱歉，我无法…」= 审核/破限问题；看到半截 JSON = max_tokens 不够；
 * 看到合法 JSON 但俩数组都空 = 模型交白卷，这时要连带看「发送内容」——
 * 是卡面素材没抽到，还是模型看到了内容却不肯给标签。
 */
function showRawDialog(job) {
    const raw = String(job.raw ?? '');
    const preview = raw.length > 6000 ? `${raw.slice(0, 6000)}\n\n…（已截断，共 ${raw.length} 字符）` : raw;

    let verdict;
    if (isEmptyTagResult(raw)) {
        verdict = '<b style="color:#e5c07b">JSON 合法，但两个标签数组都是空的 —— 模型交了白卷。</b><br>'
            + '模型看懂了格式、却一个标签都不给。先看下方「发送给模型的内容」确认卡面素材是否真的抽到了；'
            + '内容正常的话，就是模型太保守或太弱 —— 换个模型，或在「附加指令」里写「至少给出 1 个标签」。<br><br>';
    } else if (/抱歉|对不起|sorry|can't|cannot|unable|无法|不能|违反|敏感|违规/i.test(raw)) {
        verdict = '<b style="color:#e06c75">这看着像是被内容审核拦了 / 破限失败。</b><br>'
            + '模型返回的是自然语言而不是 JSON。可试试：<br>'
            + '• 换个不过审的模型或中转站<br>'
            + '• 在「附加指令」里弱化提示词，让它只做分类、不复述卡片内容<br>'
            + '• 减少读取的字段（先只读「描述」试）<br><br>';
    } else if (/^[[{]/.test(raw) && !/[\]}]\s*$/.test(raw)) {
        verdict = '<b style="color:#e5c07b">JSON 只写了一半，是被 max_tokens 截断了。</b><br>'
            + '去设置里把「单次最大 token」提到 800 以上，同时减少单次读取的字段。<br><br>';
    } else {
        verdict = '';
    }

    // 「模型到底看到了什么」——交白卷时这是第一现场：
    // 这里只有寥寥几行 = 抽取字段没选对/卡面是空的；内容详实 = 模型的问题
    const sentBlock = job.sentPreview
        ? `<div style="opacity:.7;font-size:.9em;margin:12px 0 6px;">`
          + `发送给模型的内容（共 ${job.sentLength ?? 0} 字符，下方为前 ${job.sentPreview.length} 字符预览）：</div>`
          + `<pre style="white-space:pre-wrap;word-break:break-word;margin:0;font-size:.85em;max-height:30vh;overflow:auto;">`
          + `${escapeHtml(job.sentPreview)}${(job.sentLength ?? 0) > job.sentPreview.length ? '\n…（其余部分未显示）' : ''}</pre>`
        : '';

    context.callGenericPopup(
        `<div style="text-align:left;max-height:60vh;overflow:auto;">`
        + `${verdict}`
        + `<div style="opacity:.7;font-size:.9em;margin-bottom:6px;">`
        + `角色：${escapeHtml(job.name)} · 返回 ${raw.length} 字符</div>`
        + `<pre style="white-space:pre-wrap;word-break:break-word;margin:0;font-size:.85em;">`
        + `${escapeHtml(preview)}</pre>`
        + `${sentBlock}</div>`,
        context.POPUP_TYPE.TEXT,
    );
}

function escapeHtml(str) {
    return String(str ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function renderRows() {
    state.ui.resultBody.innerHTML = '';
    state.jobs.forEach(job => {
        job.removedTags = job.removedTags ?? new Set();
        state.ui.resultBody.appendChild(buildRow(job));
    });
    updateFooterStats();
}

function buildRow(job) {
    const tr = document.createElement('tr');
    tr.dataset.avatar = job.avatar;
    if (job.status === 'failed') tr.classList.add('ct-row-failed');

    // 勾选（候选阶段也要能操作，否则没法排除单个角色）
    const tdCheck = document.createElement('td');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = job.selected && (job.status === 'ok' || job.status === 'candidate');
    check.disabled = !(job.status === 'ok' || job.status === 'candidate');
    check.addEventListener('change', () => {
        job.selected = check.checked;
        updateFooterStats();
    });
    tdCheck.appendChild(check);
    tr.appendChild(tdCheck);

    // 角色名 + 已有标签
    const tdName = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'ct-name-cell';
    const nameEl = document.createElement('div');
    nameEl.className = 'ct-char-name';
    nameEl.textContent = job.name;
    wrap.appendChild(nameEl);

    if (job.existingTags.length) {
        const exist = document.createElement('div');
        exist.className = 'ct-existing-tags';
        exist.textContent = `原有：${job.existingTags.join('、')}`;
        wrap.appendChild(exist);
    }
    tdName.appendChild(wrap);
    tr.appendChild(tdName);

    // 标签 chips
    const tdTags = document.createElement('td');
    tdTags.className = 'ct-tags-cell';
    tdTags.appendChild(buildChips(job, tdTags));
    tr.appendChild(tdTags);

    // 状态
    const tdStatus = document.createElement('td');
    tdStatus.appendChild(buildStatus(job));
    tr.appendChild(tdStatus);

    job._els = { tr, check, tdTags, tdStatus };
    return tr;
}

function buildChips(job, container) {
    const frag = document.createDocumentFragment();

    // 候选阶段还没有 AI 标签，这时该显示的是卡片自带的标签，
    // 让用户在开跑前就能看出这个角色大概是什么类型、值不值得处理
    if (job.status === 'candidate') {
        const own = job.existingTags ?? [];
        if (!own.length) {
            const hint = document.createElement('span');
            hint.className = 'ct-hint';
            hint.textContent = '卡片本身没写标签';
            frag.appendChild(hint);
            return frag;
        }
        for (const tag of own) {
            const chip = document.createElement('span');
            chip.className = 'ct-chip ct-chip-existing';
            chip.title = '卡片内嵌的标签（导出时会跟着走，但不参与筛选）';
            chip.textContent = tag;
            frag.appendChild(chip);
        }
        return frag;
    }

    const isNew = new Set(job.newTags);

    for (const tag of [...job.pick, ...job.newTags]) {
        if (job.removedTags.has(tag)) continue;

        const chip = document.createElement('span');
        chip.className = isNew.has(tag) ? 'ct-chip ct-chip-new' : 'ct-chip';
        chip.title = isNew.has(tag) ? 'AI 新建的标签（不在你的词表里）' : '来自你的标签池';

        const label = document.createElement('span');
        label.textContent = tag;
        chip.appendChild(label);

        const del = document.createElement('span');
        del.className = 'ct-chip-remove';
        del.innerHTML = '&#10005;';
        del.title = '不要这个标签';
        del.addEventListener('click', () => {
            job.removedTags.add(tag);
            container.innerHTML = '';
            container.appendChild(buildChips(job, container));
            updateFooterStats();
        });
        chip.appendChild(del);

        frag.appendChild(chip);
    }

    // 手动补标签
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'ct-chip-add';
    addBtn.textContent = '+ 补一个';
    addBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'ct-field-limit';
        input.style.width = '90px';
        const commit = () => {
            const value = input.value.trim();
            if (value) {
                job.removedTags.delete(value);
                if (!job.pick.includes(value) && !job.newTags.includes(value)) {
                    job.newTags.push(value);
                }
            }
            container.innerHTML = '';
            container.appendChild(buildChips(job, container));
            updateFooterStats();
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') input.value = '';
        });
        container.insertBefore(input, addBtn);
        input.focus();
    });
    frag.appendChild(addBtn);

    return frag;
}

function buildStatus(job) {
    const el = document.createElement('div');

    if (job.status === 'candidate') {
        el.className = 'ct-status-text ct-status-candidate';
        el.textContent = '待确认';
        return el;
    }
    if (job.status === 'pending') {
        el.className = 'ct-status-text';
        el.textContent = '排队中…';
        return el;
    }
    if (job.status === 'failed') {
        el.className = 'ct-status-text ct-status-failed';
        el.textContent = job.error || '失败';

        // 有原文就一定给看的入口：审核拦截、格式跑偏、被截断，
        // 光看这句提示是猜不出来的，必须让用户亲眼看到模型说了什么
        if (job.raw) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ct-raw-link';
            btn.textContent = '看原文';
            btn.addEventListener('click', () => showRawDialog(job));
            el.appendChild(btn);
        }
        return el;
    }

    el.className = 'ct-status-text ct-status-ok';
    const count = activeTags(job).length;
    el.textContent = job.salvaged ? `✓ ${count} 个（从原文抢救）` : `✓ ${count} 个标签`;
    if (job.reason) el.title = job.reason;
    return el;
}

function refreshRow(job) {
    if (!job._els) { renderRows(); return; }

    const { tr, check, tdTags, tdStatus } = job._els;
    tr.classList.toggle('ct-row-failed', job.status === 'failed');
    // 候选阶段也要能勾/能取消，这是用户排除单个角色的唯一入口
    check.disabled = !(job.status === 'ok' || job.status === 'candidate') || state.running;
    check.checked = job.selected && (job.status === 'ok' || job.status === 'candidate');

    tdTags.innerHTML = '';
    tdTags.appendChild(buildChips(job, tdTags));

    tdStatus.innerHTML = '';
    tdStatus.appendChild(buildStatus(job));
}

function updateFooterStats() {
    const candidates = state.jobs.filter(j => j.status === 'candidate');

    // 候选阶段：还没跑 AI，统计的应该是「将要分析几个」，
    // 同时把确认按钮的文案同步成实际勾选数，避免点下去才发现数量不对
    if (candidates.length && !state.running) {
        const picked = candidates.filter(j => j.selected).length;
        state.ui.footerStats.textContent =
            `已列出 ${candidates.length} 个角色 · 勾选 ${picked} 个 · 确认后开始调 AI`;
        state.ui.applyLocal.disabled = true;
        state.ui.applyCard.disabled = true;
        if (state.ui.confirmRun) {
            state.ui.confirmRun.hidden = false;
            state.ui.confirmRun.innerHTML =
                '<span class="fa-solid fa-wand-magic-sparkles"></span> '
                + `开始分析 ${picked} 个角色`;
        }
        return;
    }

    const okJobs = state.jobs.filter(j => j.status === 'ok');
    const selected = okJobs.filter(j => j.selected && activeTags(j).length);
    const totalTags = selected.reduce((sum, j) => sum + activeTags(j).length, 0);
    const newCount = selected.reduce(
        (sum, j) => sum + activeTags(j).filter(t => j.newTags.includes(t)).length, 0,
    );

    state.ui.footerStats.textContent = state.jobs.length
        ? `共 ${state.jobs.length} 个角色 · 已选 ${selected.length} 个 · 将写入 ${totalTags} 个标签（其中新建 ${newCount} 个）`
        : '';

    state.ui.applyLocal.disabled = !selected.length || state.running;
    state.ui.applyCard.disabled = !selected.length || state.running;
}

// ============================================================================
// 应用结果
// ============================================================================

function selectionList() {
    return state.jobs.filter(j => j.status === 'ok' && j.selected && activeTags(j).length);
}

async function applyLocal() {
    const list = selectionList();
    if (!list.length) return;

    if (!getSettings().write_to_local_tags) {
        toastr.warning('设置里没勾选「写入本地标签」，先去打开', 'CardTagger');
        return;
    }

    for (const job of list) {
        assignLocalTags(context, job.avatar, activeTags(job));
        job.appliedLocal = true;
    }
    persistLocalTags(context);

    toastr.success(`已把 ${list.length} 个角色的标签写进本地标签库。若列表没立刻刷新，按 F5 重载一次。`, 'CardTagger');
    try {
        await context.eventSource.emit(context.eventTypes.CHARACTER_EDITED, { detail: 'card-tagger' });
    } catch { /* 刷新失败不影响已落盘的数据 */ }
}

async function applyCard() {
    const list = selectionList();
    if (!list.length) return;

    const s = getSettings();
    if (!s.write_to_card_tags) {
        toastr.warning('设置里没勾选「回填卡片内嵌标签」，先去打开', 'CardTagger');
        return;
    }

    const pngCount = list.filter(j => /\.png$/i.test(j.avatar)).length;
    const confirm = await context.callGenericPopup(
        `即将重写 ${pngCount} 张 PNG 卡片的本体。<br><br>` +
        `• SillyTavern 会按你当前的头像设置<b>重新编码图片</b>（可能缩放）<br>` +
        `• 非 .png 卡片会被跳过（共 ${list.length - pngCount} 张）<br>` +
        `• 建议先备份 <code>characters</code> 目录<br><br>` +
        `要继续吗？`,
        context.POPUP_TYPE.CONFIRM,
    );
    if (confirm !== context.POPUP_RESULT.AFFIRMATIVE) return;

    const items = list
        .filter(j => /\.png$/i.test(j.avatar))
        .map(j => ({
            avatar: j.avatar,
            allTags: s.overwrite_card_tags
                ? activeTags(j)
                : Array.from(new Set([...j.cardTags, ...activeTags(j)])),
        }));

    state.controller = new AbortController();
    state.ui.applyCard.disabled = true;
    setProgress(0, items.length, '正在回填卡片…');

    const results = await writeCardTagsBulk({
        context,
        items,
        concurrency: 3,
        onProgress: (done, total) => setProgress(done, total, `回填中 ${done} / ${total}`),
        signal: state.controller.signal,
    });

    hideProgress();
    state.ui.applyCard.disabled = false;

    const okCount = results.filter(r => r?.ok).length;
    const failures = results.filter(r => r && !r.ok);

    if (failures.length) {
        console.warn('[CardTagger] 回填失败明细：', failures);
        toastr.warning(
            `回填完成：成功 ${okCount}，失败 ${failures.length}（常见原因是纯 V3 格式卡被服务端拒绝）。明细见控制台。`,
            'CardTagger',
        );
    } else {
        toastr.success(`已回填 ${okCount} 张卡片`, 'CardTagger');
    }
}

function exportResults() {
    const list = state.jobs.filter(j => j.status === 'ok');
    if (!list.length) return;

    const payload = list.map(j => ({
        avatar: j.avatar,
        name: j.name,
        tags: activeTags(j),
        newTags: activeTags(j).filter(t => j.newTags.includes(t)),
        reason: j.reason,
    }));

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `card-tagger-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ============================================================================
// 主面板
// ============================================================================

async function ensurePanel() {
    if (state.panelRoot) return state.panelRoot;

    const html = await loadTemplate('panel.html');
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);

    const $ = (id) => document.getElementById(id);

    state.ui = {
        root: $('ct_panel'),
        close: $('ct_close_panel'),
        summary: $('ct_summary'),
        viewMain: $('ct_view_main'),
        viewSettings: $('ct_view_settings'),
        openSettingsBtn: $('ct_open_settings'),
        backMain: $('ct_back_main'),
        finishSettings: $('ct_finish_settings'),
        scope: $('ct_scope'),
        scopeKeyword: $('ct_scope_keyword'),
        scopeCount: $('ct_scope_count'),
        start: $('ct_start'),
        abort: $('ct_abort'),
        retryFailed: $('ct_retry_failed'),
        confirmRun: $('ct_confirm_run'),
        candidateBar: $('ct_candidate_bar'),
        candidateText: $('ct_candidate_text'),
        candidateReset: $('ct_candidate_reset'),
        preview: $('ct_preview'),
        selectAll: $('ct_select_all'),
        selectNone: $('ct_select_none'),
        selectNew: $('ct_select_new'),
        progressWrap: $('ct_progress_wrap'),
        progressFill: $('ct_progress_fill'),
        progressText: $('ct_progress_text'),
        emptyState: $('ct_empty_state'),
        table: $('ct_result_table'),
        resultBody: $('ct_result_body'),
        footerStats: $('ct_footer_stats'),
        applyLocal: $('ct_apply_local'),
        applyCard: $('ct_apply_card'),
        exportBtn: $('ct_export'),
    };

    // ---- 事件绑定 ----
    state.ui.close.addEventListener('click', () => { state.ui.root.hidden = true; });

    state.ui.root.addEventListener('click', (e) => {
        if (e.target === state.ui.root) state.ui.root.hidden = true;
    });

    // ---- 主视图 / 设置视图 切换 ----
    const switchView = (view) => {
        const settings = view === 'settings';
        state.ui.viewMain.hidden = settings;
        state.ui.viewSettings.hidden = !settings;
        state.ui.summary.hidden = settings;
        state.ui.openSettingsBtn.hidden = settings;
    };

    state.ui.openSettingsBtn.addEventListener('click', () => switchView('settings'));
    state.ui.backMain.addEventListener('click', () => switchView('main'));
    state.ui.finishSettings.addEventListener('click', () => switchView('main'));
    state.ui.switchView = switchView;
    switchView('main');

    // 面板内的设置控件与「扩展设置抽屉」共用同一套绑定逻辑
    bindSettingsControls(state.ui.viewSettings);

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || state.ui.root.hidden) return;
        // 先看是否在设置视图，是的话先退回主视图
        if (!state.ui.viewSettings.hidden) switchView('main');
        else state.ui.root.hidden = true;
    });

    const refreshCount = () => {
        const { targets } = resolveTargets();
        state.ui.scopeCount.textContent = `${targets.length} 个角色待处理`;
    };

    state.ui.scope.addEventListener('change', () => {
        state.ui.scopeKeyword.hidden = state.ui.scope.value !== 'keyword';
        refreshCount();
    });
    state.ui.scopeKeyword.addEventListener('input', refreshCount);

    state.ui.start.addEventListener('click', () => listCandidates());
    state.ui.confirmRun.addEventListener('click', () => runAnalysis());
    state.ui.candidateReset.addEventListener('click', () => {
        state.jobs = [];
        state.candidates = null;
        renderRows();
        updateFooterStats();
        refreshCount();
    });
    state.ui.preview.addEventListener('click', () => listCandidates());
    state.ui.abort.addEventListener('click', () => {
        state.controller?.abort();
        toastr.info('正在停止…', 'CardTagger');
    });
    state.ui.retryFailed.addEventListener('click', () => retryFailed());

    const setAll = (value) => {
        state.jobs.forEach(job => {
            // 候选阶段同样要能全选/全不选，几十张卡一张张点太累
            const selectable = job.status === 'ok' || job.status === 'candidate';
            if (selectable) job.selected = value;
            if (job._els) job._els.check.checked = value && selectable;
        });
        updateFooterStats();
    };
    state.ui.selectAll.addEventListener('click', () => setAll(true));
    state.ui.selectNone.addEventListener('click', () => setAll(false));
    state.ui.selectNew.addEventListener('click', () => {
        state.jobs.forEach(job => {
            const hasNew = job.status === 'ok' && activeTags(job).some(t => job.newTags.includes(t));
            job.selected = hasNew;
            if (job._els) job._els.check.checked = hasNew;
        });
        updateFooterStats();
    });

    state.ui.applyLocal.addEventListener('click', () => applyLocal());
    state.ui.applyCard.addEventListener('click', () => applyCard());
    state.ui.exportBtn.addEventListener('click', () => exportResults());

    refreshCount();
    state.panelRoot = state.ui.root;
    return state.panelRoot;
}

async function openPanel() {
    await ensurePanel();
    state.ui.switchView?.('main');
    state.panelRoot.hidden = false;
    updateFooterStats();
}

// ============================================================================
// 设置面板
// ============================================================================

function buildFieldList(container) {
    const s = getSettings();
    container.innerHTML = '';

    for (const field of EXTRACTABLE_FIELDS) {
        const row = document.createElement('label');
        row.className = 'ct-field-row';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = (s.selected_fields ?? []).includes(field.key);
        cb.addEventListener('change', () => {
            const set = new Set(s.selected_fields);
            if (cb.checked) set.add(field.key); else set.delete(field.key);
            s.selected_fields = [...set];
            saveSettings();
        });

        const name = document.createElement('span');
        name.textContent = field.label;

        const limit = document.createElement('input');
        limit.type = 'number';
        limit.className = 'ct-field-limit';
        limit.min = '0';
        limit.step = '100';
        limit.title = '字数上限，0 表示不限制';
        limit.value = String(s.field_limits?.[field.key] ?? DEFAULT_FIELD_LIMITS[field.key] ?? 0);
        limit.addEventListener('change', () => {
            s.field_limits = { ...(s.field_limits ?? {}), [field.key]: Number(limit.value) || 0 };
            saveSettings();
        });

        const hint = document.createElement('span');
        hint.className = 'ct-field-meta';
        hint.textContent = field.hint;

        row.append(cb, name, limit, hint);
        container.appendChild(row);
    }
}

function setPoolTextarea(textarea, names) {
    textarea.value = [...new Set(names.map(x => String(x).trim()).filter(Boolean))].join('\n');
}

async function buildSettingsPanel() {
    const html = await loadTemplate('settings.html');
    const root = document.querySelector('#extensions_settings');
    if (!root) {
        console.warn('[CardTagger] 找不到 #extensions_settings，设置面板未挂载');
        return;
    }

    const host = document.createElement('div');
    host.id = 'card_tagger_settings';
    host.innerHTML = html;
    root.appendChild(host);

    // 抽屉里只保留一个入口，真正的设置项都搬进了主面板的「⚙ 设置」视图
    host.querySelector('#ct_open_panel')?.addEventListener('click', () => openPanel());
}

/**
 * 绑定设置控件。
 *
 * 抽出来是因为同一套控件要在两处出现：主面板内的设置视图，以及（曾经的）
 * 扩展设置抽屉。传入宿主元素即可，内部一律用 querySelector 作用域内查找，
 * 避免重复 id 互相干扰。
 *
 * @param {HTMLElement} host 包含设置表单的根元素
 * @param {object} s 设置对象
 */
function bindSettingsControls(host) {
    const $ = (sel) => host.querySelector(sel);
    const s = getSettings();

    // ---- AI 源 ----
    const customBlock = $('.ct-sub-block[data-source="custom"]');
    const radios = host.querySelectorAll('input[name="ct_ai_source"]');

    const syncSource = () => {
        radios.forEach(r => { r.checked = r.value === s.ai_source; });
        if (customBlock) customBlock.hidden = s.ai_source !== 'custom';
    };

    radios.forEach(r => {
        r.addEventListener('change', () => {
            s.ai_source = r.value;
            saveSettings();
            syncSource();
        });
    });
    syncSource();

    // ---- 独立 API 配置 ----
    const bindText = (id, key, cast = String) => {
        const el = $(`#${id}`);
        el.value = s[key] ?? '';
        el.addEventListener('input', () => { s[key] = cast(el.value); saveSettings(); });
    };
    bindText('ct_api_url', 'api_url');
    bindText('ct_api_key', 'api_key');
    bindText('ct_model', 'model');
    bindText('ct_extra_headers', 'extra_headers');
    bindText('ct_extra_body', 'extra_body');

    // ---- 模型列表 ----
    const modelList = $('#ct_model_list');
    const modelHint = $('#ct_model_hint');
    const fetchBtn = $('#ct_fetch_models');

    const applyModelList = (models) => {
        modelList.innerHTML = '';
        for (const name of models) {
            const opt = document.createElement('option');
            opt.value = name;
            modelList.appendChild(opt);
        }
        modelHint.className = 'ct-hint ct-model-hint';
        modelHint.textContent = models.length
            ? `已拉到 ${models.length} 个模型，点输入框就能下拉选；也可以继续手打`
            : '';
        return models.length;
    };

    let inflightModels = null;
    const pullModels = async ({ quiet = false } = {}) => {
        if (inflightModels) return inflightModels;

        if (!String(s.api_url ?? '').trim()) {
            modelHint.className = 'ct-hint ct-model-hint ct-model-hint-fail';
            modelHint.textContent = '先填 API 地址';
            return 0;
        }

        fetchBtn.disabled = true;
        fetchBtn.value = '拉取中…';
        modelHint.className = 'ct-hint ct-model-hint';
        modelHint.textContent = '';

        inflightModels = (async () => {
            try {
                const models = await fetchModelList({
                    apiUrl: s.api_url,
                    apiKey: s.api_key,
                    extraHeaders: s.extra_headers,
                });
                const count = applyModelList(models);
                if (!quiet) {
                    if (count) toastr.success(`拉到 ${count} 个可用模型`, 'CardTagger');
                    else toastr.info('接口没返回任何模型', 'CardTagger');
                }
                return count;
            } catch (err) {
                // 别在这里截断：诊断信息（CORS、404、401）全在句子里，
                // 截太短就等于把答案扔了。手机上 toast 也可能被浮层挡住，
                // 所以输入框下方的提示必须给全。
                const msg = String(err?.message ?? err);
                modelHint.className = 'ct-hint ct-model-hint ct-model-hint-fail';
                modelHint.textContent = `✗ ${msg}`;
                modelHint.title = msg;
                if (!quiet) {
                    toastr.error(
                        `拉取模型失败：${msg}<br><br>`
                        + '如果只是拉列表不行、模型名你本来就打得出，'
                        + '可以直接手打，不影响正常打标签。',
                        'CardTagger',
                        { timeOut: 15000, escapeHtml: false },
                    );
                }
                return 0;
            } finally {
                fetchBtn.disabled = false;
                fetchBtn.value = '拉取模型';
                inflightModels = null;
            }
        })();

        return inflightModels;
    };

    fetchBtn.addEventListener('click', () => pullModels());

    // URL / Key 改完之后自动拉一次。挂 change（失焦）而不是 input，
    // 否则每敲一个字母就打一次接口。
    let autoPullKey = '';
    const maybeAutoPull = () => {
        if (s.ai_source !== 'custom') return;
        const key = `${s.api_url ?? ''}|${s.api_key ?? ''}|${s.extra_headers ?? ''}`;
        if (!key.replace(/\|/g, '').trim() || key === autoPullKey) return;
        autoPullKey = key;
        pullModels({ quiet: true });
    };
    $('#ct_api_url').addEventListener('change', maybeAutoPull);
    $('#ct_api_key').addEventListener('change', maybeAutoPull);

    const bindNumber = (id, key) => {
        const el = $(`#${id}`);
        el.value = s[key];
        el.addEventListener('input', () => { s[key] = Number(el.value); saveSettings(); });
    };
    bindNumber('ct_temperature', 'temperature');
    bindNumber('ct_max_tokens', 'max_tokens');
    bindNumber('ct_max_tags', 'max_tags');
    bindNumber('ct_max_new_tags', 'max_new_tags');
    bindNumber('ct_concurrency', 'concurrency');
    bindNumber('ct_retry_times', 'retry_times');

    // ---- 测试连接 ----
    $('#ct_test_connection').addEventListener('click', async () => {
        const resultEl = $('#ct_test_result');
        resultEl.className = 'ct-test-result';
        resultEl.textContent = '连接中…';

        try {
            const startedAt = Date.now();
            const sample = buildPrompts('NAME:\n测试角色\n\nDESCRIPTION:\n一段用于连通性测试的占位文本。');
            await requestCardTags({
                systemPrompt: sample.system,
                userPrompt: sample.user,
                settings: getSettings(),
                context,
                retryTimes: 0,
            });
            resultEl.className = 'ct-test-result ct-test-ok';
            resultEl.textContent = `✓ 通了，耗时 ${Date.now() - startedAt}ms`;

            // 连接通了就把模型列表也拉回来，省得用户再点一次
            if (s.ai_source === 'custom') pullModels({ quiet: true });
        } catch (err) {
            resultEl.className = 'ct-test-result ct-test-fail';
            resultEl.textContent = `✗ ${String(err?.message ?? err).slice(0, 120)}`;
        }
    });

    // ---- 标签池 ----
    const poolArea = $('#ct_tag_pool');
    setPoolTextarea(poolArea, s.tag_pool);

    const commitPool = (names) => {
        s.tag_pool = [...new Set(names.map(x => String(x).trim()).filter(Boolean))];
        saveSettings();
        setPoolTextarea(poolArea, s.tag_pool);
        updatePoolMeta();
    };

    const updatePoolMeta = () => {
        $('#ct_pool_meta').textContent = `当前 ${s.tag_pool.length} 个标签`;
    };

    poolArea.addEventListener('change', () => {
        commitPool(poolArea.value.split('\n'));
    });

    $('#ct_import_st_tags').addEventListener('click', () => {
        const names = (context.tags ?? []).map(t => t?.name).filter(Boolean);
        commitPool([...s.tag_pool, ...names]);
        toastr.success(`已并入 ${names.length} 个 ST 本地标签`, 'CardTagger');
    });

    $('#ct_collect_card_tags').addEventListener('click', () => {
        const chars = context.characters ?? [];
        const names = chars.flatMap(c => getExistingTags(c));
        commitPool([...s.tag_pool, ...names]);
        toastr.success(`已从 ${chars.length} 张卡汇总 ${names.length} 个标签`, 'CardTagger');
    });

    $('#ct_add_nsfw').addEventListener('click', () => {
        commitPool([...s.tag_pool, ...OPTIONAL_NSFW_TAG_POOL]);
        toastr.info('已追加成人向分类词', 'CardTagger');
    });

    $('#ct_reset_pool').addEventListener('click', async () => {
        const confirm = await context.callGenericPopup(
            '这会丢弃你自定义的所有词条，换成内置默认词表。继续？',
            context.POPUP_TYPE.CONFIRM,
        );
        if (confirm !== context.POPUP_RESULT.AFFIRMATIVE) return;
        commitPool(DEFAULT_TAG_POOL);
    });

    updatePoolMeta();

    // ---- 开关类 ----
    const bindCheck = (id, key) => {
        const el = $(`#${id}`);
        el.checked = Boolean(s[key]);
        el.addEventListener('change', () => { s[key] = el.checked; saveSettings(); });
    };
    bindCheck('ct_allow_new_tags', 'allow_new_tags');
    bindCheck('ct_skip_tagged', 'skip_tagged');
    bindCheck('ct_write_local', 'write_to_local_tags');
    bindCheck('ct_write_card', 'write_to_card_tags');
    bindCheck('ct_overwrite_card', 'overwrite_card_tags');

    const extraInstr = $('#ct_extra_instruction');
    extraInstr.value = s.extra_instruction ?? '';
    extraInstr.addEventListener('input', () => {
        s.extra_instruction = extraInstr.value;
        saveSettings();
    });

    // ---- 抽取字段 ----
    buildFieldList($('#ct_field_list'));

    // ---- 折叠面板 ----
    host.querySelectorAll('.ct-collapsible-toggle').forEach(toggle => {
        toggle.addEventListener('click', () => {
            const content = toggle.parentElement.querySelector('.ct-collapsible-content');
            content.classList.toggle('open');
            toggle.classList.toggle('expanded');
        });
    });

    // ---- 抽屉初始状态 ----
    // 展开/收起本身交给 ST 原生的 jQuery 委托 + slideToggle 处理，别自己绑 click
    // （早先自己写的那份会和 slideToggle 在内联 style.display 上抢，症状是
    //  「点一下能打开、再点收不回去」）。这里只决定初始摊开哪几组：
    // 宽屏全展开，一眼看全配置；窄屏只展开第一组，否则四组全摊开会把
    // 主视图的结果列表挤到屏幕外头去。
    const isNarrow = window.matchMedia('(max-width: 720px)').matches;
    host.querySelectorAll('.inline-drawer').forEach((drawer, i) => {
        const content = drawer.querySelector('.inline-drawer-content');
        const icon = drawer.querySelector('.inline-drawer-icon');
        const open = isNarrow ? i === 0 : true;

        if (content) content.style.display = open ? 'block' : 'none';
        if (icon) {
            icon.classList.toggle('up', open);
            icon.classList.toggle('down', !open);
            icon.classList.toggle('fa-circle-chevron-up', open);
            icon.classList.toggle('fa-circle-chevron-down', !open);
        }
    });
}

// ============================================================================
// 斜杠命令
// ============================================================================

function registerCommands() {
    try {
        context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
            name: 'tag-cards',
            callback: () => {
                openPanel();
                return '';
            },
            aliases: ['tagcards', '打标签'],
            returns: '打开角色卡批量打标签面板',
            helpString: `
                <div>打开 CardTagger 的批量打标签面板。</div>
                <div><strong>用法：</strong><code>/tag-cards</code></div>
            `,
        }));
    } catch (err) {
        console.warn('[CardTagger] 斜杠命令注册失败', err);
    }
}

// ============================================================================
// 启动
// ============================================================================

(async function init() {
    ensureDefaults();

    try {
        await buildSettingsPanel();
    } catch (err) {
        console.error('[CardTagger] 设置面板初始化失败', err);
        toastr.error('CardTagger 设置面板加载失败，详情见控制台', 'CardTagger');
    }

    registerCommands();

    // 角色数据变更时，面板里缓存的行会失效，简单起见提示用户重跑
    context.eventSource.on(context.eventTypes.CHARACTER_DELETED, () => {
        if (state.panelRoot && !state.panelRoot.hidden) state.jobs = [];
    });

    console.log('[CardTagger] 已加载');
})();

export { openPanel };
