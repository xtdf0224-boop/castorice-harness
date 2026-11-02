/* 桌宠用哪个模型（docs/PET-PLAN.md §4）. 照栖枝的服务注册表挑：
   · 看图 / 实时：已接入的、API 方式的、caps.vision 为真的模型（设置里可以指定；没指定就挑最便宜最快的）；
   · 联网答疑：已登录的 Claude Code（只允许 WebSearch / WebFetch，live.petCliSpec 里把别的工具名全禁掉）；
   · 没有能看图的 API 模型时：问答退到用户的默认对话引擎（Claude 订阅等命令行方式也行），不带图，提示词里告诉模型这次没有画面；
   · 实时陪玩只用 API 方式（命令行启动要好几秒）：没有能看图的就用最快的一个 API 模型（不看画面），一个 API 模型都没有就说明原因、不开.
   纯函数：只读传进来的 ModelState，不碰 store、不碰 IPC. */
import { PROVIDER_BY_ID, engineLabel, modelInfo } from '../lib/providers';
import type { AgentEngine, ModelState, ProviderId, TaskEngine } from '../lib/types';
import { defaultChoice, engineChoices, engineFromChoice, modelOptions } from '../state/models';

/** 设置里能选的一个模型（`key` + `model` 就是存档里的 AgentEngine）. */
export interface PetModelOption { key: string; model: string; label: string }

/** 一个模型有多省：0 = 快 / 小，3 = 旗舰. 自动挑模型时按它排. */
export function petThrift(note: string | undefined, id: string): number {
  // 目录自己写的话优先：minimax-m3 是旗舰，不管 id 里有没有 mini.
  if (/旗舰/.test(note ?? '')) return 3;
  const text = `${note ?? ''} ${id}`.toLowerCase();
  // `mini` 只算单独的一个词（gpt-5-mini），不算 minimax 里的.
  if (/快速|flash|haiku|luna|lite|turbo|(^|[^a-z])mini($|[^a-z])|highspeed/.test(text)) return 0;
  if (/均衡|plus|sol/.test(text)) return 1;
  if (/编程|code/.test(text)) return 2;
  return 3;
}

/** 这个 API 模型能收图片吗：服务自己的模型列表（m.liveApi）里写了 caps.vision 就听它的，否则看目录里的预设.
    两边都没写 = 不知道 = 当作不能：宁可少发一张图，也不把画面发给一个可能收不下它的模型. */
export function modelSeesImages(m: ModelState, provider: ProviderId, model: string): boolean {
  const p = PROVIDER_BY_ID[provider];
  if (!p || !model) return false;
  const live = m.liveApi?.[provider]?.find((x) => x.id === model)?.caps?.vision;
  const preset = modelInfo(p, model)?.caps?.vision;
  return (live ?? preset) === true;
}

/** 已接入的 API 方式里，能收图片的模型（设置里「看图 / 实时用的模型」下拉就列这些）. */
export function petVisionOptions(m: ModelState): PetModelOption[] {
  const out: PetModelOption[] = [];
  for (const c of engineChoices(m)) {
    if (c.auth !== 'api') continue;
    const p = PROVIDER_BY_ID[c.provider];
    for (const x of modelOptions(m, c)) {
      if (x.id && modelSeesImages(m, c.provider, x.id) && !out.some((o) => o.key === c.key && o.model === x.id)) out.push({ key: c.key, model: x.id, label: engineLabel(p, 'api', undefined, x.id) });
    }
  }
  return out;
}

/** 已登录的 Claude Code：能联网搜索的命令行方式. 只收它：它的工具能按名字全禁掉、只留搜索和抓网页，别的命令行工具做不到这样的收窄. */
export function petWebOptions(m: ModelState): PetModelOption[] {
  const out: PetModelOption[] = [];
  for (const c of engineChoices(m)) {
    if (c.auth !== 'cli' || c.driver !== 'claude-code') continue;
    const p = PROVIDER_BY_ID[c.provider];
    for (const x of modelOptions(m, c)) if (!out.some((o) => o.key === c.key && o.model === x.id)) out.push({ key: c.key, model: x.id, label: engineLabel(p, 'cli', c.driver, x.id) });
  }
  return out;
}

/** 最省的在前；一样省的，用户选作默认的那家在前，再按目录顺序. */
function petPick(m: ModelState, options: PetModelOption[]): PetModelOption | undefined {
  const rank = (o: PetModelOption) => {
    const choice = engineChoices(m).find((c) => c.key === o.key);
    const p = choice ? PROVIDER_BY_ID[choice.provider] : undefined;
    const info = p ? modelInfo(p, o.model) : undefined;
    return petThrift(info?.note, o.model) * 10 + (choice && m.defaultEngine === choice.provider ? 0 : 1);
  };
  return options.map((o, i) => ({ o, i, r: rank(o) })).sort((a, b) => a.r - b.r || a.i - b.i)[0]?.o;
}

function engineFor(m: ModelState, o: PetModelOption, cwd?: string): TaskEngine | undefined {
  const choice = engineChoices(m).find((c) => c.key === o.key);
  return choice ? engineFromChoice(choice, { model: o.model, cwd, access: 'read' }) : undefined;
}

/** 看图的模型：设置里选的（还连着才算），否则最省的一个. 没有 = undefined（问答照样回答，只是没有画面）. */
export function petVisionEngine(m: ModelState, pref?: AgentEngine): TaskEngine | undefined {
  const options = petVisionOptions(m);
  const chosen = (pref && options.find((o) => o.key === pref.key && o.model === pref.model)) || petPick(m, options);
  return chosen ? engineFor(m, chosen) : undefined;
}

/** 联网答疑的命令行模型. `cwd` 是它跑在里面的空文件夹（desktop.workspaceFolder('pet')）. 没有已登录的 Claude Code = undefined. */
export function petWebEngine(m: ModelState, pref?: AgentEngine, cwd?: string): TaskEngine | undefined {
  const options = petWebOptions(m);
  let chosen = pref && options.find((o) => o.key === pref.key && o.model === pref.model);
  if (!chosen) {
    // 自动：已登录的 Claude Code，用「模型接入」里给它设的模型（没设就让它自己选）.
    const own = engineChoices(m).find((c) => c.auth === 'cli' && c.driver === 'claude-code');
    chosen = own ? { key: own.key, model: own.model, label: own.label } : undefined;
  }
  return chosen ? engineFor(m, chosen, cwd) : undefined;
}

/** 平常说话（不带图）用的模型：有看图的就用它（又快又便宜），否则退到用户的默认对话引擎——Claude 订阅等命令行方式也行，那时没有画面. */
export function petChatEngine(m: ModelState, o: { vision?: AgentEngine; cwd?: string }): TaskEngine | undefined {
  const vision = petVisionEngine(m, o.vision);
  if (vision) return vision;
  const choice = defaultChoice(m);
  return choice ? engineFromChoice(choice, { cwd: o.cwd, access: 'read' }) : undefined;
}

/** 实时陪玩用的模型：只用 API 方式. 能看图的优先；没有就用最快的一个 API 模型（回答照样快，只是看不到画面）；一个 API 模型都没有 = undefined. */
export function petLiveEngine(m: ModelState, vision?: AgentEngine): TaskEngine | undefined {
  const v = petVisionEngine(m, vision);
  if (v) return v;
  const api: PetModelOption[] = [];
  for (const c of engineChoices(m)) {
    if (c.auth !== 'api' || !c.model) continue;
    api.push({ key: c.key, model: c.model, label: engineLabel(PROVIDER_BY_ID[c.provider], 'api', undefined, c.model) });
  }
  const chosen = petPick(m, api);
  return chosen ? engineFor(m, chosen) : undefined;
}
