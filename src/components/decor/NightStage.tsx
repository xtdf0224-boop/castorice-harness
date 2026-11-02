/* 夜 · 壁纸关掉时，首页与「待你」右半的「她的窗」：与昼同一张官方立绘（figure-official）、同一个拱窗版式、同样的署名，
   只是配色换成夜的令牌（拱框 1 px --her-line，底是一层紫色径向光）。壁纸开着时不出现——那时右半是壁纸里的她。
   立绘只按原比例摆放，不变形、不改色、不翻转；几何与昼的 .daystage 完全一致（见 decor.css 的 .nightstage）。
   不带 data-boot-target：开屏的转场只认昼的拱窗，这里不参与. */
export function NightStage() {
  const base = import.meta.env.BASE_URL;
  return (
    <div className="nightstage" aria-hidden="true">
      <div className="nightstage__arch">
        <div className="nightstage__halo" />
        <img className="nightstage__fig" src={`${base}art/figure-official.webp`} alt="" draggable={false} decoding="async" />
        <div className="nightstage__hem" />
        <p className="nightstage__credit" data-credit="stage">立绘：官方 © miHoYo</p>
      </div>
    </div>
  );
}
