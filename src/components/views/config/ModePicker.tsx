/* 主题选择：夜 · 冥河（默认）/ 昼 · 花海。两张单选卡，各带一幅自己的缩略；方向键移动并选中，像原生单选。 */
import { CheckCircle2, Circle } from 'lucide-react';
import { useId, useRef, type KeyboardEvent } from 'react';
import type { ThemeId } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { useApp } from '../../../state/store';
import { Butterfly } from '../../decor/marks';

const MODES: Array<{ id: ThemeId; name: string; desc: string }> = [
  { id: 'night', name: '夜 · 冥河', desc: '紫黑打底，银白与藕紫；蓝只给蝶与运行中，金只给待你。默认。' },
  { id: 'day', name: '昼 · 花海', desc: '薰衣草底、奶油纸面、深紫强调；首页右半是她的拱窗。' },
];

/** 缩略：壁纸 + 左栏 + 一张卡 + 一只蝶。昼的右半是她的拱窗（官方立绘），和夜缩略里的她对等。装饰，卡片文字已经说出名字。 */
function ModePreview({ id }: { id: ThemeId }) {
  const base = import.meta.env.BASE_URL;
  // 自定义属性里的 url() 是在样式表（dist/assets/*.css）里才解析的，相对路径会指到 dist/assets/ 下面：先按页面地址换成绝对地址.
  const bg = new URL(`${base}wallpapers/${id}-1600.webp`, document.baseURI).href;
  return (
    <span className="settings-pv" aria-hidden="true" style={{ ['--pv-bg' as string]: `url("${bg}")` }}>
      <span className="settings-pv__rail" />
      <span className="settings-pv__card" />
      <span className="settings-pv__bar" />
      {id === 'day' && (
        <span className="settings-pv__arch">
          <img src={`${base}art/figure-official.webp`} alt="" draggable={false} decoding="async" />
        </span>
      )}
      <Butterfly size={16} variant="solid" />
    </span>
  );
}

export function ModePicker() {
  const mode = useApp((s) => s.settings.mode);
  const base = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (i: number, focus = false) => {
    actions.setSetting('mode', MODES[i].id);
    if (focus) refs.current[i]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = MODES.findIndex((m) => m.id === mode);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % MODES.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + MODES.length) % MODES.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = MODES.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(next, true);
  };

  return (
    <div className="settings-item">
      <p className="settings-row__title" id={`${base}-title`}>主题</p>
      <p className="settings-row__desc">切换只改变外观，不改变布局和功能。</p>
      <div className="settings-modes" role="radiogroup" aria-labelledby={`${base}-title`} onKeyDown={onKeyDown}>
        {MODES.map((m, i) => {
          const checked = m.id === mode;
          return (
            <button
              key={m.id}
              ref={(el) => { refs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-labelledby={`${base}-n-${m.id}`}
              aria-describedby={`${base}-d-${m.id}`}
              tabIndex={checked ? 0 : -1}
              data-preview-mode={m.id}
              className="settings-mode"
              onClick={() => select(i)}
            >
              <ModePreview id={m.id} />
              <span className="settings-mode__text">
                <span className="settings-mode__top">
                  <span className="settings-mode__name" id={`${base}-n-${m.id}`}>{m.name}</span>
                  <span className="settings-mode__state">
                    {checked ? <><CheckCircle2 size={14} aria-hidden />使用中</> : <Circle size={14} aria-hidden />}
                  </span>
                </span>
                <span className="settings-mode__desc" id={`${base}-d-${m.id}`}>{m.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
