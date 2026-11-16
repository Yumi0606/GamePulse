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
