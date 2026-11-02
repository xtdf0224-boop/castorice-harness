/* 小游戏的牌面、台词和结束语来自大脑那边写的纯逻辑模块（src/pet/games/*.ts）；窗口只从这里取，
   换来源时只改这一个文件。 */
export { TAROT_CARDS, drawTarot, type TarotCard } from '../games/tarot';
export { BUTTERFLY_SECONDS, butterflyEndLine } from '../games/butterfly';
