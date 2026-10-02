/** OpenAI 兼容 mock LLM：返回固定结构化结果，用于端到端验证 extract 全链路。
 * 用法：node _research/llm_probe/mock_llm.mjs  （监听 9911） */

import { createServer } from 'node:http';

const server = createServer((req, res) => {
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = JSON.parse(body);
    console.log('[mock] 收到请求 user 片段:', payload.messages.at(-1).content.slice(0, 60).replace(/\n/g, ' '));
    // 覆盖多条解析路径：锚定时间 / 引用型时间 / SHOP 大类 / estimated 推断 / banner 与 tags
    const content = JSON.stringify({
      items: [
        {
          type: 'ACTIVITY',
          slot: 'activity',
          title: 'mock 限时活动「测试行动」',
          summary: 'mock 活动条目，含明确起止时间',
          category: 'SideStory',
          startAt: '2026-10-01T12:00',
          endAt: '2026-10-15T03:59',
          phases: [{ title: '普通关', startAt: '2026-10-01T12:00', endAt: '2026-10-15T03:59' }],
          bannerImageIndex: 1,
          tags: ['测试标签'],
          confidence: 0.92,
          evidence: 'mock 依据：动态正文',
        },
        {
          type: 'ANNOUNCEMENT',
          slot: 'announcement',
          title: 'mock 版本结束公告',
          endRef: '「雪淞幽梦」版本结束',
          confidence: 0.55,
          evidence: 'mock 依据：OCR 文本',
        },
        {
          type: 'GACHA',
          slot: 'gacha',
          title: 'mock 限定寻访',
          startAt: '2026-10-02T16:00', // 原文无年份 → estimated 路径
          estimated: true,
          confidence: 0.6,
          evidence: 'mock 依据：推断',
        },
      ],
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }));
  });
});

server.listen(9911, () => console.log('mock LLM 已启动 http://localhost:9911/v1/chat/completions'));
