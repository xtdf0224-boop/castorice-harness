/* 命途占卜的界面：聊天框的位置弹出三张背面朝上的牌（深紫底、细金线的荆棘与蝶纹，用 SVG 画），点一张翻开（300 ms），
   正面是官方命途图标。牌和台词来自 src/pet/games/tarot.ts（抽哪张、说什么由那边定），这里只管画和翻。
   翻开时调 gameSay（台词进聊天记录、气泡、朗读），所以面板里同时显示这句话，气泡在面板开着时不画。 */
import { useEffect, useRef, useState } from 'react';
import type { PetMood } from '../contracts';
import { drawTarot, type TarotCard } from './games';
import { tarotIconSrc } from './petLogic';

/** 翻出牌之后面板留多久（毫秒）自己收起。 */
export const TAROT_LINGER_MS = 25_000;

interface Props {
  /** 翻开了一张：台词交给主进程（gameSay），牌的 id 记进聊天记录。 */
  onSay(line: { text: string; mood: PetMood; card: string }): void;
  /** 收起（×、「不玩了」、时间到）。 */
  onClose(): void;
  reduced: boolean;
}

interface Drawn { slot: number; card: TarotCard; line: string; mood: PetMood }

export function Tarot({ onSay, onClose, reduced }: Props) {
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const pick = (slot: number) => {
    if (drawn) return;
    const r = drawTarot();
    setDrawn({ slot, ...r });
    onSay({ text: r.line, mood: r.mood, card: r.card.id });
    timer.current = setTimeout(onClose, TAROT_LINGER_MS);
  };
  const again = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setDrawn(null);
  };

  return (
    <section className="pet-game pet-tarot" data-hit aria-label="命途占卜" data-reduced={reduced ? '' : undefined}>
      <header className="pet-game__head">
        <strong className="pet-game__title">命途占卜</strong>
        {drawn && <button type="button" className="pet-game__link" onClick={again}>再抽一次</button>}
        <button type="button" className="pet-game__x" aria-label="收起" title="收起" onClick={onClose}>×</button>
      </header>
      {/* 牌背用的渐变只定义一次（三张牌共用，免得页面里有重复的 id）。 */}
      <svg width="0" height="0" aria-hidden focusable="false" style={{ position: 'absolute' }}>
        <defs>
          <linearGradient id="pet-cb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3a2560" /><stop offset="1" stopColor="#1c1233" /></linearGradient>
          <radialGradient id="pet-cg" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stopColor="#d6c1e0" stopOpacity="0.28" /><stop offset="1" stopColor="#d6c1e0" stopOpacity="0" /></radialGradient>
        </defs>
      </svg>
      <div className="pet-tarot__row" role="group" aria-label="三张牌">
        {[0, 1, 2].map((i) => {
          const up = drawn?.slot === i;
          return (
            <button key={i} type="button" className="pet-card" data-up={up ? '' : undefined} data-rest={drawn && !up ? '' : undefined}
              disabled={!!drawn} aria-label={up ? `翻开了「${drawn.card.name}」` : `第 ${i + 1} 张牌，背面朝上`} onClick={() => pick(i)}>
              <span className="pet-card__in">
                <span className="pet-card__face pet-card__back"><CardBack /></span>
                <span className="pet-card__face pet-card__front">
                  {up && (
                    <>
                      <img src={tarotIconSrc(drawn.card.icon)} alt="" width={44} height={44} />
                      <b>{drawn.card.name}</b>
                    </>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="pet-game__quote" role="status" aria-live="polite">{drawn ? drawn.line : '选一张。'}</p>
    </section>
  );
}

/** 牌背：深紫底、细金线的荆棘（两侧各一条带刺的藤）、正中一只蝶、上下各一枚菱形。 */
function CardBack() {
  const gold = '#c9a96a';
  const thorn = 'M9.6 25 l-4.2 -2.4 l3 4.4 M10.4 42 l-4.4 1.6 l4 3 M9.2 60 l-4 -2.6 l2.6 4.6 M10.2 77 l-4.2 1.2 l3.8 3.2';
  return (
    <svg viewBox="0 0 64 100" width="100%" height="100%" aria-hidden focusable="false">
      <rect width="64" height="100" rx="6" fill="url(#pet-cb)" />
      <rect x="2" y="2" width="60" height="96" rx="4.5" fill="none" stroke={gold} strokeWidth="0.8" />
      <rect x="5" y="5" width="54" height="90" rx="3" fill="none" stroke={gold} strokeWidth="0.45" opacity="0.7" />
      <circle cx="32" cy="50" r="22" fill="url(#pet-cg)" />
      {/* 两侧的荆棘：一条弯弯的藤，上面几根短刺（右边是左边的镜像） */}
      <g fill="none" stroke={gold} strokeWidth="0.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 12 C6.6 28 13.6 38 10 54 S6.8 78 10.4 90" />
        <path d={thorn} />
        <g transform="translate(64 0) scale(-1 1)"><path d="M10 12 C6.6 28 13.6 38 10 54 S6.8 78 10.4 90" /><path d={thorn} /></g>
      </g>
      {/* 蝶：两对翅，细金线，淡紫填色 */}
      <g fill="#d6c1e0" fillOpacity="0.14" stroke={gold} strokeWidth="0.8" strokeLinejoin="round">
        <path d="M32 49 C25 33 12.5 35 14.5 45.5 C16 52 25 53.5 32 50.5 Z" />
        <path d="M32 51 C26 54.5 19 65 24.5 68.5 C29.5 70 32.5 59 32 52 Z" />
        <g transform="translate(64 0) scale(-1 1)">
          <path d="M32 49 C25 33 12.5 35 14.5 45.5 C16 52 25 53.5 32 50.5 Z" />
          <path d="M32 51 C26 54.5 19 65 24.5 68.5 C29.5 70 32.5 59 32 52 Z" />
        </g>
      </g>
      <path d="M32 44 L32 61 M32 44 C31 40.5 29.5 39 28.2 38.4 M32 44 C33 40.5 34.5 39 35.8 38.4" fill="none" stroke={gold} strokeWidth="0.7" strokeLinecap="round" />
      {/* 上下的菱形和星点 */}
      <path d="M32 11 l3 4.2 l-3 4.2 l-3 -4.2 z M32 80.6 l3 4.2 l-3 4.2 l-3 -4.2 z" fill="none" stroke={gold} strokeWidth="0.7" />
      <g fill={gold}><circle cx="21" cy="15.2" r="0.8" /><circle cx="43" cy="15.2" r="0.8" /><circle cx="21" cy="84.8" r="0.8" /><circle cx="43" cy="84.8" r="0.8" /></g>
    </svg>
  );
}
