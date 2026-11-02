/* 极小的 MP4 盒解析器：给 check-build / 校验脚本用，不依赖 ffprobe。
   取出：complete（顶层盒排满整个文件且有 mdat = 没被截断）、品牌（ftyp）、第一条视频轨的样本条目四字符（hvc1 / avc1 …）、宽高、轨时长、mvhd 时长、帧数（stts 求和）、
   colr(nclx) 里的色彩标记、hvcC / avcC 里的 profile / level（拼成 codecs 字符串）、moov 是否在 mdat 之前（faststart）。
   用法：import { mp4info } from './mp4info.mjs'; const info = mp4info(fs.readFileSync(path));
        或  node mp4info.mjs <file.mp4>   （打印 JSON） */
import fs from 'node:fs';

function* boxes(buf, start = 0, end = buf.length) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) return;
    yield { type, start: p, body: p + hdr, end: p + size };
    p += size;
  }
}
const find = (buf, b, ...path) => {
  let cur = [b];
  for (const t of path) {
    const next = [];
    for (const c of cur) for (const x of boxes(buf, c.body, c.end)) if (x.type === t) next.push(x);
    cur = next;
  }
  return cur[0] ?? null;
};

export function mp4info(buf) {
  const top = [...boxes(buf, 0, buf.length)];
  const root = { body: 0, end: buf.length };
  const ftyp = top.find((b) => b.type === 'ftyp');
  const moov = top.find((b) => b.type === 'moov');
  const mdat = top.find((b) => b.type === 'mdat');
  if (!moov) throw new Error('mp4info: no moov');
  // 截断检测：顶层盒要恰好排满整个文件（最后一个盒的声明长度 = 文件剩余字节）；mdat 被截断时 boxes() 里它会被丢掉（声明长度超出文件），topEnd < 文件长度
  const topEnd = top.length ? top[top.length - 1].end : 0;
  const out = { brand: ftyp ? buf.toString('latin1', ftyp.body, ftyp.body + 4) : null, faststart: !!(mdat && moov.start < mdat.start), complete: !!mdat && topEnd === buf.length, bytes: buf.length };
  const mvhd = find(buf, moov, 'mvhd');
  if (mvhd) {
    const v = buf[mvhd.body];
    const ts = buf.readUInt32BE(mvhd.body + (v === 1 ? 20 : 12));
    const dur = v === 1 ? Number(buf.readBigUInt64BE(mvhd.body + 24)) : buf.readUInt32BE(mvhd.body + 16);
    out.movieTimescale = ts; out.movieDuration = dur / ts;
  }
  for (const trak of boxes(buf, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const hdlr = find(buf, trak, 'mdia', 'hdlr');
    if (!hdlr || buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) !== 'vide') continue;
    const mdhd = find(buf, trak, 'mdia', 'mdhd');
    const v = buf[mdhd.body];
    const ts = buf.readUInt32BE(mdhd.body + (v === 1 ? 20 : 12));
    const dur = v === 1 ? Number(buf.readBigUInt64BE(mdhd.body + 24)) : buf.readUInt32BE(mdhd.body + 16);
    out.trackTimescale = ts; out.trackDuration = dur / ts;
    const stbl = find(buf, trak, 'mdia', 'minf', 'stbl');
    const stsd = find(buf, stbl, 'stsd');
    const ent = [...boxes(buf, stsd.body + 8, stsd.end)][0];
    out.sampleEntry = ent.type;
    out.width = buf.readUInt16BE(ent.body + 24);
    out.height = buf.readUInt16BE(ent.body + 26);
    for (const c of boxes(buf, ent.body + 78, ent.end)) {
      if (c.type === 'colr' && buf.toString('latin1', c.body, c.body + 4) === 'nclx') {
        out.colr = { primaries: buf.readUInt16BE(c.body + 4), transfer: buf.readUInt16BE(c.body + 6), matrix: buf.readUInt16BE(c.body + 8), fullRange: !!(buf[c.body + 10] & 0x80) };
      } else if (c.type === 'hvcC') {
        const b = c.body;
        const profileSpace = buf[b + 1] >> 6, tier = (buf[b + 1] >> 5) & 1, profile = buf[b + 1] & 31;
        const flags = buf.readUInt32BE(b + 2);
        let rev = 0; for (let i = 0; i < 32; i++) if (flags & (1 << i)) rev |= 1 << (31 - i);       // 比特反转（codecs 字符串里的兼容标志）
        const cs = [...buf.subarray(b + 6, b + 12)];
        let tail = cs.length; while (tail > 0 && cs[tail - 1] === 0) tail--;
        const level = buf[b + 12];
        out.hevc = { profile, tier, level, bitDepthLuma: (buf[b + 17] & 7) + 8, chromaFormat: buf[b + 16] & 3 };
        out.codecs = `hvc1.${['', 'A', 'B', 'C'][profileSpace]}${profile}.${(rev >>> 0).toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${level}` + (tail ? '.' + cs.slice(0, tail).map((x) => x.toString(16).toUpperCase()).join('.') : '');
      } else if (c.type === 'avcC') {
        const b = c.body;
        out.codecs = `avc1.${[buf[b + 1], buf[b + 2], buf[b + 3]].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
        out.avc = { profile: buf[b + 1], level: buf[b + 3] };
      }
    }
    const stts = find(buf, stbl, 'stts');
    const n = buf.readUInt32BE(stts.body + 4);
    let frames = 0; const deltas = new Set();
    for (let i = 0; i < n; i++) { frames += buf.readUInt32BE(stts.body + 8 + i * 8); deltas.add(buf.readUInt32BE(stts.body + 12 + i * 8)); }
    out.frames = frames;
    out.constantFrameDelta = deltas.size === 1 ? [...deltas][0] : null;
    out.fps = out.constantFrameDelta ? ts / out.constantFrameDelta : null;
    const stss = find(buf, stbl, 'stss');
    if (stss) out.keyframes = buf.readUInt32BE(stss.body + 4);
    break;
  }
  void root;
  return out;
}

if (process.argv[1] && /mp4info\.mjs$/.test(process.argv[1])) {
  const f = process.argv[2];
  if (f) console.log(JSON.stringify(mp4info(fs.readFileSync(f)), null, 2));
}
