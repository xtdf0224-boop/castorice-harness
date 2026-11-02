/* 设置（V0α · 模块 B4「交互」）：外观（B1）/ 她的话（settings/VoiceSection：称呼、话量试听、口吻、主动说话、记得小事…）/ 运行 / 键盘（从命令注册表生成）/ 数据（B2）/ 信任的目录（B5）/ 关于与免责声明。
   所有「回车即提交」的单行输入框都过输入法守卫（lib/ime.ts）：拼音候选未上屏时，回车是选字，不是提交. */
import { FileText, Info, Keyboard, Play, Settings, Trash2 } from 'lucide-react';
import { bindingLabel, commands } from '../../lib/commands';
import { actions } from '../../state/actions';
import { useApp } from '../../state/store';
import { Button, Kbd, Panel } from '../ui';
import { version as APP_VERSION } from '../../../package.json';
import { ViewHeader } from './config/ViewHeader';
import { AppearanceSection } from './settings/AppearanceSection';
import { DataSection } from './settings/DataSection';
import { PetSection } from './settings/PetSection';
import { SettingRow } from './settings/SettingRow';
import { TrustSection } from './settings/TrustSection';
import { VoiceSection } from './settings/VoiceSection';
import { WSwitch } from './settings/WSwitch';
import '../../styles/interaction-settings.css';

export function SettingsView() {
  const settings = useApp((s) => s.settings);
  const desktop = useApp((s) => s.models.desktop);

  return (
    <div className="view settings-view">
      <ViewHeader icon={Settings} title="设置" desc="外观、她的话、运行行为和数据。设置保存在本机。" />

      <div className="settings-body">
        <div className="settings-grid">
          {/* 外观、数据、信任的目录三个分区自带 Panel（B1 / B2 / B5），这里直接放，不再包一层. */}
          <AppearanceSection />

          <VoiceSection />

          <Panel label="行为" title="运行" icon={Play} energy>
            <div className="settings-list">
              <div className="settings-item">
                <WSwitch
                  label="取消运行前确认"
                  description="取消时先弹出确认框，避免误操作。"
                  checked={settings.confirmBeforeCancel}
                  onChange={(v) => actions.setSetting('confirmBeforeCancel', v)}
                />
              </div>
              <div className="settings-item">
                <WSwitch
                  label="出错时自动打开控制台"
                  description="工具调用出错时自动展开底部控制台，方便查看错误详情。"
                  checked={settings.openConsoleOnError}
                  onChange={(v) => actions.setSetting('openConsoleOnError', v)}
                />
              </div>
              {desktop && (
                <div className="settings-item">
                  <WSwitch
                    label="关闭窗口时缩小到系统托盘"
                    description="点右上角的关闭，栖枝会留在系统托盘里，运行中的任务继续进行；有操作等你确认时会弹出系统通知（只在窗口不在前台时弹，回合结束默认无声）。关掉这一项则关闭即退出。"
                    checked={settings.closeToTray}
                    onChange={(v) => actions.setSetting('closeToTray', v)}
                  />
                </div>
              )}
            </div>
          </Panel>

          <KeyboardPanel />

          <DataSection>
            <SettingRow title="清除所有任务记录" desc="删除全部任务、运行记录和事件时间线。模型接入、Agent、工具策略和外观设置都会保留。">
              <Button variant="danger" icon={Trash2} onClick={() => actions.openDialog({ kind: 'clear-history' })}>清除所有任务记录</Button>
            </SettingRow>
          </DataSection>

          <PetSection />

          <TrustSection />

          <AboutPanel />
        </div>
      </div>
    </div>
  );
}

/* ───────────── 键盘：从命令注册表生成 ───────────── */

function KeyboardPanel() {
  const groups = new Map<string, Array<{ id: string; title: string; keys: string[] }>>();
  for (const c of commands()) {
    if (!c.keys?.length) continue;
    const g = c.category ?? '其他';
    groups.set(g, [...(groups.get(g) ?? []), { id: c.id, title: c.title, keys: c.keys }]);
  }
  return (
    <Panel label="键盘" title="快捷键" icon={Keyboard} energy>
      <dl className="settings-keys">
        {[...groups.entries()].map(([group, list]) => list.map((c, i) => (
          <div key={c.id} className="settings-keys__row">
            <dt>{i === 0 && <span className="settings-keys__group">{group}</span>}{c.title}</dt>
            <dd>{c.keys.map((k, j) => <span key={k}>{j > 0 && <span aria-hidden> / </span>}<Kbd>{bindingLabel(k)}</Kbd></span>)}</dd>
          </div>
        )))}
        <div className="settings-keys__row"><dt><span className="settings-keys__group">输入框</span>发送（Shift + Enter 换行）</dt><dd><Kbd>Enter</Kbd></dd></div>
      </dl>
      <p className="settings-keys__note">输入法的拼音候选还没有上屏时，所有快捷键和回车都先交给输入法。批准操作没有任何快捷键，只能用鼠标点。</p>
    </Panel>
  );
}

/* ───────────── 关于与免责声明 ───────────── */

const ABOUT: Array<{ title: string; text: string }> = [
  { title: '这是什么', text: '栖枝 · Alight 是以《崩坏：星穹铁道》角色遐蝶为主题的 AI Agent 桌面工作台。它是非官方的粉丝同人项目，不用于任何商业目的。' },
  { title: '版权', text: '遐蝶及其设定、名称、官方图像的版权归上海米哈游网络科技股份有限公司 / HoYoverse 所有。界面里的官方头像等素材只作同人展示；本项目与米哈游没有任何关联，也未获得其授权或认可。' },
  { title: '官方素材', text: '对话与 Agent 页里她的头像、表情角标、聊天贴纸，以及 Agent 的命途图标，是米哈游 / HoYoverse 的官方素材：素材文件原样使用、没有改动；界面里头像按方形显示（只在显示时取景，文件本身不裁），命途图标按主题着色。官方表情与贴纸为米哈游／HoYoverse 素材 · 非官方同人作品。' },
  { title: '壁纸', text: '夜景壁纸和昼景背景里的花海取自 AI 辅助生成的同人图（GPT 绘制），由使用者选定，不是官方图像；昼景背景另叠有官方立绘的虚影。夜景的署名在首页右下角和右栏底部，昼景的署名在首页与「待你」的拱窗里，赏图时都显示完整署名。' },
  { title: '她的话', text: '界面里她说的话都是原创的文案，没有照抄游戏台词；不使用官方配音，也不克隆任何声优的声音。她是呈现层，不参与任何放行、排序与证据判断。' },
  { title: '桌宠', text: '桌宠（默认关闭）里的 Q 版小遐蝶是自制的同人图（GPT 绘制，按官方外貌），不是官方素材。朗读默认只列出你自己设计的音色，克隆的音色会被拒绝；也可以选微软在线朗读（非官方的免费接口，不是她的声音）。开启后，你的话、最近的对话和前台游戏的名字会发给为她作答的模型；开着「允许她看游戏画面」时，一帧游戏画面只在你提问或她主动搭话时发给你选的看图模型；联网查攻略交给由 Claude Code 驱动的模型；她说的话发给你选的语音服务；开启实时陪玩后，麦克风里像说话的声音发给 ElevenLabs 识别。这些都不会发给本项目作者，详见「设置 › 桌宠」和完整条款第 5 条。' },
  { title: '来源', text: '从「萤火 · Agent 工作台」v2.0.0（MIT 许可）分出，保留原有的版权与许可声明。' },
  { title: '字体', text: '界面里的西文装饰字（「ALIGHT」字标、开屏与版本号）使用 Cinzel 字体，© 2020 The Cinzel Project Authors，SIL OFL 1.1；应用附带它的 Latin 子集，许可证全文随包附在 fonts/OFL-Cinzel.txt。' },
  { title: '模型与数据', text: '栖枝自己不带模型，也不读取你的登录凭据。任务和设置只保存在这台电脑上；API 密钥由系统加密另存。选用的模型服务按它们自己的条款与计费规则处理你发送的内容。' },
];

function AboutPanel() {
  return (
    <Panel className="settings-span" label="条款" title="关于与免责声明" icon={FileText} energy id="terms">
      <div className="settings-terms">
        {ABOUT.map((s) => (
          <article key={s.title} className="settings-terms__section">
            <h3>{s.title}</h3>
            <p>{s.text}</p>
          </article>
        ))}
      </div>
      <dl className="settings-about">
        <div><dt><Info size={13} aria-hidden /> 版本</dt><dd>{APP_VERSION}</dd></div>
      </dl>
    </Panel>
  );
}
