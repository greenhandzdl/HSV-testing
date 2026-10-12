#!/usr/bin/env node
/**
 * src/js/qr.js 的自检（纯开发工具，站点不依赖它）。
 *
 * 这里刻意不复用 qr.js 的内部函数：分块表、校正图形坐标、掩码函数、数据摆放顺序
 * 全部按 ISO/IEC 18004 的说法在测试里重算一遍，再把「已经画好的矩阵」反解回文本，
 * 逐块验 Reed–Solomon 校验式。表抄错一格、摆位错一格、掩码写反行列，都会在这里炸掉，
 * 而不是等用户拿手机扫才发现。
 *
 * 用法：node tools/qr-check.mjs
 */
import { encode, capacityBytes, dataCodewords, alignmentPositions } from '../src/js/qr.js';

let failed = 0;
let passed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ------------------------- 独立重算的 GF(256) 与 RS ------------------------- */
// 素多项式 0x11D，生成元 α=2
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

check('GF(256)：α 的阶是 255', EXP[255] === 1 && new Set(EXP.slice(0, 255)).size === 255);
check('GF(256)：log/exp 互逆', Array.from({ length: 255 }, (_, k) => LOG[EXP[k]] === k).every(Boolean));
check('GF(256)：分配律抽样', mul(0x53, 0x8f) === (function () {
  let acc = 0;
  for (let i = 0; i < 8; i += 1) if ((0x8f >> i) & 1) acc ^= mul(0x53, EXP[i]);
  return acc;
}()));

/** 把一串码字在 α^0 … α^(degree-1) 处求值，全 0 说明 ECC 与生成多项式对得上 */
function syndromes(codewords, degree) {
  const res = [];
  for (let t = 0; t < degree; t += 1) {
    let acc = 0;
    for (const c of codewords) acc = mul(acc, EXP[t]) ^ c;
    res.push(acc);
  }
  return res;
}

/* ------------------------- ISO 表：抄给测试用 ------------------------- */
/** 每版每级：[总数据码字数, 每块 ECC 码字数, 块数]；块长只可能是 ⌊c/b⌋ 或 +1 */
const ISO = {
  L: [
    null,
    [19, 7, 1], [34, 10, 1], [55, 15, 1], [80, 20, 1], [108, 26, 1],
    [136, 18, 2], [156, 20, 2], [194, 24, 2], [232, 30, 2], [274, 18, 4],
  ],
  M: [
    null,
    [16, 10, 1], [28, 16, 1], [44, 26, 1], [64, 18, 2], [86, 24, 2],
    [108, 16, 4], [124, 18, 4], [154, 22, 4], [182, 22, 5], [216, 26, 5],
  ],
};

/** ISO 表 9 的 Byte 模式容量（公开值），也是 qr.js 的分块表算得对不对的唯一裁判 */
const BYTE_CAPACITY = {
  L: [null, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
  M: [null, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
};

/** ISO 表 D.1 的校正图形中心坐标 */
const ALIGN = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

for (const level of ['L', 'M']) {
  for (let v = 1; v <= 10; v += 1) {
    const [c, e, b] = ISO[level][v];
    check(`v${v}-${level} 数据码字数与 ISO 一致`, dataCodewords(v, level) === c, `qr.js=${dataCodewords(v, level)} ISO=${c}`);
    check(`v${v}-${level} Byte 容量与 ISO 一致`, capacityBytes(v, level) === BYTE_CAPACITY[level][v], `qr.js=${capacityBytes(v, level)} ISO=${BYTE_CAPACITY[level][v]}`);
    check(`v${v}-${level} 分块自洽（⌊c/b⌋ 与余数）`, c % b <= b && c === b * Math.floor(c / b) + (c % b));
  }
}
for (let v = 1; v <= 10; v += 1) {
  const got = alignmentPositions(v).join(',');
  const want = ALIGN[v - 1].join(',');
  check(`v${v} 校正图形坐标`, got === want, `qr.js=[${got}] ISO=[${want}]`);
}

/* --------------------------- 把矩阵反解回比特 --------------------------- */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** 独立重建「功能图形」占位图：与 qr.js 各画一遍，两边不一致就会在后面露出来 */
function buildFunctionMap(qr) {
  const { version, size } = qr;
  const fn = new Uint8Array(size * size);
  const mark = (r, c) => {
    if (r >= 0 && r < size && c >= 0 && c < size) fn[r * size + c] = 1;
  };
  for (let i = 0; i < size; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [ci, cj] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
    for (let di = -4; di <= 4; di += 1) for (let dj = -4; dj <= 4; dj += 1) mark(ci + di, cj + dj);
  }
  const pos = ALIGN[version - 1];
  for (const ci of pos) {
    for (const cj of pos) {
      const onFinder = (ci <= 8 && cj <= 8) || (ci <= 8 && cj >= size - 9) || (ci >= size - 9 && cj <= 8);
      if (onFinder) continue;
      for (let di = -2; di <= 2; di += 1) for (let dj = -2; dj <= 2; dj += 1) mark(ci + di, cj + dj);
    }
  }
  // 两处格式信息区 + 固定黑模块
  for (let i = 0; i <= 5; i += 1) mark(i, 8);
  mark(7, 8); mark(8, 8); mark(8, 7);
  for (let i = 9; i < 15; i += 1) mark(8, 14 - i);
  for (let i = 0; i < 8; i += 1) mark(8, size - 1 - i);
  for (let i = 8; i < 15; i += 1) mark(size - 15 + i, 8);
  mark(size - 8, 8);
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      mark(Math.floor(i / 3), size - 11 + (i % 3));
      mark(size - 11 + (i % 3), Math.floor(i / 3));
    }
  }
  return fn;
}

/** 按 ISO 的顺序把非功能格读成比特流，读的时候顺手把掩码揭掉 */
function readDataBits(qr, fn) {
  const { size, mask } = qr;
  const bits = [];
  const unmask = MASKS[mask];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (fn[row * size + col]) continue;
        const raw = qr.modules[row * size + col];
        bits.push(unmask(row, col) ? raw ^ 1 : raw);
      }
    }
  }
  return bits;
}

function readFormatBits(qr, which) {
  const { size } = qr;
  const at = (r, c) => qr.modules[r * size + c];
  const out = [];
  for (let i = 0; i < 15; i += 1) {
    if (which === 1) {
      out.push(i < 6 ? at(i, 8) : i === 6 ? at(7, 8) : i === 7 ? at(8, 8) : i === 8 ? at(8, 7) : at(8, 14 - i));
    } else {
      out.push(i < 8 ? at(8, size - 1 - i) : at(size - 15 + i, 8));
    }
  }
  return out;
}

/** b（比特数组，低位在前）按多项式 g（次数 deg）做模 2 除法，余数为 0 才合法 */
function bchRemainder(bits, deg, gen) {
  let value = 0;
  bits.forEach((bit, i) => {
    value |= bit << i;
  });
  for (let i = bits.length - 1; i >= deg; i -= 1) {
    if ((value >> i) & 1) value ^= gen << (i - deg);
  }
  return value;
}

/* ------------------------------ 结构 + 往返 ------------------------------ */
function blockLengths(version, level) {
  const [c, , b] = ISO[level][version];
  const short = Math.floor(c / b);
  const extra = c % b; // 最后 extra 个块多一个码字
  const sizes = [];
  for (let i = 0; i < b; i += 1) sizes.push(short + (i >= b - extra ? 1 : 0));
  return { sizes, ecc: ISO[level][version][1] };
}

function verify(text, options) {
  const qr = encode(text, options);
  const level = qr.ecLevel;
  const label = `「${text.slice(0, 22)}${text.length > 22 ? '…' : ''}」 v${qr.version}-${level} mask${qr.mask}`;
  const fn = buildFunctionMap(qr);

  // 三个定位图形 + 分隔符
  for (const [ci, cj] of [[3, 3], [3, qr.size - 4], [qr.size - 4, 3]]) {
    for (let di = -3; di <= 3; di += 1) {
      for (let dj = -3; dj <= 3; dj += 1) {
        const want = Math.max(Math.abs(di), Math.abs(dj)) !== 2 ? 1 : 0;
        check(`${label} 定位图形`, qr.modules[(ci + di) * qr.size + cj + dj] === want, `(${ci + di},${cj + dj})`);
      }
    }
  }
  // 时序图形交替
  let timingOk = true;
  for (let i = 8; i < qr.size - 8; i += 1) {
    if (qr.modules[6 * qr.size + i] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
    if (qr.modules[i * qr.size + 6] !== (i % 2 === 0 ? 1 : 0)) timingOk = false;
  }
  check(`${label} 时序图形交替`, timingOk);
  check(`${label} 固定黑模块是黑`, qr.modules[(qr.size - 8) * qr.size + 8] === 1);

  // 格式信息：两处一致，去 XOR 后能被 0x537 整除，且解出的等级 / 掩码与实际相符
  const c1 = readFormatBits(qr, 1);
  const c2 = readFormatBits(qr, 2);
  check(`${label} 格式信息两处一致`, c1.join('') === c2.join(''));
  const fmt = c1.reduce((acc, bit, i) => acc | (bit << i), 0);
  const raw = fmt ^ 0x5412; // 标准要先 XOR 0x5412，验整除前先还原
  const rawBits = [];
  for (let i = 0; i < 15; i += 1) rawBits.push((raw >> i) & 1);
  check(`${label} 格式信息 BCH 能被 0x537 整除`, bchRemainder(rawBits, 10, 0x537) === 0);
  const data5 = raw >> 10;
  check(`${label} 格式信息里的掩码号`, (data5 & 7) === qr.mask, `${data5 & 7} vs ${qr.mask}`);
  const ECC_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  check(`${label} 格式信息里的纠错等级`, (data5 >> 3) === ECC_BITS[level], `${data5 >> 3} vs ${level}`);

  // 版本信息（v7 起）
  if (qr.version >= 7) {
    const vb = [];
    for (let i = 0; i < 18; i += 1) vb.push(qr.modules[Math.floor(i / 3) * qr.size + qr.size - 11 + (i % 3)]);
    check(`${label} 版本信息 BCH 余数为 0`, bchRemainder(vb, 12, 0x1f25) === 0);
    const vval = vb.reduce((acc, bit, i) => acc | (bit << i), 0) >> 12;
    check(`${label} 版本信息里的版本号`, vval === qr.version, `${vval} vs ${qr.version}`);
  }

  // 数据 + ECC：反交错后逐块验校验式
  const bits = readDataBits(qr, fn);
  const { sizes, ecc } = blockLengths(qr.version, level);
  const cwCount = sizes.reduce((a, s) => a + s, 0) + sizes.length * ecc;
  check(`${label} 数据格数量`, bits.length >= cwCount * 8, `${bits.length} bits`);
  const codewords = [];
  for (let i = 0; i < cwCount; i += 1) {
    let v = 0;
    for (let b = 0; b < 8; b += 1) v = (v << 1) | bits[i * 8 + b];
    codewords.push(v);
  }
  const blocks = sizes.map(() => []);
  let ptr = 0;
  const maxData = Math.max(...sizes);
  for (let i = 0; i < maxData; i += 1) {
    sizes.forEach((len, bi) => {
      if (i < len) blocks[bi].push(codewords[ptr++]);
    });
  }
  const eccBlocks = sizes.map(() => []);
  for (let i = 0; i < ecc; i += 1) {
    sizes.forEach((_len, bi) => {
      eccBlocks[bi].push(codewords[ptr++]);
    });
  }
  blocks.forEach((blk, bi) => {
    const whole = [...blk, ...eccBlocks[bi]];
    const syms = syndromes(whole, ecc);
    check(`${label} 块${bi + 1} RS 校验`, syms.every((s) => s === 0), `syndromes=[${syms}]`);
  });

  // 解出文本：交错过的码字流得先按分块拼回原顺序，否则多块的符号会读成一团错乱
  const dbits = [];
  for (const cw of blocks.flat()) {
    for (let k = 7; k >= 0; k -= 1) dbits.push((cw >> k) & 1);
  }
  let off = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = (v << 1) | dbits[off++];
    return v;
  };
  check(`${label} 是 Byte 模式`, take(4) === 0b0100);
  const len = take(qr.version < 10 ? 8 : 16);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = take(8);
  const decoded = new TextDecoder().decode(bytes);
  check(`${label} 解码文本一致`, decoded === text, `解出「${decoded}」`);
  // 填满容量的边界：剩下的应当是结束符（最多 4 个 0）+ 0xEC/0x11 交替填充
  let rest = dbits.slice(off);
  const term = Math.min(4, rest.length);
  check(`${label} 结束符是 0`, rest.slice(0, term).every((b) => b === 0));
  rest = rest.slice(term);
  const padBytes = [];
  for (let i = 0; i < rest.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k += 1) v = (v << 1) | rest[i + k];
    padBytes.push(v);
  }
  check(`${label} 填充字节按 0xEC/0x11 交替`, padBytes.every((b, i) => b === [0xec, 0x11][i % 2]), padBytes.map((b) => b.toString(16)).join(' '));
  return qr;
}

console.log('— 结构与往返 —');
const samples = [
  ['', { ecLevel: 'L' }],
  ['https://example.com/', { ecLevel: 'L' }],
  ['ABCDEF0123456789', { ecLevel: 'M', mask: 0 }],
  ['a'.repeat(17), { ecLevel: 'L' }], // v1-L 满容量
  ['a'.repeat(18), { ecLevel: 'L' }], // 溢出到 v2
  ['x'.repeat(154), { ecLevel: 'L' }], // v7-L 满容量，含版本信息
  ['y'.repeat(271), { ecLevel: 'L' }], // v10-L 满容量，16 位长度
  ['z'.repeat(213), { ecLevel: 'M' }], // v10-M 满容量
  ['比色挑战·第 7 次猜测', { ecLevel: 'M' }], // 中文 UTF-8
  ['HSV 挑战 https://user.github.io/HSV-testing/?share=result&h=213&s=57&l=68&d=hard&g=3,5,8', { ecLevel: 'L' }],
];
for (const [text, options] of samples) verify(text, options);

console.log('— 边界 —');
check('v1-L 装 17 字节选 v1', encode('a'.repeat(17), { ecLevel: 'L' }).version === 1);
check('超容量抛 RangeError', (() => {
  try {
    encode('a'.repeat(272), { ecLevel: 'L' });
    return false;
  } catch (err) {
    return err instanceof RangeError;
  }
})());
check('锁定掩码生效', encode('hello', { ecLevel: 'L', mask: 5 }).mask === 5);
console.log('— 掩码优选 —');
const auto = encode('https://example.com/share?result=1&h=213&s=57&l=68&d=hard', { ecLevel: 'M' });
const forced = [];
for (let mask = 0; mask < 8; mask += 1) {
  forced.push(encode('https://example.com/share?result=1&h=213&s=57&l=68&d=hard', { ecLevel: 'M', mask }).mask);
  verify(`mask${mask}`, { ecLevel: 'M', mask });
}
check('自动选的掩码在 0-7 内', auto.mask >= 0 && auto.mask <= 7);
check('锁定掩码逐个可用', forced.join('') === '01234567');

console.log(failed === 0 ? `\n✓ ${passed} 项断言全部通过` : `\n✗ ${failed} / ${passed + failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
