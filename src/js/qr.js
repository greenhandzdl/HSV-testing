/**
 * 零依赖 QR Code 编码器（ISO/IEC 18004）。
 *
 * 刻意只做够用的一小块标准：Byte 模式 + 版本 1-18 + 纠错等级 L / M。
 * 历史卡二维码要带最近几题的「目标色 + 三次猜测色」，一题完整颜色约 90 字节，
 * 三题就冲出 v10-M（213 字节）到 v16-M 附近，所以把版本上界抬到 v18（配合放大后的
 * 二维码边长仍能留到 ≥4px/格）。再高版本（v19+）在卡片这个尺寸下格子太密、对着屏幕
 * 基本扫不动，且社媒二次压缩后更易失败，故不搬进来 —— 少一段表就少一处能抄错的地方。
 * 分块表数值抄自 ISO/IEC 18004 表（thonky 公开转写），由 tools/qr-check.mjs 独立重算
 * RS 校验式反查，再用浏览器 BarcodeDetector 真解码逐版对拍。
 *
 * 本文件不碰 DOM，所以 tools/qr-check.mjs 能直接在 Node 里跑数学与结构断言，
 * 再用浏览器的 BarcodeDetector（真解码器）做端到端对拍。
 */

/* ------------------------------ GF(256) 运算 ------------------------------ */
// 素多项式 0x11D（x^8 + x^4 + x^3 + x^2 + 1），QR 规定生成元 α = 0x02
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) {
  GF_EXP[i] = x;
  GF_LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/* --------------------------- 版本 / 纠错分块表 --------------------------- */
/**
 * [每块 ECC 码字数, 组1块数, 组1每块数据码字数, 组2块数, 组2每块数据码字数]
 * 下标 1..18 对应版本 1..18；组2块数为 0 表示没有第二组。
 * 抄自 ISO/IEC 18004 表 5-22（thonky 公开转写），容量对不对由 qr-check 反查。
 */
const BLOCK_TABLE = Object.freeze({
  L: [
    null,
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
    [20, 4, 81, 0, 0],
    [24, 2, 92, 2, 93],
    [26, 4, 107, 0, 0],
    [30, 3, 115, 1, 116],
    [22, 5, 87, 1, 88],
    [24, 5, 98, 1, 99],
    [28, 1, 107, 5, 108],
    [30, 5, 120, 1, 121],
  ],
  M: [
    null,
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
    [30, 1, 50, 4, 51],
    [22, 6, 36, 2, 37],
    [22, 8, 37, 1, 38],
    [24, 4, 40, 5, 41],
    [24, 5, 41, 5, 42],
    [28, 7, 45, 3, 46],
    [28, 10, 46, 1, 47],
    [26, 9, 43, 4, 44],
  ],
});

const ECC_BITS = Object.freeze({ L: 1, M: 0, Q: 3, H: 2 }); // 格式信息里的两位
const MAX_VERSION = 18;
const PAD_BYTES = [0xec, 0x11];

/** 去掉功能图形后剩下的模块数（不含补齐位） */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** 数据 + ECC 的总码字数 */
export function totalCodewords(version) {
  return Math.floor(rawDataModules(version) / 8);
}

export function dataCodewords(version, ecLevel) {
  const b = BLOCK_TABLE[ecLevel][version];
  return b[1] * b[2] + b[3] * b[4];
}

/** Byte 模式下这一版这一等级能装几个字节（4 位模式 + 8/16 位长度，按位算再取整） */
export function capacityBytes(version, ecLevel) {
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((dataCodewords(version, ecLevel) * 8 - 4 - countBits) / 8);
}

/** 校正图形中心坐标（版本 1 没有） */
export function alignmentPositions(version) {
  if (version < 2) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.ceil((size - 13) / (numAlign * 2 - 2)) * 2;
  const pos = [6];
  for (let p = size - 7; pos.length < numAlign; p -= step) pos.splice(1, 0, p);
  return pos;
}

/* ------------------------------ Reed–Solomon ------------------------------ */
const GEN_CACHE = new Map();

/** 生成多项式 (x-α^0)(x-α^1)…(x-α^(degree-1))，首项系数为 1，按降幂存 */
function generatorPoly(degree) {
  if (GEN_CACHE.has(degree)) return GEN_CACHE.get(degree);
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  GEN_CACHE.set(degree, poly);
  return poly;
}

/** 求余式，即该块的 ECC 码字（长度 = degree） */
function rsRemainder(data, degree) {
  const gen = generatorPoly(degree);
  const res = new Uint8Array(degree);
  for (let n = 0; n < data.length; n += 1) {
    const factor = data[n] ^ res[0];
    res.copyWithin(0, 1);
    res[degree - 1] = 0;
    for (let i = 0; i < degree; i += 1) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

/* -------------------------------- BCH 编码 -------------------------------- */
/** 格式信息：5 位数据 + BCH(10,5)，生成式 0x537，最后再 XOR 0x5412 */
function bchFormat(data5) {
  let rem = data5;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return ((data5 << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** 版本信息：6 位数据 + BCH(12,6)，生成式 0x1F25 */
function bchVersion(version) {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

/* -------------------------------- 掩码函数 -------------------------------- */
// i = 行，j = 列（标准里的 (row, column)，条件 1/2/4 不对称，别把行列写反）
function maskBit(mask, i, j) {
  switch (mask) {
    case 0:
      return (i + j) % 2 === 0;
    case 1:
      return i % 2 === 0;
    case 2:
      return j % 3 === 0;
    case 3:
      return (i + j) % 3 === 0;
    case 4:
      return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5:
      return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6:
      return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    default:
      return (((i + j) % 2) + ((i * j) % 3)) % 2 === 0;
  }
}

/* ------------------------------ 比特流拼装 ------------------------------ */
function buildCodewords(version, ecLevel, payloadBytes) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // Byte 模式
  push(payloadBytes.length, version < 10 ? 8 : 16);
  for (let i = 0; i < payloadBytes.length; i += 1) push(payloadBytes[i], 8);

  const capacityBits = dataCodewords(version, ecLevel) * 8;
  // 结束符：最多 4 个 0，装不下就省
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let i = 0; bits.length < capacityBits; i += 1) push(PAD_BYTES[i % 2], 8);

  const data = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i += 1) if (bits[i]) data[i >> 3] |= 0x80 >> (i & 7);

  // 分块 -> 求 ECC -> 数据与 ECC 各自交错，末尾补标准规定的 0 位
  const [eccLen, g1, g1Data, g2, g2Data] = BLOCK_TABLE[ecLevel][version];
  const sizes = [];
  for (let i = 0; i < g1; i += 1) sizes.push(g1Data);
  for (let i = 0; i < g2; i += 1) sizes.push(g2Data);
  const blocks = [];
  let offset = 0;
  for (const size of sizes) {
    const chunk = data.subarray(offset, offset + size);
    offset += size;
    blocks.push({ chunk, ecc: rsRemainder(chunk, eccLen) });
  }
  const out = [];
  for (let i = 0; i < g1Data + (g2Data > g1Data ? 1 : 0); i += 1) {
    for (const b of blocks) if (i < b.chunk.length) out.push(b.chunk[i]);
  }
  for (let i = 0; i < eccLen; i += 1) {
    for (const b of blocks) out.push(b.ecc[i]);
  }
  return { codewords: Uint8Array.from(out), remainderBits: rawDataModules(version) - totalCodewords(version) * 8 };
}

/* -------------------------------- 画矩阵 -------------------------------- */
function newMatrix(version) {
  const size = version * 4 + 17;
  return { size, mod: new Uint8Array(size * size), fn: new Uint8Array(size * size) };
}

function setFn(m, i, j, value) {
  m.mod[i * m.size + j] = value ? 1 : 0;
  m.fn[i * m.size + j] = 1;
}

/**
 * 格式信息的 15 个比特各有两处落位（返回 [row, col] 两个坐标），两处内容完全相同。
 * 副本一绕左上定位图形：比特 0-5 沿第 8 列向下（跳过第 6 行的时序），6/7 拐弯，8-14 沿第 8 行向左；
 * 副本二沿第 8 行向右 + 第 8 列向下贴住左下定位图形。
 * 占位与写入共用这一张表，避免出现「预留了数据格」或「数据盖掉格式区」这类只有解码器才发现的错误。
 */
function formatPositions(size, i) {
  const a = i < 6 ? [i, 8] : i === 6 ? [7, 8] : i === 7 ? [8, 8] : i === 8 ? [8, 7] : [8, 14 - i];
  const b = i < 8 ? [8, size - 1 - i] : [size - 15 + i, 8];
  return [a, b];
}

function drawFunctionPatterns(m, version) {
  const { size } = m;
  for (let i = 0; i < size; i += 1) {
    setFn(m, 6, i, i % 2 === 0);
    setFn(m, i, 6, i % 2 === 0);
  }
  // 三个定位图形 + 分隔符：用切比雪夫距离一次画完（3=外环黑，2=白环，<=1=中心黑，4=分隔符）
  for (const [ci, cj] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
    for (let di = -4; di <= 4; di += 1) {
      for (let dj = -4; dj <= 4; dj += 1) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || i >= size || j < 0 || j >= size) continue;
        const dist = Math.max(Math.abs(di), Math.abs(dj));
        setFn(m, i, j, dist !== 2 && dist !== 4);
      }
    }
  }
  for (const ci of alignmentPositions(version)) {
    for (const cj of alignmentPositions(version)) {
      // 三个角上的定位图形已经把这块占了
      if ((ci <= 8 && cj <= 8) || (ci <= 8 && cj >= size - 9) || (ci >= size - 9 && cj <= 8)) continue;
      for (let di = -2; di <= 2; di += 1) {
        for (let dj = -2; dj <= 2; dj += 1) {
          setFn(m, ci + di, cj + dj, Math.max(Math.abs(di), Math.abs(dj)) !== 1);
        }
      }
    }
  }
  // 格式信息区先占位（真正的比特在选完掩码后写入），别被数据覆盖
  for (let i = 0; i < 15; i += 1) {
    const [a, b] = formatPositions(size, i);
    setFn(m, a[0], a[1], 0);
    setFn(m, b[0], b[1], 0);
  }
  setFn(m, size - 8, 8, 1); // 固定黑模块，标准规定永远是黑
  if (version >= 7) {
    const bits = bchVersion(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = (bits >> i) & 1;
      const di = Math.floor(i / 3);
      const dj = (i % 3) + size - 11;
      setFn(m, dj, di, bit); // 右上角
      setFn(m, di, dj, bit); // 左下角
    }
  }
}

function drawFormatBits(m, ecLevel, mask) {
  const bits = bchFormat((ECC_BITS[ecLevel] << 3) | mask);
  for (let i = 0; i < 15; i += 1) {
    const bit = (bits >> i) & 1;
    const [a, b] = formatPositions(m.size, i);
    setFn(m, a[0], a[1], bit);
    setFn(m, b[0], b[1], bit);
  }
  setFn(m, m.size - 8, 8, 1); // 占位时写 0，掩码算完仍要把它按回黑
}

function placeData(m, codewords, remainderBits) {
  const { size } = m;
  const totalBits = codewords.length * 8 + remainderBits;
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过竖直时序图案那一列
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (m.fn[row * size + col]) continue;
        if (bit < totalBits) {
          const value = bit < codewords.length * 8 ? (codewords[bit >> 3] >> (7 - (bit & 7))) & 1 : 0;
          m.mod[row * size + col] = value;
          bit += 1;
        } else {
          m.mod[row * size + col] = 0;
        }
      }
    }
  }
}

function applyMask(m, mask) {
  const { size } = m;
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j < size; j += 1) {
      if (!m.fn[i * size + j] && maskBit(mask, i, j)) m.mod[i * size + j] ^= 1;
    }
  }
}

/** 四条罚分规则（ISO 8.8.2）：相邻同色 / 2x2 同色块 / 类似定位图形 / 黑白比例 */
function penalty(m) {
  const { size } = m;
  const at = (i, j) => m.mod[i * size + j];
  let score = 0;

  for (let i = 0; i < size; i += 1) {
    for (const line of [
      (j) => at(i, j),
      (j) => at(j, i),
    ]) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        if (line(j) === line(j - 1)) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          run = 1;
        }
      }
    }
  }

  for (let i = 0; i < size - 1; i += 1) {
    for (let j = 0; j < size - 1; j += 1) {
      const v = at(i, j);
      if (v === at(i, j + 1) && v === at(i + 1, j) && v === at(i + 1, j + 1)) score += 3;
    }
  }

  // 1:1:3:1:1 且任一侧有 4 个白模块 —— 两侧都命中就各算一次
  const DARK_LIGHT = [1, 0, 1, 1, 1, 0, 1];
  const head = [0, 0, 0, 0];
  const check = (get) => {
    for (let start = 0; start + 11 <= size; start += 1) {
      let a = true;
      let b = true;
      for (let k = 0; k < 7; k += 1) {
        if (get(start + 4 + k) !== DARK_LIGHT[k]) a = false;
        if (get(start + k) !== DARK_LIGHT[k]) b = false;
      }
      for (let k = 0; k < 4; k += 1) {
        if (get(start + k) !== head[0]) a = false;
        if (get(start + 7 + k) !== head[0]) b = false;
      }
      if (a) score += 40;
      if (b) score += 40;
    }
  };
  for (let i = 0; i < size; i += 1) {
    check((k) => at(i, k));
    check((k) => at(k, i));
  }

  let dark = 0;
  for (let i = 0; i < m.mod.length; i += 1) dark += m.mod[i];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/* ---------------------------------- 对外 ---------------------------------- */
/**
 * 把文本编成二维码。
 * @param {string} text 待编码文本（UTF-8，Byte 模式）
 * @param {{ecLevel?: 'L'|'M', mask?: number}} [options] mask 传 0-7 可锁定掩码（测试用）
 * @returns {{version:number,size:number,ecLevel:string,mask:number,modules:Uint8Array}}
 */
export function encode(text, options = {}) {
  const ecLevel = options.ecLevel === 'M' ? 'M' : 'L';
  const bytes = new TextEncoder().encode(String(text));
  let version = 1;
  while (version <= MAX_VERSION && capacityBytes(version, ecLevel) < bytes.length) version += 1;
  if (version > MAX_VERSION) {
    throw new RangeError(`QR 载荷 ${bytes.length} 字节，超出 v${MAX_VERSION}-${ecLevel} 容量`);
  }

  const { codewords, remainderBits } = buildCodewords(version, ecLevel, bytes);
  const m = newMatrix(version);
  drawFunctionPatterns(m, version);
  placeData(m, codewords, remainderBits);

  let best = { mask: 0, score: Infinity, snapshot: null };
  for (let mask = 0; mask < 8; mask += 1) {
    if (typeof options.mask === 'number' && options.mask !== mask) continue;
    applyMask(m, mask);
    drawFormatBits(m, ecLevel, mask);
    const score = penalty(m);
    if (score < best.score) best = { mask, score, snapshot: m.mod.slice() };
    applyMask(m, mask); // 掩码是自反的，再算一次即还原
  }
  m.mod.set(best.snapshot);
  drawFormatBits(m, ecLevel, best.mask);

  return { version, size: m.size, ecLevel, mask: best.mask, modules: m.mod };
}

/** 取某一模块的颜色（1=黑），越界返回 0，方便画静区 */
export function get(qr, row, col) {
  if (row < 0 || col < 0 || row >= qr.size || col >= qr.size) return 0;
  return qr.modules[row * qr.size + col];
}
