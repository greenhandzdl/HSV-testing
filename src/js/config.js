/**
 * 可调常量：难度参数、评分权重、颜色范围、机会数、历史条数、分享载荷与卡片规格。
 * 全部 frozen，任何一处运行时写入都会被静默忽略（strict mode 下抛错），
 * 所以「改了没生效」的第一件事是来这里核对，而不是翻渲染代码。
 */
export const CONFIG = Object.freeze({
  MAX_GUESSES: 3, // 每题提交机会
  // 每题开始时滑块的初始值（中性灰蓝，不泄露目标色）
  ROUND_DEFAULT: Object.freeze({ h: 180, s: 50, l: 50 }),

  // 三条轴的上限（下限统一是 0）。滑块与 ± 按钮共用这一份：两边各写一个数，
  // 迟早会出现「滑块能拖到 360 而按钮只让到 359」这种对不齐的边界
  AXES: Object.freeze({ h: 360, s: 100, l: 100 }),

  // ± 微调按钮：轻点走一格，按住进入连发，间隔逐帧收窄到 fastDelay
  STEPPER: Object.freeze({
    step: 1,        // 单档步长；要粗调请拖滑块，按钮只负责细微修正
    holdDelay: 400, // 按住多久开始连发（够长，不会把一次普通点击读成连发）
    fastDelay: 70,  // 连发收敛到的最小间隔
    rampFrames: 6,  // 用几帧把间隔降到位：起步慢得看得清，越按越快
  }),

  SCORE: Object.freeze({
    weights: Object.freeze({ h: 0.65, s: 0.2, l: 0.15 }), // 色相权重最高
    hueMaxDistance: 180, // 色相环形距离上限
    finalRule: 'max', // 最终得分口径：'max' | 'avg' | 'last'
  }),

  DIFFICULTY: Object.freeze({
    min: 1,
    max: 10,
    default: 1,
    // 饱和度均值随难度左移：meanS = clamp(85 - d * 6, 15, 85)
    meanSatBase: 85,
    meanSatPerLevel: 6,
    meanSatFloor: 15,
    meanSatCeil: 85,
    satStd: 12, // 高斯分布标准差
    hueMin: 0,
    hueMax: 360,
    lightMin: 25, // 避免过黑
    lightMax: 80, // 避免过白
  }),

  // 自动递增难度：考得好升级，考得差降级
  AUTO: Object.freeze({ upThreshold: 88, downThreshold: 45 }),

  // 连续高分记录口径
  STREAK: Object.freeze({ threshold: 95 }),

  HISTORY: Object.freeze({
    recentDefault: 5, // 默认显示最近 5 题
    recentOptions: Object.freeze([5, 8, 10]),
    maxPerBucket: 30, // 每个难度桶 / 全局最多保留 30 条，防 localStorage 膨胀
  }),

  /**
   * 评价档位：label 用于结算/历史/只读视图，line 用于分享卡片文案。
   * 两者放在同一条目里，避免两张阈值表各自漂移。
   */
  RATINGS: Object.freeze([
    Object.freeze({ min: 95, label: '神之眼', line: '三次之内锁死目标色，这双眼不太讲道理' }),
    Object.freeze({ min: 85, label: '非常接近', line: '差一点点就是完美复刻' }),
    Object.freeze({ min: 70, label: '不错', line: '色感在线，还能再收紧一点' }),
    Object.freeze({ min: 50, label: '继续努力', line: '大方向对了，细节还在飘' }),
    Object.freeze({ min: 0, label: '色感有待提升', line: '颜色都认识，就是还不太熟' }),
  ]),

  /**
   * 历史卡文案：阈值口径跟 RATINGS 完全一致（同一把分数尺），但句子说的是「一批题」
   * 而不是「这一题」，所以另开一张表而不是复用 line 字段。档位标签仍取 RATINGS 的
   * label（见 rules.js 的 historyRatingOf），两张卡对同一分数的叫法不会分裂。
   */
  HISTORY_LINES: Object.freeze([
    Object.freeze({ min: 95, line: '这批题里没几道骗得过这双眼' }),
    Object.freeze({ min: 85, line: '稳定在高分区，色感已经成型' }),
    Object.freeze({ min: 70, line: '大部分题都能压到附近，偶尔飘一次' }),
    Object.freeze({ min: 50, line: '方向感有了，精度还在练' }),
    Object.freeze({ min: 0, line: '样本还不算多，先把分数攒起来再说' }),
  ]),

  SHARE: Object.freeze({
    version: 1,
    maxRounds: 8, // 分享链接里最多带 8 题
    maxLength: 1800, // 超过则退化为"仅摘要"，避免链接过长被 IM 截断
    // 卡片二维码的载荷上限。本地量过：cardUrl 拼出的 URL 在本地是 119 字符，载荷部分 97 字符；
    // 换成 https://<user>.github.io/<repo>/ 前缀再长 20 字符 → 最长约 140 字符；
    // 150 = 卡到 v8-M（容量 152 字节，49×49 模块），340px 静区边长下每格 5px，
    // 手机屏/打印都能扫。再长就进 v9-v10，格子密到对着屏幕扫基本失败，所以直接退回站点首页。
    qrMaxLength: 150,
  }),

  CARD: Object.freeze({
    width: 1080,
    height: 1350, // 4:5，小红书 / 朋友圈都能直接发
    margin: 76,
    qrSize: 340, // 二维码绘制边长（像素，含 4 格静区）；340 才能给 v8-M 的 57 格留到 5px/格
    qrEcLevel: 'M', // 卡片会被拍照 / 截图，纠错等级优先于容量
    fileName: 'color-match',
    historyFileName: 'color-match-history',
  }),

  STORAGE_KEY: 'hsvColorMatch.history.v1',
});
