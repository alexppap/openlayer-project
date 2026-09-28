// src/composables/useVehicles.verify.js — 速度染色/播放头/朝向解缠/统计/尾迹纯函数
//   与车辆图层常量契约自测（pnpm verify 自动发现挂载）
//
// ⚠ 测试先行：本文件先于 src/composables/useVehicles.js 与 constants.js 车辆扩展落地
//   （实施计划步骤 1/5），在被测模块实现前 pnpm verify 对本挂载点报「找不到模块/导出不存在」
//   属预期红灯（先例：useAlarms.verify.js 头注）。
//
// ⚠ 运行环境约束：本文件在纯 node 下执行。useVehicles.js 模块顶层只允许 vue ref/computed
//   与纯函数（ol 实例/canvas/rAF 一律在 initVehicles 及运行时函数内惰性构造——
//   计划 risks node 兼容红线，先例 useAlarms.js:6-8）。
//
// 被测契约（实施计划 testPoint「resolveSpeedColor/buildSpeedSegments/resolvePlayheadIndex/
//   resolveSegmentHeading/resolveUnwrappedHeading/buildTrackStats/buildTrailSegments/常量契约」
//   + 步骤 1/5；设计 §4.3 L114-118 已走段速度染色、播放器倍速、车头 rotation+累计角度、
//   尾迹 TRAIL_POINT_COUNT 渐隐）：
//
// ★ 本文件断言即契约（形状由本文件定义，实现须对齐——手法先例：useAlarms.verify.js）：
//   本组纯函数的「轨迹点」统一形状（投影由调用方决定——mock 4326 侧 / 渲染层 3857 侧）：
//     TrackPointLike = { coord: [x, y], time: number, speedKmh: number }
//   resolveSpeedColor(speedKmh) → '#RRGGBB'：按 SPEED_COLOR_STOPS 升序阈值取档色
//     （speed ∈ [t_k, t_{k+1}) 取第 k 档，末档无上界）；负数/NaN 回退首档色（慢端兜底），不抛错。
//   buildSpeedSegments(points, walkedIndex = points.length - 1) → Array<SpeedSegmentRun>：
//     底层每个相邻点对 (i, i+1) 为一段，段染色速度 = points[i].speedKmh（离开点 i 时的速度，
//     对齐 resolveRoutePositionAt 的所在腿速度语义）；连续同色段合并为一个 run：
//       SpeedSegmentRun = { startIndex: number, coords: [x,y][], color: '#RRGGBB' }
//     相邻 run 颜色必不同；run.coords 为连续点串且相邻 run 无缝衔接（共享边界点）；
//     walkedIndex 截断：只覆盖点 0..walkedIndex 之间的段（Σ(coords.length-1) = walkedIndex）。
//   resolvePlayheadIndex(points, timeMs) → { index, fraction }（播放进度 → 轨迹点映射）：
//     points 按时间升序；t ≤ 首点 → { index: 0, fraction: 0 }；t ≥ 末点 →
//     { index: points.length - 2, fraction: 1 }；恰在采样点 k → { index: k, fraction: 0 }；
//     两点之间 → 线性比例 fraction ∈ (0, 1)（index 为左端点索引）。
//   resolveSegmentHeading(fromCoord, toCoord) → number（弧度，自北顺时针）：
//     3857 平面口径 atan2(dx, dy)（回放侧消费；与 mock 端 cos 修正 4326 口径在
//     Mercator 正形投影下代数等价——计划 risks 评审意见 2 头注互指）；
//     零向量返回 0 不抛错。
//   resolveUnwrappedHeading(previousRad, targetRad) → number：跨 ±π 最短路径的累计角度——
//     返回 target ± 2kπ 中与 previous 最近者（|结果 - previous| ≤ π 且结果 ≡ target (mod 2π)）；
//     同值输入恒等返回。回放每帧与实时每次推送的车头 rotation 均经它累计更新
//     （设计 §4.3 L116「rotation 属性 + 累计角度」原文，计划 risks 评审意见 3）。
//   buildTrackStats(points, { measureDistance } = {}) → {
//     totalDistanceM, totalDurationMs, averageSpeedKmh, maxSpeedKmh
//   }：measureDistance(coordA, coordB) → 米（默认为渲染层测地线口径，node 注入桩测数学）；
//     总里程 = Σ 段距；总时长 = 末首时间差；平均速度 = 总里程/总时长×3.6（km/h）；
//     最高速度 = 最快段速度；点数 < 2 → 全零结构不抛错。
//   buildTrailSegments(points) → Array<{ coords: [x,y][], alpha: number }>：
//     尾迹点按时间升序（末尾最新）；只保留最近 TRAIL_POINT_COUNT 个点，输出其相邻段；
//     alpha 沿索引严格递增（最新段最不透明），∈ (0, 1]；点数不足时全量输出；<2 点 → []。
//
// 常量（计划步骤 1 + testPoint【评审4】常量契约）：
//   VEHICLES_LAYER_ID='vehicles-layer'（kebab-case，AGENTS.md 命名规范）；
//   LAYER_TREE_GROUPS 含 { label:'车辆', layerIds:['vehicles-layer'] }；
//   PLAYBACK_SPEED_OPTIONS = [1,2,4,8,16]；POSITION_ROUTE_TIME_SCALE = 1（实跑位移预算定档，
//   见 constants 注释）；TRACK_SAMPLE_INTERVAL_MS = 10000（10s 采样）。
//
// 诚实缺口（计划 risks 已声明，先例 useAlarms.verify.js:33-35）：
//   「平滑移动」（rAF 在推送间隔内插值）、「渐隐尾迹」渲染、「倍速播放」、「车头旋转」视觉、
//   多车淡显单选、VehiclePanel UI、useVehicles/useZones 的 HMR 自愈（init 内 ol 地图操作）
//   均为浏览器行为，node 无法断言，留待人工验收（设计 §6 L154 item 4/5）；
//   buildTrackStats 默认测距（ol/sphere 测地线）的绝对精度不在注入桩口径内，不锁。

import assert from 'node:assert/strict';
import {
  buildSpeedSegments,
  buildTrackStats,
  buildTrailSegments,
  resolvePlayheadIndex,
  resolveSegmentHeading,
  resolveSpeedColor,
  resolveUnwrappedHeading,
} from './useVehicles.js';
import {
  LAYER_TREE_GROUPS,
  PLAYBACK_SPEED_OPTIONS,
  POSITION_ROUTE_TIME_SCALE,
  SPEED_COLOR_STOPS,
  TRACK_SAMPLE_INTERVAL_MS,
  TRAIL_POINT_COUNT,
  VEHICLES_LAYER_ID,
} from '../constants.js';

const TAU = Math.PI * 2;
const toRad = (deg) => (deg * Math.PI) / 180;
const normalizeHeading = (rad) => ((rad % TAU) + TAU) % TAU;

const assertClose = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}（实际 ${String(actual)}，期望 ${String(expected)} ± ${String(tolerance)}）`,
  );

// 桩轨迹点工厂：coord/time/speedKmh 全显式（用例值自造，与真实种子无关）
const makeTrackPoint = ({ coord, time, speedKmh }) => ({ coord, time, speedKmh });

// SPEED_COLOR_STOPS 复算期望档（升序阈值：speed ∈ [t_k, t_{k+1}) 取 k，末档无上界）
const expectedSpeedColor = (speedKmh) =>
  SPEED_COLOR_STOPS.reduce(
    (matchedColor, stop) => (speedKmh >= stop.threshold ? stop.color : matchedColor),
    SPEED_COLOR_STOPS[0].color,
  );

export const verify = (assert) => {
  // ================= 常量契约（计划步骤 1 + testPoint【评审4】）=================

  assert.equal(VEHICLES_LAYER_ID, 'vehicles-layer', "VEHICLES_LAYER_ID 应为 'vehicles-layer'（kebab-case）");
  const vehicleTreeGroup = LAYER_TREE_GROUPS.find((group) => group.label === '车辆');
  assert.ok(vehicleTreeGroup, "LAYER_TREE_GROUPS 应含 label='车辆' 分组（图层树统一控制显隐）");
  assert.deepEqual(
    vehicleTreeGroup.layerIds,
    [VEHICLES_LAYER_ID],
    '车辆分组的 layerIds 应恰为 [VEHICLES_LAYER_ID]',
  );
  assert.deepEqual(
    PLAYBACK_SPEED_OPTIONS,
    [1, 2, 4, 8, 16],
    'PLAYBACK_SPEED_OPTIONS 应恰为 [1,2,4,8,16]（设计 §4.3 L114 五档倍速）',
  );
  assert.equal(
    POSITION_ROUTE_TIME_SCALE,
    1,
    'POSITION_ROUTE_TIME_SCALE 应为 1（实跑位移预算定档：scale=60 时每推送跳变超厂区对角线，平滑+渐隐失效）',
  );
  assert.equal(
    TRACK_SAMPLE_INTERVAL_MS,
    10000,
    'TRACK_SAMPLE_INTERVAL_MS 应为 10000（10s 采样，10h 窗口 = 3600 点/车）',
  );

  // ================= resolveSpeedColor：分档边界与守护（计划 testPoint 10）=================

  const speedColorCases = [
    [0, 0],
    [19.9, 0],
    [20, 1],
    [39.9, 1],
    [40, 2],
    [59.9, 2],
    [60, 3],
    [99, 3],
  ];
  speedColorCases.forEach(([speedKmh, bucketIndex]) => {
    assert.equal(
      resolveSpeedColor(speedKmh),
      SPEED_COLOR_STOPS[bucketIndex].color,
      `resolveSpeedColor(${String(speedKmh)}) 应取第 ${String(bucketIndex)} 档色（阈值边界对照 SPEED_COLOR_STOPS）`,
    );
  });
  assert.equal(
    resolveSpeedColor(15),
    expectedSpeedColor(15),
    'resolveSpeedColor 应与 SPEED_COLOR_STOPS 复算期望一致（快红慢绿档位不漂移）',
  );
  assert.doesNotThrow(
    () => {
      resolveSpeedColor(-5);
      resolveSpeedColor(NaN);
    },
    'resolveSpeedColor 对负数/NaN 不应抛错（染色兜底不中断回放）',
  );
  assert.equal(resolveSpeedColor(-5), SPEED_COLOR_STOPS[0].color, '负速度应回退首档色（慢端兜底）');
  assert.equal(resolveSpeedColor(NaN), SPEED_COLOR_STOPS[0].color, 'NaN 速度应回退首档色（慢端兜底）');

  // ================= buildSpeedSegments：同色合并 run + 已走截断（计划 testPoint 11）=================

  // 8 点三色（段速度取出发点速度）：10,10,10 | 25,25 | 50,50（末点 65 无出段）
  const segmentPoints = [
    makeTrackPoint({ coord: [0, 0], time: 0, speedKmh: 10 }),
    makeTrackPoint({ coord: [1, 0], time: 10000, speedKmh: 10 }),
    makeTrackPoint({ coord: [2, 0], time: 20000, speedKmh: 10 }),
    makeTrackPoint({ coord: [3, 0], time: 30000, speedKmh: 25 }),
    makeTrackPoint({ coord: [4, 0], time: 40000, speedKmh: 25 }),
    makeTrackPoint({ coord: [5, 0], time: 50000, speedKmh: 50 }),
    makeTrackPoint({ coord: [6, 0], time: 60000, speedKmh: 50 }),
    makeTrackPoint({ coord: [7, 0], time: 70000, speedKmh: 65 }),
  ];

  // 全量（缺省 walkedIndex）：3 个 run、首尾衔接、Σ段数 = 相邻点对数 7
  const fullRuns = buildSpeedSegments(segmentPoints);
  assert.ok(Array.isArray(fullRuns), 'buildSpeedSegments 应返回数组');
  assert.equal(fullRuns.length, 3, '10/25/50 三色交替应合并为 3 个 run');
  assert.equal(fullRuns[0].startIndex, 0, '首个 run 的 startIndex 应为 0');
  assert.deepEqual(fullRuns[0].coords, [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ], '第一 run 应覆盖 10km/h 的 3 段（4 个点）');
  assert.deepEqual(fullRuns[1].coords, [
    [3, 0],
    [4, 0],
    [5, 0],
  ], '第二 run 应覆盖 25km/h 的 2 段');
  assert.deepEqual(fullRuns[2].coords, [
    [5, 0],
    [6, 0],
    [7, 0],
  ], '第三 run 应覆盖 50km/h 的 2 段');
  assert.equal(fullRuns[0].color, SPEED_COLOR_STOPS[0].color, '10km/h 段应取首档色');
  assert.equal(fullRuns[1].color, SPEED_COLOR_STOPS[1].color, '25km/h 段应取第二档色');
  assert.equal(fullRuns[2].color, SPEED_COLOR_STOPS[2].color, '50km/h 段应取第三档色');
  fullRuns.forEach((run, runIndex) => {
    if (runIndex > 0) {
      assert.notEqual(run.color, fullRuns[runIndex - 1].color, '相邻 run 颜色必须不同（否则合并不完整）');
      assert.deepEqual(
        run.coords[0],
        fullRuns[runIndex - 1].coords[fullRuns[runIndex - 1].coords.length - 1],
        '相邻 run 坐标应无缝衔接（共享边界轨迹点）',
      );
      assert.equal(
        run.startIndex,
        fullRuns[runIndex - 1].startIndex + fullRuns[runIndex - 1].coords.length - 1,
        'run.startIndex 应为上一 run 起点加其段数（连续推进）',
      );
    }
  });
  assert.equal(
    fullRuns.reduce((total, run) => total + run.coords.length - 1, 0),
    segmentPoints.length - 1,
    '全量输入的底层段数合计应 = 轨迹相邻点对数（合并不丢段不重点）',
  );
  assert.deepEqual(
    buildSpeedSegments(segmentPoints, segmentPoints.length - 1),
    fullRuns,
    '显式传入 walkedIndex = 末点索引应与缺省全量结果一致',
  );

  // 已走截断：walkedIndex=4 → 覆盖段 0..3（Σ = 4），末 run 末点恰为 points[4]
  const truncatedRuns = buildSpeedSegments(segmentPoints, 4);
  assert.equal(
    truncatedRuns.reduce((total, run) => total + run.coords.length - 1, 0),
    4,
    'walkedIndex=4 截断后底层段数合计应恰为 4（只覆盖已走段）',
  );
  assert.equal(truncatedRuns.length, 2, '截断后应仍按颜色合并（10×3 段 + 25×1 段）');
  assert.deepEqual(
    truncatedRuns[truncatedRuns.length - 1].coords[truncatedRuns[truncatedRuns.length - 1].coords.length - 1],
    segmentPoints[4].coord,
    '截断输出的最后一个点应恰为 walkedIndex 指向的轨迹点',
  );

  // walkedIndex=2 → 单 run 两段；walkedIndex=0 → 尚未出发，零段
  assert.equal(
    buildSpeedSegments(segmentPoints, 2).reduce((total, run) => total + run.coords.length - 1, 0),
    2,
    'walkedIndex=2 截断后底层段数合计应为 2',
  );
  assert.equal(
    buildSpeedSegments(segmentPoints, 0).reduce((total, run) => total + run.coords.length - 1, 0),
    0,
    'walkedIndex=0（尚未出发）应输出零段',
  );

  // 单色输入 → 1 个 run；空/单点 → []
  const singleColorRuns = buildSpeedSegments(
    Array.from({ length: 5 }, (unused, index) =>
      makeTrackPoint({ coord: [index, 0], time: index * 10000, speedKmh: 30 }),
    ),
  );
  assert.equal(singleColorRuns.length, 1, '全程同速应合并为单个 run');
  assert.equal(singleColorRuns[0].coords.length, 5, '单 run 应覆盖全部 5 个点');
  assert.deepEqual(buildSpeedSegments([]), [], '空轨迹应返回空段数组');
  assert.deepEqual(
    buildSpeedSegments([makeTrackPoint({ coord: [0, 0], time: 0, speedKmh: 10 })]),
    [],
    '单点轨迹无相邻点对应返回空段数组',
  );

  // ================= resolvePlayheadIndex：播放进度 → 轨迹点映射（计划 testPoint 12）=================

  const playheadPoints = Array.from({ length: 5 }, (unused, index) =>
    makeTrackPoint({ coord: [index, 0], time: index * 10000, speedKmh: 30 }),
  );
  // t 早于首点：钳制 index=0 / fraction=0
  assert.deepEqual(
    resolvePlayheadIndex(playheadPoints, -5000),
    { index: 0, fraction: 0 },
    't 早于首点应钳制到 { index: 0, fraction: 0 }',
  );
  // 恰在首点
  assert.deepEqual(
    resolvePlayheadIndex(playheadPoints, 0),
    { index: 0, fraction: 0 },
    't 恰为首点应命中该点 { index: 0, fraction: 0 }',
  );
  // 两点之间：线性比例 + 插值坐标复算一致
  const midPlayhead = resolvePlayheadIndex(playheadPoints, 15000);
  assert.equal(midPlayhead.index, 1, 't=15s 应落在第 1 段（index 为左端点索引）');
  assertClose(midPlayhead.fraction, 0.5, 1e-9, 't=15s 在等间隔 10s/20s 段内 fraction 应为 0.5');
  const interpolatedCoord = [
    playheadPoints[midPlayhead.index].coord[0] +
      (playheadPoints[midPlayhead.index + 1].coord[0] - playheadPoints[midPlayhead.index].coord[0]) *
        midPlayhead.fraction,
    playheadPoints[midPlayhead.index].coord[1] +
      (playheadPoints[midPlayhead.index + 1].coord[1] - playheadPoints[midPlayhead.index].coord[1]) *
        midPlayhead.fraction,
  ];
  assert.ok(
    Math.abs(interpolatedCoord[0] - 1.5) <= 1e-12 && Math.abs(interpolatedCoord[1]) <= 1e-12,
    '按返回的 (index, fraction) 插值应复算出线性插值坐标（t=15s → x=1.5）',
  );
  // 非等间隔段的比例
  const unevenPoints = [
    makeTrackPoint({ coord: [0, 0], time: 0, speedKmh: 30 }),
    makeTrackPoint({ coord: [4, 0], time: 8000, speedKmh: 30 }),
    makeTrackPoint({ coord: [5, 0], time: 20000, speedKmh: 30 }),
  ];
  assertClose(
    resolvePlayheadIndex(unevenPoints, 10000).fraction,
    2 / 12,
    1e-9,
    '非等间隔段 fraction 应按时间线性比例（10s 在 [8s,20s] 段内为 2/12）',
  );
  // 恰在中间采样点
  assert.deepEqual(
    resolvePlayheadIndex(playheadPoints, 20000),
    { index: 2, fraction: 0 },
    't 恰为采样点 2 应命中该点 { index: 2, fraction: 0 }',
  );
  // t 恰为末点 / 晚于末点：钳制末段 fraction=1
  assert.deepEqual(
    resolvePlayheadIndex(playheadPoints, 40000),
    { index: playheadPoints.length - 2, fraction: 1 },
    't 恰为末点应钳制到 { index: 末段, fraction: 1 }',
  );
  assert.deepEqual(
    resolvePlayheadIndex(playheadPoints, 99000),
    { index: playheadPoints.length - 2, fraction: 1 },
    't 晚于末点应钳制到 { index: 末段, fraction: 1 }',
  );

  // ================= resolveSegmentHeading：3857 口径四方向 + 零向量（计划 testPoint 13）=================

  const headingOrigin = [100000, 100000]; // 3857 平面向量（口径仅关心 dx/dy，数值自造）
  assertClose(
    normalizeHeading(resolveSegmentHeading(headingOrigin, [100000, 100001])),
    0,
    1e-12,
    '3857 向北（dy>0）heading 应为 0',
  );
  assertClose(
    normalizeHeading(resolveSegmentHeading(headingOrigin, [100001, 100000])),
    Math.PI / 2,
    1e-12,
    '3857 向东（dx>0）heading 应为 π/2（90°，自北顺时针）',
  );
  assertClose(
    normalizeHeading(resolveSegmentHeading(headingOrigin, [100000, 99999])),
    Math.PI,
    1e-12,
    '3857 向南（dy<0）heading 应为 π（180°）',
  );
  assertClose(
    normalizeHeading(resolveSegmentHeading(headingOrigin, [99999, 100000])),
    (3 * Math.PI) / 2,
    1e-12,
    '3857 向西（dx<0）heading 应 ≡ 3π/2（270°；atan2 主值 -π/2 亦可）',
  );
  assert.doesNotThrow(
    () => {
      resolveSegmentHeading(headingOrigin, headingOrigin);
    },
    '零向量输入不应抛错',
  );
  assert.equal(
    Math.abs(resolveSegmentHeading(headingOrigin, headingOrigin)),
    0,
    '零向量 heading 应返回 0',
  );

  // ================= resolveUnwrappedHeading：跨 ±π 最短路径累计（计划 testPoint【评审3】）=================

  assertClose(
    resolveUnwrappedHeading(3.1, -3.1),
    -3.1 + TAU,
    1e-9,
    'previous=3.10, target=-3.10 应解缠到 -3.10 + 2π ≈ 3.183（最短路径跨 ±π 继续累计）',
  );
  [
    [0, 0],
    [1.5, 1.5],
    [-2, -2],
    [Math.PI, Math.PI],
  ].forEach(([previousRad, targetRad]) => {
    assertClose(
      resolveUnwrappedHeading(previousRad, targetRad),
      targetRad,
      1e-12,
      `同值输入 (${String(previousRad)}) 应恒等返回`,
    );
  });

  // 性质扫描：|结果 - previous| ≤ π 且 结果 ≡ target (mod 2π)
  const previousSamples = [-3.13, -1.5, 0, 1, Math.PI, 3.1];
  const targetSamples = [-3.13, -1, 0, 1.7, Math.PI, 3.13];
  previousSamples.forEach((previousRad) => {
    targetSamples.forEach((targetRad) => {
      const unwrapped = resolveUnwrappedHeading(previousRad, targetRad);
      assert.ok(
        Math.abs(unwrapped - previousRad) <= Math.PI + 1e-9,
        `解缠应走最短路径：|结果 - previous| ≤ π（previous=${String(previousRad)}, target=${String(targetRad)}, 实际 ${String(unwrapped)}）`,
      );
      const residue = Math.abs(normalizeHeading(unwrapped - targetRad));
      assert.ok(
        residue <= 1e-9 || Math.abs(residue - TAU) <= 1e-9,
        `解缠结果应 ≡ target (mod 2π)（previous=${String(previousRad)}, target=${String(targetRad)}）`,
      );
    });
  });

  // 连续小步旋转：累计角单调前进、无回绕突跳（跨 ±π 后继续累计而非跳回负角）
  let accumulatedHeading = 0;
  Array.from({ length: 62 }, (unused, index) => (index + 1) * 0.05).forEach((targetRad) => {
    const nextHeading = resolveUnwrappedHeading(accumulatedHeading, targetRad);
    assert.ok(
      nextHeading >= accumulatedHeading - 1e-9,
      '正向小步旋转下累计角应单调不减（无回绕突跳）',
    );
    assert.ok(
      nextHeading - accumulatedHeading <= 0.05 + 1e-9,
      `单步累计增量应 ≤ 步长 0.05（实际 ${String(nextHeading - accumulatedHeading)}）`,
    );
    accumulatedHeading = nextHeading;
  });
  assertClose(accumulatedHeading, 3.1, 1e-9, '62 步 ×0.05 后累计角应为 3.10');
  const wrappedHeading = resolveUnwrappedHeading(accumulatedHeading, -3.13);
  assertClose(
    wrappedHeading,
    -3.13 + TAU,
    1e-9,
    '累计角 3.10 遇 target=-3.13 应解缠为 -3.13+2π ≈ 3.153（继续累计）',
  );
  assert.ok(
    wrappedHeading >= accumulatedHeading,
    '解缠应无突跳：从 3.10 到 3.153 单调前进，而非跳回负角',
  );

  // ================= buildTrackStats：注入桩测距（计划 testPoint 14）=================

  // 恒距桩：4 点、每段 100m、dt=10s
  const statsPoints = Array.from({ length: 4 }, (unused, index) =>
    makeTrackPoint({ coord: [index, 0], time: index * 10000, speedKmh: 30 }),
  );
  const constantStats = buildTrackStats(statsPoints, { measureDistance: () => 100 });
  assert.equal(constantStats.totalDistanceM, 300, '恒距桩：总里程应 = 段数 × 100 = 300m');
  assert.equal(constantStats.totalDurationMs, 30000, '恒距桩：总时长应 = 末首时间差 = 30s');
  // 换算口径：m / (ms/1000) = m/s，×3.6 → km/h（消息所述 36/36/72/144 km/h 即期望；
  //   原表达式 (m/ms)×3.6 为 ms/秒 单位滑动修正，与设计 §4.3「平均速度 = 总里程/总时长」对齐）
  assertClose(
    constantStats.averageSpeedKmh,
    (300 / (30000 / 1000)) * 3.6,
    1e-9,
    '恒距桩：平均速度应 = 总里程/总时长×3.6 = 36km/h',
  );
  assertClose(
    constantStats.maxSpeedKmh,
    (100 / (10000 / 1000)) * 3.6,
    1e-9,
    '恒距桩：最高速度应 = 最快段速度 = 36km/h',
  );

  // 变速桩：段距 [100, 100, 400]、dt=10s → 段速 [36, 36, 144] km/h
  const variableDistances = [100, 100, 400];
  let variableCallCount = 0;
  const variableStats = buildTrackStats(statsPoints, {
    measureDistance: () => {
      const distance = variableDistances[Math.min(variableCallCount, variableDistances.length - 1)];
      variableCallCount += 1;
      return distance;
    },
  });
  assert.equal(variableStats.totalDistanceM, 600, '变速桩：总里程应 = Σ 段距 = 600m');
  assert.equal(variableStats.totalDurationMs, 30000, '变速桩：总时长应 = 末首时间差 = 30s');
  assertClose(variableStats.averageSpeedKmh, 72, 1e-9, '变速桩：平均速度应 = 600/30s×3.6 = 72km/h');
  assertClose(variableStats.maxSpeedKmh, 144, 1e-9, '变速桩：最高速度应 = 最快段（400m/10s）= 144km/h');

  // <2 点：零值结构不抛错
  const emptyStats = buildTrackStats([], { measureDistance: () => 100 });
  assert.deepEqual(
    emptyStats,
    { totalDistanceM: 0, totalDurationMs: 0, averageSpeedKmh: 0, maxSpeedKmh: 0 },
    '空轨迹应返回全零统计结构（轨迹点 <2 时统计兜底，不抛错）',
  );
  assert.doesNotThrow(
    () => {
      buildTrackStats([makeTrackPoint({ coord: [0, 0], time: 0, speedKmh: 30 })], {
        measureDistance: () => 100,
      });
    },
    '单点轨迹统计不应抛错',
  );
  assert.deepEqual(
    buildTrackStats([makeTrackPoint({ coord: [0, 0], time: 0, speedKmh: 30 })], {
      measureDistance: () => 100,
    }),
    { totalDistanceM: 0, totalDurationMs: 0, averageSpeedKmh: 0, maxSpeedKmh: 0 },
    '单点轨迹应返回全零统计结构',
  );

  // ================= buildTrailSegments：截断 + 渐隐（计划 testPoint 15）=================

  // 超量点：只保留最近 TRAIL_POINT_COUNT 个点的相邻段
  const longTrailPoints = Array.from({ length: 40 }, (unused, index) =>
    makeTrackPoint({ coord: [index, 0], time: index * 2000, speedKmh: 35 }),
  );
  const longTrailSegments = buildTrailSegments(longTrailPoints);
  assert.ok(Array.isArray(longTrailSegments), 'buildTrailSegments 应返回数组');
  assert.equal(
    longTrailSegments.length,
    TRAIL_POINT_COUNT - 1,
    `40 点输入应只输出最近 ${String(TRAIL_POINT_COUNT)} 点的 ${String(TRAIL_POINT_COUNT - 1)} 段`,
  );
  assert.deepEqual(
    longTrailSegments[0].coords[0],
    longTrailPoints[longTrailPoints.length - TRAIL_POINT_COUNT].coord,
    '尾迹首段起点应为截断后最旧的保留点（最近 30 点的边界）',
  );
  assert.deepEqual(
    longTrailSegments[longTrailSegments.length - 1].coords[1],
    longTrailPoints[longTrailPoints.length - 1].coord,
    '尾迹末段终点应为最新点',
  );
  longTrailSegments.forEach((trailSegment, segmentIndex) => {
    assert.equal(trailSegment.coords.length, 2, `第 ${String(segmentIndex)} 段应恰为相邻两点对`);
    assert.ok(
      trailSegment.alpha > 0 && trailSegment.alpha <= 1,
      `第 ${String(segmentIndex)} 段 alpha 应 ∈ (0, 1]`,
    );
    if (segmentIndex > 0) {
      assert.ok(
        trailSegment.alpha > longTrailSegments[segmentIndex - 1].alpha,
        `alpha 应沿索引严格递增（第 ${String(segmentIndex)} 段比前段更不透明，最新段最实）`,
      );
    }
  });

  // 点数不足：全量输出
  const shortTrailSegments = buildTrailSegments(
    Array.from({ length: 5 }, (unused, index) =>
      makeTrackPoint({ coord: [index, 0], time: index * 2000, speedKmh: 35 }),
    ),
  );
  assert.equal(shortTrailSegments.length, 4, '5 点（< TRAIL_POINT_COUNT）应全量输出 4 段');

  // <2 点：空输出不抛错
  assert.deepEqual(buildTrailSegments([]), [], '空尾迹应返回空段数组');
  assert.deepEqual(
    buildTrailSegments([makeTrackPoint({ coord: [0, 0], time: 0, speedKmh: 35 })]),
    [],
    '单点尾迹应返回空段数组',
  );
};
