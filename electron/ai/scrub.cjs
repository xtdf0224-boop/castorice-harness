// 把密钥原文从发给页面的事件里抹掉。纯函数 / 小状态机：不引用 Electron，check-engine 直接测。
//
// agent 的 shell 会继承密钥（见 index.cjs），模型看得到的东西里可能带着它（env 输出、报错）。事件发给页面之前：
//   · scrubValue：整个值里出现的密钥原文换成 ••••（工具输入 / 输出、done.text 这类整块的字符串）；
//   · createScrubber：text / thinking 是按 token 切开的流式增量，密钥会被切成 `sk-ant-` 与 `api03-…` 两段，
//     单看每一段都匹配不到。所以对这两类事件有状态：每个流保留“可能是密钥开头”的尾巴（至多 key.length-1 个字符），
//     下一段到了再一起判断；遇到别的事件（工具、换段、结束、出错）先把尾巴冲出去，再转发它。
'use strict';

const MASK = '••••';

/** 深度替换：字符串里出现的 secret 换成 ••••. */
function scrubValue(value, secret) {
  if (!secret) return value;
  if (typeof value === 'string') return value.split(secret).join(MASK);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubValue(v, secret)]));
  return value;
}

/** s 的最长后缀，同时是 secret 的真前缀（长度 < secret.length）。返回长度. */
function partialSuffix(s, secret) {
  for (let k = Math.min(s.length, secret.length - 1); k > 0; k--) {
    if (s.endsWith(secret.slice(0, k))) return k;
  }
  return 0;
}

const STREAMED = new Set(['text', 'thinking']);
/** 冲出去的尾巴如果已经有这么长，就不再原样给页面：它是密钥开头的一大段（`sk-ant-` 这类公开前缀不到这个长度）. */
const TAIL_MASK_AT = 12;

/**
 * @param {string|undefined} secret 没有密钥就原样转发
 * @param {(ev: object) => void} emit 真正发给页面的函数
 * @returns {{ emit: (ev: object) => void, flush: () => void }}
 */
function createScrubber(secret, emit) {
  if (!secret) return { emit, flush() {} };
  const tails = { text: '', thinking: '' };
  const last = { text: null, thinking: null };   // 该类事件上一条的其余字段（agentId 之类），冲尾巴时沿用

  const flushType = (type) => {
    const tail = tails[type];
    if (!tail) return;
    tails[type] = '';
    emit({ ...(last[type] || {}), type, text: tail.length >= TAIL_MASK_AT ? MASK : tail });
  };
  const flush = () => { flushType('thinking'); flushType('text'); };

  return {
    flush,
    emit(ev) {
      if (!ev || typeof ev !== 'object') { emit(ev); return; }
      if (STREAMED.has(ev.type) && typeof ev.text === 'string') {
        const other = ev.type === 'text' ? 'thinking' : 'text';
        flushType(other);   // 切到另一种流：另一种流的尾巴已经不会再被接上
        const buf = (tails[ev.type] + ev.text).split(secret).join(MASK);
        const keep = partialSuffix(buf, secret);
        tails[ev.type] = keep ? buf.slice(buf.length - keep) : '';
        const out = keep ? buf.slice(0, buf.length - keep) : buf;
        const { text: _t, ...rest } = ev;
        last[ev.type] = rest;
        if (out) emit({ ...rest, text: out });
        return;
      }
      flush();
      emit(scrubValue(ev, secret));
    },
  };
}

module.exports = { MASK, scrubValue, createScrubber, partialSuffix };
