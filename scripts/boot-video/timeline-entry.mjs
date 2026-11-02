// 被 sources.mjs 用 rolldown 打包后在 node 里跑：打印昼时间表（T_END、DT、DAY_EVENTS、DAY_VID）的规范 JSON。manifest.sources.timeline = 这行字符串的 sha256。
import { DT, T_END, DAY_EVENTS, DAY_VID } from '../../src/components/decor/boot/dayScene.ts';
process.stdout.write(JSON.stringify({ T_END, DT, DAY_EVENTS, DAY_VID }));
