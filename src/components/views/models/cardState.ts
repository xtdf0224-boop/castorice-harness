/* 一家服务现在是什么状态（卡片头部与「已接入」紧凑行共用一份）：用哪种方式、能不能用、最近一次测试的结论。纯函数，没有 React. */
import { readiness, type ProviderInfo } from '../../../lib/providers';
import type { AuthMode, ProviderConfig } from '../../../lib/types';

export type CardState = 'off' | 'ok' | 'error' | 'ready';

export interface CardStatus {
  auth: AuthMode;
  ready: { ready: boolean; reason?: string };
  tested: ProviderConfig['test'] | undefined;
  testing: boolean;
  state: CardState;
  stateText: string;
  stateTone: 'success' | 'danger' | 'info' | 'neutral';
}

export function cardStatus(info: ProviderInfo, cfg: ProviderConfig): CardStatus {
  // a service with no command-line tool is always the API way; a plan channel is never
  const auth: AuthMode = !info.drivers.length ? 'api' : cfg.auth;
  const ready = readiness(info, cfg, auth);
  const tested = cfg.test && cfg.test.auth === auth && (auth === 'api' || cfg.test.driver === cfg.driver) ? cfg.test : undefined;
  const testing = !!tested && !tested.ok && tested.message === '测试中…';
  const state: CardState = !ready.ready ? 'off' : tested?.ok ? 'ok' : tested && !testing ? 'error' : 'ready';
  const stateText = state === 'ok' ? '已连通' : state === 'error' ? '测试失败' : state === 'ready' ? '已配置' : '未接入';
  const stateTone = state === 'ok' ? 'success' : state === 'error' ? 'danger' : state === 'ready' ? 'info' : 'neutral';
  return { auth, ready, tested, testing, state, stateText, stateTone };
}
