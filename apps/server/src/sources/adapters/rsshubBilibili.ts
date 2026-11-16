import { XMLParser } from 'fast-xml-parser';
import type { Game, Item, SourceAdapter } from '../../core/types.js';
import { normalizeImageUrl } from '../../core/imageUrl.js';
import { moduleLogger } from '../../core/logger.js';

const log = moduleLogger('adapter.rsshub-bilibili');

/**
 * RSSHub · B站官号动态适配器。
 * 输入：自建 RSSHub 的 B站用户动态 RSS（需配置个人 B站 Cookie）；
 * 输出：标准条目（v1 类型固定 NEWS）。
 */

/** 单次 RSS 请求超时（毫秒）：挂起的请求会被强制终结并暴露为错误，避免拖住整个流水线 */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * 源拉取错误：kind 供事件表分类（http=上游 HTTP 错误 / network=网络不可达或超时 / parse=响应非有效 RSS）。
 * detail 携带上游原始错误文本（如 RSSHub 错误页的 Error Message，cookie 失效等详情在此），message 保持一行摘要。
 */
export class SourceFetchError extends Error {
  constructor(
    public readonly kind: 'http' | 'network' | 'parse',
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'SourceFetchError';
  }
}

/** RSSHub 基础地址。默认本机自建实例，可用环境变量覆盖。 */
const RSSHUB_BASE = process.env.RSSHUB_BASE ?? 'http://localhost:1200';

const SOURCE = 'rsshub-bilibili';

/** RSS XML 解析器：忽略属性、扁平结构即可满足字段提取；
 * 关闭内建实体展开以避开其默认实体数量上限，文本里的常见 XML 实体另行解码 */
const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  processEntities: false,
});

/** 解码保留为字面量的常见 XML 实体（processEntities 关闭后需要）；
 * &amp; 必须最后处理，避免 "&amp;lt;" 之类被双重解码 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 从动态 HTML 提取全部图片 URL（按出现顺序；经 normalizeImageUrl 规范化，保证 OCR 幂等键稳定） */
function extractImageUrls(html: string): string[] {
  const urls: string[] = [];
  const re = /<img[^>]*\ssrc="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) urls.push(normalizeImageUrl(m[1]));
  return urls;
}

/** 动态 HTML → 纯文本：<br> 转换行，去除其余标签（保留链接文字），压缩多余空行 */
function extractPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 解析后的最小 RSS 结构（仅声明消费的字段） */
interface RawRss {
  rss: {
    channel: {
      title: string;
      item?: RawItem | RawItem[];
    };
  };
}
interface RawItem {
  title: string;
  link: string;
  pubDate: string;
  author?: string;
  /** 动态正文 HTML（&lt;br&gt;/&lt;img&gt;/&lt;a&gt; 混排），XML 解析后为实体字面量 */
  description?: string;
}

/** 从动态链接末尾提取动态原始 id，如 .../1254523012641718292 */
function extractSourceId(link: string): string {
  const m = link.match(/(\d+)(?:[/?#].*)?$/);
  return m ? m[1] : link;
}

/** 从 RSSHub HTML 错误页提取 "Error Message:" 后的原始错误文本（去内嵌标签、解码实体、截断） */
function extractRsshubErrorDetail(html: string): string | undefined {
  const m = html.match(/Error Message:<br\/?><code[^>]*>([\s\S]*?)<\/code>/);
  if (!m) return undefined;
  const text = decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim();
  return text ? text.slice(0, 500) : undefined;
}

/** 把单条原始 item 归一化为标准条目 */
function normalize(raw: RawItem, game: Game): Item {
  const sourceId = extractSourceId(raw.link);
  // 正文 HTML 先解码实体为真实 HTML，再分别提取图片与纯文本
  const html = raw.description ? decodeEntities(raw.description) : '';
  const images = extractImageUrls(html);
  return {
    id: `${game.id}:NEWS:${sourceId}`,
    sourceId,
    source: SOURCE,
    gameId: game.id,
    type: 'NEWS',
    title: decodeEntities(raw.title),
    url: raw.link,
    publishedAt: Math.floor(Date.parse(raw.pubDate) / 1000),
    author: raw.author,
    description: html ? extractPlainText(html) : undefined,
    images: images.length > 0 ? images : undefined,
  };
}

export const rsshubBilibiliAdapter: SourceAdapter = {
  source: SOURCE,

  async fetch(game: Game): Promise<Item[]> {
    const url = `${RSSHUB_BASE}/bilibili/user/dynamic/${game.bilibiliUid}`;
    log.debug('请求开始 url=%s timeoutMs=%d', url, FETCH_TIMEOUT_MS);
    let xml: string;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        // 错误页体积有限但仍截断读取，提取其中的原始错误文本（cookie 失效等详情在此）
        const body = (await res.text()).slice(0, 65_536);
        const detail = extractRsshubErrorDetail(body);
        throw new SourceFetchError('http', `拉取 ${game.name} 动态失败：HTTP ${res.status}`, detail);
      }
      xml = await res.text();
    } catch (e) {
      if (e instanceof SourceFetchError) throw e;
      // AbortSignal.timeout 超时与连接失败统一归类网络异常
      throw new SourceFetchError('network', `拉取 ${game.name} 动态失败：网络异常（${(e as Error).message}）`);
    }
    log.debug('请求完成 url=%s bytes=%d', url, xml.length);
    let data: RawRss;
    try {
      data = parser.parse(xml) as RawRss;
    } catch (e) {
      throw new SourceFetchError('parse', `拉取 ${game.name} 动态失败：RSS 解析异常（${(e as Error).message}）`);
    }
    if (!data?.rss?.channel) {
      // HTTP 200 但不是 RSS（如 RSSHub 中间层异常页），归入解析失败
      throw new SourceFetchError('parse', `拉取 ${game.name} 动态失败：响应不是有效 RSS（无 channel）`);
    }
    const items = data.rss.channel.item;
    if (!items) return [];
    const list = Array.isArray(items) ? items : [items];
    return list.map((raw) => normalize(raw, game));
  },
};
