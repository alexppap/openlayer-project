// src/mock/vehicles.verify.js — 车辆种子/路线调度/轨迹生成器纯函数自测（pnpm verify 自动发现挂载）
//
// ⚠ 测试先行：本文件先于 src/mock/vehicles.js 与 constants.js 车辆扩展落地（实施计划步骤 1/2），
//   在被测模块实现前 pnpm verify 对本挂载点报「找不到模块/导出不存在」属预期红灯
//   （先例：composables/useAlarms.verify.js 头注）。
//
// ⚠ 运行环境约束：本文件在纯 node 下执行，被测模块 vehicles.js 须零 ol/vue import
//   （计划 risks node 兼容红线：测距用模块内 haversine；heading 的 cos(lat) 修正
//   在 Mercator 正形投影下代数上恒等于 3857 侧 atan2(dx, dy)，零 ol import）。
//
// 被测契约（实施计划 testPoint「generateTrack 确定性/环线循环契约/VEHICLES_SEED 契约/
//   全车队速度染色可演示/haversine/resolveCorrectedHeading」+ 步骤 1/2；设计 §4.3 L112-L117）：
//
// ★ 本文件断言即契约（形状由本文件定义，实现须对齐——手法先例：useAlarms.verify.js）：
//   VEHICLES_SEED: Vehicle[]，恰 3 辆 ——
//     Vehicle = {
//       id: string（车队内唯一、非空）,
//       name: string（非空）,
//       color: '#RRGGBB'（车队内互异）,
//       route: RoutePoint[]（闭合环线：首尾控制点坐标相同；route.length ≥ 4 即 ≥3 个独立控制点）
//     }
//     RoutePoint = { lng, lat, speedKmh } —— speedKmh = 离开该控制点沿当前腿行进的配置速度；
//       三车路线腿速合并须覆盖 SPEED_COLOR_STOPS 全部四档（快红慢绿可演示）。
//   TRACK_WINDOW: { startMs, endMs } —— 历史轨迹窗口 08:00–18:00 的固定毫秒值
//     （模块内常量，仿 mock/alarms.js SEED_TIME_BASE 先例；跨度恰 10 小时；具体毫秒值不锁）。
//   haversine(fromLngLat, toLngLat) → number（米）：[lng, lat] 两点大圆距离。
//   buildRouteSchedule(route) → {
//     legs: Array<{ lengthM, speedKmh, durationMs, startMs }>,  // 腿 i = route[i] → route[i+1]
//     totalMs: number,                                           // 环线一圈时长 = Σ durationMs
//   }（腿长-累计时间表；startMs 为相对环线起点的出发时刻）。
//   resolveRoutePositionAt(route, timeMs) → { lng, lat, speedKmh, legIndex }：
//     任意 timeMs（含负值/超周期值）按环线周期 totalMs 取模回到 [0, totalMs) 后在所在腿上线性插值；
//     speedKmh = 所在腿配置速度（route[legIndex].speedKmh）。
//   resolveCorrectedHeading(fromLngLat, toLngLat) → number（弧度，自北顺时针，atan2 主值 (-π, π]）：
//     atan2(dLng·cos(latMid), dLat) —— 实时推送朝向的唯一来源（计划 risks 评审意见 2）。
//   generateTrack(vehicle) → Array<{ lng, lat, time, speedKmh }>：
//     纯函数无随机源（同输入两次调用逐字段一致）；从 TRACK_WINDOW.startMs 起、
//     按 TRACK_SAMPLE_INTERVAL_MS（constants.js）等间隔采样至覆盖 endMs；
//     每点恰为 resolveRoutePositionAt(route, point.time) 的确定性快照。
//
// 诚实缺口（计划 risks 已声明，先例 useAlarms.verify.js:33-35）：
//   「平滑移动」「渐隐尾迹」「速度染色渲染」为浏览器行为，node 断言只覆盖纯函数；
//   危险品区穿越断言只对 mock/zones.js 的 ZONES_SEED_GEOJSON 种子多边形成立
//   （用户 localStorage 重绘区域后不保证——围栏判断属下个任务 useGeofence，本任务不实现）；
//   「每圈必经危险品区」在 10s 采样粒度下以累计内部点数下限（≥20，多圈）锁代，不逐圈强断言。

import assert from 'node:assert/strict';
import { ZONES_SEED_GEOJSON } from './zones.js';
import {
  VEHICLES_SEED,
  TRACK_WINDOW,
  haversine,
  buildRouteSchedule,
  resolveRoutePositionAt,
  resolveCorrectedHeading,
  generateTrack,
} from './vehicles.js';
import { SPEED_COLOR_STOPS, TRACK_SAMPLE_INTERVAL_MS } from '../constants.js';

const TAU = Math.PI * 2;
const toRad = (deg) => (deg * Math.PI) / 180;
// 归一化到 [0, 2π)：西向 atan2 主值 -π/2 与规范值 3π/2 等价，方向断言统一走模 2π 比较
const normalizeHeading = (rad) => ((rad % TAU) + TAU) % TAU;
const COORD_TOLERANCE = 1e-9; // 度（约 0.1mm，容浮点取模/插值尾差）
const HEADING_TOLERANCE = 1e-9; // 弧度
const TIME_TOLERANCE = 1e-6; // 毫秒

const assertClose = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}（实际 ${String(actual)}，期望 ${String(expected)} ± ${String(tolerance)}）`,
  );

const assertLngLatClose = (actual, expected, message) => {
  assertClose(actual.lng, expected.lng, COORD_TOLERANCE, `${message}：lng`);
  assertClose(actual.lat, expected.lat, COORD_TOLERANCE, `${message}：lat`);
};

// 射线法 point-in-polygon（测试工具，独立于被测实现，不引入 ol）：
// ring 为 GeoJSON 线环 [[lng, lat], ...]（含闭合点）；恰在边界上的点不计入内部
const isPointInRing = (point, ring) => {
  const [x, y] = point;
  let inside = false;
  ring.forEach((vertex, index) => {
    const previousVertex = ring[(index + ring.length - 1) % ring.length];
    const crossesLatitude = vertex[1] > y !== previousVertex[1] > y;
    if (crossesLatitude) {
      const intersectX =
        ((previousVertex[0] - vertex[0]) * (y - vertex[1])) / (previousVertex[1] - vertex[1]) +
        vertex[0];
      if (x < intersectX) {
        inside = !inside;
      }
    }
  });
  return inside;
};

// 速度（km/h）→ SPEED_COLOR_STOPS 档位下标（升序阈值：∈ [t_k, t_{k+1}) 取 k，末档无上界）
const resolveSpeedBucket = (speedKmh) =>
  SPEED_COLOR_STOPS.reduce(
    (matchedBucket, stop, index) => (speedKmh >= stop.threshold ? index : matchedBucket),
    0,
  );

export const verify = (assert) => {
  // ================= TRACK_WINDOW：历史轨迹窗口 08:00–18:00 =================

  assert.equal(typeof TRACK_WINDOW.startMs, 'number', 'TRACK_WINDOW.startMs 应为数值');
  assert.equal(typeof TRACK_WINDOW.endMs, 'number', 'TRACK_WINDOW.endMs 应为数值');
  assert.ok(Number.isFinite(TRACK_WINDOW.startMs), 'TRACK_WINDOW.startMs 应为有限数');
  assert.ok(Number.isFinite(TRACK_WINDOW.endMs), 'TRACK_WINDOW.endMs 应为有限数');
  assert.equal(
    TRACK_WINDOW.endMs - TRACK_WINDOW.startMs,
    10 * 60 * 60 * 1000,
    '历史轨迹窗口跨度应为 10 小时（08:00–18:00；具体毫秒基准为模块内常量不锁值）',
  );

  // ================= VEHICLES_SEED 结构契约（计划 testPoint「VEHICLES_SEED 契约」）=================

  assert.ok(Array.isArray(VEHICLES_SEED), 'VEHICLES_SEED 应为数组');
  assert.equal(VEHICLES_SEED.length, 3, '车队应恰为 3 辆车');

  const vehicleIds = VEHICLES_SEED.map((vehicle) => vehicle.id);
  vehicleIds.forEach((vehicleId, index) => {
    assert.equal(typeof vehicleId, 'string', `第 ${index} 辆车 id 应为字符串`);
    assert.ok(vehicleId.trim().length > 0, `第 ${index} 辆车 id 不应为空白串`);
  });
  assert.equal(new Set(vehicleIds).size, 3, '3 辆车 id 应互不相同');

  VEHICLES_SEED.forEach((vehicle, index) => {
    assert.equal(typeof vehicle.name, 'string', `车辆「${vehicle.id}」name 应为字符串`);
    assert.ok(vehicle.name.trim().length > 0, `车辆「${vehicle.id}」name 不应为空白串`);
    assert.match(vehicle.color, /^#[0-9a-fA-F]{6}$/, `车辆「${vehicle.id}」color 应为 #RRGGBB`);
  });
  const vehicleColors = VEHICLES_SEED.map((vehicle) => vehicle.color.toUpperCase());
  assert.equal(new Set(vehicleColors).size, 3, '3 辆车 color 应互异（列表/地图/染色可区分）');

  // 路线：闭合环线 + 控制点合法性
  VEHICLES_SEED.forEach((vehicle) => {
    const { route } = vehicle;
    assert.ok(Array.isArray(route), `车辆「${vehicle.id}」route 应为数组`);
    assert.ok(route.length >= 4, `车辆「${vehicle.id}」路线应 ≥4 个控制点（首尾相同的闭合环线即 ≥3 个独立点）`);
    route.forEach((routePoint, pointIndex) => {
      assert.ok(Number.isFinite(routePoint.lng), `车辆「${vehicle.id}」第 ${pointIndex} 个控制点 lng 应为有限数`);
      assert.ok(Number.isFinite(routePoint.lat), `车辆「${vehicle.id}」第 ${pointIndex} 个控制点 lat 应为有限数`);
      assert.ok(routePoint.lng >= -180 && routePoint.lng <= 180, `车辆「${vehicle.id}」第 ${pointIndex} 个控制点 lng 越界`);
      assert.ok(routePoint.lat >= -90 && routePoint.lat <= 90, `车辆「${vehicle.id}」第 ${pointIndex} 个控制点 lat 越界`);
      assert.ok(
        Number.isFinite(routePoint.speedKmh) && routePoint.speedKmh > 0 && routePoint.speedKmh <= 200,
        `车辆「${vehicle.id}」第 ${pointIndex} 个控制点 speedKmh 应为 (0, 200] 内的有限数`,
      );
    });
    assertClose(
      route[route.length - 1].lng,
      route[0].lng,
      1e-12,
      `车辆「${vehicle.id}」环线应闭合：末控制点 lng = 首控制点 lng`,
    );
    assertClose(
      route[route.length - 1].lat,
      route[0].lat,
      1e-12,
      `车辆「${vehicle.id}」环线应闭合：末控制点 lat = 首控制点 lat`,
    );
  });

  // ================= haversine（计划 testPoint「haversine」）=================

  const samePoint = [121.4737, 31.2304];
  assert.ok(
    Math.abs(haversine(samePoint, samePoint)) <= 1e-6,
    'haversine 同点距离应为 0',
  );
  const pointA = [121.47, 31.23];
  const pointB = [121.475, 31.234];
  assert.ok(
    Math.abs(haversine(pointA, pointB) - haversine(pointB, pointA)) <= 1e-6,
    'haversine 应满足对称性：h(a,b) = h(b,a)',
  );
  // 实跑基准（计划 risks）：1° 经度差在 lat≈31.23 的球面距离 ≈95.2km（R=6371km 口径 95.08km、
  // R=6378.137km 口径 95.19km），容差 1% 同时覆盖两种地球半径取法
  const oneDegreeLngDistance = haversine([121.0, 31.23], [122.0, 31.23]);
  assert.ok(
    oneDegreeLngDistance >= 95200 * 0.99 && oneDegreeLngDistance <= 95200 * 1.01,
    `1° 经度差在 lat 31.23 的距离应 ≈95.2km ±1%（实际 ${String(oneDegreeLngDistance)}m）`,
  );

  // ================= buildRouteSchedule：腿长-累计时间表（逐车）=================

  const schedulesByVehicleId = new Map();
  const legSpeedsAll = [];
  VEHICLES_SEED.forEach((vehicle) => {
    const schedule = buildRouteSchedule(vehicle.route);
    schedulesByVehicleId.set(vehicle.id, schedule);
    assert.ok(Array.isArray(schedule.legs), `车辆「${vehicle.id}」schedule.legs 应为数组`);
    assert.equal(
      schedule.legs.length,
      vehicle.route.length - 1,
      `车辆「${vehicle.id}」腿数应 = 控制点数 - 1（闭合环线，末控制点回到起点）`,
    );
    let cumulativeMs = 0;
    schedule.legs.forEach((leg, legIndex) => {
      const fromPoint = vehicle.route[legIndex];
      const toPoint = vehicle.route[legIndex + 1];
      assert.ok(leg.lengthM > 0, `车辆「${vehicle.id}」第 ${legIndex} 腿长应为正（相邻控制点不重合）`);
      assert.ok(
        Math.abs(leg.lengthM - haversine([fromPoint.lng, fromPoint.lat], [toPoint.lng, toPoint.lat])) <= 1e-3,
        `车辆「${vehicle.id}」第 ${legIndex} 腿长应 = haversine(腿两端控制点)`,
      );
      assert.equal(leg.speedKmh, fromPoint.speedKmh, `车辆「${vehicle.id}」第 ${legIndex} 腿速度应取出发控制点配置速度`);
      const expectedDurationMs = (leg.lengthM / (leg.speedKmh / 3.6)) * 1000;
      assertClose(
        leg.durationMs,
        expectedDurationMs,
        Math.max(1e-3, expectedDurationMs * 1e-9),
        `车辆「${vehicle.id}」第 ${legIndex} 腿时长应 = 腿长 / 速度`,
      );
      assertClose(leg.startMs, cumulativeMs, 1e-3, `车辆「${vehicle.id}」第 ${legIndex} 腿 startMs 应为前序腿时长累计`);
      cumulativeMs += leg.durationMs;
      legSpeedsAll.push(leg.speedKmh);
    });
    assertClose(schedule.totalMs, cumulativeMs, 1e-3, `车辆「${vehicle.id}」环线一圈时长应 = Σ 腿时长`);
    const lastLeg = schedule.legs[schedule.legs.length - 1];
    assertClose(
      schedule.totalMs,
      lastLeg.startMs + lastLeg.durationMs,
      1e-3,
      `车辆「${vehicle.id}」totalMs 应 = 末腿 startMs + 末腿 durationMs`,
    );
    const perimeterM = schedule.legs.reduce((total, leg) => total + leg.lengthM, 0);
    assert.ok(
      perimeterM >= 1500 && perimeterM <= 4000,
      `车辆「${vehicle.id}」环线周长应在 1.5–4km（实际 ${String(perimeterM)}m，巡逻环线语义）`,
    );
  });

  // 腿级四档覆盖：三车全部腿速按 SPEED_COLOR_STOPS 分桶，四档各至少 1 腿（速度曲线设计的因）
  SPEED_COLOR_STOPS.forEach((stop, bucketIndex) => {
    const legCountInBucket = legSpeedsAll.filter(
      (speedKmh) => resolveSpeedBucket(speedKmh) === bucketIndex,
    ).length;
    assert.ok(
      legCountInBucket >= 1,
      `腿速应覆盖 SPEED_COLOR_STOPS 第 ${bucketIndex} 档（阈值 ${String(stop.threshold)} km/h）：该档腿数为 0`,
    );
  });

  const fleetMinSpeedMs = Math.min(...legSpeedsAll) / 3.6; // 全车队最低腿速（米/秒）
  const fleetMaxSpeedMs = Math.max(...legSpeedsAll) / 3.6; // 全车队最高腿速（米/秒）

  // ================= resolveRoutePositionAt：环线循环契约（计划 testPoint「环线循环契约」）=================

  VEHICLES_SEED.forEach((vehicle) => {
    const { route } = vehicle;
    const schedule = schedulesByVehicleId.get(vehicle.id);

    // 腿中点时刻 ≈ 腿中点坐标（线性插值复算）+ 所在腿/速度
    schedule.legs.forEach((leg, legIndex) => {
      const midTimeMs = leg.startMs + leg.durationMs / 2;
      const position = resolveRoutePositionAt(route, midTimeMs);
      const fromPoint = route[legIndex];
      const toPoint = route[legIndex + 1];
      assertLngLatClose(
        position,
        { lng: (fromPoint.lng + toPoint.lng) / 2, lat: (fromPoint.lat + toPoint.lat) / 2 },
        `车辆「${vehicle.id}」第 ${legIndex} 腿中点时刻的位置应在控制点连线中点（线性插值）`,
      );
      assert.equal(position.legIndex, legIndex, `车辆「${vehicle.id}」第 ${legIndex} 腿中点时刻应仍位于该腿`);
      assert.equal(position.speedKmh, fromPoint.speedKmh, `车辆「${vehicle.id}」腿内任一时刻速度应恒等于所在腿配置速度`);
    });

    // 周期取模：t 与 t + 3×周期 同位置同腿（3 圈后回同一处）
    schedule.legs.forEach((leg, legIndex) => {
      const midTimeMs = leg.startMs + leg.durationMs / 2;
      const directPosition = resolveRoutePositionAt(route, midTimeMs);
      const wrappedPosition = resolveRoutePositionAt(route, midTimeMs + schedule.totalMs * 3);
      assertLngLatClose(
        wrappedPosition,
        directPosition,
        `车辆「${vehicle.id}」resolveRoutePositionAt(t) 与 (t + 3×环线周期) 应同位置（周期取模）`,
      );
      assert.equal(wrappedPosition.legIndex, legIndex, `车辆「${vehicle.id}」(t + 3×环线周期) 应回到同一腿`);
      assert.equal(wrappedPosition.speedKmh, directPosition.speedKmh, `车辆「${vehicle.id}」周期回绕后速度应不变`);
    });

    // 负时刻取模：resolveRoutePositionAt(-1000) 与 (周期 - 1000) 同位置
    const beforeLapPosition = resolveRoutePositionAt(route, schedule.totalMs - 1000);
    const negativeTimePosition = resolveRoutePositionAt(route, -1000);
    assertLngLatClose(
      negativeTimePosition,
      beforeLapPosition,
      `车辆「${vehicle.id}」负时刻应按周期取模（-1000 ≡ 周期 - 1000）`,
    );

    // t = 恰一圈：回到起点（腿边界归属不锁，只锁位置）
    const lapEndPosition = resolveRoutePositionAt(route, schedule.totalMs);
    assertLngLatClose(
      lapEndPosition,
      { lng: route[0].lng, lat: route[0].lat },
      `车辆「${vehicle.id}」t = 环线周期时应回到起点位置`,
    );

    // t 单调推进时沿腿前进：第 0 腿上 6 个等分时刻，位置 = 线性插值、相邻推进在动且不越腿瞬移
    const firstLeg = schedule.legs[0];
    let previousAdvancePosition = null;
    Array.from({ length: 6 }, (unused, stepIndex) => stepIndex / 5).forEach((ratio) => {
      const timeMs = firstLeg.startMs + firstLeg.durationMs * ratio;
      const position = resolveRoutePositionAt(route, timeMs);
      const fromPoint = route[0];
      const toPoint = route[1];
      assertLngLatClose(
        position,
        {
          lng: fromPoint.lng + (toPoint.lng - fromPoint.lng) * ratio,
          lat: fromPoint.lat + (toPoint.lat - fromPoint.lat) * ratio,
        },
        `车辆「${vehicle.id}」第 0 腿上比例 ${String(ratio)} 时刻应线性插值于两端控制点`,
      );
      if (previousAdvancePosition !== null) {
        const stepDistance = haversine(
          [previousAdvancePosition.lng, previousAdvancePosition.lat],
          [position.lng, position.lat],
        );
        assert.ok(stepDistance > 0.01, `车辆「${vehicle.id}」t 单调推进时位置应沿腿前进（步距 ${String(stepDistance)}m > 0）`);
        assert.ok(
          stepDistance <= firstLeg.lengthM + 1e-6,
          `车辆「${vehicle.id}」腿内单步推进距离不应超过腿长（无瞬移）`,
        );
      }
      previousAdvancePosition = position;
    });

    // 输出字段恒为有限数（腿中点抽查）
    const sampledPosition = resolveRoutePositionAt(route, schedule.legs[0].durationMs / 2);
    ['lng', 'lat', 'speedKmh', 'legIndex'].forEach((fieldName) => {
      assert.ok(
        Number.isFinite(sampledPosition[fieldName]),
        `车辆「${vehicle.id}」resolveRoutePositionAt 输出字段 ${fieldName} 不应产出 NaN/Infinity`,
      );
    });
  });

  // ================= resolveCorrectedHeading（计划 testPoint【评审2】方向性与 cos 修正）=================

  const headingOrigin = [121.47, 31.23];
  // 北/东/南/西四组构造 → 0 / π/2 / π / 3π/2（自北顺时针；西向允许 atan2 主值 -π/2，按模 2π 比较）
  assertClose(
    normalizeHeading(resolveCorrectedHeading(headingOrigin, [121.47, 31.231])),
    0,
    HEADING_TOLERANCE,
    '向北行进 heading 应为 0',
  );
  assertClose(
    normalizeHeading(resolveCorrectedHeading(headingOrigin, [121.471, 31.23])),
    Math.PI / 2,
    HEADING_TOLERANCE,
    '向东行进 heading 应为 π/2（90°）',
  );
  assertClose(
    normalizeHeading(resolveCorrectedHeading(headingOrigin, [121.47, 31.229])),
    Math.PI,
    HEADING_TOLERANCE,
    '向南行进 heading 应为 π（180°）',
  );
  assertClose(
    normalizeHeading(resolveCorrectedHeading(headingOrigin, [121.469, 31.23])),
    (3 * Math.PI) / 2,
    HEADING_TOLERANCE,
    '向西行进 heading 应 ≡ 3π/2（270°；atan2 主值 -π/2 亦可）',
  );

  // 45° 真方位构造（关于 latMid 对称：dLat = k·cos(latMid)、dLng = k）→ 修正公式恰返回 π/4，
  // 而朴素 atan2(dLng, dLat) 对同输入得 ≈49.47°——断言两者差 ≈4.4–4.7°，锁 cos 修正不可回退
  // （实跑基准：latMid=31.23 时朴素 49.466°、修正 45.000°）
  const latMid = 31.23;
  const cosLatMid = Math.cos(toRad(latMid));
  const headingDeltaLng = 0.002;
  const halfHeadingDeltaLat = (headingDeltaLng * cosLatMid) / 2;
  const from45 = [121.47, latMid - halfHeadingDeltaLat];
  const to45 = [121.47 + headingDeltaLng, latMid + halfHeadingDeltaLat];
  const corrected45 = resolveCorrectedHeading(from45, to45);
  const naive45 = Math.atan2(to45[0] - from45[0], to45[1] - from45[1]);
  assertClose(corrected45, Math.PI / 4, HEADING_TOLERANCE, '45° 真方位构造：修正公式应恰返回 π/4');
  // 参考值由构造式第一性推导（dLat = dLng·cos(latMid) ⇒ 朴素方位 = atan(1/cos(latMid))，
  // = 49.46648°）——头注基准 49.466° 为三位小数舍入值，与 1e-9 容差不兼容（测试自身笔误修正，
  // 断言语义不变：锁定朴素公式显著偏离 π/4）
  assertClose(naive45, Math.atan(1 / cosLatMid), HEADING_TOLERANCE, '前置复算：朴素 atan2(dLng, dLat) 对同输入应得 ≈49.466°');
  assert.ok(
    Math.abs(naive45 - corrected45) >= toRad(4.2) && Math.abs(naive45 - corrected45) <= toRad(4.7),
    `修正与朴素公式的方位差应 ≈4.4–4.7°（实际 ${String(((naive45 - corrected45) * 180) / Math.PI)}°，锁 cos(lat) 修正不可回退）`,
  );

  // 等度数差线段（dLat = dLng）：朴素 45.00°、修正 ≈40.53°（真实地图方位；实跑基准）
  const correctedEqualDeg = resolveCorrectedHeading([121.47, 31.23], [121.471, 31.231]);
  assertClose(
    Math.atan2(0.001, 0.001),
    Math.PI / 4,
    1e-12,
    '前置复算：等度数差线段的朴素方位应恰为 45.00°',
  );
  assertClose(
    correctedEqualDeg,
    toRad(40.53),
    toRad(0.02),
    '等度数差线段的修正方位应 ≈40.53°（cos 修正后偏小，= 真实地图方位）',
  );
  assert.ok(
    correctedEqualDeg < Math.PI / 4 - toRad(4),
    '等度数差线段上修正方位应显著小于朴素 45°（东向分量被 cos(lat) 缩小）',
  );

  // 零向量守护：同点不抛错、归一化后为 0
  assert.doesNotThrow(
    () => {
      resolveCorrectedHeading(headingOrigin, headingOrigin);
    },
    '零位移输入不应抛错',
  );
  assertClose(
    normalizeHeading(resolveCorrectedHeading(headingOrigin, headingOrigin)),
    0,
    HEADING_TOLERANCE,
    '零位移 heading 归一化后应为 0',
  );

  // ================= generateTrack（计划 testPoint「generateTrack 确定性」）=================

  const tracksByVehicleId = new Map();
  VEHICLES_SEED.forEach((vehicle) => {
    const trackFirst = generateTrack(vehicle);
    const trackSecond = generateTrack(vehicle);
    tracksByVehicleId.set(vehicle.id, trackFirst);

    assert.ok(Array.isArray(trackFirst), `车辆「${vehicle.id}」generateTrack 应返回数组`);
    assert.ok(trackFirst.length > 0, `车辆「${vehicle.id}」轨迹不应为空`);
    assert.deepEqual(
      trackSecond,
      trackFirst,
      `车辆「${vehicle.id}」generateTrack 应为纯函数：同输入两次调用逐字段一致（无随机源）`,
    );

    // 首点 = 窗口起点；时间严格递增；相邻间隔 = TRACK_SAMPLE_INTERVAL_MS；末点覆盖窗口尾部
    assert.equal(
      trackFirst[0].time,
      TRACK_WINDOW.startMs,
      `车辆「${vehicle.id}」轨迹首点时间应 = 窗口起点（TRACK_WINDOW.startMs）`,
    );
    trackFirst.forEach((trackPoint, pointIndex) => {
      ['lng', 'lat', 'time', 'speedKmh'].forEach((fieldName) => {
        assert.ok(
          Number.isFinite(trackPoint[fieldName]),
          `车辆「${vehicle.id}」第 ${pointIndex} 个轨迹点字段 ${fieldName} 不应产出 NaN/Infinity`,
        );
      });
      if (pointIndex > 0) {
        const previousPoint = trackFirst[pointIndex - 1];
        assert.ok(
          trackPoint.time > previousPoint.time,
          `车辆「${vehicle.id}」轨迹时间戳应严格递增（第 ${String(pointIndex)} 点）`,
        );
        assertClose(
          trackPoint.time - previousPoint.time,
          TRACK_SAMPLE_INTERVAL_MS,
          TIME_TOLERANCE,
          `车辆「${vehicle.id}」相邻轨迹点间隔应 = TRACK_SAMPLE_INTERVAL_MS`,
        );
        // 无跨图传送段：相邻采样距离在 [最低腿速, 最高腿速] × 间隔(秒) 的预算内
        // （计划 scale=1 位移预算的采样版；间隔换算成秒——m/s × s = m，单位一致性修正，
        //   与计划原文算例「20-70km/h×2s=11-39m」对齐）
        const stepDistance = haversine(
          [previousPoint.lng, previousPoint.lat],
          [trackPoint.lng, trackPoint.lat],
        );
        assert.ok(
          stepDistance >= fleetMinSpeedMs * (TRACK_SAMPLE_INTERVAL_MS / 1000) * 0.9 - 1e-6,
          `车辆「${vehicle.id}」第 ${String(pointIndex)} 步距 ${String(stepDistance)}m 不应低于最低腿速×间隔×0.9（车辆在持续行进）`,
        );
        assert.ok(
          stepDistance <= fleetMaxSpeedMs * (TRACK_SAMPLE_INTERVAL_MS / 1000) * 1.1 + 1e-6,
          `车辆「${vehicle.id}」第 ${String(pointIndex)} 步距 ${String(stepDistance)}m 不应超过最高腿速×间隔×1.1（环线循环下无跨圈传送段）`,
        );
      }
    });
    const lastTrackPoint = trackFirst[trackFirst.length - 1];
    assert.ok(
      lastTrackPoint.time >= TRACK_WINDOW.endMs - TRACK_SAMPLE_INTERVAL_MS,
      `车辆「${vehicle.id}」轨迹末点应覆盖到窗口尾部（末点时间 ≥ endMs - 一个采样间隔）`,
    );
    assert.ok(
      lastTrackPoint.time <= TRACK_WINDOW.endMs + TIME_TOLERANCE,
      `车辆「${vehicle.id}」轨迹末点时间不应越过窗口终点`,
    );
    assert.ok(
      trackFirst.length >= (TRACK_WINDOW.endMs - TRACK_WINDOW.startMs) / TRACK_SAMPLE_INTERVAL_MS,
      `车辆「${vehicle.id}」10 小时窗口 / 10s 采样应至少产出 3600 个轨迹点`,
    );

    // 每个采样点 = resolveRoutePositionAt(route, time) 的确定性快照（生成器与插值核同源）
    trackFirst.forEach((trackPoint, pointIndex) => {
      const replayPosition = resolveRoutePositionAt(vehicle.route, trackPoint.time);
      assertLngLatClose(
        { lng: trackPoint.lng, lat: trackPoint.lat },
        replayPosition,
        `车辆「${vehicle.id}」第 ${String(pointIndex)} 个轨迹点坐标应与 resolveRoutePositionAt(route, time) 一致`,
      );
      assertClose(
        trackPoint.speedKmh,
        replayPosition.speedKmh,
        1e-9,
        `车辆「${vehicle.id}」第 ${String(pointIndex)} 个轨迹点速度应 = 所在腿配置速度`,
      );
    });
  });

  // ================= 全车队速度染色可演示（计划 testPoint 4，点级是果、腿级是因）=================

  const allTrackPoints = [...tracksByVehicleId.values()].flat();
  SPEED_COLOR_STOPS.forEach((stop, bucketIndex) => {
    const pointCountInBucket = allTrackPoints.filter(
      (trackPoint) => resolveSpeedBucket(trackPoint.speedKmh) === bucketIndex,
    ).length;
    assert.ok(
      pointCountInBucket >= 1,
      `三车轨迹点速度合并后应覆盖 SPEED_COLOR_STOPS 第 ${bucketIndex} 档（阈值 ${String(stop.threshold)} km/h）：该档轨迹点数为 0`,
    );
  });

  // ================= 危险品区穿越（射线法，仅对种子多边形成立）=================

  const dangerFeature = ZONES_SEED_GEOJSON.features.find(
    (feature) => feature.properties?.type === 'danger',
  );
  assert.ok(dangerFeature, 'ZONES_SEED_GEOJSON 应含 type=danger 的危险品区（mock/zones.js 契约）');
  const dangerRing = dangerFeature.geometry.coordinates[0];

  const insideCounts = VEHICLES_SEED.map((vehicle) => {
    const track = tracksByVehicleId.get(vehicle.id);
    return track.filter((trackPoint) => isPointInRing([trackPoint.lng, trackPoint.lat], dangerRing))
      .length;
  });
  assert.ok(
    Math.max(...insideCounts) >= 20,
    `应至少有 1 辆车的路线穿越危险品区种子多边形（内部轨迹点 ≥20 以锁多圈穿越；实际各车 [${insideCounts.join(', ')}]；采样粒度下「每圈必经」以累计下限锁代）`,
  );
};
