import { XMLParser } from 'fast-xml-parser';
import type { Game, Item, SourceAdapter } from '../types.js';

/**
 * RSSHub · B站官号动态适配器。
 * 输入：自建 RSSHub 的 B站用户动态 RSS（需配置个人 B站 Cookie）；
 * 输出：标准条目（v1 类型固定 NEWS）。
 */

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

/** 解码保留为字面量的常见 XML 实体（processEntities 关闭后需要） */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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
}

/** 从动态链接末尾提取动态原始 id，如 .../1254523012641718292 */
function extractSourceId(link: string): string {
  const m = link.match(/(\d+)(?:[/?#].*)?$/);
  return m ? m[1] : link;
}

/** 把单条原始 item 归一化为标准条目 */
function normalize(raw: RawItem, game: Game): Item {
  const sourceId = extractSourceId(raw.link);
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
  };
}

export const rsshubBilibiliAdapter: SourceAdapter = {
  source: SOURCE,

  async fetch(game: Game): Promise<Item[]> {
    const url = `${RSSHUB_BASE}/bilibili/user/dynamic/${game.bilibiliUid}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`拉取 ${game.name} 动态失败：HTTP ${res.status}`);
    }
    const xml = await res.text();
    const data = parser.parse(xml) as RawRss;
    const items = data.rss.channel.item;
    if (!items) return [];
    const list = Array.isArray(items) ? items : [items];
    return list.map((raw) => normalize(raw, game));
  },
};
