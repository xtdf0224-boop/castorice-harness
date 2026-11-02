/* 拼音与首字母（模型接入页的搜索用）。
   不带拼音库：只收目录里出现的汉字（服务名、厂商名、别名）和起自定义服务名时常用的一批字。
   读音按它们在这些词里的读法取（「行」「长」这类多音字目录里没有）。目录里新增了汉字而这里没有，check-models-ui 会失败，提醒补这一张表。
   纯函数、无依赖。 */

const TABLE = `
克ke 劳lao 德de 谷gu 歌ge 马ma 斯si 法fa 国guo 脸lian 书shu 深shen 度du 求qiu 索suo 月yue 之zhi 暗an 面mian 高gao 速su 版ban
阿a 里li 云yun 通tong 义yi 千qian 问wen 百bai 炼lian 智zhi 谱pu 稀xi 宇yu 海hai 螺luo 豆dou 包bao 字zi 节jie 跳tiao 动dong
火huo 山shan 方fang 舟zhou 文wen 心xin 帆fan 混hun 元yuan 腾teng 讯xun 阶jie 跃yue 星xing 辰chen 小xiao 米mi 科ke 大da 飞fei
聚ju 合he 路lu 由you 中zhong 转zhuan 最zui 新xin 硅gui 基ji 流liu 抱bao 英ying 伟wei 达da 微wei 软ruan 亚ya 逊xun
本ben 机ji 地di 代dai 理li 网wang 关guan 档dang 位wei
我wo 的de 公gong 司si 内nei 部bu 站zhan 测ce 试shi 模mo 型xing 服fu 务wu 私si 有you 开kai 发fa 团tuan 队dui 学xue 校xiao 实shi 验yan 室shi
个ge 人ren 默mo 认ren 际ji 聊liao 天tian 编bian 程cheng 写xie 作zuo 助zhu 手shou 端duan 自zi 定ding 兼jian 容rong 接jie 口kou 密mi 钥yao
官guan 常chang 用yong 备bei 老lao 板ban 家jia 工gong 项xiang 目mu 主zhu 副fu 快kuai 慢man 免mian 费fei 付fu 号hao 池chi 渠qu 道dao
发fa 镜jing 像xiang 加jia 通tong 智zhi 能neng 语yu 言yan 平ping 台tai 共gong 总zong 线xian 在zai 线xian 免mian 第di 一yi 二er 三san
四si 五wu 六liu 七qi 八ba 九jiu 十shi 新xin 旧jiu 北bei 京jing 上shang 广guang 深shen 圳zhen 杭hang 州zhou 南nan 东dong 西xi 海hai 外wai
`;

const MAP = new Map<string, string>();
for (const part of TABLE.split(/\s+/)) {
  if (!part) continue;
  const ch = [...part][0];
  const py = part.slice(ch.length);
  if (ch && py && /^[a-z]+$/.test(py)) MAP.set(ch, py);
}

const HAN = /[㐀-鿿]/;
export const hasHan = (s: string) => HAN.test(s);
/** Does this table know the character? (check-models-ui verifies every Han character of the catalog's names and aliases.) */
export const knowsHan = (ch: string) => MAP.has(ch);
export const hanChars = (s: string): string[] => [...new Set([...s].filter((c) => HAN.test(c)))];

/** 「通义千问」 → { full: 'tongyiqianwen', initials: 'tyqw' }; non-Han text is kept lowercase (letters and digits) in both. A Han character the table does not know stays as it is. */
export function pinyinOf(text: string): { full: string; initials: string } {
  let full = '';
  let initials = '';
  for (const ch of text.toLowerCase()) {
    const py = MAP.get(ch);
    if (py) { full += py; initials += py[0]; } else if (/[\p{L}\p{N}]/u.test(ch)) { full += ch; initials += ch; }
  }
  return { full, initials };
}
