import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** 游戏清单查询：全局共享一份，游戏 id 与展示名只认服务端。 */
export function useGames() {
  return useQuery({ queryKey: ['games'], queryFn: api.games, staleTime: Number.POSITIVE_INFINITY });
}

/** 返回 gameId → 展示名 的查找函数；清单未加载时回退 gameId */
export function useGameName(): (gameId: string) => string {
  const { data } = useGames();
  const map = new Map((data?.items ?? []).map((g) => [g.id, g.name]));
  return (gameId: string) => map.get(gameId) ?? gameId;
}

/**
 * URL query 参数的防抖写入。
 *
 * 返回值用于输入框的即时显示；值变化后延迟 `delay` 毫秒才写回 URL，
 * 输入法拼音阶段和逐字符输入都不会触发请求。
 * 参数被外部改变（回退、分享链接、重置）时同步回输入框。
 */
export function useDebouncedQueryParam(key: string, delay = 350): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const current = params.get(key) ?? '';
  const [draft, setDraft] = useState(current);

  useEffect(() => setDraft(current), [current]);

  useEffect(() => {
    if (draft === current) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (draft) next.set(key, draft);
      else next.delete(key);
      next.delete('page');
      setParams(next, { replace: true });
    }, delay);
    return () => clearTimeout(timer);
    // params/setParams 每次渲染都是新引用，不能作为依赖，否则会重置计时器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, current, key, delay]);

  return [draft, setDraft];
}
