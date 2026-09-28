// src/api/vehiclesApi.js — 车辆数据 mock API（设计 §4.3 L112-118、§5 L143）。
//
// 契约（api/vehiclesApi.verify.js 断言）：
//   getVehicles()：resolve VEHICLES_SEED 的深拷贝；每次调用各自独立副本——
//     污染上一次返回值不影响下一次（防状态污染，对齐 getAlarms 先例）。
//   getTrack(vehicleId, range?)：resolve { ok: true, points } 或 { ok: false, error }，
//     任何分支均 resolve、永不 reject（§5 L143）——已知 id 无 range → 全窗轨迹
//     （逐字段 = mock 端 generateTrack(vehicle)；模块内缓存生成结果，命中返回深拷贝）；
//     range = { startMs, endMs } → 全窗轨迹在闭区间 [startMs, endMs] 内的时间子序列
//     （端点采样点保留；边界不对齐采样网格时取区间内首个/末个采样点）；
//     未知 id → { ok: false, error }。
//   subscribePositions(listener, { intervalMs } = POSITION_PUSH_INTERVAL_MS)：返回取消函数；
//     共享 setInterval → 每 tick 逐车广播一条位置记录；非最后订阅者取消不清除 interval；
//     最后一个取消时 clearInterval；再次订阅可重建定时器（首订阅重新锚定路线时间）。
//     推送记录形状（★锁定）：{ vehicleId, lng, lat, heading, time, speedKmh }——
//     time 为路线虚拟毫秒：首订阅锚定 routeMs = TRACK_WINDOW.startMs，此后每 tick 按
//     routeMs = startMs + (now - anchor) × POSITION_ROUTE_TIME_SCALE 推进（scale=1）；
//     heading 为该时刻所在腿（腿两端控制点）的 resolveCorrectedHeading 值
//     （弧度，cos 修正、自北顺时针——实时推送朝向唯一来源，mock/vehicles.js 头注）。
//
// ⚠ node 兼容（risks 红线，先例 alarmsApi.js:16-17）：模块导入时不启动任何定时器
//   （首订阅才启动），否则 vehiclesApi.verify.js 的静态 import 阶段就会挂起 node 进程。
import { POSITION_PUSH_INTERVAL_MS, POSITION_ROUTE_TIME_SCALE } from '../constants.js';
import {
  TRACK_WINDOW,
  VEHICLES_SEED,
  generateTrack,
  resolveCorrectedHeading,
  resolveRoutePositionAt,
} from '../mock/vehicles.js';

// 全窗轨迹缓存（vehicleId → generateTrack 结果；mock 数据确定，缓存不失效）
const trackCache = new Map();

// 订阅者集合 + 共享推送定时器（首订阅启动并锚定路线时间，最后一个取消时清除）
const positionListeners = new Set();
let pushIntervalId = null;
let routeAnchorWallMs = null;
let routeAnchorRouteMs = null;

const resolveVehicleById = (vehicleId) =>
  VEHICLES_SEED.find((vehicle) => vehicle.id === vehicleId);

// 取车队清单（种子的深拷贝，绝不让调用方污染种子常量）
export const getVehicles = async () => structuredClone(VEHICLES_SEED);

// 取历史轨迹（缓存生成 + 闭区间切片，深拷贝返回）；未知 id / 异常均结构化失败不 reject
export const getTrack = async (vehicleId, range) => {
  try {
    const vehicle = resolveVehicleById(vehicleId);
    if (!vehicle) {
      return { ok: false, error: new Error(`车辆「${String(vehicleId)}」不存在`) };
    }
    if (!trackCache.has(vehicleId)) {
      trackCache.set(vehicleId, generateTrack(vehicle));
    }
    const fullTrack = trackCache.get(vehicleId);
    const points =
      range && Number.isFinite(range.startMs) && Number.isFinite(range.endMs)
        ? fullTrack.filter(
            (trackPoint) => trackPoint.time >= range.startMs && trackPoint.time <= range.endMs,
          )
        : fullTrack;
    return { ok: true, points: structuredClone(points) };
  } catch (error) {
    console.error('[vehiclesApi] getTrack 异常：', error);
    return { ok: false, error };
  }
};

// 推送 tick：按墙钟推进路线虚拟时间，逐车广播 resolveRoutePositionAt + 朝向快照。
// heading 取所在腿两端控制点的 resolveCorrectedHeading（与腿恒定朝向一致——
// 腿是直线段，任意时刻的真实行进方向 = 腿方向）。
const pushPositions = () => {
  const routeMs =
    routeAnchorRouteMs + (Date.now() - routeAnchorWallMs) * POSITION_ROUTE_TIME_SCALE;
  VEHICLES_SEED.forEach((vehicle) => {
    const position = resolveRoutePositionAt(vehicle.route, routeMs);
    const legFrom = vehicle.route[position.legIndex];
    const legTo = vehicle.route[position.legIndex + 1];
    const positionRecord = {
      vehicleId: vehicle.id,
      lng: position.lng,
      lat: position.lat,
      heading: resolveCorrectedHeading([legFrom.lng, legFrom.lat], [legTo.lng, legTo.lat]),
      time: routeMs,
      speedKmh: position.speedKmh,
    };
    positionListeners.forEach((listener) => {
      listener(structuredClone(positionRecord));
    });
  });
};

// 订阅实时位置推送：返回取消函数。intervalMs 可注入（node 自测把间隔压到亚秒级）；
// 将来换 WebSocket 时本函数形态不变（subscribe 返回取消函数——设计 §3.3 L88）。
export const subscribePositions = (listener, options = {}) => {
  const intervalMs = options?.intervalMs ?? POSITION_PUSH_INTERVAL_MS;
  positionListeners.add(listener);
  if (pushIntervalId === null) {
    routeAnchorWallMs = Date.now();
    routeAnchorRouteMs = TRACK_WINDOW.startMs;
    pushIntervalId = setInterval(pushPositions, intervalMs);
  }
  return () => {
    positionListeners.delete(listener);
    if (positionListeners.size === 0 && pushIntervalId !== null) {
      clearInterval(pushIntervalId);
      pushIntervalId = null;
      routeAnchorWallMs = null;
      routeAnchorRouteMs = null;
    }
  };
};
