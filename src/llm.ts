import { envNum, envStr } from './env.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('llm');

/**
 * LLM 客户端：OpenAI 兼容协议（POST {LLM_BASE_URL}/chat/completions）。
 * 兼容 DeepSeek / GLM / Kimi / OpenAI 官方及本地 Ollama（http://localhost:11434/v1）等，
 * 仅换 .env 配置，不改代码。
 *
 * 约定：要求模型输出 JSON（response_format=json_object + prompt 双保险），
 * 调用方自行做结构校验——不同厂商对 response_format 的支持度不一，不能只依赖参数。
 */

const BASE_URL = envStr('LLM_BASE_URL');
const API_KEY = envStr('LLM_API_KEY');
const MODEL = envStr('LLM_MODEL');
const TIMEOUT_MS = envNum('LLM_TIMEOUT_MS', 120_000);

/** LLM 是否已配置可用（BASE_URL + MODEL 都需要） */
export function llmEnabled(): boolean {
  return BASE_URL !== '' && MODEL !== '';
}

/** 返回脱敏的当前配置描述（日志用）；未配置时返回提示文案 */
export function llmConfig(): string {
  if (!llmEnabled()) return '(未配置)';
  return `${MODEL} @ ${BASE_URL}${API_KEY ? '' : '（无 key，仅支持本地无需鉴权的服务）'}`;
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
  if (!llmEnabled()) throw new Error('LLM 未配置（LLM_BASE_URL / LLM_MODEL）');

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Ollama 等本地服务不校验 key，占位值避免缺 header 报错
        Authorization: `Bearer ${API_KEY || 'none'}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        temperature: opts.temperature ?? 0,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM 返回缺少 content');

    log.debug(
      'chat 完成 tokens=%s costMs=%d',
      data.usage ? `${data.usage.prompt_tokens}+${data.usage.completion_tokens}` : 'unknown',
      Date.now() - t0,
    );
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}
