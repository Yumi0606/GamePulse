/**
 * 图片 URL 规范化（纯函数，无 IO）。
 * 供三处共用：sources 拉取层（extractImageUrls）、storage（posts.images 键）、processing OCR（幂等键）。
 */

/**
 * 规范化图片 URL 作为幂等键：
 * 补全协议、B站图床多镜像主机（i0~i9.hdslb.com 同内容）统一为 i0，
 * 避免不同源返回不同主机号导致幂等键分裂。
 */
export function normalizeImageUrl(raw: string): string {
  const withProto = raw.startsWith('//') ? `https:${raw}` : raw;
  return withProto.replace(/^(https?):\/\/i\d(\.hdslb\.com)/i, 'https://i0$2');
}
