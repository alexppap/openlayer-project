// src/mock/vehicles.js — 车辆种子 + 环线调度/朝向/轨迹生成纯函数（设计 §4.3 L112-118）。
//
// ⚠ 纯数据/纯函数模块：零 ol/vue import（mock/vehicles.verify.js 在纯 node 下断言）。
//   测距用模块内 haversine；朝向的 cos(lat) 修正公式在 Mercator 正形投影下代数上
//   恒等于 3857 侧的 atan2(dx, dy)（渲染层 resolveSegmentHeading 头注互指），
//   因此本模块不需要 ol——坐标转换红线（map/utils.js 是全站唯一口）不被绕过。
// 坐标约定：业务坐标一律 EPSG:4326 [lng, lat]（设计 §2 L27），渲染前经 map/utils.js 转 3857。
//
// 路线布设（围绕 mock/zones.js 四类区域的间隙道路，全部为闭合环线、周长 1.5-4km）：
//   - 道路网格：西线 lng≈121.4690-121.4706（生产区以西及其北向延伸）/ 中线 lng≈121.4737
//     （危险品区正中穿越）/ 东线 lng≈121.4784（仓储区以东），南环 lat≈31.2255（危险品区以南）/
//     中横 lat≈31.2278（危险品区北缘与生产/仓储区南缘之间）/ 北横 lat≈31.2320（生产/仓储区
//     北缘与办公区南缘之间）/ 顶横 lat≈31.2348（办公区以北）。
//   - 危化品转运车沿中线穿越危险品区种子多边形正中（lng 121.4737 = 区内 [121.4729,121.4745]
//     中点），且穿越段限速 12km/h——供下个任务 useGeofence 围栏演示（本任务不做围栏判断）。
//   - 三条环线均为不自交的简单回路（无 180° 折返/重叠段，消除任意小步距弦）；
//     腿速覆盖 SPEED_COLOR_STOPS 全部四档（12/25/45/70 km/h），其中 12km/h 慢腿的相邻腿
//     均为 45/70km/h：10s 采样步距下限 = 最低腿速×10s×0.9 = 30.0m，慢-快直角弯的
//     最短弦长 32.2m，保证任意采样相位都不会出现低于预算的步距。

import { TRACK_SAMPLE_INTERVAL_MS } from '../constants.js';

// 地球半径（米，haversine 口径）
const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;

// 历史轨迹窗口 08:00–18:00（固定毫秒基准：2026-09-18T00:00Z = 北京时间 08:00，
// 仿 mock/alarms.js SEED_TIME_BASE 先例——数据专项常量，不入 constants.js）
export const TRACK_WINDOW = {
  startMs: 1789689600000,
  endMs: 1789689600000 + 10 * 60 * 60 * 1000,
};

// ---- 车队种子（id/name/color 互异；路线首尾控制点相同 = 闭合巡逻环线）----
// RoutePoint.speedKmh 语义 = 离开该控制点沿当前腿行进的配置速度（与所在腿速度口径一致）。
export const VEHICLES_SEED = [
  {
    id: 'vehicle-hazmat-01',
    name: '危化品转运车',
    color: '#722ed1',
    route: [
      { lng: 121.4737, lat: 31.232, speedKmh: 70 }, // 中线×北横，向南直冲
      { lng: 121.4737, lat: 31.2278, speedKmh: 12 }, // 减速进入危险品区
      { lng: 121.4737, lat: 31.2267, speedKmh: 12 }, // 危险品区正中（区内限速通过）
      { lng: 121.4737, lat: 31.2255, speedKmh: 45 }, // 驶离危险品区，加速
      { lng: 121.469, lat: 31.2255, speedKmh: 45 }, // 南环西行（生产区以西）
      { lng: 121.469, lat: 31.232, speedKmh: 45 }, // 西线北行（生产区以西）
      { lng: 121.4737, lat: 31.232, speedKmh: 45 }, // 北环东行回到起点（闭合）
    ],
  },
  {
    id: 'vehicle-patrol-01',
    name: '厂区巡逻车',
    color: '#13c2c2',
    route: [
      { lng: 121.4737, lat: 31.232, speedKmh: 25 }, // 中线×北横，东行
      { lng: 121.4784, lat: 31.232, speedKmh: 45 }, // 东线南行（仓储区以东）
      { lng: 121.4784, lat: 31.2278, speedKmh: 45 }, // 中横西行
      { lng: 121.4737, lat: 31.2278, speedKmh: 70 }, // 中线北行（危险品区北缘外）
      { lng: 121.4737, lat: 31.232, speedKmh: 25 }, // 回到起点（闭合）
    ],
  },
  {
    id: 'vehicle-logistics-01',
    name: '物流配送车',
    color: '#fa541c',
    route: [
      { lng: 121.4706, lat: 31.232, speedKmh: 12 }, // 西北角，北行进入装卸慢速段
      { lng: 121.4706, lat: 31.2348, speedKmh: 45 }, // 顶环东行（办公区以北）
      { lng: 121.4784, lat: 31.2348, speedKmh: 45 }, // 东线南行
      { lng: 121.4784, lat: 31.232, speedKmh: 45 }, // 北环西行
      { lng: 121.4706, lat: 31.232, speedKmh: 12 }, // 回到起点（闭合，速度同首点）
    ],
  },
];

// ---- haversine 大圆距离（米）----
export const haversine = (fromLngLat, toLngLat) => {
  const [fromLng, fromLat] = fromLngLat;
  const [toLng, toLat] = toLngLat;
  const deltaLatRad = toRad(toLat - fromLat);
  const deltaLngRad = toRad(toLng - fromLng);
  const sinHalfLat = Math.sin(deltaLatRad / 2);
  const sinHalfLng = Math.sin(deltaLngRad / 2);
  const haversineRatio =
    sinHalfLat * sinHalfLat +
    Math.cos(toRad(fromLat)) * Math.cos(toRad(toLat)) * sinHalfLng * sinHalfLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(haversineRatio)));
};

// ---- 环线腿长-累计时间表：腿 i = route[i] → route[i+1] ----
// startMs 为相对环线起点的出发时刻；totalMs = 一圈时长 = Σ durationMs。
export const buildRouteSchedule = (route) => {
  let cumulativeMs = 0;
  const legs = route.slice(0, -1).map((fromPoint, legIndex) => {
    const toPoint = route[legIndex + 1];
    const lengthM = haversine([fromPoint.lng, fromPoint.lat], [toPoint.lng, toPoint.lat]);
    const durationMs = (lengthM / (fromPoint.speedKmh / 3.6)) * 1000;
    const leg = { lengthM, speedKmh: fromPoint.speedKmh, durationMs, startMs: cumulativeMs };
    cumulativeMs += durationMs;
    return leg;
  });
  return { legs, totalMs: cumulativeMs };
};

// ---- 任意时刻的环线位置：按 totalMs 取模后在所在腿上线性插值 ----
// 输出 { lng, lat, speedKmh, legIndex }；speedKmh = 所在腿配置速度（route[legIndex].speedKmh）。
// 负值/超周期时刻均安全回绕（((t % T) + T) % T → [0, T)），环线闭合无跨图传送段。
export const resolveRoutePositionAt = (route, timeMs) => {
  const { legs, totalMs } = buildRouteSchedule(route);
  const loopTimeMs = ((timeMs % totalMs) + totalMs) % totalMs;
  const legIndex = Math.max(
    0,
    legs.findIndex((leg) => loopTimeMs < leg.startMs + leg.durationMs),
  );
  const leg = legs[legIndex];
  const fraction = Math.min(1, Math.max(0, (loopTimeMs - leg.startMs) / leg.durationMs));
  const fromPoint = route[legIndex];
  const toPoint = route[legIndex + 1];
  return {
    lng: fromPoint.lng + (toPoint.lng - fromPoint.lng) * fraction,
    lat: fromPoint.lat + (toPoint.lat - fromPoint.lat) * fraction,
    speedKmh: leg.speedKmh,
    legIndex,
  };
};

// ---- 朝向（弧度，自北顺时针，atan2 主值 (-π, π]）：实时推送的唯一来源 ----
// atan2(dLng·cos(latMid), dLat)：把经度差按中点纬度折算成东西向真实距离比例，
// 等度数差线段不再被抬高成 45°（lat≈31.23 时朴素公式报 49.5°、真实地图方位 40.5°）。
// Mercator 正形投影下与 3857 平面口径 atan2(dx, dy) 代数等价（dy ∝ dLat/cos(lat)）。
// 零位移输入返回 0 不抛错（atan2(0, 0) = 0）。
export const resolveCorrectedHeading = (fromLngLat, toLngLat) => {
  const [fromLng, fromLat] = fromLngLat;
  const [toLng, toLat] = toLngLat;
  const deltaLng = toLng - fromLng;
  const deltaLat = toLat - fromLat;
  const latMidRad = toRad((fromLat + toLat) / 2);
  return Math.atan2(deltaLng * Math.cos(latMidRad), deltaLat);
};

// ---- 历史轨迹生成器（纯函数，无随机源）：按 TRACK_SAMPLE_INTERVAL_MS 等间隔采样 ----
// 从 TRACK_WINDOW.startMs 采样到恰好覆盖 endMs（10h / 10s = 3601 点），
// 每点 = resolveRoutePositionAt(route, point.time) 的确定性快照（生成器与插值核同源）。
export const generateTrack = (vehicle) => {
  const sampleCount = Math.floor((TRACK_WINDOW.endMs - TRACK_WINDOW.startMs) / TRACK_SAMPLE_INTERVAL_MS);
  return Array.from({ length: sampleCount + 1 }, (unused, sampleIndex) => {
    const time = TRACK_WINDOW.startMs + sampleIndex * TRACK_SAMPLE_INTERVAL_MS;
    const position = resolveRoutePositionAt(vehicle.route, time);
    return { lng: position.lng, lat: position.lat, time, speedKmh: position.speedKmh };
  });
};
