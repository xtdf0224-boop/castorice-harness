/* 「AI 辅助角色」小标（施工图 §4.2、R-CI 第 245 行）。
   小胶囊，字号 ≥ 12.5 px；不进 NamePlate 副标（副标只准三个官方称号）；出现在 FirstRun 的欢迎卡与右栏 HerHeader. */
import '../../styles/her.css';

export function AiTag() {
  return <span data-ai-tag className="hai">AI 辅助角色</span>;
}
