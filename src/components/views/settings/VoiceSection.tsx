/* 设置 › 她的话（取代旧的「称呼与距离」卡，施工图 §4.5）.
   称呼（输入框 aria-label 含「称呼」，IME 探针依赖）→ 话量三张试听卡（同一个场合三种说法，用 say2 固定种子渲染，
   替代样稿 C 的「三种说法」脚手架）→ 角色口吻 → 她主动说话 → 让她自己想话题 → 每天第一次问候 → 小状态 → 贴纸 → 她退半步
   → 剧情框 → 记得小事（含清单）→ 回复显示方式 → 离开多久算「归来」.
   话量（level）与角色口吻（persona）是两个开关（D6）：话量管她说多少，口吻管她是不是「她」；放行、排序、证据永远由确定性的代码决定. */
import { Heart } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { lineInputKeys } from '../../../lib/ime';
import type { Level, Settings } from '../../../lib/types';
import { DEFAULT_CALL, voiceSeed, useSay2 } from '../../../lib/voice';
import { actions } from '../../../state/actions';
import { personaOn } from '../../../state/selectors';
import { useApp } from '../../../state/store';
import { Panel, Segmented, Slider, cx } from '../../ui';
import { Words } from '../../shell/Words';
import { MemoryList } from './MemoryList';
import { SettingRow } from './SettingRow';
import { WSwitch } from './WSwitch';

function CallNameField() {
  const stored = useApp((s) => s.settings.callName);
  const [name, setName] = useState(stored);
  useEffect(() => { setName(stored); }, [stored]);
  const commit = () => {
    const v = Array.from(name.trim()).slice(0, 20).join('') || DEFAULT_CALL;
    setName(v);
    if (v !== stored) actions.setSetting('callName', v);
  };
  // 组合期间（拼音候选未上屏）回车是选字、Esc 是取消组合，都不属于这个框（IME-3、IME-4）.
  const onKeyDown = lineInputKeys<KeyboardEvent<HTMLInputElement>>({ onEnter: commit, onEscape: () => setName(stored) });
  return (
    <input className="input settings-callname" value={name} aria-label="称呼" aria-describedby="settings-callname-hint" placeholder={DEFAULT_CALL}
      onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
  );
}

const LEVELS: Array<{ value: Level; name: string; sub: string }> = [
  { value: 's', name: '少', sub: '短，但仍是她：一两句话，不闲聊。工作时只在开始、待批、完成或失败、被打断时说一句。' },
  { value: 'm', name: '中', sub: '会接话（默认）：多一句理解，阶段切换时说一声，有事件才主动开口。' },
  { value: 'l', name: '多', sub: '站近一些，愿意讲小事：偶尔多说一句，可以主动搭话，也会在等待时关照一声。' },
];

/** 试听用的两个场合：你回来、没有事在等时（return.quiet）与你说谢谢时（chat.thanks）. 小标写的就是这两个场合，三张卡对同样两个场合各说一遍；固定种子，不随时间变. */
const SAMPLES: Array<{ label: string; scene: string; mode: 'work' | 'chat' }> = [
  { label: '你回来、没有事在等时', scene: 'return.quiet', mode: 'work' },
  { label: '你说谢谢时', scene: 'chat.thanks', mode: 'chat' },
];

const PROACTIVE: Array<{ value: Settings['proactive']; label: string }> = [{ value: 'auto', label: '自动' }, { value: 'on', label: '开' }, { value: 'off', label: '关' }];
const STORY: Array<{ value: Settings['storyBox']; label: string }> = [{ value: 'off', label: '关' }, { value: 'chat', label: '闲聊' }, { value: 'all', label: '全部' }];

function proactiveDesc(level: Level, p: Settings['proactive']): string {
  if (level === 's') return '话量为「少」时，她只在该休息时提醒一声，不主动闲聊。';
  if (p === 'off') return '她不主动开口；该休息时也只出一行字，不用她的口吻。';
  if (p === 'on') return '话量为「中」或「多」时，有事件才开口；每天最多 3 次，你静默 8 分钟之后才会。';
  return '自动：话量为「多」时才开口；「中」只在事件之后说话。每天最多 3 次，你静默 8 分钟之后才会。';
}

export function VoiceSection() {
  const st = useApp((s) => s.settings);
  const persona = useApp((s) => personaOn(s));
  const say2 = useSay2();
  const level = st.level ?? 'm';
  const call = st.callName;
  const sample = (l: Level, scene: string, mode: 'work' | 'chat') =>
    say2(scene, {}, { level: l, persona: true, mode, callName: call, seed: voiceSeed(new Date(2026, 9, 24), '设置', 0) }).text;

  return (
    <Panel label="她" title="她的话" icon={Heart} energy>
      <div className="settings-list">
        <SettingRow title="她怎么称呼你" desc={<span id="settings-callname-hint"><Words text={`默认「${DEFAULT_CALL}」。只出现在她的话里，不会写进按钮和菜单。最多 20 个字。`} /></span>}>
          <CallNameField />
        </SettingRow>

        <div className="settings-item settings-item--level">
          <p className="settings-row__title" id="settings-level-title">她的话量</p>
          <p className="settings-row__desc words-scope"><Words text="只管她说多少，不影响任何功能；计划、工具调用、代码和审批永远照原样写清楚。下面三张卡对同样两个场合各说一遍，一档一种说法。" /></p>
          <div className="distance-cards" role="radiogroup" aria-labelledby="settings-level-title">
            {LEVELS.map((d) => {
              const on = level === d.value;
              return (
                <label key={d.value} className={cx('distance-card', on && 'is-on')}>
                  <input type="radio" name="level" value={d.value} checked={on} onChange={() => actions.setLevel(d.value)} />
                  <span className="distance-card__name">{d.name}{on && <b className="distance-card__now">当前</b>}</span>
                  <span className="distance-card__sub words-scope"><Words text={d.sub} /></span>
                  {SAMPLES.map((x) => (
                    <span key={x.scene} className="distance-card__sample words-scope" aria-label={`示例：${x.label}`}>
                      <small>{x.label}</small><Words text={`「${sample(d.value, x.scene, x.mode)}」`} />
                    </span>
                  ))}
                </label>
              );
            })}
          </div>
        </div>

        <div className="settings-item">
          <WSwitch label="角色口吻" description="开着：她用自己的口吻说话，有头像、表情和聊天贴纸。关掉：只说事实，牌名改叫「编排 Agent」，所有功能照常。"
            checked={persona} onChange={(v) => actions.setPersona(v)} />
        </div>

        <SettingRow title="她主动说话" desc={proactiveDesc(level, st.proactive ?? 'auto')}>
          <Segmented<Settings['proactive']> size="sm" label="她主动说话" value={st.proactive ?? 'auto'} onChange={(v) => actions.setProactive(v)} options={PROACTIVE} />
        </SettingRow>
        <div className="settings-item">
          <WSwitch label="让她自己想话题" description="打开后，她主动开口时会请模型想一句，要用少量额度。默认关：话题来自内置的句子，不调用模型。"
            checked={!!st.proactiveTopics} disabled={!persona || (st.proactive ?? 'auto') === 'off'} onChange={(v) => actions.setSetting('proactiveTopics', v)} />
        </div>
        <div className="settings-item">
          <WSwitch label="每天第一次问候" description="每天第一次打开闲聊时，按早、午、晚说一句。句子来自内置模板，不调用模型。"
            checked={st.lifeGreeting} disabled={!persona} onChange={(v) => actions.setSetting('lifeGreeting', v)} />
        </div>
        <div className="settings-item">
          <WSwitch label="小状态" description="空闲时名字旁显示她在做什么（在读书、在看花……）。只是一个词，不是说话。" checked={st.lifeMood} disabled={!persona}
            onChange={(v) => actions.setSetting('lifeMood', v)} />
        </div>
        <div className="settings-item">
          <WSwitch label="聊天贴纸" description="她偶尔会回一张官方贴纸，只在道谢、被夸或做完时，整张送出，不会套进气泡。每次对话有上限。"
            checked={!!st.stickers} disabled={!persona} onChange={(v) => actions.setSetting('stickers', v)} />
        </div>
        <div className="settings-item">
          <WSwitch label="她退半步" description="审批、报错、提问、你正在用输入法打字，或你请她安静时，头像和表情淡出，只留最短的一句。卡片里本来就没有头像和贴纸。"
            checked={st.stepBack !== false} disabled={!persona} onChange={(v) => actions.setSetting('stepBack', v)} />
        </div>
        <SettingRow title="剧情框" desc="把她最新的一句放大成游戏对话框的样子。「闲聊」只在闲聊里用，「全部」连工作里的计划引言和总结也用，「关」就仍是气泡。默认「闲聊」。角色口吻关着、她退半步、报错或审批提问时不用剧情框。">
          <Segmented<Settings['storyBox']> size="sm" label="剧情框" value={st.storyBox ?? 'chat'} onChange={(v) => actions.setSetting('storyBox', v)} options={STORY} />
        </SettingRow>

        <div className="settings-item">
          <WSwitch label="记得小事" description="邀请制：只记你让她记的，默认只在那场对话里。关着时不存、不读、不交给模型。"
            checked={!!st.memoryOn} onChange={(v) => actions.setSetting('memoryOn', v)} />
          <MemoryList on={!!st.memoryOn} />
        </div>

        <SettingRow title="回复显示方式" desc="边写边显示：回复一点点出现；写完再显示：先显示「正在写」，整段写完后一次出现。">
          <Segmented<'natural' | 'instant'> size="sm" label="回复显示方式" value={st.typing} onChange={(v) => actions.setSetting('typing', v)}
            options={[{ value: 'natural', label: '边写边显示' }, { value: 'instant', label: '写完再显示' }]} />
        </SettingRow>
        <div className="settings-item">
          <Slider label="离开多久算「归来」" value={st.returnAfterMin} min={5} max={120} step={5} format={(v) => `${v} 分钟`}
            onChange={(v) => actions.setSetting('returnAfterMin', v)}
            description="键盘和鼠标这么久没有动，再回来时，首页会写一封归来简。简报只来自运行记录，不调用模型。" ends={['5 分钟', '2 小时']} />
        </div>
      </div>
    </Panel>
  );
}
