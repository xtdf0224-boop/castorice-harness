/* 设置 › 外观（V0α · 模块 B1「外观」）：夜/昼主题、动效档 A/B、减少动态、背景落雪与蝶、开屏、壁纸可见度与玻璃、赏图。
   只输出设置行（.settings-list）；外面的 Panel（「界面 · 外观」标题）由 SettingsView（B4）包——与 DataSection 一致.
   SettingsView 里不必再放任何外观相关的开关（主题、动效、粒子、开屏、壁纸都在这里）. */
import { ExternalLink, ImageIcon, Play, RotateCcw } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { desktop, type GpuPref, type GpuStatus } from '../../../lib/desktop';
import { rememberGpuKind } from '../../decor/boot/gpuKind';
import { useMedia, useReducedMotion } from '../../../lib/hooks';
import type { MotionPref, ParticleDensity } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { DEFAULT_SETTINGS } from '../../../state/seed';
import { useApp } from '../../../state/store';
import { getBootPolicy, setBootAlways, type BootPolicy } from '../../decor/bootPolicy';
import { motionHealth } from '../../decor/motionHealth';
import { WALLPAPERS } from '../../decor/wallpapers';
import { Button, Segmented, Slider, cx } from '../../ui';
import { ModePicker } from '../config/ModePicker';
import { Words } from '../../shell/Words';
import { SettingRow } from './SettingRow';
import { WSwitch } from './WSwitch';

const MOTION_OPTIONS: Array<{ value: MotionPref; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'reduced', label: '减少' },
  { value: 'full', label: '完整' },
];
const TIER_OPTIONS: Array<{ value: 'A' | 'B'; label: string; hint: string }> = [
  { value: 'A', label: 'A 省电', hint: '集显、电池：只留静态雪点，不落雪、不飞蝶，玻璃模糊减半' },
  { value: 'B', label: 'B 标准', hint: '等你的时候落雪，偶尔一只蝶' },
];
const PARTICLE_OPTIONS: Array<{ value: ParticleDensity; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '少量' },
  { value: 'normal', label: '标准' },
];
const GPU_OPTIONS: Array<{ value: GpuPref; label: string; hint: string }> = [
  { value: 'auto', label: '自动', hint: '交给系统挑；双显卡的笔记本上通常是集显' },
  { value: 'low', label: '省电（集显）', hint: '固定用集显：最省电、最安静' },
  { value: 'high', label: '高性能（独显）', hint: '开屏、转场和玻璃更顺，但更耗电、更热' },
];
const BOOT_VIDEO_OPTIONS: Array<{ value: 'live' | 'video'; label: string; hint: string }> = [
  { value: 'live', label: '实时', hint: '开屏每一帧现画（默认）' },
  { value: 'video', label: '视频（试验）', hint: '背景层提前逐帧渲染成视频，开屏时硬件解码播放；文字与光尘仍实时画' },
];
const BOOT_OPTIONS: Array<{ value: BootPolicy; label: string }> = [
  { value: 'upgrade', label: '首次与升级后' },
  { value: 'always', label: '每次启动' },
  { value: 'never', label: '关闭' },
];

export function AppearanceSection() {
  const settings = useApp((s) => s.settings);
  const osReduced = useMedia('(prefers-reduced-motion: reduce)');
  const reduced = useReducedMotion();
  const [, tick] = useState(0);
  const degraded = useSyncExternalStore(motionHealth.subscribe, motionHealth.get, motionHealth.get);
  const policy = getBootPolicy(settings.bootAnimation);

  const setPolicy = (p: BootPolicy) => {
    setBootAlways(p === 'always');
    actions.setSetting('bootAnimation', p !== 'never');
    tick((n) => n + 1);
  };

  return (
    <div className="settings-list">
      <ModePicker />
      <SettingRow
        title="动效档"
        desc="A 省电（集显、电池）只留静态雪点，玻璃模糊减半；B 标准在等你的时候落雪、偶尔飞过一只蝶。动效帧率封顶 30，窗口不可见时暂停。"
      >
        <div className="settings-tier">
          <Segmented<'A' | 'B'> label="动效档" options={TIER_OPTIONS} value={settings.motionTier} onChange={(v) => { motionHealth.set(false); actions.setSetting('motionTier', v); }} />
          {degraded && <p className="settings-tier__note words-scope" role="status"><Words text="帧耗时偏高（p95 > 50 ms），这一次已自动降为静态；换一档或重开背景粒子可再试。" /></p>}
        </div>
      </SettingRow>
      <GpuSetting />
      <SettingRow
        title="减少动态效果"
        desc={`系统偏好：${osReduced ? '已开启减少动态效果' : '未开启减少动态效果'} · 当前生效：${reduced ? '减少（落雪与蝶全部静止）' : '完整'}`}
      >
        <Segmented<MotionPref> label="减少动态效果" options={MOTION_OPTIONS} value={settings.motion} onChange={(v) => actions.setSetting('motion', v)} />
      </SettingRow>
      <SettingRow title="背景落雪与蝶" desc="很淡的雪点，只在有事等你时才缓缓落下，等得久了（约 2 分钟）会慢慢停下；窗口失焦或不可见超过 15 秒也会停，阁下回来再落一阵。偶尔飞过一只蝶。关闭后什么都不画。">
        <Segmented<ParticleDensity> label="背景落雪与蝶" options={PARTICLE_OPTIONS} value={settings.particles} onChange={(v) => { motionHealth.set(false); actions.setSetting('particles', v); }} />
      </SettingRow>
      <SettingRow
        title="开屏「蝶落枝头」"
        desc="约 8 秒：夜里一只蝶沿着亮起的河飞来，落在枝头；昼里花海在她脚下绽开。随当前的夜 / 昼主题，停在定格画面，约 3 秒后自己淡出。它盖在应用上面，不挡你输入：按任意键、点一下或按 Esc 立刻透出。减少动态时直接是定格画面。"
      >
        <div className="settings-boot">
          <Button size="sm" variant="ghost" icon={Play} onClick={() => actions.playBoot()}>预览</Button>
          <Segmented<BootPolicy> size="sm" label="开屏播放时机" options={BOOT_OPTIONS} value={policy} onChange={setPolicy} />
        </div>
      </SettingRow>
      <SettingRow
        title="昼开屏"
        desc={`只影响昼主题的开屏（当前${settings.mode === 'day' ? '是昼' : '是夜，换到昼才生效'}）。视频版把背景层提前逐帧渲染成视频、用显卡解码播放，标题文字与光尘仍实时画；设备不支持、窗口比例不合适、减少动态或播放出问题时自动回到实时。视频按 1530 px 高渲染，窗口更高时会略软。「预览」按这里的选择播放。`}
      >
        <div className="settings-boot" aria-disabled={settings.mode !== 'day'} style={settings.mode === 'day' ? undefined : { opacity: 0.45, pointerEvents: 'none' }}>
          <Segmented<'live' | 'video'> size="sm" label="昼开屏" options={BOOT_VIDEO_OPTIONS} value={settings.bootVideo ? 'video' : 'live'} onChange={(v) => actions.setSetting('bootVideo', v === 'video')} />
        </div>
      </SettingRow>
      <WallpaperSettings />
    </div>
  );
}

/** 图形处理器：自动 / 省电（集显）/ 高性能（独显）。显卡只在启动时选，改了要重启；网页预览里没有桌面外壳，不显示这一行. */
function GpuSetting() {
  const [st, setSt] = useState<GpuStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const busyRuns = useApp((s) => Object.values(s.runs).filter((r) => r.status === 'running' || r.status === 'queued' || r.status === 'awaiting').length);
  useEffect(() => {
    let live = true;
    desktop?.app?.gpu?.().then((s) => { if (live) { setSt(s); rememberGpuKind(s?.kind, s?.atLaunch); } }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  if (!desktop?.app?.gpu || failed) return null;

  const change = async (pref: GpuPref) => {
    if (!st) return;
    const before = st;
    setSt({ ...st, pref });
    const r = await desktop?.app?.setGpu?.(pref).catch(() => null);
    if (!r?.ok) setSt(before);
  };
  const kindText = st?.kind === 'discrete' ? '独显' : st?.kind === 'integrated' ? '集显' : '';
  const now = !st ? '正在读取显卡信息…' : st.active ? `现在在用：${st.active}${kindText ? `（${kindText}）` : ''}` : '';
  const pending = !!st && st.pref !== st.atLaunch;
  const offline = !!st && st.atLaunch === 'high' && st.kind === 'integrated';

  return (
    <SettingRow
      title="图形处理器"
      desc={<><Words text="开屏、转场、玻璃与壁纸都由显卡来画。高性能用独显，更顺，但更耗电、更热，插着电源时更合适；省电固定用集显。显卡只在启动时选，改了要重启栖枝才生效。" />{now && <><br /><Words text={now} /></>}{st && !st.choice && <><br /><Words text="这台电脑只有一块可用的显卡，选哪一档都一样。" /></>}</>}
    >
      <div className="settings-tier">
        <Segmented<GpuPref> label="图形处理器" options={GPU_OPTIONS} value={st?.pref ?? 'auto'} onChange={(v) => void change(v)} />
        {pending && (
          <div className="settings-gpu__pending" role="status">
            <p className="settings-gpu__note words-scope"><Words text={busyRuns ? `重启后生效。现在有 ${busyRuns} 个任务在跑，重启会先把它们停下。` : '重启栖枝后生效。'} /></p>
            <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => void desktop?.app?.relaunch?.()}>立即重启</Button>
          </div>
        )}
        {offline && !pending && <p className="settings-tier__note words-scope" role="status"><Words text="选了高性能，但现在用的还是集显：独显可能被系统或厂商工具（如 Eco 省电模式）关掉了。" /></p>}
      </div>
    </SettingRow>
  );
}

/** 背景壁纸: on/off, the two transparency sliders, per-page adjustment and credits. */
function WallpaperSettings() {
  const on = useApp((s) => s.settings.wallpaper);
  const visibility = useApp((s) => s.settings.wallpaperVisibility);
  const glass = useApp((s) => s.settings.panelGlass);
  const adaptive = useApp((s) => s.settings.wallpaperAdaptive);
  const mode = useApp((s) => s.settings.mode);
  const base = import.meta.env.BASE_URL;
  const isDefault = visibility === DEFAULT_SETTINGS.wallpaperVisibility && glass === DEFAULT_SETTINGS.panelGlass && adaptive === DEFAULT_SETTINGS.wallpaperAdaptive;
  const reset = () => {
    actions.setSetting('wallpaperVisibility', DEFAULT_SETTINGS.wallpaperVisibility);
    actions.setSetting('panelGlass', DEFAULT_SETTINGS.panelGlass);
    actions.setSetting('wallpaperAdaptive', DEFAULT_SETTINGS.wallpaperAdaptive);
  };
  return (
    <section className="settings-item settings-wallpaper" aria-labelledby="settings-wallpaper-title">
      <div className="settings-wallpaper__head">
        <h3 id="settings-wallpaper-title" className="settings-wallpaper__title"><ImageIcon size={15} aria-hidden />背景壁纸</h3>
        <Button size="sm" variant="ghost" icon={RotateCcw} disabled={!on || isDefault} onClick={reset}>恢复默认透明度</Button>
      </div>
      <WSwitch
        label="显示壁纸"
        description="夜是冥河岸边她与蝶的画，昼是花海与日光；切换主题时壁纸跟着切换。每个页面都能透过薄烟玻璃看到她。"
        checked={on}
        onChange={(v) => actions.setSetting('wallpaper', v)}
      />
      <div className="settings-wallpaper__thumbs" role="list" aria-label="壁纸">
        {WALLPAPERS.map((w) => (
          <figure key={w.id} role="listitem" className={cx('settings-wallpaper__thumb', w.mode === mode && 'is-current', !on && 'is-off')}>
            <img src={`${base}wallpapers/${w.id}-1600.avif`} alt={`${w.mode === 'night' ? '夜' : '昼'}的壁纸：${w.title}`} loading="lazy" decoding="async" style={{ objectPosition: w.focus }} />
            <figcaption>
              <span className="settings-wallpaper__mode">{w.mode === 'night' ? '夜 · 冥河' : '昼 · 花海'}{w.mode === mode && <span className="settings-wallpaper__now">当前</span>}</span>
              <span className="settings-wallpaper__note">
                {w.note}
                {w.credit.url && <a href={w.credit.url} target="_blank" rel="noopener noreferrer">{w.credit.label}<ExternalLink size={11} aria-hidden /><span className="sr-only">（在新窗口打开）</span></a>}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="settings-wallpaper__sliders">
        <Slider
          label="壁纸可见度"
          value={visibility}
          onChange={(v) => actions.setSetting('wallpaperVisibility', v)}
          disabled={!on}
          ends={['朦胧', '清晰']}
          description="壁纸被罩住的程度。文字周围有一圈淡淡的光晕，调到最清晰也能读（正文对比度 ≥ 4.5∶1）。"
        />
        <Slider
          label="面板通透度"
          value={glass}
          onChange={(v) => actions.setSetting('panelGlass', v)}
          disabled={!on}
          ends={['稳重', '通透']}
          description="面板像薄烟玻璃一样透出壁纸，越通透透出越多，文字光晕也随之加强。代码、日志和输入框始终更实。"
        />
      </div>
      <WSwitch
        label="按页面自动调节"
        description="首页让壁纸更清楚；工作区、行迹等信息密集的页面略压暗。"
        checked={adaptive}
        disabled={!on}
        onChange={(v) => actions.setSetting('wallpaperAdaptive', v)}
      />
      <p className="settings-wallpaper__credit">想完整看壁纸：点左栏底部的眼睛图标或按 Alt + W（赏图），Esc 返回。</p>
      <p className="settings-wallpaper__credit">
        夜的壁纸是 AI 辅助同人图（GPT 绘制、Real-ESRGAN 超分），不是官方图；昼景背景里的花海取自 AI 辅助同人图（GPT 绘制），另叠有官方立绘的虚影，首页拱窗里的立绘是官方素材。角色版权归米哈游／HoYoverse，本项目为个人非商用同人作品，非官方。
      </p>
    </section>
  );
}
