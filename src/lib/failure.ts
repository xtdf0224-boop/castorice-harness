/* 失败说明（施工图 §4.4 / §4.6a）：错误码 → 去哪里处理的一句话，以及失败时她那一句取哪个场景.
   原先 failureHint 是 live.ts 私有；下沉到这里，未竟之信（C1 的 LetterCard）也用它. 纯函数，不读 store. */
import type { Run } from './types';

/** 常见错误码后面补一句去哪里处理. 参数可以是错误码，也可以是一个运行（取它最后一个致命错误的码）. */
export function failureHint(arg?: string | Pick<Run, 'errors'>): string {
  const code = typeof arg === 'string' || arg === undefined ? arg : [...(arg.errors ?? [])].reverse().find((e) => e.fatal)?.code;
  if (code === 'AUTH') return '到「模型接入」检查密钥是否有效，或 claude 是否已登录（栖枝不会替你登录）。';
  if (code === 'PLAN_KEY') return '套餐 Key 只能给命令行编码工具用：到「模型接入」改用命令行方式。';
  if (code === 'QUOTA') return '余额不足或额度用完（或请求太频繁），到服务商的控制台看看。';
  if (code === 'BUDGET') return '这是 API 密钥路径的预算上限，可以在「模型接入」里调整预算，或改用已登录的 claude。';
  if (code === 'RATE_LIMIT') return '订阅额度或接口限流，过一会儿再试，或看右下的额度提示。';
  if (code === 'ENOENT') return '到「模型接入」检查 claude 的路径。';
  // 权限被拒（EACCES / EPERM）与被占用（EBUSY）是两回事，别混着说：前者去查权限，后者关掉占用它的程序.
  if (code === 'EACCES' || code === 'EPERM') return '检查这个文件或目录的权限（也可能被安全软件拦下），改好后从失败处重试。';
  if (code === 'EBUSY') return '关掉正占用它的程序，再从失败处重试。';
  return '';
}

export type FailScene = 'fail.ext' | 'fail.perm' | 'fail.rep' | 'fail.w';

/** 外部原因：账号 / 额度 / 限流 / 余额 / 预算，以及网络（连不上、超时、断线）. */
const EXTERNAL = new Set(['AUTH', 'AUTH_SCOPE', 'PLAN_KEY', 'RATE_LIMIT', 'QUOTA', 'BILLING', 'OVERLOADED', 'BUDGET', 'NETWORK', 'ENETWORK', 'ENETDOWN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'TIMEOUT', 'EIDLE', 'NET']);
/** 权限被拒：只读运行里被自动拒绝、目录没信任、系统不让写. */
const PERMISSION = new Set(['READONLY', 'PERMISSION', 'PERM_DENIED', 'DENIED', 'EACCES', 'EPERM']);
const PERMISSION_TEXT = /permission denied|operation not permitted|权限被拒|权限不足|没有权限|已自动拒绝/i;

/**
 * 失败时她那一句取哪个场景（§4.6a）：AUTH / RATE_LIMIT / QUOTA / 网络 → fail.ext；权限被拒 → fail.perm；
 * 同一步第 2 次失败 → fail.rep；其余 fail.w. 顺序就是这个：外部原因最先（重试也解决不了），其次权限，再次重复失败.
 */
export function failureScene(code: string | undefined, message: string, repeated: boolean): FailScene {
  const c = (code ?? '').toUpperCase();
  if (EXTERNAL.has(c) || /^E?NET/.test(c)) return 'fail.ext';
  if (PERMISSION.has(c) || PERMISSION_TEXT.test(message)) return 'fail.perm';
  if (repeated) return 'fail.rep';
  return 'fail.w';
}

/** 失败原因的一小段（填 fail.* 的 {reason} 槽位）：取报错的第一行，去掉首尾空白，最多 60 字. */
export function failureReason(message: string): string {
  const first = message.split('\n').find((l) => l.trim()) ?? message;
  const t = first.trim().replace(/\s+/g, ' ');
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}
