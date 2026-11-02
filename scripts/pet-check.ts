/* 桌宠主进程一侧的检查：npm run check:pet（和 scripts/pet-brain-check.ts、木偶的纯函数检查一起，见 docs/PET-PLAN.md §8）
   策略（她能看什么）、语音辅助与密钥、实时陪玩的听与说、发送方身份检查、图片消息与桌宠快速通道，以及 electron/pet/*.cjs
   （把 Electron 换成替身，真的 window.cjs / index.cjs / capture.cjs / hotkeys.cjs 跑起来）：页面、主进程、采集页、桌宠窗口之间的接线，
   新通道（小游戏、童话、光标 look）、探针模式不建窗口。不开任何窗口，不联网（只连 127.0.0.1 上的假服务）。纯断言，没有测试框架。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';

let failures = 0;
function expect(label: string, cond: boolean, extra = '') {
  console.log(`${cond ? '  ok ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}
function eq<T>(label: string, actual: T, expected: T) {
  const same = isDeepStrictEqual(actual, expected);
  expect(label, same, same ? '' : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const root = process.cwd();
const req = createRequire(path.join(root, 'package.json'));
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
process.env.ALIGHT_PROBE = ''; // 外面跑着探针的话，别带进来：探针模式在下面单独测

/* ───────────────────────── names, files, and the contract ───────────────────────── */

console.log('Names and contract');
{
  const pre = read('electron/preload.cjs');
  const petPre = read('electron/pet/preload.cjs');
  const capPre = read('electron/pet/capture-preload.cjs');
  expect('the pet window exposes window.alightPet and the capture page window.alightCapture', petPre.includes("exposeInMainWorld('alightPet'") && capPre.includes("exposeInMainWorld('alightCapture'"));
  expect('the main page gets alightDesktop.pet, and the call() allow-list is not widened for it',
    /\bpet: \{/.test(pre) && /\(store\|trust\|usage\|git\|probe\)/.test(pre) && !/\(store\|trust\|usage\|git\|probe\|pet/.test(pre));
  // The bridge methods are the ones contracts.ts lists (the file the three sides share).
  const contract = read('src/pet/contracts.ts');
  const methods = (iface: string) => {
    const m = new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`).exec(contract);
    return m ? [...m[1].matchAll(/^ {2}(\w+)\(/gm)].map((x) => x[1]) : [];
  };
  const bridge = methods('PetBridge');
  const windowBridge = methods('PetWindowBridge');
  expect('contracts.ts lists the bridges (so the next two checks mean something)', bridge.length >= 13 && windowBridge.length >= 19, `${bridge.length} / ${windowBridge.length}`);
  const petBlock = /\bpet: \{([\s\S]*?)\n {2}\},/.exec(pre)?.[1] ?? '';
  eq('every PetBridge method is in the main preload', bridge.filter((n) => !new RegExp(`\\b${n}:`).test(petBlock)), []);
  eq('every PetWindowBridge method is in the pet window preload', windowBridge.filter((n) => !new RegExp(`\\b${n}:`).test(petPre)), []);
  // The channels a preload sends on all have a listener in the main process.
  const hub = read('electron/pet/index.cjs') + read('electron/pet/capture.cjs');
  const used = [...(petBlock + petPre + capPre).matchAll(/ipcRenderer\.(?:send|invoke)\('([^']+)'/g)].map((m) => m[1]);
  eq('every channel the pet preloads use has a handler in the main process', [...new Set(used)].filter((c) => !hub.includes(`'${c}'`)), []);
  // Nothing the user can read says the sister app's names.
  const walk = (dir: string): string[] => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  const forbidden = /流萤|萨姆|萤火|firefly/i;
  eq('electron/pet/ has no 流萤 / 萨姆 / 萤火 / firefly anywhere', walk('electron/pet').filter((f) => forbidden.test(read(f))), []);
  const main = read('electron/main.cjs');
  eq('the tray and the notices in main.cjs do not either', main.split(/\r?\n/).filter((l) => /label:|title:|content:|setToolTip|body:/.test(l) && forbidden.test(l)), []);
  expect('the tray has 显示 / 隐藏桌宠 (without raising the main window) and 桌宠设置… (raising it)',
    /显示 \/ 隐藏桌宠.*pet-toggle'\s*\}, false\)/.test(main) && /桌宠设置….*pet-settings'\s*\}\)/.test(main));
  expect('main.cjs: pet wired before ready, registered with the sender check, stopped on quit, crash reloads at most 3 times a minute',
    /pet\.beforeReady\(\)/.test(main) && /pet\.register\(\{[^}]*isAppSender/.test(main) && /ai\.register\(\{ isAppSender \}\)/.test(main)
    && /render-process-gone/.test(main) && /crashes\.length > 3/.test(main));
  expect('main.cjs: on quit each step (agents, 桌宠, store) runs in its own try, so one that throws cannot keep the store from closing',
    /before-quit[\s\S]*?\[\(\) => ai\.stopAll\(\), \(\) => pet\.stopAll\(\), \(\) => store\.close\(\)\][\s\S]*?try \{ stop\(\); \} catch/.test(main));
  expect('main.cjs: the 桌宠 is told when the page crashes, starts a real navigation, is destroyed or its window closes, and when the new page has loaded',
    /did-start-navigation/.test(main) && /isSameDocument/.test(main) && /'destroyed', petPageLost/.test(main) && /render-process-gone[\s\S]{0,80}petPageLost\(\)/.test(main) && /pet\.pageLoaded\(\)/.test(main) && /win = null;\s*petPageLost\(\)/.test(main));
  expect('main.cjs: the window\'s own `closed` quits the app when it does not tuck into the tray (the pet window keeps window-all-closed from firing)',
    /win\.on\('closed', \(\) => \{[\s\S]*?quitting \|\| !closeToTray\) app\.quit\(\)/.test(main));
}

/* ───────────────────────── who is talking ───────────────────────── */

console.log('Sender identity');
{
  const { pageUrls, appSenderCheck } = req('./electron/pet/sender.cjs') as { pageUrls(f: string): Set<string>; appSenderCheck(getWin: () => unknown, urls: Set<string>): (e: unknown) => boolean };
  const page = path.join(root, 'dist', 'index.html');
  const urls = pageUrls(page);
  const mainFrame = { url: pathToFileURL(page).href };
  const wc: any = { mainFrame };
  const win: any = { webContents: wc };
  const check = appSenderCheck(() => win, urls);
  expect('the main window\'s own page, in its top frame, on dist/index.html: believed', check({ sender: wc, senderFrame: mainFrame }));
  expect('…also with a #fragment on the address', check({ sender: wc, senderFrame: Object.assign(wc.mainFrame, { url: `${mainFrame.url}#/x` }) }));
  wc.mainFrame = mainFrame;
  mainFrame.url = pathToFileURL(page).href;
  expect('another window\'s page with the very same address is not', !check({ sender: { mainFrame: { url: mainFrame.url } }, senderFrame: { url: mainFrame.url } }));
  expect('a frame inside the page (not the top one), even with the right address, is not', !check({ sender: wc, senderFrame: { url: mainFrame.url } }));
  mainFrame.url = 'file:///C:/evil.html';
  expect('the main window navigated somewhere else is not', !check({ sender: wc, senderFrame: mainFrame }));
  mainFrame.url = pathToFileURL(page).href;
  expect('no main window (closed), no event, a getter that throws: all refused, none throw',
    !appSenderCheck(() => null, urls)({ sender: wc, senderFrame: mainFrame }) && !check(undefined) && !check({}) && !appSenderCheck(() => { throw new Error('x'); }, urls)({ sender: wc, senderFrame: mainFrame }));
  // Under a short (8.3) user name the two ways of writing the address differ; both are accepted.
  const odd = pageUrls('C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\app\\dist\\index.html');
  expect('a folder with ~ or [ ] in it has two spellings, and both count', odd.size === 2 && [...odd].some((u) => u.includes('~')) && [...odd].some((u) => u.includes('%7E')), [...odd].join(' | '));
  const oddFrames = [...odd].map((u) => ({ url: u }));
  const oddWc: any = { mainFrame: oddFrames[0] };
  const oddCheck = appSenderCheck(() => ({ webContents: oddWc }), odd);
  expect('…each as the top frame\'s address', oddCheck({ sender: oddWc, senderFrame: oddFrames[0] }) && (() => { oddWc.mainFrame = oddFrames[1]; return oddCheck({ sender: oddWc, senderFrame: oddFrames[1] }); })());
}

/* ───────────────────────── what she may look at ───────────────────────── */

console.log('Policy');
type Classified = { exe: string; title: string; isGame: boolean; game?: string; policy: string; pid: number; hwnd: string; antiCheat?: boolean };
type PolicyEnv = { listDir(dir: string): string[] };
const policy = req('./electron/pet/policy.cjs') as {
  classify(raw: object, lists?: object, env?: PolicyEnv): Classified;
  isAntiCheat(raw: object, env?: PolicyEnv): boolean;
};
const lists = { neverWatch: ['wechat.exe'], gameAllow: ['mygame.exe', 'valorant.exe'], gameDeny: ['eldenring.exe'] };
const cls = (exe: string, title = '', fullscreen = 'no') => policy.classify({ exe, title, pid: 7, hwnd: '4242', fullscreen }, lists);
eq('a known game is watched, with its name', [cls('StarRail.exe').policy, cls('StarRail.exe').game], ['watch', '崩坏：星穹铁道']);
eq('exe names are compared in lower case, ids come through', [cls('StarRail.exe').exe, cls('x.exe').hwnd, cls('x.exe').pid], ['starrail.exe', '4242', 7]);
eq('a browser is never a game, even full screen', [cls('chrome.exe', 'x', 'borderless').isGame, cls('chrome.exe', 'x', 'borderless').policy], [false, 'chat-only']);
eq('an unknown full-screen program is not a game: no look, no title as a name', [cls('whatever.exe', 'Cool Game', 'borderless').isGame, cls('whatever.exe', 'Cool Game', 'borderless').game, cls('whatever.exe', 'Cool Game', 'borderless').policy], [false, undefined, 'chat-only']);
eq('so a full-screen notes app or mailbox is never captured', ['obsidian.exe', 'notion.exe', 'netflix.exe', 'enpass.exe'].map((x) => { const c = cls(x, 'Inbox - me@example.com', 'borderless'); return [c.isGame, c.game, c.policy]; }), Array(4).fill([false, undefined, 'chat-only']));
eq('an unknown window is not', cls('whatever.exe', 'Cool Game').isGame, false);
eq('the user\'s "watch" list names the game after its window, a built-in one after the list', [cls('mygame.exe', 'My Game').game, cls('starrail.exe', 'Inbox').game], ['My Game', '崩坏：星穹铁道']);
eq('games with a protected online mode are chat only', ['eldenring.exe', 'helldivers2.exe', 'gta5.exe', 'wutheringwaves.exe', 'nightreign.exe'].map((x) => [cls(x).isGame, cls(x).policy]), Array(5).fill([true, 'chat-only']));
eq('the same exe as 鸣潮 or as another game', [cls('client-win64-shipping.exe', '鸣潮').policy, policy.classify({ exe: 'client-win64-shipping.exe', title: 'Other', path: 'D:\\Other\\client-win64-shipping.exe' }, {}, { listDir: () => [] }).isGame], ['chat-only', false]);
{
  // A game that is not on the list but ships an anti-cheat next to it (the folder listing is faked).
  const listDir = (dir: string) => (/\\Foo$/.test(dir) ? ['Engine', 'EasyAntiCheat', 'foo.exe'] : /\\Bar$/.test(dir) ? ['bar.exe', 'data'] : []);
  const at = (exe: string, p: string, l: object = {}) => policy.classify({ exe, title: 'T', pid: 7, hwnd: '1', fullscreen: 'no', path: p }, l, { listDir });
  eq('an anti-cheat in the folder: a game, chat only, even if the user allowed it', [at('foo.exe', 'D:\\Games\\Foo\\foo.exe').policy, at('foo.exe', 'D:\\Games\\Foo\\foo.exe', { gameAllow: ['foo.exe'] }).policy, at('foo.exe', 'D:\\Games\\Foo\\foo.exe').game], ['chat-only', 'chat-only', 'foo']);
  eq('also found three folders up (Unreal)', at('foo-win64-shipping.exe', 'D:\\Games\\Foo\\Game\\Binaries\\Win64\\foo-win64-shipping.exe').isGame, true);
  eq('no marker: an unknown program, and watchable only if the user says so', [at('bar.exe', 'D:\\Games\\Bar\\bar.exe').isGame, at('bar.exe', 'D:\\Games\\Bar\\bar.exe', { gameAllow: ['bar.exe'] }).policy], [false, 'watch']);
  eq('a browser in a folder with such a file is still not a game', at('chrome.exe', 'D:\\Games\\Foo\\chrome.exe').isGame, false);
  eq('the path is never copied into the result', 'path' in at('foo.exe', 'D:\\Games\\Foo\\foo.exe'), false);
  eq('isAntiCheat: the list, the folder, and not the rest', [policy.isAntiCheat({ exe: 'cs2.exe' }), policy.isAntiCheat({ exe: 'foo.exe', path: 'D:\\Games\\Foo\\foo.exe' }, { listDir }), policy.isAntiCheat({ exe: 'starrail.exe' }), policy.isAntiCheat({ exe: 'whatever.exe' })], [true, true, false, false]);
  eq('the brain is told which games have an anti-cheat (she is hidden over them); a game the user only said not to watch has none',
    [at('foo.exe', 'D:\\Games\\Foo\\foo.exe').antiCheat, cls('cs2.exe').antiCheat, policy.classify({ exe: 'starrail.exe', title: '', pid: 7, hwnd: '1', fullscreen: 'no' }, { gameDeny: ['starrail.exe'] }).antiCheat, cls('starrail.exe').antiCheat],
    [true, true, undefined, undefined]);
}
{
  // (a folder's listing is remembered for ten minutes, so each try gets a folder of its own)
  let folderNo = 0;
  const marked = (name: string) => { const dir = `D:\\Games\\Z${++folderNo}`; return policy.isAntiCheat({ exe: 'somegame.exe', path: `${dir}\\somegame.exe` }, { listDir: () => ['somegame.exe', 'data', name] }); };
  eq('the folder markers of Tencent\'s TenProtect / tersafe / TP3Helper, HackShield and XHUNTER are found, besides EasyAntiCheat, BattlEye and the rest',
    ['TenProtect', 'tersafe.dll', 'TP3Helper.exe', 'HackShield', 'HShield', 'EHSvc.dll', 'xhunter1.sys', 'EasyAntiCheat', 'BattlEye'].map(marked), Array(9).fill(true));
  eq('…and an ordinary file next to a game is not one', ['readme.txt', 'tencent.ini', 'protect.txt', 'shield.dll'].map(marked), Array(4).fill(false));
}
eq('an anti-cheat game is chat only (but still a game)', [cls('cs2.exe').isGame, cls('cs2.exe').policy], [true, 'chat-only']);
eq('the user\'s "watch" list does not beat the anti-cheat list', cls('valorant.exe').policy, 'chat-only');
eq('the user\'s "watch" list makes a window a game', [cls('mygame.exe').isGame, cls('mygame.exe').policy], [true, 'watch']);
eq('the user\'s "don\'t watch" list makes a game chat only', cls('eldenring.exe').policy, 'chat-only');
eq('the "never" list wins and even the title is dropped', [cls('wechat.exe', '聊天记录').policy, cls('wechat.exe', '聊天记录').title], ['never', '']);
eq('Minecraft is found by its window title', [cls('javaw.exe', 'Minecraft 1.21').game, cls('javaw.exe', 'Eclipse').isGame], ['Minecraft', false]);
eq('nothing in front is not a game', cls('', '').isGame, false);
eq('this app\'s own window (Alight.exe) is never taken for a game', [cls('Alight.exe', '栖枝', 'borderless').isGame, cls('Alight.exe', '栖枝', 'borderless').policy], [false, 'chat-only']);

/* ───────────────────────── the voice helpers ───────────────────────── */

console.log('Voice');
const gec = req('./electron/pet/tts-edge-gec.cjs') as { secMsGec(t: number): string };
// Values from the reference implementation (edge-tts 7.3, drm.py): a port must match them to the last digit.
eq('Sec-MS-GEC matches the reference', gec.secMsGec(1760000000.5), '6D50DDDB91812C33-DD68EFB01898B0750C9797D51A5FF93471DFDAE6888A1039D532CBDCCE54545D');
eq('…at a window edge', gec.secMsGec(1760000299), 'BAF4076F572BFE4E-2D6FBE5C0E24F56622EB94F37395F2D153C6C0C451DAAE2249A459BB3AFAD62C');
eq('…and the same value across the five-minute window', gec.secMsGec(1760000300), 'BAF4076F572BFE4E-2D6FBE5C0E24F56622EB94F37395F2D153C6C0C451DAAE2249A459BB3AFAD62C');
eq('…and a far one', gec.secMsGec(1900000000), '35CB2860F259268E-7C6AC7AAFAF9ECFDEF5C38802D91759C088D45E6E8BDBC2EC1C78C22D51F1DF6');
const tts = req('./electron/pet/tts.cjs') as {
  _internals: { speakable(t: string): string; chain(p: string, f: boolean): string[]; voiceFor(p: string, v: object): string | null; xmlEscape(t: string): string; EDGE_VOICES: Array<{ id: string; name: string }> };
  voices(p: string): Promise<Array<{ id: string; name: string }>>;
  synth(text: string, voice: object, o: object): Promise<unknown>;
};
const ti = tts._internals;
eq('markup and emoji are not read aloud', ti.speakable('# 标题\n**重点** [链接](http://a.b) `code` 😀 https://x.y/z'), '标题 重点 链接 code');
eq('very long text is cut', ti.speakable('字'.repeat(900)).length, 600);
eq('a chosen service is spoken with; Microsoft\'s read-aloud is the only fallback, and only when switched on', [ti.chain('minimax', true), ti.chain('elevenlabs', false), ti.chain('elevenlabs', true), ti.chain('edge', true)], [['minimax', 'edge'], ['elevenlabs'], ['elevenlabs', 'edge'], ['edge']]);
eq('an unknown service becomes the one that needs no key', ti.chain('nope', false), ['edge']);
eq('her voice is the id the user typed for the chosen service; the other keyed service has none (no stock voice stands in); Microsoft has a default',
  [ti.voiceFor('elevenlabs', { provider: 'elevenlabs', voiceId: 'abc' }), ti.voiceFor('minimax', { provider: 'elevenlabs', voiceId: 'abc' }), ti.voiceFor('elevenlabs', { provider: 'elevenlabs', voiceId: '' }), ti.voiceFor('edge', { provider: 'elevenlabs', voiceId: 'abc' }), ti.voiceFor('edge', { provider: 'edge', voiceId: 'zh-CN-YunxiNeural' })],
  ['abc', null, null, 'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural']);
eq('SSML text is escaped', ti.xmlEscape(`a<b>&"c'`), 'a&lt;b&gt;&amp;&quot;c&apos;');
expect('the Microsoft voice list starts with 晓晓', ti.EDGE_VOICES[0].id === 'zh-CN-XiaoxiaoNeural' && ti.EDGE_VOICES.every((v) => /Neural$/.test(v.id)));
eq('the voices of "edge" come without a key', (await tts.voices('edge')).length, ti.EDGE_VOICES.length);
{
  // Speech models: the chosen one goes into the request, '' or junk means the recommended one.
  type Model = { id: string; name: string; note?: string; recommended?: boolean; legacy?: boolean };
  const tm = tts as unknown as {
    models(p: string): Promise<{ models: Model[]; live: boolean }>;
    test(v: object, o?: object): Promise<{ ok: boolean; error?: string }>;
    live(t: string, v: object, o: object): Promise<{ provider: string; mime: string }>;
    _internals: {
      MODELS: Record<string, Model[]>; RUN: Record<string, (t: string, id: string, o: { onChunk(b: Buffer, m: string): void; model?: string; pcm?: boolean; previous?: string; plain?: boolean }) => Promise<void>>;
      pickModel(p: string, m?: string): string; elevenRequest(t: string, v: string, m?: string, o?: object): { url: string; body: Record<string, unknown> };
      elevenModelList(raw: unknown): Model[]; minimaxBody(t: string, v: string, m?: string): { model: string; voice_setting: { voice_id: string } }; PCM_MIME: string;
      LOOKUP: Record<string, (id: string) => Promise<string>>; assertHer(p: string, id: string): Promise<void>; CLONE_REFUSED: string;
      elevenVoiceList(raw: unknown, all: boolean): Array<{ id: string; name: string; kind: string }>; minimaxVoiceList(raw: unknown, all: boolean): Array<{ id: string; name: string; kind: string }>;
    };
  };
  const mi = tm._internals;
  eq('the recommended models are ElevenLabs v4 and MiniMax 2.8 HD', [mi.MODELS.elevenlabs[0].id, mi.MODELS.minimax[0].id], ['eleven_v4', 'speech-2.8-hd']);
  eq('a chosen ElevenLabs model goes into the request', mi.elevenRequest('你好', 'voice1', 'eleven_flash_v2_5').body, { text: '你好', model_id: 'eleven_flash_v2_5' });
  eq('none chosen (or junk) = the recommended one', [mi.elevenRequest('你好', 'v', '').body.model_id, mi.pickModel('elevenlabs', 'a b/c'), mi.minimaxBody('你好', 'v', undefined).model], ['eleven_v4', 'eleven_v4', 'speech-2.8-hd']);
  eq('a chosen MiniMax model goes into the request, with the voice', [mi.minimaxBody('你好', 'female-shaonv', 'speech-2.6-hd').model, mi.minimaxBody('你好', 'female-shaonv', 'speech-2.6-hd').voice_setting.voice_id], ['speech-2.6-hd', 'female-shaonv']);
  const mm = await tm.models('minimax');
  eq('MiniMax offers its built-in list, recommended first, legacy marked', [mm.live, mm.models[0].id, mm.models[0].recommended, mm.models.filter((m) => m.legacy).length], [false, 'speech-2.8-hd', true, 4]);
  eq('without a key ElevenLabs offers the built-in list too', [(await tm.models('elevenlabs')).live, (await tm.models('elevenlabs')).models[0].id], [false, 'eleven_v4']);
  const live = mi.elevenModelList([
    { model_id: 'eleven_flash_v2_5', name: 'Flash v2.5', can_do_text_to_speech: true, languages: [{ language_id: 'en', name: 'English' }, { language_id: 'zh', name: 'Chinese' }] },
    { model_id: 'eleven_flash_v2', name: 'Flash v2', can_do_text_to_speech: true, languages: [{ language_id: 'en', name: 'English' }] },
    { model_id: 'eleven_english_sts_v2', name: 'STS', can_do_text_to_speech: false, languages: [{ language_id: 'zh', name: 'Chinese' }] },
    { model_id: 'eleven_v4', name: 'Eleven v4', can_do_text_to_speech: true, languages: [{ language_id: 'zh', name: 'Chinese' }] },
    { model_id: 'eleven_v5_preview', name: 'Eleven v5 Preview', can_do_text_to_speech: true, languages: [{ language_id: 'cmn', name: 'Mandarin Chinese' }] },
    { model_id: 'eleven_v3_conversational', name: 'v3 Conversational', can_do_text_to_speech: true, languages: [{ language_id: 'zh', name: 'Chinese' }] },
    { model_id: 'bad id!', name: 'x', can_do_text_to_speech: true },
  ]);
  eq('the account list keeps only models that read Mandarin over this endpoint, catalog order first', live.map((m) => m.id), ['eleven_v4', 'eleven_flash_v2_5', 'eleven_v5_preview']);
  eq('…with the catalog notes, the recommended mark, and a note for unknown ones', [live[0].recommended, live[1].note === mi.MODELS.elevenlabs[2].note, live[2].note], [true, true, '你账号里的模型']);

  // A chosen model the service refuses: she speaks with the recommended one; 试听 reports it instead.
  const runs: string[] = [];
  const orig = { ...mi.RUN };
  mi.RUN.minimax = async (_t, _id, o) => {
    runs.push(o.model ?? '');
    if (o.model !== 'speech-2.8-hd') throw Object.assign(new Error('MiniMax：invalid params'), { code: 'REQUEST' });
    o.onChunk(Buffer.from('mp3'), 'audio/mpeg');
  };
  const r1 = await tts.synth('你好', { provider: 'minimax', voiceId: 'v', fallback: false, models: { minimax: 'speech-9-hd' } }, {});
  eq('a refused chosen model is retried with the recommended one', [runs, (r1 as { model: string }).model], [['speech-9-hd', 'speech-2.8-hd'], 'speech-2.8-hd']);
  runs.length = 0;
  const t1 = await tm.test({ provider: 'minimax', voiceId: 'v', model: 'speech-9-hd', text: '你好' }, {});
  eq('试听 does not swap the model: it reports the refusal', [runs, t1.ok, t1.error], [['speech-9-hd'], false, 'MiniMax：invalid params']);
  runs.length = 0;
  mi.RUN.minimax = async (_t, _id, o) => { runs.push(o.model ?? ''); throw new Error('MiniMax 密钥无效（或不是这个地域的密钥）'); };
  let other = '';
  try { await tts.synth('你好', { provider: 'minimax', voiceId: 'v', fallback: false, models: { minimax: 'speech-2.6-hd' } }, {}); } catch (e) { other = (e as Error).message; }
  eq('other failures (a bad key) are not retried with another model', [runs, other], [['speech-2.6-hd'], 'MiniMax 密钥无效（或不是这个地域的密钥）']);

  // Her voice is only the one the user made: no id typed = no stock voice. Microsoft's read-aloud stands in only when asked.
  const spoke: string[] = [];
  mi.RUN.elevenlabs = async (_t, id) => { spoke.push(`el:${id}`); };
  mi.RUN.minimax = async (_t, id) => { spoke.push(`mm:${id}`); };
  mi.RUN.edge = async (_t, id, o) => { spoke.push(`edge:${id}`); o.onChunk(Buffer.from('mp3'), 'audio/mpeg'); };
  let noId = '';
  try { await tts.synth('你好', { provider: 'elevenlabs', voiceId: '', fallback: false }, {}); } catch (e) { noId = (e as Error).message; }
  eq('ElevenLabs with no voice id: nothing is spoken, and it says what to fill in', [spoke, noId.includes('音色 ID')], [[], true]);
  const viaEdge = await tts.synth('你好', { provider: 'elevenlabs', voiceId: '', fallback: true }, {});
  eq('…with 备用 on, Microsoft\'s read-aloud speaks (the other keyed service never does)', [spoke, (viaEdge as { provider: string }).provider], [['edge:zh-CN-XiaoxiaoNeural'], 'edge']);
  spoke.length = 0;
  await tts.synth('你好', { provider: 'elevenlabs', voiceId: 'her-voice', fallback: true }, {});
  eq('her own voice id is what ElevenLabs gets', spoke, ['el:her-voice']);
  spoke.length = 0;
  const lv = await tm.live('你好', { provider: 'minimax', voiceId: '', fallback: false }, { onPcm() {} }).catch((e: Error) => e);
  eq('a live sentence follows the same rule', [spoke, (lv as Error).message.includes('音色 ID')], [[], true]);
  Object.assign(mi.RUN, orig);

  // Her voice is never a clone of a real person's: the pickers do not list clones, and a voice id typed in by hand is checked too.
  const el = [
    { voice_id: 'g1', name: '她', category: 'generated' }, { voice_id: 'p1', name: 'Rachel', category: 'premade' }, { voice_id: 'c1', name: '某某', category: 'cloned' },
    { voice_id: 'pr1', name: '某某专业版', category: 'professional' }, { voice_id: 'f1', name: 'Famous', category: 'famous' }, { voice_id: 'n1', name: '无类别' }, { name: 'no id' }, null,
  ];
  eq('ElevenLabs: by default only the voices the user designed are listed', mi.elevenVoiceList({ voices: el }, false).map((v) => [v.id, v.kind]), [['g1', 'designed']]);
  eq('…「显示全部」 adds the ready-made ones, never a clone (cloned, professional)', mi.elevenVoiceList({ voices: el }, true).map((v) => v.id), ['g1', 'p1', 'f1', 'n1']);
  expect('…and a designed one is marked as such', mi.elevenVoiceList({ voices: el }, true)[0].name.endsWith('· 设计') && !mi.elevenVoiceList({ voices: el }, true)[1].name.includes('·'));
  eq('a garbled answer is an empty list', [mi.elevenVoiceList(null, true), mi.elevenVoiceList({ voices: 'x' }, true)], [[], []]);
  const mmRaw = { voice_generation: [{ voice_id: 'd1', voice_name: '设计的她' }], voice_cloning: [{ voice_id: 'k1', voice_name: '克隆的' }], system_voice: [{ voice_id: 'female-shaonv', voice_name: '少女音色' }, { voice_id: 'English_x', voice_name: 'English' }] };
  eq('MiniMax: by default only 音色设计 voices', mi.minimaxVoiceList(mmRaw, false).map((v) => [v.id, v.kind]), [['d1', 'designed']]);
  eq('…「显示全部」 adds the Chinese stock voices, never voice_cloning', mi.minimaxVoiceList(mmRaw, true).map((v) => v.id), ['d1', 'female-shaonv']);

  const origLookup = { ...mi.LOOKUP };
  const asked: string[] = [];
  mi.LOOKUP.elevenlabs = async (id) => { asked.push(`el:${id}`); if (id === 'boom') throw new Error('网络不通'); return id.startsWith('clone') ? 'cloned' : 'ok'; };
  mi.LOOKUP.minimax = async (id) => { asked.push(`mm:${id}`); return id === 'mmclone' ? 'cloned' : 'ok'; };
  const refusal = async (p: string, id: string) => { try { await mi.assertHer(p, id); return ''; } catch (e) { return `${(e as { code?: string }).code}:${(e as Error).message}`; } };
  eq('a clone is refused with a sentence that says why (and what to use)', await refusal('elevenlabs', 'clone-1'), `CLONE:${mi.CLONE_REFUSED}`);
  expect('…the sentence is the one the page can show', mi.CLONE_REFUSED.startsWith('这是克隆出来的音色，不能用作她的声音') && mi.CLONE_REFUSED.includes('音色设计'));
  eq('a designed voice passes', await refusal('elevenlabs', 'her-1'), '');
  await refusal('elevenlabs', 'clone-1');
  await refusal('elevenlabs', 'her-1');
  eq('the answer is kept per voice id: asking again does not ask the service again', asked, ['el:clone-1', 'el:her-1']);
  eq('an answer that could not be had is refused as it is and not kept (the next use asks again)', [await refusal('elevenlabs', 'boom'), await refusal('elevenlabs', 'boom'), asked.filter((a) => a === 'el:boom').length], ['undefined:网络不通', 'undefined:网络不通', 2]);
  eq('MiniMax: a voice from voice_cloning is refused the same way', [await refusal('minimax', 'mmclone'), await refusal('minimax', 'mm-ok')], [`CLONE:${mi.CLONE_REFUSED}`, '']);
  // …in every way a voice is used.
  const spoken: string[] = [];
  mi.RUN.edge = async (_t, id, o) => { spoken.push(`edge:${id}`); o.onChunk(Buffer.from('mp3'), 'audio/mpeg'); };
  let said = '';
  try { await tts.synth('你好', { provider: 'elevenlabs', voiceId: 'clone-2', fallback: false }, {}); } catch (e) { said = (e as Error).message; }
  eq('speaking with a cloned voice id typed into the settings is refused', [said, spoken], [mi.CLONE_REFUSED, []]);
  eq('…with 备用 on the Microsoft voice (not hers, and the user\'s own choice) speaks instead', [(await tts.synth('你好', { provider: 'elevenlabs', voiceId: 'clone-2', fallback: true }, {}) as { provider: string }).provider, spoken], ['edge', ['edge:zh-CN-XiaoxiaoNeural']]);
  eq('试听 reports it', await tm.test({ provider: 'elevenlabs', voiceId: 'clone-3', text: '你好' }, {}), { ok: false, error: mi.CLONE_REFUSED });
  eq('a live sentence is refused too', (await tm.live('你好', { provider: 'minimax', voiceId: 'mmclone', fallback: false }, { onPcm() {} }).catch((e: Error) => e) as Error).message, mi.CLONE_REFUSED);
  Object.assign(mi.RUN, orig);
  Object.assign(mi.LOOKUP, origLookup);
}
{
  let msg = '';
  try { await tts.synth('   ', { provider: 'edge' }, {}); } catch (e) { msg = (e as Error).message; }
  eq('nothing to read: an error, not a silent success', msg, '没有可以读的文字');
  let denied = '';
  try { await tts.voices('nope'); } catch (e) { denied = (e as Error).message; }
  eq('an unknown service is refused', denied, '未知的语音服务');
}

/* ───────────────────────── 实时陪玩: hearing and speaking ───────────────────────── */

console.log('Live');
{
  const { Vad } = req('./electron/pet/vad.cjs') as { Vad: new (o: object) => { push(b: Buffer): void; setBusy(on: boolean): void; floor: number } };
  const R = 16000;
  // Noise, or a voice-like tone that wavers the way speech does.
  const tone = (ms: number, amp: number, f = 0) => {
    const n = (R * ms) / 1000;
    const b = Buffer.alloc(n * 2);
    let seed = 7;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = ((seed / 0x7fffffff) * 2 - 1) * 0.002;
      const v = f ? amp * (Math.sin((2 * Math.PI * f * i) / R) + 0.5 * Math.sin((2 * Math.PI * f * 2.7 * i) / R)) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / R)) : 0;
      b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((noise + v) * 32767))), i * 2);
    }
    return b;
  };
  const run = (busy: boolean, ...parts: Buffer[]) => {
    const ev: string[] = [];
    let t = 0;
    let sent = 0;
    const v = new Vad({ sensitivity: 50, onStart: () => ev.push(`start@${t}`), onAudio: (b: Buffer) => { sent += b.length; }, onEnd: () => ev.push(`end@${t}`) });
    v.setBusy(busy);
    for (const p of parts) for (let o = 0; o < p.length; o += 4096) { v.push(p.subarray(o, o + 4096)); t += Math.min(4096, p.length - o) / 32; }
    return { ev, sentMs: sent / 32 };
  };
  const a = run(false, tone(1000, 0), tone(1200, 0.08, 180), tone(1500, 0));
  const start = Number(a.ev[0]?.split('@')[1]);
  const end = Number(a.ev[1]?.split('@')[1]);
  expect('speech is noticed within about a tenth of a second', a.ev.length === 2 && start >= 1000 && start <= 1150, a.ev.join(' '));
  expect('and its end about two thirds of a second after it stops', end >= 2500 && end <= 3000, a.ev.join(' '));
  expect('what is sent starts a little before the first word (nothing clipped)', a.sentMs >= 1200 && a.sentMs <= 2200, String(a.sentMs));
  eq('silence and steady hum never count as speech', run(false, tone(3000, 0), tone(3000, 0.004, 300)).ev, []);
  eq('while she talks, a short or quiet sound does not cut in', run(true, tone(1000, 0), tone(120, 0.08, 180), tone(800, 0), tone(1000, 0.01, 200)).ev, []);
  expect('but the user talking over her still does', run(true, tone(1000, 0), tone(1500, 0.15, 180), tone(1500, 0)).ev.length === 2);
}
{
  // The ears: ElevenLabs Scribe over a fake WebSocket.
  type Sent = { message_type: string; audio_base_64: string; commit: boolean; sample_rate: number };
  const sockets: Array<{ url: string; headers: Record<string, string>; sent: Sent[]; onmessage?: (e: { data: string }) => void; onclose?: () => void; closed: boolean; msg(m: object): void; close(): void }> = [];
  class FakeWs {
    url: string; headers: Record<string, string>; sent: Sent[] = []; closed = false;
    onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: () => void;
    constructor(url: string, o: { headers: Record<string, string> }) { this.url = url; this.headers = o.headers; sockets.push(this as never); }
    send(t: string) { this.sent.push(JSON.parse(t)); }
    close() { if (this.closed) return; this.closed = true; setTimeout(() => this.onclose?.(), 0); }
    msg(m: object) { this.onmessage?.({ data: JSON.stringify(m) }); }
  }
  const realWs = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWs;
  delete req.cache[req.resolve('./electron/pet/realtime.cjs')];
  const ears = req('./electron/pet/realtime.cjs') as {
    start(o: object, h: object): Promise<{ ok: boolean; error?: string }>; stop(m?: string): void; pushMic(b: Buffer): void; setBusy(on: boolean): void; listenOnce(): boolean; update(o: object): void; active(): boolean;
  };
  const heard: string[] = [];
  // The key is a promise of one (it is decrypted when used) or plain.
  const hooks = (key: string | null = 'sk-el', asPromise = true) => ({
    key: () => (asPromise ? Promise.resolve(key) : key), state: (st: string, m?: string) => heard.push(`state:${st}${m ? `:${m}` : ''}`),
    speechStart: () => heard.push('start'), partial: (t: string) => heard.push(`partial:${t}`), final: (t: string) => heard.push(`final:${t}`), none: () => heard.push('none'),
  });
  eq('without an ElevenLabs key it does not start', (await ears.start({ listen: 'auto', sensitivity: 50, autoOffMin: 20 }, hooks(null))).ok, false);

  const starting = ears.start({ listen: 'auto', sensitivity: 50, autoOffMin: 20 }, hooks());
  await wait(5);
  const ws = sockets[sockets.length - 1];
  const u = new URL(ws.url);
  eq('it connects to Scribe realtime with the key in a header, PCM 16 kHz, Mandarin, committing itself', [u.host, u.pathname, u.searchParams.get('model_id'), u.searchParams.get('audio_format'), u.searchParams.get('language_code'), u.searchParams.get('commit_strategy'), ws.headers['xi-api-key']],
    ['api.elevenlabs.io', '/v1/speech-to-text/realtime', 'scribe_v2_realtime', 'pcm_16000', 'zh', 'manual', 'sk-el']);
  expect('…and biased towards her name', u.searchParams.getAll('keyterms').includes('遐蝶') && !u.searchParams.getAll('keyterms').some((k) => /流萤|萨姆/.test(k)));
  ws.msg({ message_type: 'session_started', session_id: 's1', config: {} });
  eq('the session is live once the server says so', [(await starting).ok, heard.includes('state:live')], [true, true]);

  const tone = (ms: number, amp: number) => { const n = 16 * ms; const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin(i / 3) * (0.6 + 0.4 * Math.sin(i / 1000))), i * 2); return b; };
  const feed = (b: Buffer) => { for (let o = 0; o < b.length; o += 4096) ears.pushMic(b.subarray(o, o + 4096)); };
  feed(tone(800, 0));
  eq('silence sends nothing', ws.sent.length, 0);
  feed(tone(1000, 0.1));
  expect('speech goes out as base64 PCM chunks of about 0.1 s', heard.includes('start') && ws.sent.length >= 8 && ws.sent.every((m) => m.message_type === 'input_audio_chunk' && m.sample_rate === 16000 && !m.commit));
  feed(tone(1200, 0));
  const commit = ws.sent[ws.sent.length - 1];
  eq('when the user stops, the turn is committed', [commit.commit, commit.audio_base_64], [true, '']);
  ws.msg({ message_type: 'partial_transcript', text: '' });
  ws.msg({ message_type: 'committed_transcript', text: '这里往哪走' });
  eq('the committed words are the turn', heard.slice(-1), ['final:这里往哪走']);
  feed(tone(1000, 0.1));
  feed(tone(1200, 0));
  ws.msg({ message_type: 'committed_transcript', text: '' });
  eq('a turn without words ends empty', heard.slice(-1), ['none']);

  ears.update({ listen: 'key', sensitivity: 50, autoOffMin: 20 });
  const before = ws.sent.length;
  feed(tone(1000, 0.1));
  eq('in the hotkey mode nothing is heard until the key is pressed', ws.sent.length, before);
  expect('…then one sentence is', ears.listenOnce());
  feed(tone(1000, 0.1));
  feed(tone(1200, 0));
  expect('…and it is committed', ws.sent.length > before && ws.sent[ws.sent.length - 1].commit);
  ws.msg({ message_type: 'committed_transcript', text: '好的' });
  feed(tone(1000, 0.1));
  eq('…and then it stops listening again', ws.sent[ws.sent.length - 1].commit, true);

  ears.update({ listen: 'auto', sensitivity: 50, autoOffMin: 20 });
  const h0 = heard.length;
  feed(tone(1000, 0.1));
  feed(tone(1200, 0));
  feed(tone(800, 0.1));
  feed(tone(1200, 0));
  ws.msg({ message_type: 'committed_transcript', text: '帮我看看这个' });
  ws.msg({ message_type: 'committed_transcript', text: '吧' });
  eq('two quick sentences whose words come back late are one, in order, nothing lost', heard.slice(h0).filter((x) => x.startsWith('final') || x === 'none'), ['final:帮我看看这个吧']);
  ws.msg({ message_type: 'auth_error', error: 'bad key' });
  expect('a key the server refuses ends the session with a reason', heard.some((h) => h.startsWith('state:error:ElevenLabs 的密钥无效')) && !ears.active());

  // Options the server refuses: once more with the bare minimum.
  const second = ears.start({ listen: 'auto', sensitivity: 50, autoOffMin: 20 }, hooks('sk-el', false));
  await wait(5);
  const w2 = sockets[sockets.length - 1];
  w2.msg({ message_type: 'invalid_request', error: 'bad language' });
  w2.close();
  await wait(20);
  const w3 = sockets[sockets.length - 1];
  expect('a refused set of options is retried without language, filters and names', w3 !== w2 && !new URL(w3.url).searchParams.has('language_code') && !new URL(w3.url).searchParams.has('keyterms'));
  w3.msg({ message_type: 'session_started', session_id: 's3', config: {} });
  eq('…and that session runs', (await second).ok, true);
  ears.stop();
  eq('stopping closes the socket', w3.closed, true);
  const t0 = Date.now();
  const third = ears.start({ listen: 'auto', sensitivity: 50, autoOffMin: 20 }, hooks());
  await wait(5);
  ears.stop();
  const r3 = await third;
  expect('stopping while it starts ends the start at once, as cancelled', r3.ok === false && (r3 as { cancelled?: boolean }).cancelled === true && Date.now() - t0 < 1000);
  // …even before the key has been read.
  const fourth = ears.start({ listen: 'auto', sensitivity: 50, autoOffMin: 20 }, { ...hooks(), key: () => new Promise<string>((r) => setTimeout(() => r('sk-el'), 20)) });
  ears.stop();
  const r4 = await fourth;
  const nSock = sockets.length;
  await wait(40);
  expect('…and stopping while the key is still being read cancels it without ever connecting', r4.ok === false && (r4 as { cancelled?: boolean }).cancelled === true && sockets.length === nSock);
  (globalThis as { WebSocket?: unknown }).WebSocket = realWs;
}
{
  // Speaking a live reply: raw PCM, whole samples, the right request.
  const tl = req('./electron/pet/tts.cjs') as {
    live(t: string, v: object, o: object): Promise<{ provider: string; mime: string }>;
    _internals: { RUN: Record<string, (t: string, id: string, o: { onChunk(b: Buffer, m: string): void; model?: string; pcm?: boolean; previous?: string; plain?: boolean }) => Promise<void>>; elevenRequest(t: string, v: string, m?: string, o?: object): { url: string; body: Record<string, unknown> }; PCM_MIME: string };
  };
  const ti2 = tl._internals;
  const rq = ti2.elevenRequest('先去左边。', 'v1', 'eleven_flash_v2_5', { pcm: true, previous: '嗯，开拓者。' });
  eq('a live sentence asks ElevenLabs for 24 kHz PCM, in Mandarin, after what she just said', [new URL(rq.url).searchParams.get('output_format'), rq.body.language_code, rq.body.previous_text], ['pcm_24000', 'zh', '嗯，开拓者。']);
  eq('Multilingual v2 does not take a language code', ti2.elevenRequest('好。', 'v1', 'eleven_multilingual_v2', { pcm: true }).body.language_code, undefined);
  eq('an ordinary line is still MP3', new URL(ti2.elevenRequest('好。', 'v1').url).searchParams.get('output_format'), 'mp3_44100_64');
  const orig = { ...ti2.RUN };
  const seen: string[] = [];
  ti2.RUN.elevenlabs = async (_t, _id, o) => { seen.push(`${o.model}|${o.pcm}|${o.previous}`); o.onChunk(Buffer.from([1, 2, 3]), ti2.PCM_MIME); o.onChunk(Buffer.from([4, 5, 6, 7, 8]), ti2.PCM_MIME); };
  const chunks: number[][] = [];
  const r1 = await tl.live('先去左边。', { provider: 'elevenlabs', voiceId: 'ff', fallback: false, models: { elevenlabs: 'eleven_v4' } }, { onPcm: (b: Buffer) => chunks.push([...b]), fast: true, previous: '嗯。' });
  eq('the faster voice model is used, and PCM chunks always hold whole samples (an odd byte waits for the next chunk)', [seen[0], chunks], ['eleven_flash_v2_5|true|嗯。', [[1, 2], [3, 4, 5, 6, 7, 8]]]);
  eq('…reported as PCM', r1, { provider: 'elevenlabs', mime: ti2.PCM_MIME });
  ti2.RUN.elevenlabs = async (_t, _id, o) => { seen.push(`plain:${!!o.plain}`); if (!o.plain) throw Object.assign(new Error('400'), { code: 'REQUEST' }); o.onChunk(Buffer.from([0, 0]), ti2.PCM_MIME); };
  seen.length = 0;
  await tl.live('好。', { provider: 'elevenlabs', voiceId: 'ff', fallback: false }, { onPcm() {} });
  eq('a model that refuses the language or previous text is asked again without them', seen, ['plain:false', 'plain:true']);
  ti2.RUN.elevenlabs = async () => { throw new Error('ElevenLabs 请求太频繁或额度用完了'); };
  ti2.RUN.edge = async (_t, _id, o) => { seen.push('edge'); o.onChunk(Buffer.from([0, 0]), 'audio/mpeg'); };
  seen.length = 0;
  const viaEdge = await tl.live('好。', { provider: 'elevenlabs', voiceId: 'ff', fallback: true }, { onPcm() {}, onMp3() { seen.push('mp3'); } });
  eq('a failing service hands over to Microsoft\'s read-aloud (MP3 for the window to decode) when 备用 is on', [viaEdge.provider, viaEdge.mime, seen], ['edge', 'audio/mpeg', ['edge', 'mp3']]);
  let off = '';
  try { await tl.live('好。', { provider: 'elevenlabs', voiceId: 'ff', fallback: false }, { onPcm() {} }); } catch (e) { off = (e as Error).message; }
  eq('…and with it off the failure is reported as it is', off, 'ElevenLabs 请求太频繁或额度用完了');
  Object.assign(ti2.RUN, orig);
}

/* ───────────────────────── the desktop side, with Electron faked ───────────────────────── */

console.log('Desktop side');
const modules = req.cache;
function fake(rel: string, exports: unknown) {
  const file = req.resolve(rel);
  modules[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [], path: path.dirname(file) } as unknown as NodeJS.Module;
}
type Handler = (e: unknown, ...a: unknown[]) => unknown;
const ipcOn = new Map<string, Handler>();
const ipcHandle = new Map<string, Handler>();
const switches: Array<[string, string?]> = [];
const partitions: string[] = [];
let menuItems: Array<{ label?: string; click?: () => void; submenu?: Array<{ label?: string; click?: () => void }> }> = [];

/* A fake BrowserWindow for the capture page: it answers like the real page would. */
const pageWc = {
  sent: [] as Array<[string, unknown]>, ran: [] as Array<[string, boolean | undefined]>,
  /** The capture page's top frame: requests are believed when they come from this very object. */
  mainFrame: { url: '' },
  isDestroyed: () => false, setAudioMuted() {}, setWindowOpenHandler() {}, on() {},
  send(ch: string, p: unknown) { this.sent.push([ch, p]); },
  async executeJavaScript(code: string, gesture?: boolean) {
    this.ran.push([code, gesture]);
    const gen = Number(/start\((\d+)\)/.exec(code)?.[1]);
    ipcOn.get('pet-capture:state')?.({ sender: pageWc }, { gen, live: true, width: 1920, height: 1080 });
    return true;
  },
};
class FakeWindow {
  webContents = pageWc;
  isDestroyed() { return false; }
  on() {}
  destroy() {}
  loadFile() { setTimeout(() => ipcOn.get('pet-capture:ready')?.({ sender: pageWc }), 5); return Promise.resolve(); }
}
let displayHandler: ((req: { frame?: object }, cb: (s: object) => void) => Promise<void>) | undefined;
type PermWc = { getURL(): string } | null;
let permRequest: ((wc: PermWc, permission: string, cb: (ok: boolean) => void, details: object) => void) | undefined;
let permCheck: ((wc: PermWc, permission: string, origin: string, details: object) => boolean) | undefined;
let sources: Array<{ id: string }> = [{ id: 'window:4242:0' }, { id: 'window:1:0' }];
/** The cursor and the displays, for her eyes (index.cjs) — an object whose members change, because the hub captured it when it was loaded. */
const fakeScreen: any = {
  cursor: { x: 0, y: 0 }, factor: 1,
  getCursorScreenPoint() { return { ...this.cursor }; },
  getDisplayNearestPoint() { return { scaleFactor: this.factor }; },
  on() {},
};
const fakeSystemPrefs: any = { reduced: false, getAnimationSettings() { return { prefersReducedMotion: this.reduced }; } };
/** What each session was given, by partition name (the capture page and her window have their own). */
const sessions: Record<string, { req?: (wc: any, permission: string, cb: (ok: boolean) => void, details: object) => void; check?: (wc: any, permission: string) => boolean }> = {};
const fakeElectron: any = {
  app: { on() {}, isReady: () => false, commandLine: { appendSwitch: (k: string, v?: string) => { switches.push([k, v]); } }, getPath: () => path.join(root, 'node_modules', '.cache') },
  ipcMain: { on: (c: string, f: Handler) => ipcOn.set(c, f), handle: (c: string, f: Handler) => ipcHandle.set(c, f) },
  Menu: { buildFromTemplate: (items: typeof menuItems) => ({ popup: () => { menuItems = items; } }) },
  Notification: class { static isSupported() { return false; } show() {} },
  BrowserWindow: FakeWindow,
  desktopCapturer: { getSources: async () => sources },
  session: {
    fromPartition: (name: string) => {
      partitions.push(name);
      const rec = (sessions[name] ??= {});
      const capture = name === 'alight-capture';
      return {
        setDisplayMediaRequestHandler: (h: typeof displayHandler) => { if (capture) displayHandler = h; },
        setPermissionRequestHandler: (h: typeof permRequest) => { rec.req = h as never; if (capture) permRequest = h; },
        setPermissionCheckHandler: (h: typeof permCheck) => { rec.check = h as never; if (capture) permCheck = h; },
      };
    },
  },
  globalShortcut: { register: () => true, unregister() {} },
  screen: fakeScreen,
  systemPreferences: fakeSystemPrefs,
};
fake('electron', fakeElectron);

// 1. The capture module itself (real code, fake window).
{
  const capture = req('./electron/pet/capture.cjs') as {
    init(): void; start(h: string): Promise<boolean>; stop(): boolean; frame(o?: object): Promise<{ data: string; mime: string; width: number } | null>;
    png(o?: object): Promise<Buffer | null>; onScene(fn: (e: { state: string; since: number; change: number }) => void): () => void;
    onLive(fn: (live: boolean) => void): () => void; status(): { active: boolean; live: boolean; hwnd: string | null; black: boolean }; dispose(): void;
    _internals: { retryDelay(fails: number): number };
  };
  eq('a capture that keeps failing is retried after 1 s, 3 s, then every 10 s, and after six failures in a row only once a minute',
    [0, 1, 2, 3, 5, 6, 7, 30].map((n) => capture._internals.retryDelay(n)), [1000, 3000, 10000, 10000, 10000, 60000, 60000, 60000]);
  capture.init();
  eq('the capture page has its own session, alight-capture', partitions.filter((p) => /capture/.test(p)), ['alight-capture']);
  const pageUrl = pathToFileURL(path.join(root, 'dist', 'capture.html')).href;
  pageWc.mainFrame.url = pageUrl;
  expect('before anything starts, nothing is captured', !capture.status().active && !capture.status().live);
  const lives: boolean[] = [];
  capture.onLive((v) => lives.push(v));
  eq('a window handle must be decimal', [await capture.start('abc'), await capture.start('0'), await capture.start('')], [false, false, false]);
  const started = await capture.start('4242');
  eq('starting asks the page (with a user gesture) and waits for the first frame', [started, pageWc.ran.length, pageWc.ran[0][1]], [true, 1, true]);
  eq('status shows what is captured', [capture.status().active, capture.status().live, capture.status().hwnd], [true, true, '4242']);
  eq('listeners hear that frames are flowing', lives, [true]);
  eq('starting the same window again does nothing', [await capture.start('4242'), pageWc.ran.length], [true, 1]);
  const gen = Number(/start\((\d+)\)/.exec(pageWc.ran[0][0])?.[1]);

  // What the page may be given to capture.
  const answers: object[] = [];
  await displayHandler!({ frame: pageWc.mainFrame }, (s) => answers.push(s));
  // Another frame — even one that claims the same address — is not the capture page.
  await displayHandler!({ frame: { url: pageUrl } }, (s) => answers.push(s));
  eq('only the capture page gets the chosen window; anything else gets nothing', [JSON.stringify(answers[0]), JSON.stringify(answers[1])], [JSON.stringify({ video: { id: 'window:4242:0' } }), '{}']);
  sources = [{ id: 'window:1:0' }];
  await displayHandler!({ frame: pageWc.mainFrame }, (s) => answers.push(s));
  eq('a window that is gone is not substituted by another', JSON.stringify(answers[2]), '{}');
  // Electron 44+ asks for getDisplayMedia as 'media' with no device types: that must pass, a camera or microphone must not.
  const asks: boolean[] = [];
  const capWc = pageWc as unknown as PermWc;
  permRequest!(capWc, 'media', (v) => asks.push(v), { mediaTypes: [] });
  permRequest!(capWc, 'display-capture', (v) => asks.push(v), {});
  permRequest!(capWc, 'media', (v) => asks.push(v), { mediaTypes: ['audio'] });
  permRequest!(capWc, 'media', (v) => asks.push(v), { mediaTypes: ['video'] });
  permRequest!({ getURL: () => pageUrl }, 'media', (v) => asks.push(v), { mediaTypes: [] }); // same address, other contents
  permRequest!(capWc, 'notifications', (v) => asks.push(v), {});
  eq('the capture page may ask for screen capture, nothing else, and no other page may', asks, [true, true, false, false, false, false]);
  eq('permission checks follow the same rule', [permCheck!(capWc, 'media', 'file:///', {}), permCheck!(capWc, 'media', 'file:///', { mediaType: 'audio' }), permCheck!(null, 'media', '', {})], [true, false, false]);

  // Scene events: the page reports how long a state had held; the desktop turns it into the wall-clock start.
  const scenes: Array<{ state: string; since: number; change: number }> = [];
  capture.onScene((e) => scenes.push(e));
  const tn = Date.now();
  ipcOn.get('pet-capture:scene')!({ sender: pageWc }, { gen, state: 'static', since: 4000, change: 0.002 });
  ipcOn.get('pet-capture:scene')!({ sender: pageWc }, { gen: gen - 1, state: 'cut', since: 0, change: 1 });
  ipcOn.get('pet-capture:scene')!({ sender: {} }, { gen, state: 'cut', since: 0, change: 1 });
  ipcOn.get('pet-capture:scene')!({ sender: pageWc }, { gen, state: 'bogus', since: 0, change: 1 });
  eq('only a scene from the page, of this capture, with a known state counts', scenes.length, 1);
  expect('"static for 4 s" becomes the moment it began', scenes[0].state === 'static' && Math.abs(scenes[0].since - (tn - 4000)) < 500 && scenes[0].change === 0.002);
  ipcOn.get('pet-capture:scene')!({ sender: pageWc }, { gen, state: 'black', since: 2000, change: 0 });
  eq('black is reported in the status', capture.status().black, true);

  // Pictures on request.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const asked = capture.frame({ maxSide: 1280 });
  const grab = pageWc.sent.filter(([c]) => c === 'pet-capture:grab').pop()![1] as { id: string; kind: string; maxSide: number };
  eq('a picture request names the kind and size', [grab.kind, grab.maxSide], ['jpeg', 1280]);
  ipcOn.get('pet-capture:result')!({ sender: pageWc }, { id: grab.id, ok: true, data: new Uint8Array(jpeg), width: 1280, height: 720 });
  const f = await asked;
  eq('the frame comes back as base64 JPEG with its size', [f?.mime, f?.data, f?.width], ['image/jpeg', jpeg.toString('base64'), 1280]);
  const pngAsked = capture.png({ maxSide: 99999 });
  const grab2 = pageWc.sent.filter(([c]) => c === 'pet-capture:grab').pop()![1] as { id: string; kind: string; maxSide: number };
  eq('the size is capped', [grab2.kind, grab2.maxSide], ['png', 2560]);
  ipcOn.get('pet-capture:result')!({ sender: pageWc }, { id: grab2.id, ok: false });
  eq('a failed grab is null, not an error', await pngAsked, null);
  ipcOn.get('pet-capture:result')!({ sender: pageWc }, { id: 'nope', ok: true, data: new Uint8Array(3) });

  eq('stopping tells the page and the status goes quiet', [capture.stop(), capture.status().active, capture.status().live, pageWc.sent.some(([c, p]) => c === 'pet-capture:cmd' && (p as { op: string }).op === 'stop')], [true, false, false, true]);
  eq('with nothing captured there is no frame', await capture.frame(), null);
  ipcOn.get('pet-capture:scene')!({ sender: pageWc }, { gen, state: 'cut', since: 0, change: 1 });
  eq('a late scene event of a stopped capture is ignored', scenes.length, 2);
  capture.dispose();
}

// 1b. The hotkeys (real code, a fake globalShortcut).
{
  const held = new Map<string, () => void>();
  const gs = fakeElectron.globalShortcut as unknown as { register(a: string, f: () => void): boolean; unregister(a: string): void };
  gs.register = (a: string, f: () => void) => {
    if (a.includes('Bogus')) throw new Error('not an accelerator');
    if (a === 'Ctrl+Alt+X' || held.has(a)) return false; // another program has it
    held.set(a, f);
    return true;
  };
  gs.unregister = (a: string) => { held.delete(a); };
  delete modules[req.resolve('./electron/pet/hotkeys.cjs')];
  const hk = req('./electron/pet/hotkeys.cjs') as {
    apply(k: { ask: string; pause: string }, f: { onAsk(): void; onPause(): void }): { ok: boolean; errors: string[]; ask: boolean; pause: boolean }; clear(): void;
  };
  let asks = 0;
  const fns = { onAsk: () => { asks++; }, onPause() {} };
  const r1 = hk.apply({ ask: 'Ctrl+Alt+B', pause: 'Ctrl+Alt+H' }, fns);
  eq('both hotkeys register (her defaults, which do not collide with the sister app\'s Ctrl+Alt+F / P)', [r1.ok, r1.ask, r1.pause, [...held.keys()]], [true, true, true, ['Ctrl+Alt+B', 'Ctrl+Alt+H']]);
  for (let i = 0; i < 3; i++) held.get('Ctrl+Alt+B')!(); // held down: Windows repeats it
  eq('a key held down (its repeats) is one press, not a toggle back and forth', asks, 1);
  await wait(850);
  held.get('Ctrl+Alt+B')!();
  eq('…a new press later counts again', asks, 2);
  const r2 = hk.apply({ ask: 'Ctrl+Alt+X', pause: 'Ctrl+Alt+H' }, fns);
  eq('a combination another program has: said so, and the one it was to replace goes on working',
    [r2.ok, r2.ask, r2.pause, held.has('Ctrl+Alt+B'), held.has('Ctrl+Alt+X'), r2.errors.length, r2.errors[0]?.includes('Ctrl+Alt+B')], [false, false, true, true, false, 1, true]);
  const r3 = hk.apply({ ask: 'Ctrl+Alt+H', pause: 'Ctrl+Alt+B' }, fns);
  eq('swapping the two works', [r3.ok, r3.ask, r3.pause, held.size], [true, true, true, 2]);
  const r4 = hk.apply({ ask: 'Ctrl+Alt+Q', pause: 'Ctrl+Alt+Q' }, fns);
  eq('the same keys for both: the second is refused and keeps its old combination', [r4.ask, r4.pause, r4.errors.length, held.has('Ctrl+Alt+Q'), held.has('Ctrl+Alt+B')], [true, false, 1, true, true]);
  const r5 = hk.apply({ ask: 'Bogus+F', pause: '' }, fns);
  eq('one Electron cannot read is called malformed; an empty one is simply not set', [r5.ask, r5.pause, r5.errors.length, r5.errors[0]?.includes('格式不对')], [false, false, 1, true]);
  hk.clear();
  eq('clearing lets go of all of them', held.size, 0);
  // What may be a global hotkey: one of Ctrl / Alt / Win and a plain key, and not an editing key or a system one.
  const hkx = hk as unknown as { badAccelerator(label: string, a: string): string };
  const refusedKeys = ['F', 'f9', 'Shift+F', 'Shift+F5', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+A', 'Ctrl+Y', 'Ctrl+Shift+Z', 'CommandOrControl+C', 'Ctrl+Insert', 'Alt+F4', 'Alt+Tab', 'Ctrl+Alt+Delete', 'Win+L', 'Ctrl', 'Ctrl+Alt', 'Ctrl+', '+F', 'Ctrl+Nope+F'];
  const outcome = refusedKeys.map((k) => { const r = hk.apply({ ask: k, pause: '' }, fns); const out = [k, r.ask, r.errors.length, held.size]; hk.clear(); return out; });
  eq('bare keys, Shift alone, modifiers alone, editing keys (Ctrl+C / V / X / Z / A / Y) and Windows\' own are refused with a reason and never registered',
    outcome, refusedKeys.map((k) => [k, false, 1, 0]));
  expect('…the reason is a Chinese sentence for the settings page (it names the key and what is missing)', hkx.badAccelerator('呼出', 'F').includes('修饰键') && hkx.badAccelerator('呼出', 'Ctrl+C').includes('编辑') && hkx.badAccelerator('呼出', 'Ctrl+Alt').includes('普通键'));
  const goodKeys = ['Ctrl+Alt+B', 'Ctrl+Alt+H', 'Alt+Shift+F', 'Ctrl+Shift+F5', 'Win+Alt+P', 'Ctrl+F9', 'CommandOrControl+Alt+H', 'Alt+Q'];
  eq('combinations with Ctrl / Alt / Win and a plain key register ', goodKeys.map((k) => { const r = hk.apply({ ask: k, pause: '' }, fns); const out = [r.ask, r.errors.length]; hk.clear(); return out; }), goodKeys.map(() => [true, 0]));
  gs.register = () => true;
  gs.unregister = () => {};
}

// 1c. The voice services' keys (real code, Electron's storage faked with the async API the app uses).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-tts-keys-'));
  const getPath = fakeElectron.app.getPath;
  fakeElectron.app.getPath = () => dir;
  let reEncrypt = false;
  const calls: string[] = [];
  fakeElectron.safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s: string) => { calls.push('enc'); return Buffer.from(`enc:${s}`); },
    decryptStringAsync: async (b: Buffer) => ({ result: b.toString().slice(4), shouldReEncrypt: reEncrypt }),
    // the deprecated synchronous API must not be used at all
    encryptString: () => { throw new Error('deprecated'); }, decryptString: () => { throw new Error('deprecated'); }, isEncryptionAvailable: () => { throw new Error('deprecated'); },
  };
  const tk = tts as unknown as { saveKey(p: string, k: string): Promise<{ ok: boolean; error?: string; hint?: string }>; clearKey(p: string): { ok: boolean; error?: string }; getKey(p: string): Promise<string | null>; hints(): Record<string, string> };
  const saved = await tk.saveKey('elevenlabs', 'sk_abcd1234​');
  eq('a key copied with a zero-width character in it is saved without it (through the async safeStorage API)', [saved.ok, saved.hint, await tk.getKey('elevenlabs')], [true, '••••1234', 'sk_abcd1234']);
  expect('the file holds only the encrypted text and the hint', !fs.readFileSync(path.join(dir, 'tts-keys.json'), 'utf8').includes('sk_abcd1234') && JSON.stringify(tk.hints()) === '{"elevenlabs":"••••1234"}');
  const bad = await tk.saveKey('minimax', 'sk_abcd１２３４');
  eq('one with full-width or Chinese characters is refused, saying why, and nothing is stored', [bad.ok, bad.error, await tk.getKey('minimax')], [false, '密钥里有看不见的字符或中文、全角符号，请重新复制', null]);
  eq('a service that needs no key is not given one', (await tk.saveKey('edge', 'sk_abcd1234')).ok, false);
  // What was learned about a voice belongs to the account of the key: a new key or none forgets it.
  const lk = tts as unknown as { _internals: { LOOKUP: Record<string, (id: string) => Promise<string>>; assertHer(p: string, id: string): Promise<void> } };
  const origLookup = lk._internals.LOOKUP.elevenlabs;
  let looked = 0;
  lk._internals.LOOKUP.elevenlabs = async () => { looked++; return 'ok'; };
  await lk._internals.assertHer('elevenlabs', 'vv');
  await lk._internals.assertHer('elevenlabs', 'vv');
  const sameKey = looked;
  await tk.saveKey('elevenlabs', 'sk_new_key_5678');
  await lk._internals.assertHer('elevenlabs', 'vv');
  const afterSave = looked;
  tk.clearKey('elevenlabs');
  await lk._internals.assertHer('elevenlabs', 'vv');
  eq('the check of a voice is asked once, and again after the key is replaced or removed', [sameKey, afterSave, looked], [1, 2, 3]);
  lk._internals.LOOKUP.elevenlabs = origLookup;
  await tk.saveKey('elevenlabs', 'sk_abcd1234');
  reEncrypt = true;
  calls.length = 0;
  eq('a key the OS wants written again is read, and written again under the new one', [await tk.getKey('elevenlabs'), calls.length], ['sk_abcd1234', 1]);
  reEncrypt = false;
  // The key file cannot be written (here: a folder sits where its temporary copy goes).
  fs.mkdirSync(path.join(dir, 'tts-keys.json.tmp'));
  const stuck = tk.clearKey('elevenlabs');
  eq('deleting a key that cannot be written away says so, and the key is still there', [stuck.ok, !!stuck.error?.startsWith('没能删除密钥'), await tk.getKey('elevenlabs')], [false, true, 'sk_abcd1234']);
  fs.rmdirSync(path.join(dir, 'tts-keys.json.tmp'));
  eq('…once it can be, it is gone', [tk.clearKey('elevenlabs').ok, await tk.getKey('elevenlabs')], [true, null]);
  fakeElectron.app.getPath = getPath;
  delete fakeElectron.safeStorage;
  fs.rmSync(dir, { recursive: true, force: true });
}

// 1d. The sense helper: the script it runs, and giving up when it keeps dying right after it starts.
console.log('Sense helper');
{
  const cp = req('node:child_process') as any;
  delete modules[req.resolve('./electron/pet/sense.cjs')];
  type Sense = { start(o: object): void; stop(): void; running(): boolean; gaveUpRetrying(): boolean; lastError(): string; _internals: { resolveScript(src?: string, tmp?: string): string; QUICK_EXIT_LIMIT: number; setTestDelay(ms: number | null): void } };
  const sn = req('./electron/pet/sense.cjs') as Sense;
  const dirS = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-sense-check-'));
  const asar = path.join(dirS, 'app.asar');
  fs.mkdirSync(asar);
  const src = path.join(asar, 'sense.ps1');
  const body = 'Write-Output "the real script"\n';
  fs.writeFileSync(src, body);
  const tmpS = path.join(dirS, 'tmp');
  const first = sn._internals.resolveScript(src, tmpS);
  eq('inside an asar the script runs from a copy in the temp folder, and the copy is the script', [first.startsWith(tmpS), fs.readFileSync(first, 'utf8')], [true, body]);
  fs.writeFileSync(first, 'Remove-Item -Recurse C:\\evil\n');
  eq('…a copy that was changed is written again before the next start', [sn._internals.resolveScript(src, tmpS) === first, fs.readFileSync(first, 'utf8')], [true, body]);
  fs.rmSync(first);
  eq('…and one that is gone too', [sn._internals.resolveScript(src, tmpS) === first, fs.existsSync(first)], [true, true]);
  eq('outside an asar it runs where it is', sn._internals.resolveScript(path.join(dirS, 'plain', 'sense.ps1'), tmpS), path.join(dirS, 'plain', 'sense.ps1'));
  expect('…and every start asks for it again (a cached path would never be compared)', /'-File', resolveScript\(\)/.test(read('electron/pet/sense.cjs')) && !/scriptPath/.test(read('electron/pet/sense.cjs')));
  fs.rmSync(dirS, { recursive: true, force: true });

  if (process.platform !== 'win32') expect('(the helper is Windows only: the give-up check is skipped here)', true);
  else {
    const { EventEmitter } = req('node:events');
    let spawned = 0;
    const realSpawn = cp.spawn;
    cp.spawn = () => {
      spawned++;
      const c: any = new EventEmitter();
      c.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
      c.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
      c.stdin = Object.assign(new EventEmitter(), { writable: true, write() { return true; }, end() {} });
      c.exitCode = 1;
      setImmediate(() => { c.stderr.emit('data', 'boom: policy forbids the script'); c.emit('close', 1); });
      return c;
    };
    try {
      delete modules[req.resolve('./electron/pet/sense.cjs')];
      const dying = req('./electron/pet/sense.cjs') as Sense;
      dying._internals.setTestDelay(5);
      const gave: string[] = [];
      const lost: number[] = [];
      dying.start({ onGiveUp: (why: string) => gave.push(why), onLost: () => lost.push(1) });
      await wait(400);
      eq('a helper that dies at once, five starts in a row: it is not tried again, and the page-side callback hears it once, with the reason',
        [spawned, dying._internals.QUICK_EXIT_LIMIT, gave.length, gave[0]?.includes('boom'), dying.running(), dying.gaveUpRetrying()], [5, 5, 1, true, false, true]);
      await wait(150);
      eq('…and it stays given up', [spawned, gave.length], [5, 1]);
      dying.start({ onGiveUp: (why: string) => gave.push(why) });
      await wait(400);
      eq('…starting it again (a settings change, switching her on) begins afresh: five more starts, and it is said again', [spawned, gave.length], [10, 2]);
      dying.stop();
    } finally {
      cp.spawn = realSpawn;
      delete modules[req.resolve('./electron/pet/sense.cjs')];
    }
  }
}

// 2. The main-process hub, with the other modules faked.
const liveLog: string[] = [];
let liveHold = false;
let liveRelease: (() => void) | undefined;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-pet-userdata-'));
{
  const calls: string[] = [];
  const log = (s: string) => { calls.push(s); };
  const petWc = { mainFrame: { url: pathToFileURL(path.join(root, 'dist', 'pet.html')).href, parent: null } };
  // What the pet window sends: her webContents, from the top frame of her own page.
  const fromPetWin = { sender: petWc, senderFrame: petWc.mainFrame };
  let pageReset: ((why: string) => void) | undefined;
  type ChatMsg = { op: string; entry?: any; entries?: any[]; id?: string };
  const win = { lines: [] as any[], audio: [] as unknown[], states: [] as any[], cmds: [] as any[], restore: '', chat: [] as ChatMsg[], games: [] as unknown[], chatOpen: false, chatKeys: false, visible: true, mic: false, visCb: undefined as undefined | (() => void) };
  /** The window is shown or hidden: the hub is told, like the real window's `show` / `hide` events. */
  const setVisible = (v: boolean) => { win.visible = v; win.visCb?.(); };
  const voiceArgs: Array<[string, unknown]> = [];
  fake('./electron/pet/window.cjs', {
    onReset: (fn: (why: string) => void) => { pageReset = fn; return () => {}; },
    create: () => log('create'), get: () => ({ webContents: petWc, destroy() {} }), show: () => log('show'), hide: () => log('hide'), isVisible: () => win.visible,
    sendState: (s: unknown) => win.states.push(s), sendLine: (l: unknown) => win.lines.push(l), sendLineDelta() {}, sendAudio: (a: unknown) => win.audio.push(a),
    sendMood() {}, destroy() {}, setInteractive: (v: boolean) => log(`interactive:${v}`), drag: (p: string) => log(`drag:${p}`),
    sendCommand: (c: { type: string }) => {
      win.cmds.push(c);
      if (c.type === 'chat') { win.chatOpen = true; win.chatKeys = true; } else if (c.type === 'close-chat') { win.chatOpen = false; win.chatKeys = false; }
    },
    applyScale: (s: number) => log(`scale:${s}`), hwnd: () => '777', whenReady: async () => {}, setRestoreTarget: (h: string) => { win.restore = h; },
    sendChat: (m: ChatMsg) => win.chat.push(m), chatState: () => ({ open: win.chatOpen, focused: win.chatOpen && win.chatKeys }),
    focusChat: () => { log('chat-focus'); win.chatKeys = true; }, park: () => log('park'), shutdown: () => log('window-shutdown'),
    sendGame: (g: unknown) => { if (g) win.games.push(g); }, headPoint: () => ({ x: 100, y: 100 }),
    allowMic: (on: boolean) => { win.mic = on; }, onVisibility: (fn: () => void) => { win.visCb = fn; return () => {}; },
  });
  const lastCmd = () => JSON.stringify(win.cmds[win.cmds.length - 1]);
  const lastPut = () => win.chat.filter((m) => m.op === 'put').pop()?.entry;
  const synced = () => { ipcOn.get('pet-ui:chat-sync')!(fromPetWin); return win.chat[win.chat.length - 1].entries ?? []; };
  let hot: { keys: { ask: string; pause: string }; onAsk(): void; onPause(): void } | undefined;
  fake('./electron/pet/hotkeys.cjs', {
    apply: (keys: { ask: string; pause: string }, cb: { onAsk(): void; onPause(): void }) => { hot = { keys, ...cb }; return { ok: true, errors: [], ask: true, pause: true }; },
    clear: () => { hot = undefined; log('hotkeys-clear'); },
  });
  let onFocus: ((raw: object) => void) | undefined;
  let onLost: (() => void) | undefined;
  let sensing = false;
  fake('./electron/pet/sense.cjs', {
    start: (cb: { onFocus: (raw: object) => void; onLost: () => void }) => { sensing = true; onFocus = cb.onFocus; onLost = cb.onLost; },
    stop: () => { sensing = false; log('sense-stop'); }, running: () => sensing, ocrPng: async () => ['任务：前往群星图书馆', '遐蝶：我会一直陪着你。'],
  });
  const cap = { live: false, hwnd: null as string | null, scene: undefined as undefined | ((e: object) => void), liveCb: undefined as undefined | ((v: boolean) => void) };
  fake('./electron/pet/capture.cjs', {
    init: () => log('capture-init'), dispose: () => log('capture-dispose'),
    start: async (h: string) => { log(`capture-start:${h}`); cap.live = true; cap.hwnd = h; cap.liveCb?.(true); return true; },
    stop: () => { log('capture-stop'); cap.live = false; cap.hwnd = null; return true; },
    frame: async () => ({ mime: 'image/jpeg', data: '/9j/4AAQ', width: 1280, height: 720, at: 1 }), png: async () => Buffer.from([1, 2, 3]),
    onScene: (fn: (e: object) => void) => { cap.scene = fn; return () => {}; }, onLive: (fn: (v: boolean) => void) => { cap.liveCb = fn; return () => {}; },
    status: () => ({ active: cap.hwnd !== null, live: cap.live, hwnd: cap.hwnd, black: false }),
  });
  fake('./electron/pet/tts.cjs', {
    synth: async (text: string, voice: object, o: { onChunk(b: Buffer, m: string): void }) => { o.onChunk(Buffer.from([1, 2, 3]), 'audio/mpeg'); log(`synth:${text}`); return { provider: (voice as { provider: string }).provider }; },
    voices: async (p: string, o?: object) => { voiceArgs.push([p, o]); return [{ id: `${p}-1`, name: 'one' }]; }, test: async (_v: object, o: { onChunk(b: Buffer, m: string): void }) => { o.onChunk(Buffer.from([9]), 'audio/mpeg'); return { ok: true }; },
    saveKey: async (p: string, k: string) => ({ ok: true, hint: `••••${k.slice(-4)}`, p }), clearKey: () => ({ ok: true }), hints: () => ({ minimax: '••••abcd' }),
    getKey: async (p: string) => (p === 'elevenlabs' ? 'sk-el' : null),
    live: async (text: string, _v: object, o: { onPcm(b: Buffer): void; signal: AbortSignal; fast: boolean }) => {
      liveLog.push(`live:${text}:${o.fast}`);
      o.onPcm(Buffer.from([1, 2, 3, 4]));
      if (liveHold) await new Promise<void>((resolve) => { liveRelease = resolve; o.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return { provider: 'elevenlabs', mime: 'audio/pcm;rate=24000' };
    },
    _internals: { PCM_MIME: 'audio/pcm;rate=24000' },
  });
  const rtLog: string[] = [];
  let rtHooks: { key(): Promise<string | null> | string | null; state(st: string, m?: string): void; speechStart(): void; partial(t: string): void; final(t: string): void; none(): void } | undefined;
  let rtActive = false;
  fake('./electron/pet/realtime.cjs', {
    start: async (o: object, h: typeof rtHooks) => { rtLog.push(`start:${JSON.stringify(o)}`); rtHooks = h; rtActive = true; h!.state('live'); return { ok: true }; },
    update: (o: object) => rtLog.push(`update:${JSON.stringify(o)}`), listenOnce: () => { rtLog.push('listen'); return true; },
    setBusy: (on: boolean) => rtLog.push(`busy:${on}`), pushMic() {},
    stop: (m?: string, failed?: boolean) => { rtLog.push('stop'); if (rtActive) { rtActive = false; rtHooks?.state(failed ? 'error' : 'closed', m); } }, active: () => rtActive,
  });
  fakeElectron.app.getPath = () => userData;
  // The real policy and the real hub.
  delete modules[req.resolve('./electron/pet/index.cjs')];
  const hub = req('./electron/pet/index.cjs') as {
    beforeReady(): void; register(h: object): void; stopAll(): void; pageLost(): void; pageLoaded(): void;
    frontApp(): { fullscreen: string; isGame: boolean; rect: object } | null;
    _internals: { sanitizeConfig(c: unknown): any; sanitizeLine(l: unknown): any; sanitizeGame(g: unknown): object | null; gameText(t: unknown): string; plain(t: unknown): string };
  };
  const toPage: Array<[string, unknown]> = [];
  const commands: Array<[object, boolean | undefined]> = [];
  const mainWc = { isDestroyed: () => false, send: (c: string, p: unknown) => { toPage.push([c, p]); } };
  const appUrl = pathToFileURL(path.join(root, 'dist', 'index.html')).href;
  // The shell decides who the main page is (main.cjs isAppSender): here, this one frame object.
  const appFrame = { url: appUrl };
  const fromApp = { sender: mainWc, senderFrame: appFrame };
  const fromEvil = { sender: mainWc, senderFrame: { url: appUrl } };
  const events = () => toPage.filter(([c]) => c === 'pet:event').map(([, p]) => p as { type: string; [k: string]: unknown });

  hub.beforeReady();
  eq('a switch is set before the app is ready', switches.map((s) => s[0]), ['disable-features']);
  // The main window asks what is in front (is a fullscreen game covering it?) and is told when that changes (main.cjs coveredNow).
  let frontPings = 0;
  hub.register({ getMainWindow: () => ({ isDestroyed: () => false, webContents: mainWc }), showMainWindow: () => log('show-main'), sendCommandToPage: (c: object, s?: boolean) => commands.push([c, s]),
    isAppSender: (e: { senderFrame?: object }) => !!e && e.senderFrame === appFrame, onFrontApp: () => { frontPings++; } });
  eq('before the pet is on, nothing says what is in front (the main window goes by how long it was left)', hub.frontApp(), null);

  const clean = hub._internals.sanitizeConfig({ enabled: 1, theme: 'x', scale: 9, neverWatch: ['  A.exe', 4], follow: 'no', fpsCap: 45, voice: { provider: 'siri', volume: 900, models: { elevenlabs: ' eleven_v4 ', minimax: 'speech 2.8; rm' } } });
  eq('speech models from the page are checked like everything else', clean.voice.models, { elevenlabs: 'eleven_v4', minimax: '' });
  eq('whatever the page sends is checked field by field (nothing is on by itself; an odd service is ElevenLabs, never Microsoft\'s)',
    [clean.enabled, clean.theme, clean.scale, clean.neverWatch, clean.voice.provider, clean.voice.volume, clean.watch, clean.voice.enabled, clean.voice.fallback, clean.fpsCap, clean.follow],
    [false, 'night', 1.6, ['a.exe'], 'elevenlabs', 100, false, false, false, 60, true]);
  const dflt = hub._internals.sanitizeConfig(undefined);
  eq('nothing sent = everything off, her keys', [dflt.enabled, dflt.watch, dflt.voice.enabled, dflt.voice.fallback, dflt.hotkeyAsk, dflt.hotkeyPause, dflt.theme, dflt.follow, dflt.fpsCap, dflt.realtimeReady], [false, false, false, false, 'Ctrl+Alt+B', 'Ctrl+Alt+H', 'night', true, 60, false]);
  eq('realtimeReady is the brain\'s word and only a real true counts', [hub._internals.sanitizeConfig({ realtimeReady: true }).realtimeReady, hub._internals.sanitizeConfig({ realtimeReady: 'yes' }).realtimeReady], [true, false]);
  eq('theme day, 30 fps, follow off and each switch that is exactly true are taken', (({ theme, fpsCap, follow, watch, voice }) => [theme, fpsCap, follow, watch, voice.enabled, voice.fallback])(hub._internals.sanitizeConfig({ theme: 'day', fpsCap: 30, follow: false, watch: true, voice: { enabled: true, fallback: true } })), ['day', 30, false, true, true, true]);
  eq('a line needs an id and text', [hub._internals.sanitizeLine({ id: 'a' }), hub._internals.sanitizeLine('x')], [null, null]);
  eq('and drops what it does not know', hub._internals.sanitizeLine({ id: 'a', text: 'hi', mood: 'angry', speak: 'yes', extra: 1 }), { id: 'a', text: 'hi' });
  // The small cleaning: the same punctuation rules as src/pet/tidy.ts, for her lines (a second guard), the games' lines and the tales.
  const pl = hub._internals.plain;
  eq('「！」 and 「!」 become 「。」, a 「？！」 is a question, 「～」 「〜」 go, 「~」 goes unless it is between two numbers', [pl('好！'), pl('好!!'), pl('真的？！'), pl('真的!?'), pl('嗯～好〜'), pl('a~b'), pl('3~5 个'), pl('好！！！')], ['好。', '好。', '真的？', '真的？', '嗯好', 'ab', '3~5 个', '好。']);
  eq('short pure-Chinese narration in brackets goes; brackets with numbers, letters or marks are text', [pl('好的（笑）嗯'), pl('好的(小声)嗯'), pl('暴击率（+10%）'), pl('（见图 2）'), pl('（这是一段很长很长很长很长很长的旁白说明）')], ['好的嗯', '好的嗯', '暴击率（+10%）', '（见图 2）', '（这是一段很长很长很长很长很长的旁白说明）']);
  eq('all together, and a run of 「。」 becomes one', [pl('好！！真的？！这个（笑）可以(小声)。3~5个～ 暴击率（+10%）'), pl('好！。。')], ['好。真的？这个可以。3~5个 暴击率（+10%）', '好。']);
  eq('a line from the brain is cleaned as it comes in — text and the longer answer — whatever it was told to be', [hub._internals.sanitizeLine({ id: 'a', text: '好！', more: '好！\n再往前走（笑）～' }).text, hub._internals.sanitizeLine({ id: 'a', text: '好！', more: '好！\n再往前走（笑）～' }).more], ['好。', '好。\n再往前走']);
  eq('her new moods (shy, surprised) are known', [hub._internals.sanitizeLine({ id: 'a', text: 'x', mood: 'shy' }), hub._internals.sanitizeLine({ id: 'a', text: 'x', mood: 'surprised' })], [{ id: 'a', text: 'x', mood: 'shy' }, { id: 'a', text: 'x', mood: 'surprised' }]);

  const cfg = { enabled: true, theme: 'night', scale: 1.2, watch: true, neverWatch: [], gameAllow: [], gameDeny: [], hotkeyAsk: 'Ctrl+Alt+B', hotkeyPause: 'Ctrl+Alt+H', follow: true, fpsCap: 60, voice: { enabled: true, provider: 'edge', voiceId: '', volume: 70, fallback: true } };
  ipcOn.get('pet:config')!(fromEvil, cfg);
  eq('a call from any other page is ignored', calls.filter((c) => c === 'show').length, 0);
  let denied = '';
  try { await ipcHandle.get('pet:frame')!(fromEvil, {}); } catch (e) { denied = (e as Error).message; }
  expect('and a request from another page is refused', denied.startsWith('拒绝'), denied);
  ipcOn.get('pet:config')!(fromApp, cfg);
  eq('switching on sets her size, but she waits to hear what is in front (an anti-cheat game?) before showing', [calls.includes('show'), calls.includes('scale:1.2')], [false, true]);
  eq('registers her hotkeys', hot?.keys, { ask: 'Ctrl+Alt+B', pause: 'Ctrl+Alt+H' });
  eq('…and tells the page which ones work', events().filter((e) => e.type === 'hotkeys').pop() as unknown, { type: 'hotkeys', ask: true, pause: true, errors: [] });
  eq('and starts sensing', sensing, true);
  eq('the pet window is told how things stand (night theme, follow, 60 fps)', win.states[win.states.length - 1], { theme: 'night', scale: 1.2, watching: false, paused: false, realtime: false, listening: false, voice: true, follow: true, fpsCap: 60, reducedMotion: false, realtimeReady: false });
  fakeSystemPrefs.reduced = true;
  ipcOn.get('pet:config')!(fromApp, { ...cfg, theme: 'day', fpsCap: 30 });
  eq('the day theme, the 30 fps cap and the system\'s 减少动态效果 reach her window', [win.states[win.states.length - 1].theme, win.states[win.states.length - 1].fpsCap, win.states[win.states.length - 1].reducedMotion], ['day', 30, true]);
  fakeSystemPrefs.reduced = false;
  ipcOn.get('pet:config')!(fromApp, { ...cfg, realtimeReady: true });
  eq('the brain\'s realtimeReady goes to her window as it is (it decides whether the 「实时」 button shows)', win.states[win.states.length - 1].realtimeReady, true);
  ipcOn.get('pet:config')!(fromApp, cfg);

  // The program in front.
  onFocus!({ exe: 'chrome.exe', title: 'x', pid: 5, hwnd: '1000', fullscreen: 'no', rect: {} });
  eq('the first report of the program in front (no anti-cheat game) shows her at once', calls.filter((c) => c === 'show').length, 1);
  onFocus!({ exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} });
  eq('a game that has just come to the front is not watched yet (the focus must hold still)', calls.some((c) => c.startsWith('capture-start')), false);
  await wait(1750);
  const focusEvents = events().filter((e) => e.type === 'focus');
  eq('after 1.5 s the page hears about it: only the last program, classified', [focusEvents.length, (focusEvents[0]?.app as { policy: string; game: string })?.policy, (focusEvents[0]?.app as { game: string })?.game], [1, 'watch', '崩坏：星穹铁道']);
  eq('and the game window starts being captured', calls.filter((c) => c.startsWith('capture-start')), ['capture-start:4242']);
  eq('the pet shows the eye', win.states[win.states.length - 1].watching, true);
  eq('with a game in front her eyes stop following the cursor (the window is told)', win.states[win.states.length - 1].follow, false);
  eq('the main window can ask: a borderless fullscreen game she knows is in front (and it was told the front changed)', [hub.frontApp()?.fullscreen, hub.frontApp()?.isGame, frontPings > 0], ['borderless', true, true]);

  // Her own window must not count as "the program in front".
  onFocus!({ exe: 'alight.exe', title: '栖枝桌宠', pid: process.pid, hwnd: '777', fullscreen: 'no', rect: {} });
  await wait(1750);
  eq('the pet window holding the keyboard (ask box) does not stop the watch', [calls.includes('capture-stop'), events().filter((e) => e.type === 'focus').length], [false, 1]);
  // But another program does: at once.
  onFocus!({ exe: 'notepad.exe', title: 'n', pid: 9, hwnd: '555', fullscreen: 'no', rect: {} });
  eq('looking stops the instant another window takes the front', calls.includes('capture-stop'), true);
  await wait(1750);
  eq('and the page is told the program changed', events().filter((e) => e.type === 'focus').length, 2);
  eq('a program that is neither fullscreen nor a game she knows does not count as covering the main window', [hub.frontApp()?.fullscreen, hub.frontApp()?.isGame], ['no', false]);
  eq('no picture can be had of a program that is not a game', await ipcHandle.get('pet:frame')!(fromApp, { maxSide: 1280 }), null);
  onFocus!({ exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} });
  await wait(1750);
  const frame = await ipcHandle.get('pet:frame')!(fromApp, { maxSide: 1280 }) as { mime: string } | null;
  eq('back in the game she can have a picture', frame?.mime, 'image/jpeg');
  const ocr = await ipcHandle.get('pet:ocr')!(fromApp) as { lines: string[] } | null;
  eq('and the text on it', ocr?.lines.length, 2);

  // A title that keeps changing (a clock, a song's name) must not hold the change back for ever.
  const nF = events().filter((e) => e.type === 'focus').length;
  for (let i = 0; i < 4; i++) { onFocus!({ exe: 'music.exe', title: `歌 ${i}`, pid: 12, hwnd: '600', fullscreen: 'no', rect: {} }); await wait(400); }
  const moved = events().filter((e) => e.type === 'focus').slice(nF).map((e) => e.app as { exe: string; title: string });
  eq('a window whose title changes every 0.4 s still becomes the program in front after 1.5 s (with its newest title)', [moved.length, moved[0]?.exe, moved[0]?.title], [1, 'music.exe', '歌 3']);
  onFocus!({ exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} });
  await wait(1750);
  // While another window settles in front, pausing and resuming must not start looking at the game she left.
  const starts = calls.filter((c) => c.startsWith('capture-start')).length;
  onFocus!({ exe: 'notepad.exe', title: 'n', pid: 9, hwnd: '555', fullscreen: 'no', rect: {} });
  hot!.onPause();
  hot!.onPause();
  await wait(30);
  eq('pausing and resuming while another window settles in front does not look at the game she left', calls.filter((c) => c.startsWith('capture-start')).length, starts);
  onFocus!({ exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} });
  await wait(1750);

  // The sense helper dies or goes quiet: what it last reported is stale, so she stops looking.
  const nFocus = events().filter((e) => e.type === 'focus').length;
  const stops1 = calls.filter((c) => c === 'capture-stop').length;
  const pings1 = frontPings;
  onLost!();
  eq('a lost helper leaves the main window nothing to go by, and it is told so', [hub.frontApp(), frontPings > pings1], [null, true]);
  const lostApp = (events().filter((e) => e.type === 'focus').pop() as unknown as { app: { exe: string; hwnd: string; policy: string; isGame: boolean } }).app;
  eq('when sense is lost she forgets the program, stops looking and tells the page', [events().filter((e) => e.type === 'focus').length, lostApp.exe, lostApp.hwnd, lostApp.policy, lostApp.isGame, calls.filter((c) => c === 'capture-stop').length > stops1], [nFocus + 1, '', '0', 'never', false, true]);
  eq('and has no picture or text to give', [await ipcHandle.get('pet:frame')!(fromApp, {}), await ipcHandle.get('pet:ocr')!(fromApp)], [null, null]);
  onLost!();
  eq('the page is told once per outage', events().filter((e) => e.type === 'focus').length, nFocus + 1);
  onFocus!({ exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} });
  await wait(1750);
  eq('a fresh report from the helper brings her back', (await ipcHandle.get('pet:frame')!(fromApp, { maxSide: 1280 })) !== null, true);

  // Scene events and the text that appears in calm moments.
  cap.scene!({ state: 'settled', since: 123, change: 0.01 });
  eq('scene events go to the page', events().some((e) => e.type === 'scene' && e.state === 'settled' && e.since === 123), true);
  await wait(30);
  const text = events().find((e) => e.type === 'text');
  eq('a calm picture gets its text read, once', [(text?.lines as string[] | undefined)?.length, events().filter((e) => e.type === 'text').length], [2, 1]);
  cap.scene!({ state: 'static', since: 1, change: 0 });
  await wait(30);
  eq('and not again for 30 s', events().filter((e) => e.type === 'text').length, 1);

  // Pausing.
  hot!.onPause();
  eq('the pause hotkey stops the capture and tells the page', [calls.filter((c) => c === 'capture-stop').length >= 2, events().some((e) => e.type === 'pause' && e.paused === true), await ipcHandle.get('pet:frame')!(fromApp, {})], [true, true, null]);
  hot!.onPause();
  await wait(30);
  eq('pressing it again resumes', [events().some((e) => e.type === 'pause' && e.paused === false), (await ipcHandle.get('pet:frame')!(fromApp, {})) !== null], [true, true]);

  // The 「暂停看屏」 button of her window: the same as the hotkey, but it says which side it wants.
  const pauses = () => events().filter((e) => e.type === 'pause').map((e) => e.paused);
  const nP = pauses().length;
  const stopsP = calls.filter((c) => c === 'capture-stop').length;
  ipcOn.get('pet-ui:pause')!({ sender: {} }, true);
  ipcOn.get('pet-ui:pause')!(fromEvil, true);
  ipcOn.get('pet-ui:pause')!(fromPetWin, 'yes');
  eq('only her window\'s own boolean pauses (another sender, a made-up value: nothing)', [pauses().length - nP, (await ipcHandle.get('pet:frame')!(fromApp, {})) !== null], [0, true]);
  ipcOn.get('pet-ui:pause')!(fromPetWin, true);
  eq('the button pauses like the hotkey: the capture stops, the brain is told, her window\'s state says paused, no picture is given',
    [pauses().slice(nP), calls.filter((c) => c === 'capture-stop').length > stopsP, win.states[win.states.length - 1].paused, await ipcHandle.get('pet:frame')!(fromApp, {})], [[true], true, true, null]);
  ipcOn.get('pet-ui:pause')!(fromPetWin, true);
  eq('…saying it twice is still one pause', pauses().slice(nP), [true]);
  ipcOn.get('pet-ui:pause')!(fromPetWin, false);
  await wait(30);
  eq('…and false resumes', [pauses().slice(nP), win.states[win.states.length - 1].paused, (await ipcHandle.get('pet:frame')!(fromApp, {})) !== null], [[true, false], false, true]);
  hot!.onPause();
  ipcOn.get('pet-ui:pause')!(fromPetWin, true);
  eq('the hotkey and the button share one pause state (hotkey paused it, the button asking for paused changes nothing)', pauses().slice(nP), [true, false, true]);
  ipcOn.get('pet-ui:pause')!(fromPetWin, false);
  await wait(30);

  // Saying things.
  eq('a bad line is refused', await ipcHandle.get('pet:say')!(fromApp, { nope: 1 }), { ok: false });
  const said = await ipcHandle.get('pet:say')!(fromApp, { id: 'l1', text: '你好呀', mood: 'talk', speak: true });
  await wait(20);
  eq('a spoken line shows the bubble and sends the voice', [said, (win.lines[0] as { text: string }).text, calls.includes('synth:你好呀'), (win.audio[0] as { seq: number; volume: number; mime: string }).volume, (win.audio[win.audio.length - 1] as { end?: boolean }).end], [{ ok: true }, '你好呀', true, 70, true]);
  const audio0 = win.audio[0] as { lineId: string; chunk: Uint8Array };
  eq('the audio arrives as bytes for that line', [audio0.lineId, audio0.chunk instanceof Uint8Array], ['l1', true]);
  const before = win.audio.length;
  await ipcHandle.get('pet:say')!(fromApp, { id: 'l2', text: '还在写…', mood: 'think', speak: true, streaming: true });
  await wait(20);
  eq('a line that is still being written is shown but not read', [win.lines.length, win.audio.length], [2, before]);


  // The pet window's own messages.
  ipcOn.get('pet-ui:ask')!({ sender: {} }, { text: 'x' });
  eq('a message from anything but the pet window is ignored', events().filter((e) => e.type === 'ask').length, 0);
  const cmdsBeforeAsk = win.cmds.length;
  ipcOn.get('pet-ui:ask')!(fromPetWin, { text: '  这个怎么打？  ' });
  eq('a message from the chat panel reaches the brain, goes into the log, and closes nothing', [events().find((e) => e.type === 'ask')?.text, lastPut()?.who, lastPut()?.text, win.cmds.length], ['这个怎么打？', 'me', '这个怎么打？', cmdsBeforeAsk]);
  const putsBefore = win.chat.length;
  ipcOn.get('pet-ui:ask')!(fromPetWin, { text: '   ' });
  eq('an empty message is ignored', [events().filter((e) => e.type === 'ask').length, win.chat.length], [1, putsBefore]);
  ipcOn.get('pet-ui:click')!({ sender: petWc, senderFrame: { url: 'file:///evil.html', parent: null } });
  ipcOn.get('pet-ui:click')!({ sender: petWc, senderFrame: { url: fromPetWin.senderFrame.url, parent: petWc.mainFrame } });
  ipcOn.get('pet-ui:click')!({ sender: {}, senderFrame: petWc.mainFrame });
  eq('her window is not enough: only her own page, in its top frame, is believed', events().filter((e) => e.type === 'click').length, 0);
  ipcOn.get('pet-ui:click')!(fromPetWin);
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'l1', state: 'end' });
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'l1', state: 'bogus' });
  eq('clicks and playback state are passed on', [events().filter((e) => e.type === 'click').length, events().filter((e) => e.type === 'spoken').length], [1, 1]);
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'l9', state: 'start' });
  pageReset!('gone');
  pageReset!('hide');
  eq('when her page is lost, a line it began reading is reported as ended (once), so the brain is not left waiting', events().filter((e) => e.type === 'spoken' && e.lineId === 'l9').map((e) => e.state), ['start', 'end']);
  ipcOn.get('pet-ui:hit')!(fromPetWin, true);
  ipcOn.get('pet-ui:drag')!(fromPetWin, { phase: 'start', x: NaN, y: NaN });
  ipcOn.get('pet-ui:drag')!(fromPetWin, { phase: 'fly', x: 1, y: 1 });
  eq('hit-testing and dragging go to the window (a made-up phase does not)', [calls.includes('interactive:true'), calls.filter((c) => c.startsWith('drag:'))], [true, ['drag:start']]);
  // The chat panel's log: her lines, as they reach the window.
  eq('her lines go into the log too; one still being written is marked so', synced().map((e: any) => [e.id, e.who, e.text, !!e.streaming]), [['l1', 'her', '你好呀', false], ['l2', 'her', '还在写…', true], [lastPut()!.id, 'me', '这个怎么打？', false]]);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'a1', text: '嗯……让我想想', mood: 'think', streaming: true });
  eq('a new reply starting drops the older one that never got past thinking', [win.chat[win.chat.length - 2], synced().map((e: any) => e.id).slice(0, 1)], [{ op: 'drop', id: 'l2' }, ['l1']]);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'a1', text: '先去', mood: 'talk', streaming: true });
  await ipcHandle.get('pet:say')!(fromApp, { id: 'a1', text: '先去左边。', more: '先去左边。\n再往前走。', mood: 'talk', speak: true });
  const a1 = synced().filter((e: any) => e.id === 'a1');
  eq('her reply grows in the same message and ends with the whole answer', [a1.length, a1[0].text, a1[0].more, !!a1[0].streaming, synced().map((e: any) => e.id).pop()], [1, '先去左边。', '先去左边。\n再往前走。', false, 'a1']);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'a2', text: '嗯，那', mood: 'talk', streaming: true });
  await ipcHandle.get('pet:say')!(fromApp, { id: 'a3', text: '让我想想', mood: 'think', streaming: true });
  eq('…an older reply that had words in it stays, as far as it got', synced().filter((e: any) => e.id === 'a2').map((e: any) => [e.text, !!e.streaming]), [['嗯，那', false]]);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'a3', text: '好。', mood: 'talk' });
  // A reply that stops without a last line (the user cut in, a newer line took over): it does not stay "typing" for good.
  const streamingIds = () => synced().filter((e: any) => e.streaming).map((e: any) => e.id);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'b1', text: '我觉得', mood: 'talk', streaming: true });
  await ipcHandle.get('pet:say')!(fromApp, { id: 'b2', text: '哇，好厉害。', mood: 'happy' });
  eq('any other line ends an older reply still being written: it stays as far as it got, not "typing"',
    [streamingIds(), synced().filter((e: any) => e.id === 'b1').map((e: any) => e.text)], [[], ['我觉得']]);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'b3', text: '让我想想', mood: 'think', streaming: true });
  await ipcHandle.get('pet:say')!(fromApp, { id: 'b4', text: '嗯？', mood: 'happy' });
  eq('…and one that never got past "let me think" goes', [streamingIds(), synced().some((e: any) => e.id === 'b3')], [[], false]);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'cl1', text: '先去左边！～（笑）', mood: 'talk', more: '先去左边！\n再往前走～' });
  eq('what the brain says is cleaned once more on the way to her window and the log (the second guard behind tidy.ts)', [win.lines[win.lines.length - 1].text, win.lines[win.lines.length - 1].more, lastPut()?.text, lastPut()?.more], ['先去左边。', '先去左边。\n再往前走', '先去左边。', '先去左边。\n再往前走']);

  // Opening the chat panel: the hotkey, the menu, a double-click / the chat button (the page asks), and closing it.
  hot!.onAsk();
  eq('the ask hotkey opens the chat panel and remembers the game to hand the keyboard back to', [lastCmd(), win.restore], [JSON.stringify({ type: 'chat' }), '4242']);
  const nLines = win.lines.length;
  await ipcHandle.get('pet:say')!(fromApp, { id: 'o1', text: '在呢。', mood: 'happy' });
  eq('her lines reach the window while the panel is open (bubble data and log)', [win.lines.length, (win.lines[nLines] as { id: string }).id, lastPut()?.id], [nLines + 1, 'o1', 'o1']);
  ipcOn.get('pet-ui:ask')!(fromPetWin, { text: '再说一遍' });
  eq('sending keeps the panel open', [win.chatOpen, lastCmd()], [true, JSON.stringify({ type: 'chat' })]);
  hot!.onAsk();
  eq('the hotkey again, while the panel has the keyboard, closes it', [lastCmd(), win.chatOpen], [JSON.stringify({ type: 'close-chat' }), false]);
  ipcOn.get('pet-ui:chat-open')!({ sender: {} });
  eq('only her own page may open it', lastCmd(), JSON.stringify({ type: 'close-chat' }));
  ipcOn.get('pet-ui:chat-open')!(fromPetWin);
  eq('a double-click on her (or the chat button) opens it', [lastCmd(), win.chatOpen], [JSON.stringify({ type: 'chat' }), true]);
  win.chatKeys = false; // the user clicked into another window
  win.restore = '';
  ipcOn.get('pet-ui:chat-focus')!(fromPetWin);
  eq('a click back into the open panel takes the keyboard again (and remembers whom to give it back to)', [calls.filter((c) => c === 'chat-focus').length, win.restore], [1, '4242']);
  ipcOn.get('pet-ui:chat-focus')!(fromPetWin);
  eq('…but not when it already has it', calls.filter((c) => c === 'chat-focus').length, 1);
  ipcOn.get('pet-ui:chat-close')!(fromPetWin);
  eq('Esc or × in the panel closes it', [lastCmd(), win.chatOpen], [JSON.stringify({ type: 'close-chat' }), false]);

  // The menu.
  ipcOn.get('pet-ui:menu')!(fromPetWin);
  menuItems.find((m) => m.label === '和她聊天')!.click!();
  eq('the menu has 「和她聊天」, which opens the panel', [lastCmd(), win.chatOpen], [JSON.stringify({ type: 'chat' }), true]);
  ipcOn.get('pet-ui:menu')!(fromPetWin);
  menuItems.find((m) => m.label === '收起聊天框')!.click!();
  eq('…and while it is open, an item to close it', win.chatOpen, false);
  ipcOn.get('pet-ui:menu')!(fromPetWin);
  const labels = menuItems.map((m) => m.label).filter(Boolean) as string[];
  expect('the menu offers "don\'t look at this game", pause, 实时陪玩, 小游戏, settings, 打开栖枝', labels.some((l) => l.includes('不看')) && labels.includes('暂停观看') && labels.some((l) => l.includes('实时陪玩')) && labels.includes('小游戏') && labels.includes('打开栖枝') && labels.includes('隐藏桌宠'), labels.join(' / '));
  const games = menuItems.find((m) => m.label === '小游戏')!.submenu!;
  eq('小游戏 lists the four games', games.map((g) => g.label), ['命途占卜', '引蝶', '词语接龙', '一起写童话']);
  games[0].click!();
  games[3].click!();
  eq('choosing one tells her window which game to start', win.cmds.slice(-2), [{ type: 'game', kind: 'tarot' }, { type: 'game', kind: 'tale' }]);
  menuItems.find((m) => m.label?.includes('不看'))!.click!();
  menuItems.find((m) => m.label === '桌宠设置…')!.click!();
  eq('menu choices go to the page as commands', commands.map(([c, s]) => [(c as { type: string }).type, s]), [['pet-watch', false], ['pet-settings', true]]);
  eq('the program is named in the command', (commands[0][0] as { exe: string; allow: boolean }).exe + ':' + (commands[0][0] as { allow: boolean }).allow, 'starrail.exe:false');

  // Voice and 实时陪玩.
  eq('the voices come through', await ipcHandle.get('pet:tts:voices')!(fromApp, 'minimax'), [{ id: 'minimax-1', name: 'one' }]);
  await ipcHandle.get('pet:tts:voices')!(fromApp, 'elevenlabs', { all: true });
  await ipcHandle.get('pet:tts:voices')!(fromApp, 'elevenlabs', { all: 'yes' });
  eq('the picker asks for the voices the user designed, and for all (ready-made ones too) only when the page says all: true', voiceArgs.map(([p, o]) => [p, (o as { all: boolean }).all]), [['minimax', false], ['elevenlabs', true], ['elevenlabs', false]]);
  eq('keys are saved by the voice module, and only hints come back', [await ipcHandle.get('pet:tts:key')!(fromApp, 'elevenlabs', 'sk-1234567890abcd'), await ipcHandle.get('pet:tts:keys')!(fromApp)], [{ ok: true, hint: '••••abcd', p: 'elevenlabs' }, { minimax: '••••abcd' }]);
  eq('a voice test plays in the pet window (which goes back to sleep if she is switched off)', [await ipcHandle.get('pet:tts:test')!(fromApp, { provider: 'edge', voiceId: '', text: '试听' }), win.audio.some((a) => (a as { lineId?: string }).lineId?.startsWith('test-')), calls.includes('park')], [{ ok: true }, true, true]);
  eq('an unknown service is refused', (await ipcHandle.get('pet:tts:test')!(fromApp, { provider: 'siri' }) as { ok: boolean }).ok, false);
  // 实时陪玩: start, read a reply aloud, cut her off, listen by hotkey.
  // The 「实时」 button of her window only asks the brain; the main process does not open it by itself.
  const evR = events().length;
  ipcOn.get('pet-ui:realtime')!(fromPetWin, true);
  ipcOn.get('pet-ui:realtime')!(fromPetWin, false);
  ipcOn.get('pet-ui:realtime')!(fromPetWin, 'on');
  ipcOn.get('pet-ui:realtime')!({ sender: {} }, true);
  ipcOn.get('pet-ui:realtime')!(fromEvil, true);
  eq('the button goes to the brain as rt-request (on, off); another sender or a made-up value does not, and nothing is started here',
    [events().slice(evR).map((e) => [e.type, e.on]), rtLog.filter((x) => x.startsWith('start:')).length, rtActive], [[['rt-request', true], ['rt-request', false]], 0, false]);
  const rt = (cmd: object) => ipcHandle.get('pet:rt')!(fromApp, cmd);
  eq('实时陪玩 starts with checked options', [await rt({ op: 'start', listen: 'loud', sensitivity: 900, fastVoice: true, autoOffMin: 1 }), rtLog.find((x) => x.startsWith('start:'))], [{ ok: true }, 'start:{"listen":"auto","sensitivity":100,"fastVoice":true,"autoOffMin":5}']);
  eq('the key is handed to the ears as a promise of the decrypted key, read when it is needed', await rtHooks!.key(), 'sk-el');
  eq('the pet window shows it is on, and may use the microphone now', [win.states[win.states.length - 1].realtime, win.mic], [true, true]);
  eq('a sentence of her reply is read as PCM, live, in her voice settings', [await rt({ op: 'say', id: 'L1', text: '嗯，开拓者先去左边的门。' }), liveLog[0], (win.audio[win.audio.length - 1] as { lineId: string; mime: string; live: boolean })],
    [{ ok: true }, 'live:嗯，开拓者先去左边的门。:true', { lineId: 'L1', seq: 0, chunk: new Uint8Array([1, 2, 3, 4]), mime: 'audio/pcm;rate=24000', volume: 70, live: true } as never]);
  eq('bad commands are refused', [await rt({ op: 'say', id: '', text: 'x' }), await rt({ op: 'dance' })], [{ ok: false, error: '命令无效' }, { ok: false, error: '命令无效' }]);
  liveHold = true;
  void rt({ op: 'say', id: 'L2', text: '那里有一个宝箱，记得打开。' });
  await ipcHandle.get('pet:say')!(fromApp, { id: 'L2', text: '那里有一个宝箱，', mood: 'talk', streaming: true });
  await wait(5);
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'L2', state: 'start' });
  const evN = events().length;
  const cmdN = win.cmds.length;
  rtHooks!.speechStart();
  eq('while she talks, a sound on the microphone does not cut her off by itself', [events().slice(evN).filter((e) => e.type === 'hear').length, win.cmds.length], [0, cmdN]);
  rtHooks!.partial('宝箱记得打开');
  eq('…nor her own words coming back through the speakers', win.cmds.length, cmdN);
  rtHooks!.partial('等一下我问你');
  eq('the user\'s own words cut her off at once', [win.cmds.slice(cmdN), events().slice(evN).filter((e) => e.type === 'hear').map((e) => e.state)], [[{ type: 'hush' }], ['start']]);
  eq('…and the reply she was cut off from stops "typing" in the log', synced().filter((e: any) => e.id === 'L2').map((e: any) => [e.text, !!e.streaming]), [['那里有一个宝箱，', false]]);
  rtHooks!.final('等一下我问你个事');
  eq('…and what they said goes to the brain', events().filter((e) => e.type === 'hear').pop() as unknown, { type: 'hear', state: 'final', text: '等一下我问你个事' });
  eq('…and into the chat log, marked as spoken', [lastPut()?.who, lastPut()?.text, lastPut()?.voice], ['me', '等一下我问你个事', true]);
  const nL = liveLog.length;
  eq('a late sentence of the reply she was cut off from is not read', [await rt({ op: 'say', id: 'L2', text: '还有一个宝箱。' }), liveLog.length], [{ ok: false }, nL]);
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'L2', state: 'end' });
  liveHold = false;
  liveRelease?.();
  rtHooks!.speechStart();
  rtHooks!.final('那里有一个宝箱记得打开');
  eq('her own sentence heard back is not a question', (events().filter((e) => e.type === 'hear').pop() as unknown as { state: string }).state, 'none');
  await wait(3200);
  rtHooks!.speechStart();
  rtHooks!.final('那里有一个宝箱');
  eq('…but the user saying the same words later is the user', (events().filter((e) => e.type === 'hear').pop() as unknown as { state: string }).state, 'final');
  liveHold = true;
  void rt({ op: 'say', id: 'L3', text: '我觉得可以先去左边看看。' });
  await wait(5);
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'L3', state: 'start' });
  const c3 = win.cmds.length;
  rtHooks!.speechStart();
  rtHooks!.partial('我觉');
  rtHooks!.partial('好');
  eq('a word or two is not enough to cut her off', win.cmds.length, c3);
  rtHooks!.final('好');
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'L3', state: 'end' });
  liveHold = false;
  liveRelease?.();
  await wait(5);
  // Her voice is switched off in the middle of a reply (one sentence being read, another queued): it stops at once.
  liveHold = true;
  void rt({ op: 'say', id: 'L5', text: '第一句话。' });
  await wait(5);
  void rt({ op: 'say', id: 'L5', text: '第二句话。' });
  await wait(5);
  const nHush = win.cmds.filter((c) => (c as { type: string }).type === 'hush').length;
  const nSaid = liveLog.length;
  ipcOn.get('pet:config')!(fromApp, { ...cfg, voice: { ...cfg.voice, enabled: false } });
  liveHold = false;
  liveRelease?.();
  await wait(20);
  eq('switching 朗读 off stops what she is saying now (her window is hushed) and the sentence queued behind it is never read', [win.cmds.filter((c) => (c as { type: string }).type === 'hush').length > nHush, liveLog.length - nSaid, liveLog.some((l) => l.includes('第二句话'))], [true, 0, false]);
  const nV = liveLog.length;
  eq('with her voice off a live reply is only shown', [await rt({ op: 'say', id: 'L4', text: '好的。' }), liveLog.length], [{ ok: true }, nV]);
  rtHooks!.speechStart();
  eq('…and the user is heard at once (nothing of hers is playing)', (events().filter((e) => e.type === 'hear').pop() as unknown as { state: string }).state, 'start');
  rtHooks!.none();
  ipcOn.get('pet:config')!(fromApp, cfg);
  await rt({ op: 'start', listen: 'key', sensitivity: 40, fastVoice: false, autoOffMin: 30 });
  eq('changing options while it runs updates the session', rtLog.filter((x) => x.startsWith('update:')).pop(), 'update:{"listen":"key","sensitivity":40,"fastVoice":false,"autoOffMin":30}');
  const askN = win.cmds.filter((c) => (c as { type: string }).type === 'chat').length;
  const logN = rtLog.length;
  hot!.onAsk();
  eq('in the hotkey mode the 呼出 key means "listen to me"', [rtLog.slice(logN).includes('listen'), win.cmds.filter((c) => (c as { type: string }).type === 'chat').length, win.states[win.states.length - 1].listening], [true, askN, true]);
  rtHooks!.none();
  eq('…and the ear goes away when nothing was said', win.states[win.states.length - 1].listening, false);
  await rt({ op: 'stop' });
  eq('stopping ends the session and the LIVE mark, and takes the microphone permission back', [rtLog.includes('stop'), win.states[win.states.length - 1].realtime, win.mic], [true, false, false]);
  // The page cannot open the microphone (or loses it): she would be deaf with LIVE showing.
  await rt({ op: 'start', listen: 'auto', sensitivity: 50, fastVoice: true, autoOffMin: 20 });
  ipcOn.get('pet-ui:mic-failed')!({ sender: {} });
  eq('only her own page can say the microphone failed', win.states[win.states.length - 1].realtime, true);
  ipcOn.get('pet-ui:mic-failed')!(fromPetWin);
  const micErr = events().filter((e) => e.type === 'rt').pop() as unknown as { state: string; message?: string };
  eq('a microphone that will not open ends 实时陪玩, with the reason', [micErr.state, !!micErr.message?.includes('麦克风'), win.states[win.states.length - 1].realtime], ['error', true, false]);

  /* ── small games (docs/PET-PLAN.md §2.1) ── */
  const nGames = win.games.length;
  ipcOn.get('pet:game-state')!(fromEvil, { kind: 'chain', active: true });
  eq('a game state from any other page is ignored', win.games.length, nGames);
  ipcOn.get('pet:game-state')!(fromApp, { kind: 'chain', active: true, nextChar: '棠花', turns: 3.7, hint: '轮到你，接「棠」', extra: 1 });
  ipcOn.get('pet:game-state')!(fromApp, { kind: 'poker', active: true });
  ipcOn.get('pet:game-state')!(fromApp, 'chain');
  eq('the game state goes to her window, checked field by field (a made-up game is dropped)', win.games.slice(nGames), [{ kind: 'chain', active: true, nextChar: '棠', turns: 3, hint: '轮到你，接「棠」' }]);
  eq('only the fields of PetGameState survive', hub._internals.sanitizeGame({ kind: 'tale', active: false, evil: 1 }), { kind: 'tale', active: false });

  const evG = events().length;
  ipcOn.get('pet-ui:game')!(fromPetWin, { op: 'start', kind: 'tarot' });
  ipcOn.get('pet-ui:game')!(fromPetWin, { op: 'stop', kind: 'butterfly' });
  ipcOn.get('pet-ui:game')!(fromPetWin, { op: 'pause', kind: 'chain' });
  ipcOn.get('pet-ui:game')!(fromPetWin, { op: 'start', kind: 'poker' });
  ipcOn.get('pet-ui:game')!({ sender: {} }, { op: 'start', kind: 'chain' });
  eq('starting and stopping a game goes to the brain as a game event; a made-up op or game, or another sender, does not',
    events().slice(evG).map((e) => [e.type, e.op, e.kind]), [['game', 'start', 'tarot'], ['game', 'stop', 'butterfly']]);

  const linesG = win.lines.length;
  const audioG = win.audio.length;
  ipcOn.get('pet-ui:game-say')!(fromPetWin, { text: ' 抽到这一张了！～别太在意。 ', mood: 'shy', card: 'remembrance' });
  await wait(20);
  const gl = win.lines[linesG];
  eq('a line the game says is cleaned (「！」 becomes 「。」, 「～」 goes), shown, entered in the log as a card, and read when her voice is on',
    [gl.text, gl.mood, gl.speak, lastPut()?.kind, lastPut()?.card, lastPut()?.who, lastPut()?.text, win.audio.length > audioG, calls.includes('synth:抽到这一张了。别太在意。')], ['抽到这一张了。别太在意。', 'shy', true, 'card', 'remembrance', 'her', '抽到这一张了。别太在意。', true, true]);
  eq('the game\'s cleaning: full-width 「！」、「～」 and runs of 「。」, cut to 140 characters', [hub._internals.gameText('好！！～真棒！'), Array.from(hub._internals.gameText('字'.repeat(300))).length, hub._internals.gameText('   '), hub._internals.gameText(undefined)], ['好。真棒。', 140, '', '']);
  ipcOn.get('pet-ui:game-say')!(fromPetWin, { text: '没有牌。', card: '../evil', mood: 'angry' });
  await wait(5);
  eq('a card name that is not a plain word, and a mood she does not have, are dropped', [lastPut()?.kind, lastPut()?.card, lastPut()?.mood], [undefined, undefined, undefined]);
  const nSay = win.lines.length;
  ipcOn.get('pet-ui:game-say')!({ sender: {} }, { text: '谁都能说话吗' });
  ipcOn.get('pet-ui:game-say')!(fromPetWin, { text: '！～' });
  ipcOn.get('pet-ui:game-say')!(fromPetWin, 'text');
  eq('another sender, an empty line (nothing left after cleaning) and a made-up shape say nothing', win.lines.length, nSay);
  for (let i = 0; i < 12; i++) ipcOn.get('pet-ui:game-say')!(fromPetWin, { text: `第${i}句。` });
  eq('a page that keeps sending is let through at most 8 lines in 10 seconds (two went through above, so six of these twelve)', win.lines.length - nSay, 6);

  /* ── tales (pet-tales.json) ── */
  const tale = { words: ['雪', '灯', '蝴蝶'], title: '雪夜的灯', text: '雪落下来，灯亮着，一只蝴蝶停在窗边！～等了很久。' };
  eq('a tale needs words, a title and a text', [await ipcHandle.get('pet:tale:save')!(fromApp, { ...tale, words: [] }), await ipcHandle.get('pet:tale:save')!(fromApp, { ...tale, title: '' }), await ipcHandle.get('pet:tale:save')!(fromApp, 'x')].map((r: any) => r.ok), [false, false, false]);
  let taleDenied = '';
  try { await ipcHandle.get('pet:tale:save')!(fromEvil, tale); } catch (e) { taleDenied = (e as Error).message; }
  expect('only the app page may save one', taleDenied.startsWith('拒绝'), taleDenied);
  const s1: any = await ipcHandle.get('pet:tale:save')!(fromApp, tale);
  eq('saving returns the tale with an id and a time, cleaned the same way', [s1.ok, typeof s1.tale.id, s1.tale.words, s1.tale.title, s1.tale.text, typeof s1.tale.at], [true, 'string', ['雪', '灯', '蝴蝶'], '雪夜的灯', '雪落下来，灯亮着，一只蝴蝶停在窗边。等了很久。', 'number']);
  const file = path.join(userData, 'pet-tales.json');
  expect('it is in userData/pet-tales.json (and not in window-state.json)', fs.existsSync(file) && !fs.existsSync(path.join(userData, 'window-state.json')));
  await wait(3);
  const s2: any = await ipcHandle.get('pet:tale:save')!(fromApp, { ...tale, title: '第二篇' });
  const listed: any = await ipcHandle.get('pet-ui:tales')!(fromPetWin);
  eq('the pet window lists them newest first', listed.map((t: any) => t.title), ['第二篇', '雪夜的灯']);
  let notPet = '';
  try { await ipcHandle.get('pet-ui:tales')!({ sender: {} }); } catch (e) { notPet = (e as Error).message; }
  expect('…and only her own page may ask', notPet.startsWith('拒绝'), notPet);
  void s2;
  for (let i = 0; i < 105; i++) await ipcHandle.get('pet:tale:save')!(fromApp, { ...tale, title: `多余的 ${i}` });
  const many: any = await ipcHandle.get('pet-ui:tales')!(fromPetWin);
  eq('at most 100 are kept, the oldest go first', [many.length, many[0].title, many.some((t: any) => t.title === '雪夜的灯')], [100, '多余的 104', false]);
  fs.writeFileSync(file, '{ not json');
  eq('a damaged file reads as no tales, without throwing', await ipcHandle.get('pet-ui:tales')!(fromPetWin), []);
  const s3: any = await ipcHandle.get('pet:tale:save')!(fromApp, { ...tale, title: '重新开始' });
  expect('saving after that works, and the damaged file is set aside, not overwritten', s3.ok && fs.readdirSync(userData).some((f) => f.startsWith('pet-tales.json.corrupt-')) && JSON.parse(fs.readFileSync(file, 'utf8')).tales.length === 1);
  fs.writeFileSync(file, JSON.stringify({ version: 1, tales: [{ id: 'ok', words: ['a'], title: 't', text: 'x', at: 5 }, { id: 'no-text', words: ['a'], title: 't', at: 4 }, null, 7, { id: '', words: ['a'], title: 't', text: 'x', at: 3 }] }));
  eq('entries with a broken shape are dropped, the rest stay', ((await ipcHandle.get('pet-ui:tales')!(fromPetWin)) as any[]).map((t) => t.id), ['ok']);
  // A tale in the chat log, saved from the window with 「存下」.
  await ipcHandle.get('pet:say')!(fromApp, { id: 'tl1', text: '雪夜的灯', kind: 'tale', tale, more: tale.text, mood: 'talk' });
  const te = synced().find((e: any) => e.id === 'tl1');
  eq('a tale the brain says is a letter in the log (kind tale, unsaved: no id)', [te.kind, te.tale.title, te.tale.id], ['tale', '雪夜的灯', undefined]);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'tl2', text: '《雪夜的灯》\n雪落下来。', kind: 'tale' });
  const te2 = synced().find((e: any) => e.id === 'tl2');
  eq('…one with only the letter text (the window finds 《标题》 in it) is a tale too', [te2.kind, te2.tale], ['tale', undefined]);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'tl3', text: 'x', kind: 'card', card: 'hunt' });
  await ipcHandle.get('pet:say')!(fromApp, { id: 'tl4', text: 'x', kind: 'rubbish', tale: tale });
  eq('a card is only ever flipped by her own window; any other kind from the page is an ordinary line', [synced().find((e: any) => e.id === 'tl3').kind, synced().find((e: any) => e.id === 'tl3').card, synced().find((e: any) => e.id === 'tl4').kind], [undefined, undefined, undefined]);
  // 「存下」 on the letter: the window brings the words, the title and the text itself.
  const mine = { words: ['雪', '灯', '蝴蝶'], title: '窗边的蝴蝶', text: '灯亮着！～有一只蝴蝶。' };
  const ts: any = await ipcHandle.get('pet-ui:tale-save')!(fromPetWin, mine);
  eq('「存下」 in her window writes the same pet-tales.json, cleaned and numbered like the page\'s',
    [ts.ok, typeof ts.tale.id, ts.tale.text, ((await ipcHandle.get('pet-ui:tales')!(fromPetWin)) as any[]).map((t) => t.title)], [true, 'string', '灯亮着。有一只蝴蝶。', ['窗边的蝴蝶', 't']]);
  eq('…a body that is not complete, or not an object, is refused in words', [await ipcHandle.get('pet-ui:tale-save')!(fromPetWin, { ...mine, words: [] }), await ipcHandle.get('pet-ui:tale-save')!(fromPetWin, 'tl1')].map((r: any) => [r.ok, typeof r.error]), [[false, 'string'], [false, 'string']]);
  let saveDenied = '';
  try { await ipcHandle.get('pet-ui:tale-save')!({ sender: {} }, mine); } catch (e) { saveDenied = (e as Error).message; }
  try { await ipcHandle.get('pet-ui:tale-save')!(fromApp, mine); } catch (e) { saveDenied += (e as Error).message; }
  eq('…and only her own page may use this door (the app page has its own, pet:tale:save)', saveDenied.split('拒绝').length - 1, 2);
  fs.writeFileSync(file, '{ not json');
  const afterBroken: any = await ipcHandle.get('pet-ui:tale-save')!(fromPetWin, mine);
  eq('saving from her window over a damaged file also works and keeps the damaged one aside', [afterBroken.ok, fs.readdirSync(userData).filter((f) => f.startsWith('pet-tales.json.corrupt-')).length >= 2], [true, true]);
  // A file that cannot be READ (EBUSY, EPERM: a virus scan or another program holds it) is nothing to set aside: say so, leave it.
  const corrupt = () => fs.readdirSync(userData).filter((f) => f.startsWith('pet-tales.json.corrupt-')).length;
  const beforeBusy = fs.readFileSync(file, 'utf8');
  const nCorrupt = corrupt();
  const realRead = fs.readFileSync;
  (fs as any).readFileSync = (f: any, ...a: any[]) => { if (String(f) === file) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }); return (realRead as any)(f, ...a); };
  let busy: any;
  let busyList: any;
  try { busy = await ipcHandle.get('pet-ui:tale-save')!(fromPetWin, mine); busyList = await ipcHandle.get('pet-ui:tales')!(fromPetWin); } finally { (fs as any).readFileSync = realRead; }
  eq('so saving over one that is busy fails with a sentence that says try again, and the file is untouched', [busy.ok, /过一会儿再存/.test(busy.error), fs.readFileSync(file, 'utf8') === beforeBusy, corrupt() === nCorrupt], [false, true, true, true]);
  eq('…listing it then is empty without throwing', busyList, []);
  fs.writeFileSync(file, JSON.stringify({ nope: 1 }));
  const shapeSave: any = await ipcHandle.get('pet:tale:save')!(fromApp, tale);
  eq('a file that reads fine but is not a tale file (valid JSON, wrong shape) is damaged: set aside, and saving goes on', [shapeSave.ok, corrupt() === nCorrupt + 1], [true, true]);

  /* ── her eyes follow the cursor ── */
  const looks = () => win.cmds.filter((c: any) => c.type === 'look');
  const stopFollow = () => ipcOn.get('pet:config')!(fromApp, { ...cfg, follow: false });
  stopFollow();
  await wait(80);
  const nl0 = looks().length;
  fakeScreen.cursor = { x: 300, y: 40 };
  await wait(150);
  eq('follow off: the cursor is not looked at', looks().length, nl0);
  fakeScreen.factor = 1.5;
  ipcOn.get('pet:config')!(fromApp, cfg);
  onFocus!({ exe: 'notepad.exe', title: 'n', pid: 9, hwnd: '555', fullscreen: 'no', rect: {} });
  await wait(1750);
  await wait(150);
  const l1 = looks();
  eq('follow on, she is seen and no game is in front: the cursor goes out as dx / dy from the middle of her head, in physical pixels',
    [l1.length > nl0, l1[l1.length - 1]], [true, { type: 'look', dx: Math.round((300 - 100) * 1.5), dy: Math.round((40 - 100) * 1.5) }]);
  const nl1 = looks().length;
  await wait(250);
  eq('a cursor that holds still is not sent again', looks().length, nl1);
  fakeScreen.cursor = { x: 310, y: 40 };
  await wait(150);
  eq('…one that moves is', [looks().length, looks()[looks().length - 1].dx], [nl1 + 1, Math.round((310 - 100) * 1.5)]);
  setVisible(false);
  fakeScreen.cursor = { x: 50, y: 50 };
  await wait(300);
  const nl2 = looks().length;
  eq('she is hidden: the cursor is not read, nothing is sent (the timer has stopped)', looks()[nl2 - 1].dx, Math.round((310 - 100) * 1.5));
  fakeScreen.cursor = { x: 60, y: 60 };
  await wait(150);
  eq('…not even after a while', looks().length, nl2);
  setVisible(true);
  await wait(150);
  eq('shown again: the window says so, the reading starts again and the cursor is sent at once', looks()[looks().length - 1].dx, Math.round((60 - 100) * 1.5));
  onFocus!({ exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} });
  await wait(1750);
  const nl3 = looks().length;
  fakeScreen.cursor = { x: 700, y: 400 };
  await wait(200);
  eq('a game in front: the cursor is not read at all', looks().length, nl3);
  onFocus!({ exe: 'notepad.exe', title: 'n', pid: 9, hwnd: '555', fullscreen: 'no', rect: {} });
  await wait(1750);
  await wait(150);
  eq('…and back out of the game it is', looks()[looks().length - 1].dx, Math.round((700 - 100) * 1.5));
  // A full-screen program that is not a game (a video, a presentation) counts as well.
  onFocus!({ exe: 'vlc.exe', title: '视频', pid: 13, hwnd: '700', fullscreen: 'borderless', rect: {} });
  await wait(1750);
  const nl5 = looks().length;
  fakeScreen.cursor = { x: 900, y: 500 };
  await wait(200);
  eq('a full-screen program in front (not a game): the cursor is not read and the window is told follow is off', [looks().length, win.states[win.states.length - 1].follow], [nl5, false]);
  onFocus!({ exe: 'notepad.exe', title: 'n', pid: 9, hwnd: '555', fullscreen: 'no', rect: {} });
  await wait(1750);
  await wait(150);
  eq('…and when it is gone the reading starts again by itself (the state change starts it)', [looks().length > nl5, looks()[looks().length - 1].dx, win.states[win.states.length - 1].follow], [true, Math.round((900 - 100) * 1.5), true]);
  fakeScreen.factor = 1;

  /* ── the app page goes away and comes back (crash, reload, navigation) ── */
  const starrail = { exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} };
  onFocus!(starrail);
  await wait(1750);
  await rt({ op: 'start', listen: 'auto', sensitivity: 50, fastVoice: true, autoOffMin: 20 });
  liveHold = true;
  void rt({ op: 'say', id: 'P1', text: '我正在说话。' });
  await wait(5);
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'P1', state: 'start' });
  await ipcHandle.get('pet:say')!(fromApp, { id: 'p2', text: '写到一半', mood: 'talk', streaming: true });
  const evBefore = events().length;
  const toPageBefore = toPage.length;
  const cmdBefore = win.cmds.length;
  const stopsBefore = calls.filter((c) => c === 'capture-stop').length;
  const rtStopsBefore = rtLog.filter((x) => x === 'stop').length;
  hub.pageLost();
  liveHold = false;
  liveRelease?.();
  eq('the page goes away: 实时陪玩 ends and the microphone permission is taken back, she stops talking, the capture closes',
    [rtActive, rtLog.filter((x) => x === 'stop').length - rtStopsBefore, win.states[win.states.length - 1].realtime, win.mic, win.cmds.slice(cmdBefore).some((c: any) => c.type === 'hush'), calls.filter((c) => c === 'capture-stop').length > stopsBefore, cap.live],
    [false, 1, false, false, true, true, false]);
  eq('…a reply she was writing stops "typing", and the line the page was told began is reported ended nowhere (the page is gone)', [synced().filter((e: any) => e.id === 'p2').map((e: any) => !!e.streaming), toPage.length - toPageBefore], [[false], 0]);
  const nlG = looks().length;
  fakeScreen.cursor = { x: 11, y: 11 };
  await wait(150);
  eq('…and her eyes stop reading the cursor', looks().length, nlG);
  hot!.onAsk();
  ipcOn.get('pet-ui:click')!(fromPetWin);
  ipcOn.get('pet-ui:ask')!(fromPetWin, { text: '有人在吗' });
  eq('…and whatever the pet window sends meanwhile is not forwarded to a page that is gone', toPage.length - toPageBefore, 0);
  ipcOn.get('pet-ui:ask')!(fromPetWin, { text: '   ' });
  ipcOn.get('pet:config')!(fromApp, cfg);
  eq('a pet:config while the new page is still loading is a late message of the page that is leaving: ignored (no capture, nothing sent)', [cap.live, toPage.length - toPageBefore], [false, 0]);
  hub.pageLoaded();
  ipcOn.get('pet:config')!(fromApp, cfg);
  await wait(60);
  const back = events().slice(evBefore);
  eq('the new page\'s first pet:config brings the program in front, the hotkeys and the end of 实时陪玩 (with the reason) to its brain',
    [back.some((e) => e.type === 'hotkeys' && e.ask === true && e.pause === true), (back.find((e) => e.type === 'focus')?.app as { exe: string })?.exe, back.some((e) => e.type === 'pause'), (back.find((e) => e.type === 'rt') as { state: string; message?: string } | undefined)?.state, !!(back.find((e) => e.type === 'rt') as { message?: string } | undefined)?.message?.includes('重新加载')],
    [true, 'starrail.exe', false, 'closed', true]);
  eq('…and she looks at the game again', [cap.live, (await ipcHandle.get('pet:frame')!(fromApp, {})) !== null], [true, true]);
  hot!.onPause();
  hub.pageLost();
  hub.pageLoaded();
  const evBefore2 = events().length;
  ipcOn.get('pet:config')!(fromApp, cfg);
  await wait(30);
  eq('if she was paused she is told so as well, and stays paused (no capture)', [events().slice(evBefore2).filter((e) => e.type === 'pause').map((e) => e.paused), events().slice(evBefore2).some((e) => e.type === 'rt'), cap.live], [[true], false, false]);
  hot!.onPause();
  await wait(30);
  hub.pageLost();
  hub.pageLost();
  hub.pageLoaded();
  ipcOn.get('pet:config')!(fromApp, cfg);
  await wait(30);
  eq('(once is enough: a second pageLost before the page is back changes nothing; after the pause is lifted she looks again)', cap.live, true);
  onFocus!({ exe: 'notepad.exe', title: 'n', pid: 9, hwnd: '555', fullscreen: 'no', rect: {} });
  await wait(1750);
  const nlH = looks().length;
  fakeScreen.cursor = { x: 21, y: 21 };
  await wait(150);
  eq('…and so do her eyes, when no game is in front', looks().length > nlH, true);

  // Changing the lists re-classifies the program in front.
  onFocus!({ exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} });
  await wait(1750);
  const n0 = events().filter((e) => e.type === 'focus').length;
  ipcOn.get('pet:config')!(fromApp, { ...cfg, gameDeny: ['starrail.exe'] });
  await wait(20);
  const lastFocus = events().filter((e) => e.type === 'focus').pop() as unknown as { app: { policy: string } };
  eq('moving a game to "don\'t watch" takes effect at once: no more capture', [events().filter((e) => e.type === 'focus').length, lastFocus.app.policy, cap.live], [n0 + 1, 'chat-only', false]);

  // An anti-cheat game in front: her window (a transparent always-on-top overlay) goes at once and she says nothing over it.
  const hides0 = calls.filter((c) => c === 'hide').length;
  const shows0 = calls.filter((c) => c === 'show').length;
  await ipcHandle.get('pet:say')!(fromApp, { id: 'ac0', text: '这一关的', mood: 'talk', streaming: true });
  await rt({ op: 'start', listen: 'auto', sensitivity: 50, fastVoice: true, autoOffMin: 20 });
  onFocus!({ exe: 'valorant.exe', title: 'VALORANT', pid: 11, hwnd: '900', fullscreen: 'exclusive', rect: {} });
  eq('an anti-cheat game takes the front: her window is hidden at once', calls.filter((c) => c === 'hide').length, hides0 + 1);
  const acRt = events().filter((e) => e.type === 'rt').pop() as unknown as { state: string; message?: string };
  eq('…and 实时陪玩 ends with it (no microphone or recogniser running unseen), saying why', [rtActive, acRt.state, !!acRt.message?.includes('反作弊')], [false, 'closed', true]);
  const startsBefore = rtLog.filter((x) => x.startsWith('start:')).length;
  const refusedRt = await rt({ op: 'start', listen: 'auto', sensitivity: 50, fastVoice: true, autoOffMin: 20 }) as { ok: boolean; error?: string };
  eq('…and it cannot be started over the game either: refused with the reason, nothing is opened', [refusedRt.ok, !!refusedRt.error?.includes('反作弊'), rtLog.filter((x) => x.startsWith('start:')).length - startsBefore, win.mic], [false, true, 0, false]);
  eq('…and a reply she was writing stops "typing" (its end will not be shown)', synced().filter((e: any) => e.id === 'ac0').map((e: any) => !!e.streaming), [false]);
  eq('and she says nothing over it', await ipcHandle.get('pet:say')!(fromApp, { id: 'ac1', text: '嗨' }), { ok: false });
  ipcOn.get('pet-ui:game-say')!(fromPetWin, { text: '占卜的一句。' });
  eq('…not even a game\'s line', synced().some((e: any) => e.text === '占卜的一句。'), false);
  await wait(1750);
  onFocus!({ exe: 'notepad.exe', title: 'n', pid: 9, hwnd: '555', fullscreen: 'no', rect: {} });
  await wait(1750);
  eq('she is shown again once it is no longer in front', [calls.filter((c) => c === 'show').length > shows0, await ipcHandle.get('pet:say')!(fromApp, { id: 'ac2', text: '嗨' })], [true, { ok: true }]);

  // Switching off.
  const hides1 = calls.filter((c) => c === 'hide').length;
  await ipcHandle.get('pet:say')!(fromApp, { id: 'off0', text: '那我', mood: 'talk', streaming: true });
  ipcOn.get('pet:config')!(fromApp, { ...cfg, enabled: false });
  eq('switching off hides the window, drops the hotkeys and stops sensing', [calls.filter((c) => c === 'hide').length > hides1, hot, sensing], [true, undefined, false]);
  eq('…the page hears no hotkey works now', events().filter((e) => e.type === 'hotkeys').pop() as unknown, { type: 'hotkeys', ask: false, pause: false, errors: [] });
  eq('…and nothing in the log is left "typing"', synced().filter((e: any) => e.streaming).length, 0);
  const nl4 = looks().length;
  fakeScreen.cursor = { x: 5, y: 5 };
  await wait(200);
  eq('…and her eyes stop reading the cursor', looks().length, nl4);
  hub.stopAll();
  expect('quitting leaves nothing running, and her window is not built again once it closes', calls.includes('capture-dispose') && calls.includes('window-shutdown'));
}

// 2b. A probe run (ALIGHT_PROBE=1): no pet window, no sensing, no changes to Chromium's switches.
{
  const calls: string[] = [];
  const nSwitches = switches.length;
  const nCap = partitions.length;
  const stub = (rel: string, extra: Record<string, unknown> = {}) => fake(rel, new Proxy({ ...extra }, { get: (t: any, k: string) => (k in t ? t[k] : (...a: unknown[]) => { calls.push(`${rel.split('/').pop()}.${k}`); return a.length ? undefined : false; }) }));
  stub('./electron/pet/window.cjs', { onReset: () => () => {}, onVisibility: () => () => {}, whenReady: async () => {}, isVisible: () => false, chatState: () => ({ open: false, focused: false }) });
  stub('./electron/pet/capture.cjs', { onScene: () => () => {}, onLive: () => () => {}, status: () => ({ active: false, live: false, hwnd: null }) });
  stub('./electron/pet/sense.cjs', { running: () => false });
  stub('./electron/pet/hotkeys.cjs', { apply: () => ({ ok: true, errors: [], ask: true, pause: true }) });
  process.env.ALIGHT_PROBE = '1';
  try {
    delete modules[req.resolve('./electron/pet/index.cjs')];
    const hub = req('./electron/pet/index.cjs') as { beforeReady(): void; register(h: object): void; stopAll(): void };
    hub.beforeReady();
    eq('a probe run does not turn off Chromium\'s window-occlusion detection', switches.length, nSwitches);
    const mainWc = { isDestroyed: () => false, send() {} };
    const frame = { url: 'x' };
    hub.register({ getMainWindow: () => ({ isDestroyed: () => false, webContents: mainWc }), showMainWindow() {}, sendCommandToPage() {}, isAppSender: (e: any) => e.senderFrame === frame });
    ipcOn.get('pet:config')!({ sender: mainWc, senderFrame: frame }, { enabled: true, watch: true, follow: true, voice: { enabled: true } });
    await wait(80);
    eq('…and switching her on creates no window, no sensing, no hotkeys, no capture page',
      [calls.filter((c) => /^(window\.cjs\.(show|create|applyScale)|sense\.cjs\.start|capture\.cjs\.(init|start)|hotkeys\.cjs\.apply)$/.test(c)), partitions.length - nCap], [[], 0]);
    const t: any = await ipcHandle.get('pet:tts:test')!({ sender: mainWc, senderFrame: frame }, { provider: 'edge', text: 'x' });
    eq('a voice test does not build her window either', [t.ok, calls.includes('window.cjs.create')], [false, false]);
    hub.stopAll();
  } finally { process.env.ALIGHT_PROBE = ''; }
}

// 3. The pet window itself (window.cjs): the chat panel's size and the keyboard.
console.log('Pet window');
{
  type Rect = { x: number; y: number; width: number; height: number };
  type Fn = (...a: unknown[]) => void;
  class FakePetWindow {
    static last: FakePetWindow | undefined;
    static made = 0;
    bounds: Rect;
    focusable: boolean;
    focused = false;
    visible = false;
    /** The OS will not hand over the keyboard. */
    refuse = false;
    /** Like Windows at 150 % display scaling: at an odd y the window reads back a pixel taller than it was set. */
    offByOne = false;
    /** Like a real transparent window at 150 %: it reads back 2 px wider and taller than it was set. */
    pad = 0;
    /** setBounds calls: each one can make a transparent window flash. */
    sets = 0;
    ignore: boolean | null = null;
    destroyed = false;
    sent: Array<[string, any]> = [];
    private on_ = new Map<string, Fn[]>();
    private wcOn = new Map<string, Fn[]>();
    webContents = {
      send: (c: string, p: any) => { this.sent.push([c, p]); },
      on: (ev: string, fn: Fn) => { this.wcOn.set(ev, [...(this.wcOn.get(ev) ?? []), fn]); },
      setWindowOpenHandler() {}, setBackgroundThrottling() {}, isDestroyed: () => this.destroyed,
    };
    constructor(o: Rect & { focusable?: boolean }) {
      this.bounds = { x: o.x, y: o.y, width: o.width, height: o.height };
      this.focusable = o.focusable !== false;
      FakePetWindow.last = this;
      FakePetWindow.made++;
    }
    on(ev: string, fn: Fn) { this.on_.set(ev, [...(this.on_.get(ev) ?? []), fn]); }
    once(ev: string, fn: Fn) { this.on(ev, fn); }
    emit(ev: string) { (this.on_.get(ev) ?? []).forEach((fn) => fn()); }
    emitWc(ev: string, details: object = {}) { (this.wcOn.get(ev) ?? []).forEach((fn) => fn({}, details)); }
    getBounds() { return { ...this.bounds, width: this.bounds.width + this.pad, height: this.bounds.height + this.pad + (this.offByOne && Math.abs(this.bounds.y) % 2 ? 1 : 0) }; }
    setBounds(r: Rect) { this.bounds = { ...r }; this.sets++; }
    setFocusable(v: boolean) { this.focusable = v; }
    setSkipTaskbar() {}
    setAlwaysOnTop() {}
    setIgnoreMouseEvents(v: boolean) { this.ignore = v; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; this.emit('show'); }
    hide() { this.blurTo(); this.visible = false; this.emit('hide'); }
    isFocused() { return this.focused; }
    focus() { if (this.focusable && !this.refuse && !this.focused) { this.focused = true; this.emit('focus'); } }
    /** The user clicks into another window. */
    blurTo() { if (this.focused) { this.focused = false; this.emit('blur'); } }
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed'); }
    /** Alt+F4. */
    close() { this.destroy(); }
    loadFile() { setTimeout(() => { this.emit('ready-to-show'); this.emitWc('did-finish-load'); }, 5); return Promise.resolve(); }
    reload() { setTimeout(() => this.emitWc('did-finish-load'), 5); }
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(777n); return b; }
  }
  // Her own box is 340 x 360 (at size 1), and the window is always 230 taller than that for the chat panel: 340 x 590.
  const W = 340;
  const H = 360;
  const TALL = 590;
  const UP = TALL - H;
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-pet-check-'));
  const fe = fakeElectron as Record<string, unknown>;
  fe.BrowserWindow = FakePetWindow;
  const screenOn = new Map<string, Fn[]>();
  fe.screen = {
    getDisplayNearestPoint: () => display, getPrimaryDisplay: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    on: (ev: string, fn: Fn) => { screenOn.set(ev, [...(screenOn.get(ev) ?? []), fn]); },
  };
  const screensChanged = () => (screenOn.get('display-metrics-changed') ?? []).forEach((fn) => fn());
  fakeElectron.app.getPath = () => tmp;
  const pNames = partitions.length;
  delete modules[req.resolve('./electron/pet/window.cjs')];
  const pw = req('./electron/pet/window.cjs') as {
    show(): void; hide(): void; sendCommand(c: { type: string }): void; chatState(): { open: boolean; focused: boolean }; focusChat(): void;
    drag(phase: string, x: number, y: number): void; applyScale(s: number): void; setInteractive(on: boolean): void; shutdown(): void;
    sendGame(g: object | null): void; headPoint(): { x: number; y: number } | null; _internals: { BASE_W: number; BASE_H: number; CHAT_H: number };
    allowMic(on: boolean): void; onVisibility(fn: () => void): () => void;
  };
  eq('her box is 340 x 360 and the panel gets 230 above it', [pw._internals.BASE_W, pw._internals.BASE_H, pw._internals.CHAT_H], [W, H, 230]);
  const saved = () => (JSON.parse(fs.readFileSync(path.join(tmp, 'pet-state.json'), 'utf8')) as { petBounds: Rect }).petBounds;
  const told = (w: FakePetWindow) => w.sent.filter(([c]) => c === 'pet-ui:command').map(([, p]) => p.type);
  pw.show();
  await wait(300);
  const w = FakePetWindow.last!;
  eq('she has her own session, alight-pet', partitions.slice(pNames), ['alight-pet']);
  // The microphone: only while 实时陪玩 is on.
  const ps = sessions['alight-pet'];
  const askMic = (types: string[], wc: any = w.webContents) => new Promise<boolean>((resolve) => ps.req!(wc, 'media', resolve, { mediaTypes: types }));
  eq('her window gets no microphone while 实时陪玩 is off', [await askMic(['audio']), ps.check!(w.webContents, 'media')], [false, false]);
  pw.allowMic(true);
  eq('…it does once it is on — the microphone only: no camera, no other contents, no other permission',
    [await askMic(['audio']), await askMic(['audio', 'video']), await askMic([]), await askMic(['audio'], {}), ps.check!(w.webContents, 'media'), ps.check!({}, 'media'), ps.check!(w.webContents, 'notifications')], [true, false, false, false, true, false, false]);
  pw.allowMic(false);
  eq('…and not any more when it ends', [await askMic(['audio']), ps.check!(w.webContents, 'media')], [false, false]);
  let seenVis = 0;
  pw.onVisibility(() => { seenVis++; });
  eq('she starts on the taskbar at the bottom right, in a window already as tall as with the panel open, that never takes the keyboard',
    [w.getBounds(), w.focusable, w.visible], [{ x: 1920 - W - 12, y: 1032 - TALL, width: W, height: TALL }, false, true]);
  const x0 = 1920 - W - 12;
  const y0 = 1032 - H; // where she stands

  let sets = w.sets;
  pw.sendCommand({ type: 'chat' });
  eq('opening the chat neither moves nor resizes the window (a transparent window that grows upward flashes on Windows)',
    [w.getBounds(), w.sets - sets], [{ x: x0, y: y0 - UP, width: W, height: TALL }, 0]);
  eq('…takes the keyboard, and tells the page', [w.focusable, w.focused, pw.chatState(), told(w).pop()], [true, true, { open: true, focused: true }, 'chat']);
  eq('the open panel does not make the whole window swallow clicks (only where the page says)', w.ignore, true);
  pw.setInteractive(true);
  eq('…the panel itself does', w.ignore, false);
  pw.setInteractive(false);
  w.blurTo();
  eq('clicking elsewhere lets go of the keyboard and is click-through again, but the panel stays open and the window tall',
    [w.focusable, w.ignore, pw.chatState(), w.getBounds().height, told(w).includes('close-chat')], [false, true, { open: true, focused: false }, TALL, false]);
  pw.focusChat();
  eq('a click back into the panel takes the keyboard again', [w.focusable, w.focused, pw.chatState().focused], [true, true, true]);

  pw.drag('start', 1000, 900);
  pw.drag('move', 900, 900);
  pw.drag('end', 900, 900);
  eq('dragging her with the panel open moves both; the saved place is where she stands, not the tall window',
    [w.getBounds(), saved()], [{ x: x0 - 100, y: y0 - UP, width: W, height: TALL }, { x: x0 - 100, y: y0, width: W, height: H }]);
  sets = w.sets;
  pw.sendCommand({ type: 'close-chat' });
  eq('closing leaves the window as it is and lets go of the keyboard', [w.getBounds(), w.sets - sets, w.focusable, pw.chatState().open], [{ x: x0 - 100, y: y0 - UP, width: W, height: TALL }, 0, false, false]);
  expect('her place is kept in userData/pet-state.json, and window-state.json (the main window\'s) is not touched', fs.existsSync(path.join(tmp, 'pet-state.json')) && !fs.existsSync(path.join(tmp, 'window-state.json')));

  pw.drag('start', 0, 0);
  pw.drag('end', 0, -582);
  const topY = y0 - 582;
  eq('near the top of the screen the empty part above her head reaches past the top edge; she stands where she was dropped',
    [w.getBounds(), saved()], [{ x: x0 - 100, y: topY - UP, width: W, height: TALL }, { x: x0 - 100, y: topY, width: W, height: H }]);
  pw.sendCommand({ type: 'chat' });
  eq('…there the open window moves into the work area (she moves down while it is open)', w.getBounds(), { x: x0 - 100, y: 0, width: W, height: TALL });
  eq('…and the saved place is still where she stands', saved(), { x: x0 - 100, y: topY, width: W, height: H });
  pw.sendCommand({ type: 'close-chat' });
  eq('…and she goes back up when it closes', w.getBounds(), { x: x0 - 100, y: topY - UP, width: W, height: TALL });
  pw.sendCommand({ type: 'chat' });
  pw.drag('start', 500, 500);
  pw.drag('end', 500, 500);
  pw.drag('start', 500, 500);
  pw.drag('end', 502, 501); // a hand's tremble, under the page's 4 px
  pw.sendCommand({ type: 'close-chat' });
  eq('a click (or double-click) on her while the open panel has pushed her down is not a drop: same place, same saved place',
    [w.getBounds(), saved()], [{ x: x0 - 100, y: topY - UP, width: W, height: TALL }, { x: x0 - 100, y: topY, width: W, height: H }]);
  pw.sendCommand({ type: 'chat' });
  pw.drag('start', 500, 500);
  pw.drag('move', 510, 500);
  pw.sendCommand({ type: 'close-chat' }); // the hotkey, with the mouse button still down
  pw.drag('move', 520, 500);
  eq('closing the panel in the middle of a drag: the window goes on around her, back where it is with the panel closed', w.getBounds(), { x: x0 - 80, y: topY - UP, width: W, height: TALL });
  pw.drag('end', 520, 500);
  eq('…and she is dropped where the pointer let go', [w.getBounds(), saved()], [{ x: x0 - 80, y: topY - UP, width: W, height: TALL }, { x: x0 - 80, y: topY, width: W, height: H }]);

  // Her head, for the eyes: the middle of her box, a little above its middle.
  const head = pw.headPoint()!;
  expect('her head is in the upper part of her box, centred', Math.abs(head.x - (x0 - 80 + W / 2)) < 1 && head.y > topY && head.y < topY + H / 2, JSON.stringify(head));

  // A small screen at the largest size: the whole thing does not fit, so the panel is shorter.
  display.bounds = { x: 0, y: 0, width: 1366, height: 768 };
  display.workArea = { x: 0, y: 0, width: 1366, height: 728 };
  pw.drag('start', 0, 0);
  pw.drag('end', -600, 728 - H - topY); // her feet on the top of the taskbar (the bottom of the work area)
  pw.applyScale(1.6);
  const small = w.getBounds();
  sets = w.sets;
  pw.sendCommand({ type: 'chat' });
  const big = w.getBounds();
  eq('on a small screen at size 1.6 the window is as tall as the work area and no taller, her feet at its bottom, and the panel opens in it as it is',
    [big.width, big.height, big.y >= 0, big.y + big.height <= 728, big.y + big.height === saved().y + saved().height, w.sets - sets], [Math.round(W * 1.6), 728, true, true, true, 0]);
  pw.sendCommand({ type: 'close-chat' });
  eq('…and the same after', w.getBounds(), small);

  pw.sendCommand({ type: 'chat' });
  w.reload();
  await wait(300);
  eq('a reloaded page is told the panel is open', told(w).slice(-2), ['chat', 'chat']);
  // The state of a small game is told to a page that has just loaded.
  pw.sendGame({ kind: 'chain', active: true, nextChar: '棠', hint: '轮到你，接「棠」' });
  const gameSent = () => w.sent.filter(([c]) => c === 'pet-ui:game').map(([, p]) => p);
  w.reload();
  await wait(300);
  eq('a game state goes to her page, and a reloaded page is told it again', gameSent(), [{ kind: 'chain', active: true, nextChar: '棠', hint: '轮到你，接「棠」' }, { kind: 'chain', active: true, nextChar: '棠', hint: '轮到你，接「棠」' }]);
  pw.sendGame(null);
  w.reload();
  await wait(300);
  eq('…and once it is forgotten (she was switched off) it is not told again', gameSent().length, 2);
  const v0 = seenVis;
  pw.hide();
  eq('hiding her (an anti-cheat game, switched off) closes the panel with her and stops her voice (the page is told both), and the page forgets where the pointer was',
    [pw.chatState().open, told(w).slice(-3), w.focusable, w.getBounds().height], [false, ['close-chat', 'hush', 'pointer'], false, 728]);

  eq('…the window tells when it is hidden, and when it is shown again (the cursor reading starts and stops with it)', seenVis - v0, 1);
  pw.show();
  eq('…and shown', seenVis - v0, 2);
  w.refuse = true;
  pw.sendCommand({ type: 'chat' });
  eq('when the OS will not hand over the keyboard, the panel opens anyway…', [pw.chatState(), w.focusable], [{ open: true, focused: false }, true]);
  await wait(6200);
  eq('…and after a while the window stops being focusable for nothing (the panel stays)', [w.focusable, pw.chatState().open], [false, true]);
  pw.sendCommand({ type: 'close-chat' });
  w.refuse = false;

  // Windows at 150 %: a work area 1019 px tall, so her default place is at an odd y, where the window reads back a pixel
  // taller than it was set. Opening and closing must not walk her down the screen a pixel or two each time.
  display.bounds = { x: 0, y: 0, width: 1707, height: 1067 };
  display.workArea = { x: 0, y: 0, width: 1707, height: 1019 };
  pw.applyScale(1);
  const here = saved();
  const sx = 1355;
  const sy = 1019 - H; // 659: the window's top is 429, odd
  pw.drag('start', 0, 0);
  pw.drag('end', sx - here.x, sy - here.y);
  w.offByOne = true;
  const ys: number[] = [];
  sets = w.sets;
  for (let i = 0; i < 15; i++) {
    pw.sendCommand({ type: 'chat' });
    pw.sendCommand({ type: 'close-chat' });
    ys.push(w.bounds.y);
  }
  eq('open/close 15 times where getBounds() is a pixel off: the window is never set again, and she and the saved place stay put',
    [[...new Set(ys)], w.bounds, saved(), w.sets - sets], [[sy - UP], { x: sx, y: sy - UP, width: W, height: TALL }, { x: sx, y: sy, width: W, height: H }, 0]);
  pw.sendCommand({ type: 'chat' });
  eq('…and the open window still stands on her feet, inside the work area', w.bounds, { x: sx, y: sy - UP, width: W, height: TALL });
  pw.sendCommand({ type: 'close-chat' });
  w.offByOne = false;
  w.pad = 2;
  sets = w.sets;
  for (let i = 0; i < 5; i++) {
    pw.sendCommand({ type: 'chat' });
    pw.sendCommand({ type: 'close-chat' });
  }
  eq('…nor where the window reads back 2 px larger than it was set (a transparent window at 150 %)', [w.sets - sets, w.bounds], [0, { x: sx, y: sy - UP, width: W, height: TALL }]);
  w.pad = 0;

  // A display that shrinks for a while (a full-screen game at a lower resolution, a monitor unplugged) moves her only for that while.
  const put = { ...w.bounds };
  const savedPut = saved();
  display.bounds = { x: 0, y: 0, width: 1280, height: 720 };
  display.workArea = { x: 0, y: 0, width: 1280, height: 720 };
  screensChanged();
  const shrunk = { ...w.bounds };
  display.bounds = { x: 0, y: 0, width: 1707, height: 1067 };
  display.workArea = { x: 0, y: 0, width: 1707, height: 1019 };
  screensChanged();
  eq('a display that shrinks keeps her on it; when it grows back she is where the user put her, and the saved place never moved',
    [shrunk.x + shrunk.width <= 1280 && shrunk.y + shrunk.height <= 720, w.bounds, saved()], [true, put, savedPut]);

  // A page that keeps crashing: the window is let go (no dead rectangle on the screen holding the keyboard).
  pw.sendCommand({ type: 'chat' });
  for (let i = 0; i < 4; i++) w.emitWc('render-process-gone', { reason: 'crashed' });
  eq('four crashes in a minute: the panel closes and the window goes', [w.destroyed, pw.chatState().open], [true, false]);
  await wait(400);
  eq('…and it is not built again by itself', FakePetWindow.last, w);
  pw.show();
  await wait(300);
  const w2 = FakePetWindow.last!;
  eq('showing her again builds a new window, where the user put her', [w2 !== w, w2.visible, w2.bounds], [true, true, put]);
  w2.close(); // Alt+F4 while the panel had the keyboard
  await wait(400);
  const w3 = FakePetWindow.last!;
  eq('a window closed under her while she is switched on comes back by itself', [w3 !== w2, w3.visible, w3.bounds], [true, true, put]);
  pw.shutdown();
  w3.close();
  await wait(400);
  eq('…but not once the app is quitting', FakePetWindow.last, w3);

  // A probe run builds no window at all.
  const made = FakePetWindow.made;
  process.env.ALIGHT_PROBE = '1';
  try {
    delete modules[req.resolve('./electron/pet/window.cjs')];
    const pw2 = req('./electron/pet/window.cjs') as { show(): void; create(): unknown; isVisible(): boolean };
    pw2.show();
    pw2.create();
    await wait(50);
    eq('a probe run (ALIGHT_PROBE=1) never builds the pet window', [FakePetWindow.made - made, pw2.isVisible()], [0, false]);
  } finally { process.env.ALIGHT_PROBE = ''; }
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ───────────────────────── pictures in messages, and the pet's quick lane ───────────────────────── */

console.log('Image messages');
{
  const net = req('./electron/ai/net.cjs') as { __forceTransport(n: string): void };
  net.__forceTransport('node');
  const servicesMod = req('./electron/ai/services.cjs');
  const secrets = req('./electron/ai/secrets.cjs');
  const api = req('./electron/ai/api.cjs');
  const { createScrubber } = req('./electron/ai/scrub.cjs');
  const { startFake } = req('./scripts/fixtures/fake-llm.cjs');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-pet-img-'));
  secrets.__setDeps({
    dir: work,
    safeStorage: {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (s: string) => Buffer.from(`ENC:${Buffer.from(s, 'utf8').toString('base64')}`),
      decryptStringAsync: async (b: Buffer) => ({ result: Buffer.from(b.toString().slice(4), 'base64').toString('utf8'), shouldReEncrypt: false }),
    },
  });
  const reg = servicesMod.createRegistry({ userDir: path.join(work, 'user'), secrets });
  secrets.configure(reg.secretsConfig());
  const yes = async () => true;
  const fakeDef = (f: any, extra: Record<string, unknown> = {}) => ({
    name: '假服务', endpoints: [{ id: 'main', label: '本机假服务', kind: 'local', baseUrl: f.baseUrl, compatUrl: f.origin }],
    auth: { scheme: 'bearer', keyOptional: true }, models: [{ id: 'fake-model', ctx: 32768 }, { id: 'blind-model', ctx: 32768, caps: { vision: false } }], wire: { maxTokensField: 'max_tokens', defaultMaxOut: 4096, testMaxTokens: 128 }, ...extra,
  });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]).toString('base64');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(60, 2)]).toString('base64');
  const img = (data = jpeg, mime = 'image/jpeg') => ({ type: 'image', mime, data });
  const clean = (messages: unknown) => reg.cleanMessages(messages);
  const user = (content: unknown) => [{ role: 'user', content }];

  eq('a plain string message is untouched', clean([{ role: 'user', content: '你好' }, { role: 'assistant', content: '嗯。' }]), { ok: true, messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '嗯。' }] });
  eq('a text and a picture: a list, in order, the parts cleaned', clean(user([{ type: 'text', text: '这是哪里？', extra: 1 }, img()])), { ok: true, messages: [{ role: 'user', content: [{ type: 'text', text: '这是哪里？' }, { type: 'image', mime: 'image/jpeg', data: jpeg }] }] });
  eq('a list of text only is one string', clean(user([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }])), { ok: true, messages: [{ role: 'user', content: '甲\n乙' }] });
  expect('a PNG is fine too', clean(user([img(png, 'image/png')])).ok === true);
  const objectMime = clean(user([{ type: 'image', mime: new String('image/jpeg'), data: jpeg }]));
  eq('the mime is kept as a plain string, whatever object it came as', [objectMime.ok, typeof objectMime.messages[0].content[0].mime, objectMime.messages[0].content[0].mime], [true, 'string', 'image/jpeg']);
  const refused = (what: string, messages: unknown, why: RegExp) => { const r = clean(messages); expect(`refused: ${what}`, r.ok === false && why.test(r.error), JSON.stringify(r)); };
  refused('a GIF, a WebP and an SVG', user([img(jpeg, 'image/gif')]), /JPEG 或 PNG/);
  refused('a mime that is not a plain name (a prototype key)', user([img(jpeg, '__proto__')]), /JPEG 或 PNG/);
  refused('bytes that are not the declared type (a PNG called JPEG)', user([img(png, 'image/jpeg')]), /不符/);
  refused('data that is not base64', user([img('not base64!!')]), /Base64/);
  refused('base64 with a wrong length', user([img(`${jpeg}A`)]), /Base64/);
  refused('no data / data that is not a string', user([{ type: 'image', mime: 'image/jpeg' }]), /没有内容/);
  refused('three pictures in one message', user([img(), img(), img()]), /最多 2 张/);
  refused('more than 4 pictures over the request', [...user([img(), img()]), { role: 'assistant', content: 'x' }, ...user([img(), img()]), ...user([img()])], /最多带 4 张/);
  refused('a picture from the assistant', [{ role: 'assistant', content: [img()] }], /用户的消息/);
  refused('a part with an unknown type', user([{ type: 'audio', data: 'x' }]), /不支持的内容类型/);
  refused('a part that is not an object', user(['text']), /不支持/);
  refused('text that is not text', user([{ type: 'text', text: 7 }]), /不是文字/);
  refused('content that is an object', user({ type: 'text', text: 'x' }), /形状不对/);
  refused('a list with nothing in it', user([]), /是空的/);
  refused('a list of only empty texts', user([{ type: 'text', text: '' }]), /是空的/);
  refused('a list of 17 parts', user(Array.from({ length: 17 }, () => ({ type: 'text', text: 'a' }))), /太多/);
  // 4 MB limit: decoded size, not text size.
  const big = (bytes: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(bytes - 3, 7)]).toString('base64');
  expect('exactly 4 MB decoded is accepted', clean(user([img(big(4 * 1024 * 1024))])).ok === true);
  refused('4 MB and one byte', user([img(big(4 * 1024 * 1024 + 1))]), /超过 4 MB/);
  refused('a huge string is refused before it is looked at', user([img('A'.repeat(20_000_000))]), /超过 4 MB/);

  const fake = await startFake({ script: 'openai-ok' });
  const asOpenAI = (await reg.saveService(fakeDef(fake, { name: '开放' }), { confirm: yes })).value.id as string;
  const asClaude = (await reg.saveService(fakeDef(fake, { name: '安索', protocol: 'anthropic', auth: { scheme: 'x-api-key', keyOptional: true } }), { confirm: yes })).value.id as string;
  const run = async (id: string, spec: Record<string, unknown>) => {
    const rr = reg.resolveApi({ driver: 'api', provider: id, model: 'fake-model', maxTokens: 400, ...spec });
    if (!rr.ok) return { rr, events: [] as any[], error: undefined as any };
    const events: any[] = [];
    const sc = createScrubber('sk-fake-pet-key-12', (e: any) => events.push(e));
    let error: any;
    try { await (rr.r.protocol === 'anthropic' ? api.streamAnthropic : api.streamOpenAI)(rr.r, 'sk-fake-pet-key-12', sc.emit, new AbortController().signal); } catch (e) { error = e; }
    return { rr, events, error };
  };
  const asked = [{ role: 'user', content: [{ type: 'text', text: '这一关怎么过？' }, img()] }];
  fake.reset();
  fake.script = 'openai-ok';
  const o1 = await run(asOpenAI, { messages: asked });
  const ob = fake.requests[0].body;
  eq('the OpenAI-compatible request turns a picture into an image_url data URL, after the text, in order',
    ob.messages[0].content, [{ type: 'text', text: '这一关怎么过？' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg}` } }]);
  eq('…and the reply streams back as usual', o1.events.filter((e: any) => e.type === 'text').map((e: any) => e.text).join(''), '你好，阁下。');
  fake.reset();
  fake.script = 'anthropic-ok';
  await run(asClaude, { messages: asked });
  eq('the Anthropic request puts the picture first, as a base64 block, then the text',
    fake.requests[0].body.messages[0].content, [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg } }, { type: 'text', text: '这一关怎么过？' }]);
  fake.reset();
  fake.script = 'openai-ok';
  await run(asOpenAI, { messages: [{ role: 'user', content: '纯文字' }] });
  eq('a plain message is still a plain string in the request', fake.requests[0].body.messages[0].content, '纯文字');
  const refusedRun = await run(asOpenAI, { messages: user([img(jpeg, 'image/gif')]) });
  eq('a refused message never reaches the service', [refusedRun.rr.ok, refusedRun.rr.code, fake.requests.length], [false, 'MESSAGES', 1]);
  const blind = reg.resolveApi({ driver: 'api', provider: asOpenAI, model: 'blind-model', messages: asked });
  eq('a model the list says cannot see is not sent a picture (an unknown one is tried)', [blind.ok, blind.code, reg.resolveApi({ driver: 'api', provider: asOpenAI, model: 'fake-model', messages: asked }).ok], [false, 'VISION', true]);

  // The pet's quick lane.
  eq('pet:true limits: 12 s for the first byte, 20 s of silence; everyone else keeps 90 s / 180 s', [api.limitsFor({ pet: true }), api.limitsFor({})], [{ firstByteMs: 12000, idleMs: 20000 }, { firstByteMs: 90000, idleMs: 180000 }]);
  eq('…and the test seam can only make them shorter', (() => { api.__setLimits({ firstByteMs: 250, idleMs: 300 }); try { return api.limitsFor({ pet: true }); } finally { api.__setLimits(); } })(), { firstByteMs: 250, idleMs: 300 });
  eq('the flag is only taken from a real boolean, and not for a connection test', [reg.resolveApi({ driver: 'api', provider: asOpenAI, model: 'fake-model', pet: true }).r.pet, reg.resolveApi({ driver: 'api', provider: asOpenAI, model: 'fake-model', pet: 'yes' }).r.pet, reg.resolveApi({ driver: 'api', provider: asOpenAI, model: 'fake-model', pet: true }, { test: true }).r.pet], [true, false, false]);
  eq('her answers are short: at most 600 tokens asked of the model, however much the page asks for', [reg.resolveApi({ driver: 'api', provider: asOpenAI, model: 'fake-model', pet: true, maxTokens: 4000 }).r.maxTokens, reg.resolveApi({ driver: 'api', provider: asOpenAI, model: 'fake-model', pet: true, maxTokens: 500 }).r.maxTokens, reg.resolveApi({ driver: 'api', provider: asOpenAI, model: 'fake-model', maxTokens: 4000 }).r.maxTokens], [600, 500, 4000]);
  // No retry with adjusted fields: a gateway that refuses stream_options is retried for everyone else, not for her.
  fake.reset();
  fake.script = 'reject-stream-options';
  const plainRetry = await run(asOpenAI, { messages: [{ role: 'user', content: '你好' }] });
  const nPlain = fake.requests.length;
  fake.reset();
  const petRetry = await run(asOpenAI, { messages: [{ role: 'user', content: '你好' }], pet: true });
  eq('the usual lane retries once without the field the gateway refused; the pet\'s lane reports the refusal at once', [plainRetry.error === undefined, nPlain, petRetry.error?.code, fake.requests.length], [true, 2, 'PARAM', 1]);
  await fake.close();
  net.__forceTransport('');
  fs.rmSync(work, { recursive: true, force: true });
}

/* ───────────────────────── model access: who may call, and where the pet's web helper runs ───────────────────────── */

console.log('Model access');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-pet-ai-'));
  const real = fs.realpathSync(dir);
  fakeElectron.app.getPath = (n: string) => (n === 'userData' ? path.join(real, 'userData') : real);
  fs.mkdirSync(path.join(real, 'userData'), { recursive: true });
  const ai = req('./electron/ai/index.cjs') as { __test: { fromApp(e: unknown): boolean; setAppSender(fn: unknown): void; petWorkspace(): string; samePath(a: string, b: string): boolean; startStream(sender: any, spec: any): string } };
  const t = ai.__test;
  const page = pathToFileURL(path.join(root, 'dist', 'index.html')).href;
  const frame = { url: page };
  const same = { sender: { id: 'main' }, senderFrame: frame };
  t.setAppSender(null);
  expect('without the shell\'s check (loaded on its own) the old rule holds: only dist/index.html as the frame address', t.fromApp({ senderFrame: { url: page } }) && t.fromApp({ senderFrame: { url: `${page}#x` } }) && !t.fromApp({ senderFrame: { url: 'file:///x/dist/pet.html' } }) && !t.fromApp({}));
  t.setAppSender((e: any) => e.senderFrame === frame);
  expect('with it, the shell\'s identity check decides — a frame that merely has the address is no longer enough', t.fromApp(same) && !t.fromApp({ sender: same.sender, senderFrame: { url: page } }));
  t.setAppSender(null);

  // The pet's web helper runs in <userData>/workspaces/pet, which the trust ledger already treats as the app's own (T1).
  const trust = req('./electron/trust.cjs') as { levelOf(d: string): string };
  const petDir = t.petWorkspace();
  fs.mkdirSync(petDir, { recursive: true });
  const other = path.join(real, 'elsewhere');
  fs.mkdirSync(other);
  eq('workspaceFolder("pet") is the app\'s own practice folder: T1, no "directory not trusted" prompt; any other folder is still T0',
    [path.relative(path.join(real, 'userData', 'workspaces'), petDir), trust.levelOf(petDir), trust.levelOf(other)], ['pet', 'T1', 'T0']);
  eq('the same place is recognised however it is written; another place is not', [t.samePath(petDir, `${petDir}${path.sep}.`), t.samePath(petDir, petDir.toUpperCase()), t.samePath(petDir, other)], [true, process.platform === 'win32', false]);
  // A pet run that wants tools may only run there: anywhere else it is refused before anything starts.
  const events: any[] = [];
  const sender = { isDestroyed: () => false, send: (_c: string, ev: any) => events.push(ev) };
  t.startStream(sender, { driver: 'claude-code', provider: 'claude', access: 'work', pet: true, readOnly: true, cwd: other, prompt: '查一下', allow: ['WebSearch'] });
  await wait(150);
  eq('a pet run with tools in any other folder is refused, in words', [events[0]?.type, events[0]?.code, /pet 工作文件夹/.test(events[0]?.message ?? '')], ['error', 'CONFIG', true]);
  events.length = 0;
  t.startStream(sender, { driver: 'claude-code', provider: 'claude', access: 'chat', pet: true, cwd: other, prompt: '你好' });
  await wait(150);
  eq('…and one without tools is held to her folder as well (access does not matter)', [events[0]?.type, events[0]?.code, /pet 工作文件夹/.test(events[0]?.message ?? '')], ['error', 'CONFIG', true]);
  events.length = 0;
  t.startStream(sender, { driver: 'codex', provider: 'gpt', access: 'work', pet: true, cwd: petDir, prompt: '查一下', readOnly: true });
  t.startStream(sender, { driver: 'dsh', provider: 'deepseek', access: 'work', pet: true, cwd: petDir, prompt: '查一下', readOnly: true });
  await wait(150);
  eq('Codex and DeepSeek Harness cannot be held to the two web tools, so a pet run with tools is refused for them (before looking for the program)',
    events.slice(0, 2).map((e) => [e.type, e.code, /只用 Claude Code/.test(e.message ?? '')]), [['error', 'CONFIG', true], ['error', 'CONFIG', true]]);

  // Claude Code through the Agent SDK: exactly the two web tools, and anything else is refused here, not asked of the page.
  const sdkMod = req('./electron/ai/claude-sdk.cjs') as { runClaudeSdk(spec: any, emit: (e: any) => void, deps: any): { stop(): void } };
  let seen: any;
  const fakeSdk = { query: ({ options }: any) => { seen = options; return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), interrupt: async () => {}, close() {}, getContextUsage: async () => ({}) }; } };
  const emitted: any[] = [];
  const ctl = sdkMod.runClaudeSdk({ cwd: petDir, prompt: '查一下', access: 'work', readOnly: true, trust: 'T1', allow: ['WebSearch', 'WebFetch'], deny: ['Bash'], onlyTools: ['WebSearch', 'WebFetch'] },
    (e: any) => emitted.push(e), { sdk: fakeSdk, resolveExe: () => ({ source: 'user', path: 'C:\\x\\claude.exe' }) });
  await wait(40);
  eq('Claude Code (Agent SDK): the tool set is exactly WebSearch and WebFetch', [seen.tools, seen.allowedTools], [['WebSearch', 'WebFetch'], ['WebSearch', 'WebFetch']]);
  const asked1 = [await seen.canUseTool('Bash', { command: 'dir' }, { toolUseID: 't1' }), await seen.canUseTool('Read', { file_path: 'C:/x' }, { toolUseID: 't2' }), await seen.canUseTool('Glob', { pattern: '**/*' }, { toolUseID: 't3' })];
  eq('…any other tool it asks to use is refused on the spot, and the page is not asked', [asked1.map((a: any) => a.behavior), emitted.filter((e) => e.type === 'permission').length], [['deny', 'deny', 'deny'], 0]);
  const hook = seen.hooks.PreToolUse[0].hooks[0];
  const verdict = async (name: string, input: object) => ((await hook({ tool_name: name, tool_input: input })).hookSpecificOutput?.permissionDecision ?? 'none') as string;
  eq('…and the hook before every tool says the same, the built-in ones too; the two web tools pass',
    [await verdict('Read', { file_path: 'x' }), await verdict('Glob', { pattern: '*' }), await verdict('Agent', {}), await verdict('TodoWrite', {}), await verdict('Bash', { command: 'dir' }), await verdict('WebSearch', { query: 'x' }), await verdict('WebFetch', { url: 'https://example.com' })],
    ['deny', 'deny', 'deny', 'deny', 'deny', 'none', 'none']);
  const webAsk = seen.canUseTool('WebFetch', { url: 'https://example.com' }, { toolUseID: 't4' });
  await wait(10);
  eq('(a web tool that needs a yes still goes to the page, which refuses everything for her)', emitted.filter((e) => e.type === 'permission').map((e) => e.name), ['WebFetch']);
  ctl.stop();
  void webAsk;

  // The older stream-json driver gets the same tool set as an argument; a general run keeps the page's lists.
  const { buildArgs } = req('./electron/ai/claude.cjs') as { buildArgs(spec: object, sysFile: string | null): string[] };
  const pa = buildArgs({ access: 'work', onlyTools: ['WebSearch', 'WebFetch'], allow: ['Bash'], deny: ['Edit'] }, null);
  eq('stream-json driver: --tools and --allowedTools are WebSearch,WebFetch, and the page\'s own lists are not in the arguments', [pa[pa.indexOf('--tools') + 1], pa[pa.indexOf('--allowedTools') + 1], pa.includes('Bash'), pa.includes('--disallowedTools')], ['WebSearch,WebFetch', 'WebSearch,WebFetch', false, false]);
  const ga = buildArgs({ access: 'work', allow: ['Read'], deny: ['Edit'] }, null);
  eq('…an ordinary run is unchanged, and a chat run has no tools at all', [ga[ga.indexOf('--allowedTools') + 1], ga[ga.indexOf('--disallowedTools') + 1], ga.includes('--tools'), buildArgs({ access: 'chat' }, null).slice(-2)], ['Read', 'Edit', false, ['--tools', '']]);

  // Paths: a glob is a path too.
  const perm = req('./electron/ai/perm.cjs') as { outsideRoots(i: object, roots: string[], tool?: string): string; hookDecision(c: object, n: string, i: object): { decision: string } };
  const roots = ['C:/work/pet'];
  eq('a Glob pattern that leaves the working folder is found (absolute, ../, ~), one that stays is not',
    [{ pattern: 'C:/Users/**/*.txt' }, { pattern: '../../**' }, { pattern: '~/*' }, { pattern: '**/*.md' }, { pattern: 'src/**/*.ts' }, { pattern: 'C:/work/pet/**/*.md' }, { pattern: '**/*.ts', path: 'C:/work/pet/src' }].map((i) => perm.outsideRoots(i, roots, 'glob')),
    ['C:/Users/**/*.txt', '../../**', '~/*', '', '', '', '']);
  eq('Grep: its glob filter is a path, its pattern (a regular expression) is not', [perm.outsideRoots({ pattern: 'a..b', glob: '../*.ts' }, roots, 'grep'), perm.outsideRoots({ pattern: 'C:\\\\Users', path: 'C:/work/pet' }, roots, 'grep'), perm.outsideRoots({ pattern: 'x', glob: '*.ts' }, roots, 'grep')], ['../*.ts', '', '']);
  eq('the read-only hook asks about such a Glob, and lets an inside one through', [perm.hookDecision({ mode: 'default', readOnly: true, roots }, 'Glob', { pattern: 'C:/Users/**' }).decision, perm.hookDecision({ mode: 'default', readOnly: true, roots }, 'Glob', { pattern: '**/*.md' }).decision], ['ask', 'none']);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
fs.rmSync(userData, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
