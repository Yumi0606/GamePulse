import { envNum, envStr } from '../core/env.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('llm');

/**
 * LLM 客户端：OpenAI 兼容协议（POST {LLM_BASE_URL}/chat/completions）。
 * 兼容 DeepSeek / GLM / Kimi / OpenAI 官方及本地 Ollama（http://localhost:11434/v1）等，
 * 仅换 .env 配置，不改代码。
 *
 * 约定：要求模型输出 JSON（response_format=json_object + prompt 双保险），
 * 调用方自行做结构校验——不同厂商对 response_format 的支持度不一，不能只依赖参数。
 *
 * 错误分类（供 extract 决定是否消耗重试次数）：
 * - LlmInfraError：网络/超时/鉴权/限流/服务端故障 → 临时或配置问题，不烧 attempts；
 * - 普通错误：HTTP 400（请求本身非法）、模型输出缺 content 或非法 JSON → 与该动态相关，烧 attempts。
 */

/** LLM 基础设施错误：重试不计入内容失败次数 */
export class LlmInfraError extends Error {}

/**
 * 思考模式策略：
 * - disabled：显式关闭（默认）。DeepSeek 新版模型默认开启思考，思维链按输出计费；
 * - enabled：显式开启；
 * - default：不传该字段，跟随服务商默认行为。
 */
function thinkingMode(): 'disabled' | 'enabled' | 'default' {
  const v = envStr('LLM_THINKING', 'disabled').toLowerCase();
  return v === 'enabled' || v === 'default' ? v : 'disabled';
}

/**
 * thinking 字段的探测结果：部分 OpenAI 兼容端点不识别该字段并返回 400。
 * 首次判定不支持后，本进程后续请求不再发送，避免每条动态都先失败一次再重试。
 */
let thinkingSupported: boolean | undefined;

/** 只对明确由 thinking 字段引发的 400 重试，其余 400 仍按请求本身非法处理 */
function isThinkingRejected(body: string): boolean {
  return /thinking|reasoning|unknown|unsupported|unrecognized|extra field|additional propert/i.test(body);
}

/** LLM 是否已配置可用（BASE_URL + MODEL 都需要）；惰性读取，保证 .env 加载后判断生效 */
export function llmEnabled(): boolean {
  return envStr('LLM_BASE_URL') !== '' && envStr('LLM_MODEL') !== '';
}

/** 返回脱敏的当前配置描述（日志用）；未配置时返回提示文案 */
export function llmConfig(): string {
  if (!llmEnabled()) return '(未配置)';
  const baseUrl = envStr('LLM_BASE_URL');
  const apiKey = envStr('LLM_API_KEY');
  return `${envStr('LLM_MODEL')} @ ${baseUrl}${apiKey ? '' : '（无 key，仅支持本地无需鉴权的服务）'}`;
}

export interface ChatOptions {
  /** 系统提示（任务定义 + 输出格式约定） */
  system: string;
  /** 用户消息（待解析的上下文） */
  user: string;
  /** 采样温度，默认 0（结构化提取要确定性） */
  temperature?: number;
}

/** 发起一次 chat 补全并解析为 JSON；任何异常（网络/非 2xx/JSON 解析失败）抛错由调用方处理 */
export async function chatJSON(opts: ChatOptions): Promise<unknown> {
  const baseUrl = envStr('LLM_BASE_URL');
  const apiKey = envStr('LLM_API_KEY');
  const model = envStr('LLM_MODEL');
  const timeoutMs = envNum('LLM_TIMEOUT_MS', 120_000);
  if (baseUrl === '' || model === '') throw new LlmInfraError('LLM 未配置（LLM_BASE_URL / LLM_MODEL）');

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const mode = thinkingMode();
  // 'default' 不传字段；其余只有 enabled/disabled 两种取值
  const thinkType: 'enabled' | 'disabled' = mode === 'enabled' ? 'enabled' : 'disabled';

  try {
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    // 是否携带 thinking 由策略与历史探测结果共同决定；探测失败后永久降级
    const send = (withThinking: boolean): Promise<Response> =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Ollama 等本地服务不校验 key，占位值避免缺 header 报错
          Authorization: `Bearer ${apiKey || 'none'}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
          ],
          temperature: opts.temperature ?? 0,
          response_format: { type: 'json_object' },
          ...(withThinking ? { thinking: { type: thinkType } } : {}),
        }),
        signal: controller.signal,
      });

    let withThinking = mode !== 'default' && thinkingSupported !== false;
    let res = await send(withThinking);
    // 兼容防御：端点不认识 thinking 字段时去掉该字段重试一次，并记住结果。
    // 只对明确提到 thinking/reasoning/未知字段的 400 生效，其他 400 原样抛出。
    if (res.status === 400 && withThinking) {
      const body = await res.text().catch(() => '');
      if (!isThinkingRejected(body)) throw new Error(`LLM HTTP 400: ${body.slice(0, 200)}`);
      thinkingSupported = false;
      withThinking = false;
      log.warn('LLM 端点不支持 thinking 字段，后续请求自动省略：%s', body.slice(0, 120));
      res = await send(false);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 鉴权/限流/服务端故障/请求超时均属临时或配置问题 → infra；
      // 400 通常是请求本身非法（如上下文超长），重试无意义 → 内容类
      if (res.status === 400) {
        throw new Error(`LLM HTTP 400: ${body.slice(0, 200)}`);
      }
      throw new LlmInfraError(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    if (withThinking) thinkingSupported = true;

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
      };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM 返回缺少 content');

    // 记录缓存命中情况：DeepSeek 按前缀匹配，命中与未命中单价相差 50 倍，
    // 这里必须打出命中率，否则无法判断 prompt 结构是否让缓存失效。
    const usage = data.usage;
    if (usage) {
      const hit = usage.prompt_cache_hit_tokens ?? 0;
      const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, usage.prompt_tokens - hit);
      const rate = hit + miss > 0 ? Math.round((hit / (hit + miss)) * 100) : 0;
      log.info(
        'chat 完成 model=%s input=%d(命中=%d 未命中=%d 命中率=%d%%) output=%d costMs=%d',
        model, usage.prompt_tokens, hit, miss, rate, usage.completion_tokens, Date.now() - t0,
      );
    } else {
      log.info('chat 完成 model=%s tokens=unknown costMs=%d', model, Date.now() - t0);
    }
    return JSON.parse(content);
  } catch (e) {
    // fetch 网络错误/超时（AbortError）也归为 infra
    if (e instanceof LlmInfraError || e instanceof TypeError || (e as Error).name === 'AbortError') {
      throw e instanceof LlmInfraError ? e : new LlmInfraError(`LLM 请求失败：${(e as Error).message}`);
    }
    throw e; // JSON.parse 失败等保持普通 Error（内容类）
  } finally {
    clearTimeout(timer);
  }
}
