/* 服务地区（MODELS-SPEC §14.4「端点」）：国内 / 国际 / 套餐 / 本机，每项带种类图标（按量 · 套餐 · 本机）。
   端点不超过 3 个、标签又短就用单选组，否则用下拉；选了带 {占位符} 的端点（Azure 的资源名、Bedrock 的区域…）时，下面出现对应的输入框，
   带例子作 placeholder，按这个占位符的 pattern 实时校验（主进程会再校验一遍，也会再检查替换后的地址）。 */
import { Coins, HardDrive, Ticket, type LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { regionOf, type ProviderInfo, type RegionOption } from '../../../lib/providers';
import type { PlaceholderDef } from '../../../lib/services';
import type { ProviderConfig } from '../../../lib/types';
import { modelActions } from '../../../state/models';
import { cx } from '../../ui';
import { MenuSelect } from '../../ui/MenuSelect';
import { ChoiceTabs } from './ChoiceTabs';

export const KIND_ICON: Record<RegionOption['kind'], LucideIcon> = { payg: Coins, plan: Ticket, local: HardDrive };
export const KIND_TEXT: Record<RegionOption['kind'], string> = { payg: '按量计费', plan: '套餐（只给命令行工具）', local: '这台电脑' };

/** Does the value fit the placeholder's pattern? (An unusable pattern counts as no.) */
export function paramOk(prm: PlaceholderDef, value: string): boolean {
  try { return new RegExp(prm.pattern).test(value); } catch { return false; }
}

export function EndpointField({ info, cfg, disabled }: { info: ProviderInfo; cfg: ProviderConfig; disabled: boolean }) {
  const ids = useId();
  const region = regionOf(info, cfg);
  const many = info.regions.length > 1;
  const choose = (id: string) => {
    const next = info.regions.find((r) => r.id === id);
    // a plan channel is for the vendor's own tools: leave the API way
    modelActions.set(info.id, { region: id, ...(next?.kind === 'plan' && cfg.auth === 'api' && info.drivers.length ? { auth: 'cli' as const } : {}) });
  };
  const params = region.params ?? [];
  if (!many && !params.length) return null;
  return (
    <div className="model-field">
      {many && (
        <>
          <span className="model-field__label" id={`${ids}-l`}>服务地区</span>
          {/* 3 个以内、标签都不长才用单选组；4 个（如 Kimi 的 国内 / 国际 / 会员·国内 / 会员·海外）或标签长了，分段控件在两列卡里会折成不规则的两行，改下拉 */}
          {info.regions.length <= 3 && info.regions.every((r) => [...r.label].length <= 10) ? (
            <ChoiceTabs<string> size="sm" label="服务地区" value={cfg.region}
              options={info.regions.map((r) => ({ value: r.id, label: r.label, icon: KIND_ICON[r.kind], hint: KIND_TEXT[r.kind], disabled }))} onChange={choose} />
          ) : (
            <MenuSelect<string> variant="field" id={`${ids}-m`} label="服务地区" value={cfg.region} disabled={disabled} search={false}
              icon={KIND_ICON[region.kind]} options={info.regions.map((r) => ({ value: r.id, label: r.label, sub: KIND_TEXT[r.kind], icon: KIND_ICON[r.kind] }))} onChange={choose} minWidth={300} />
          )}
          {region.note && <p className="model-field__hint">{region.note}</p>}
        </>
      )}
      {params.map((prm) => {
        const v = cfg.params?.[prm.name] ?? '';
        const bad = !!v && !paramOk(prm, v);
        return (
          <div key={prm.name} className="model-field model-field--param">
            <label className="model-field__label" htmlFor={`${ids}-p-${prm.name}`}>{prm.label}</label>
            <input id={`${ids}-p-${prm.name}`} className={cx('input mono', bad && 'is-invalid')} value={v} disabled={disabled} spellCheck={false} autoComplete="off"
              placeholder={prm.example ? (/[一-鿿]/.test(prm.example) ? prm.example : `例如 ${prm.example}`) : undefined} aria-invalid={bad || undefined} aria-describedby={bad ? `${ids}-e-${prm.name}` : undefined}
              onChange={(e) => modelActions.set(info.id, { params: { ...(cfg.params ?? {}), [prm.name]: e.target.value.trim() } })} />
            {bad && <p className="model-field__hint model-field__hint--bad" id={`${ids}-e-${prm.name}`}>格式不对，请对照说明填写{prm.example ? `（${prm.example}）` : ''}。</p>}
          </div>
        );
      })}
    </div>
  );
}
