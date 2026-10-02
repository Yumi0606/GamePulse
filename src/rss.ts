import type { Game, Item } from './types.js';

/**
 * RSS 2.0 生成：把一个游戏的条目生成为单个订阅源。
 * 输出即 v1 的 5 个游戏 RSS 产物。
 */

/** XML 转义（文本节点与属性通用的最小集合） */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** RFC-822 格式时间，如 RSS pubDate 要求 */
function toRfc822(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toUTCString();
}

/** 生成单个游戏的 RSS 文档。条目按发布时间倒序。 */
export function buildGameRss(game: Game, items: Item[]): string {
  const sorted = [...items]
    .filter((i) => i.gameId === game.id)
    .sort((a, b) => b.publishedAt - a.publishedAt);

  const latest = sorted[0]?.publishedAt ?? Math.floor(Date.now() / 1000);

  const itemXml = sorted
    .map(
      (it) => `    <item>
      <title>${escapeXml(it.title)}</title>
      <link>${escapeXml(it.url)}</link>
      <guid isPermaLink="false">${escapeXml(it.id)}</guid>
      <pubDate>${toRfc822(it.publishedAt)}</pubDate>
      ${it.author ? `<author>${escapeXml(it.author)}</author>` : ''}
    </item>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(game.name)}</title>
    <link>https://space.bilibili.com/${game.bilibiliUid}</link>
    <description>${escapeXml(game.name)} 官号动态聚合</description>
    <language>zh-cn</language>
    <lastBuildDate>${toRfc822(latest)}</lastBuildDate>
${itemXml}
  </channel>
</rss>
`;
}
