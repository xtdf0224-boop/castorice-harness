/* 昼 · 首页与「待你」右半的「她的窗」：尖拱窗，官方立绘站在白花海里，**被拱窗的轮廓裁切**（发尾落在窗内）。
   官方立绘只按原比例摆放，不变形、不改色、不翻转（形象一致性红线）。署名就写在窗里——署名只出现在有她的地方。
   窗的尺寸全部由 --ah（拱窗高度）推出，随窗口高度等比缩放；样式见 decor.css 的 .daystage。 */
export function DayStage({ flowers = true }: { flowers?: boolean } = {}) {
  const base = import.meta.env.BASE_URL;
  return (
    <div className="daystage" aria-hidden="true">
      <div className="daystage__arch" data-boot-target="arch">
        <div className="daystage__pattern" />
        <div className="daystage__halo" />
        <img className="daystage__fig" src={`${base}art/figure-official.webp`} alt="" draggable={false} decoding="async" data-boot-target="fig" />
        {flowers && <div className="daystage__flowers" style={{ backgroundImage: `url("${base}art/day-flowers.webp")` }} />}
        <div className="daystage__hem" />
        <p className="daystage__credit" data-credit="stage" data-boot-target="credit">{flowers ? '立绘：官方 © miHoYo · 背景含 AI 辅助同人图' : '立绘：官方 © miHoYo'}</p>
      </div>
    </div>
  );
}
