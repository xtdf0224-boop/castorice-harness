/* 归来简上的邮戳（自绘的抽象图形：圆环里写「归来」、时间与日期，纸面右上角，略微倾斜）。
   她的头像与蝶用 her/HerAvatar 与 decor/marks 的 Butterfly，这里不再重复画. */
export function Postmark({ time, date, label = '归来' }: { time: string; date: string; label?: string }) {
  return (
    <svg className="postmark" viewBox="0 0 128 66" aria-hidden focusable="false">
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        <circle cx="94" cy="33" r="29" strokeWidth="1.6" />
        <circle cx="94" cy="33" r="25" strokeWidth="0.7" />
        <path d="M2 24c8-6 16 6 24 0s16 6 24 0 16 6 24 0M2 35c8-6 16 6 24 0s16 6 24 0 16 6 24 0M2 46c8-6 16 6 24 0s16 6 24 0 16 6 24 0" strokeWidth="1" opacity="0.5" />
      </g>
      <g fill="currentColor" textAnchor="middle" fontFamily="var(--font-serif, serif)">
        <text x="94" y="23" fontSize="8" letterSpacing="2">{label}</text>
        <text x="94" y="40" fontSize="15" fontWeight="600" fontFamily="var(--font-sans, sans-serif)">{time}</text>
        <text x="94" y="52" fontSize="7.5" letterSpacing="1">{date}</text>
      </g>
    </svg>
  );
}
