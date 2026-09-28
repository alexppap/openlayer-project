// src/api/vehiclesApi.verify.js — 车辆 mock API 契约自测（pnpm verify 自动发现挂载）
//
// ⚠ 测试先行：本文件先于 src/api/vehiclesApi.js 与 api/index.js 车辆出口落地（实施计划步骤 3/4），
//   在被测模块实现前 pnpm verify 对本挂载点报「找不到模块/导出不存在」属预期红灯
//   （先例：api/alarmsApi.verify.js 头注）。
//
// ⚠ 运行环境约束：本文件在纯 node 下执行。subscribePositions 以真实 setInterval 模拟推送，
//   本文件用 intervalMs:10 注入把等待压到亚秒级；★全部订阅必须在收尾取消——
//   残留 interval 会让 node 进程挂起（scripts/verify.js 等事件循环清空才退出），
//   故用 activeUnsubscribers 集合追踪、finally 兜底全取消（先例 alarmsApi.verify.js:7-9）。
//   「模块导入阶段不启动定时器」由本文件顶部静态 import 本身证明：若导入即挂定时器，
//   node 进程在进入 verify 前就挂起（先例 alarmsApi.verify.js:29-30 同口径，无法另写显式断言）。
//
// 被测契约（实施计划 testPoint「getVehicles/getTrack/subscribePositions」+ 步骤 3/4；
//   设计 §3.3 L86-88 subscribe 返回取消函数、§5 L143 mock 永不 reject、§4.3 L118 实时推送）：
//
// ★ 本文件断言即契约（形状由本文件定义，实现须对齐——手法先例：alarmsApi.verify.js）：
//   getVehicles()：resolve VEHICLES_SEED 的深拷贝（每次调用各自独立副本——
//     污染上一次返回值不影响下一次，防状态污染，对齐 getAlarms 先例）。
//   getTrack(vehicleId, range?)：resolve { ok: true, points } 或 { ok: false, error }，永不 reject——
//     已知 id 无 range → 全窗轨迹（逐字段 = mock 端 generateTrack(vehicle)）；
//     range = { startMs, endMs } → 全窗轨迹在闭区间 [startMs, endMs] 内的时间子序列
//     （端点采样点保留；range 边界不对齐采样网格时取区间内首个/末个采样点）；
//     未知 id → { ok: false, error }。points 同样为独立深拷贝。
//   subscribePositions(listener, { intervalMs } = POSITION_PUSH_INTERVAL_MS)：返回取消函数；
//     共享 setInterval → 每 tick 逐车广播一条位置记录；非最后订阅者取消不清除 interval；
//     最后一个取消时 clearInterval；再次订阅可重建定时器。推送记录（★形状锁定）：
//       { vehicleId, lng, lat, heading, time, speedKmh }
//       vehicleId ∈ VEHICLES_SEED；time 为路线虚拟毫秒——首订阅锚定 routeMs = TRACK_WINDOW.startMs
//       （计划步骤 4 原文的 TRACK_START 即窗口起点），此后每 tick 按
//       routeMs = startMs + (now - anchor) × POSITION_ROUTE_TIME_SCALE 推进；
//       heading 为该时刻所在腿（腿两端控制点）的 resolveCorrectedHeading 值（弧度，cos 修正，
//       自北顺时针——计划 risks 评审意见 2：实时推送朝向唯一来源）。
//   api/index.js re-export：getVehicles/getTrack/subscribePositions 经统一出口导出
//     （AGENTS.md 分层约定：组件与 composable 只能 import api/*）。
//
// 诚实缺口：range 完全落在窗口外的返回形状（空数组 vs 结构化失败）计划未约定，本测试不锁；
//   「平滑移动」的 rAF 插值是浏览器行为，node 只断言推送序列本身（计划 risks 诚实缺口声明先例）。

import { getTrack, getVehicles, subscribePositions } from './vehiclesApi.js';
import * as apiIndex from './index.js';
import {
  VEHICLES_SEED,
  TRACK_WINDOW,
  buildRouteSchedule,
  generateTrack,
  haversine,
  resolveCorrectedHeading,
  resolveRoutePositionAt,
} from '../mock/vehicles.js';
import { POSITION_ROUTE_TIME_SCALE, TRACK_SAMPLE_INTERVAL_MS } from '../constants.js';

const POSITION_TOLERANCE = 1e-9; // 度
const HEADING_TOLERANCE = 1e-9; // 弧度
const SPEED_TOLERANCE = 1e-9;
// intervalMs=10 注入下的墙钟抖动余量：同车相邻推送 time 增量 ≈ intervalMs × scale，
// node 定时器精度与调度抖动下放宽到 [0.9×, 15×]（锁「≈intervalMs」量级，防跨量级跳变；
// 上界余量修正：verify 全部挂载点经 Promise.all 并行执行，本测 200ms 窗口内其他
// 挂载点的同步重活（3×3601 点轨迹生成/射线法求交）会阻塞事件循环，实测单次推送
// 间隙可达 60-70ms——6× 上界在本机偶发误红且与实现无关；15× 仍远低于跨量级
// （scale 误配 = 100× 量级），scale===1 由常量契约断言另锁）
const TIME_STEP_MIN_MS = 10 * 0.9;
const TIME_STEP_MAX_MS = 10 * 15;
const waitFor = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const verify = async (assert) => {
  // 订阅句柄追踪：成功路径主动移出，异常中断由 finally 兜底全取消（防残留 interval 挂起 node）
  const activeUnsubscribers = new Set();
  const subscribeTracked = (callback, options) => {
    const unsubscribe = subscribePositions(callback, options);
    activeUnsubscribers.add(unsubscribe);
    return unsubscribe;
  };
  const unsubscribeTracked = (unsubscribe) => {
    unsubscribe();
    activeUnsubscribers.delete(unsubscribe);
  };

  // 全车队腿速预算（相邻推送位移断言用；米/秒）
  const legSpeedsAllMs = VEHICLES_SEED.flatMap((vehicle) =>
    buildRouteSchedule(vehicle.route).legs.map((leg) => leg.speedKmh / 3.6),
  );
  const fleetMinSpeedMs = Math.min(...legSpeedsAllMs);
  const fleetMaxSpeedMs = Math.max(...legSpeedsAllMs);
  const vehiclesById = new Map(VEHICLES_SEED.map((vehicle) => [vehicle.id, vehicle]));

  try {
    // —— api/index.js 统一出口（AGENTS.md 分层约定：组件与 composable 只调 api/*）——
    ['getVehicles', 'getTrack', 'subscribePositions'].forEach((methodName) => {
      assert.equal(
        typeof apiIndex[methodName],
        'function',
        `api/index.js 应 re-export ${methodName}（组件/composable 只调 api/*）`,
      );
    });

    // —— getVehicles：resolve 种子深拷贝、两次调用互不影响 ——
    const firstVehicles = await getVehicles();
    assert.ok(Array.isArray(firstVehicles), 'getVehicles 应 resolve 数组');
    assert.equal(firstVehicles.length, 3, 'getVehicles 应 resolve 恰 3 辆车');
    assert.deepEqual(firstVehicles, VEHICLES_SEED, 'getVehicles 应 resolve VEHICLES_SEED 内容');
    const secondVehicles = await getVehicles();
    assert.notEqual(firstVehicles, secondVehicles, '两次 getVehicles 不应返回同一引用');
    firstVehicles[0].name = '__污染测试__';
    firstVehicles[0].route = [];
    const thirdVehicles = await getVehicles();
    assert.deepEqual(
      thirdVehicles,
      VEHICLES_SEED,
      '污染上一次 getVehicles 返回值不应影响下一次（每次均为深拷贝）',
    );

    // —— getTrack 已知 id、无 range：全窗轨迹 = mock 端 generateTrack ——
    const sampleVehicle = VEHICLES_SEED[0];
    let fullTrackResult;
    await assert.doesNotReject(
      async () => {
        fullTrackResult = await getTrack(sampleVehicle.id);
      },
      'getTrack 已知 id 不应 reject',
    );
    assert.equal(fullTrackResult.ok, true, 'getTrack 已知 id 应 resolve { ok: true }');
    assert.deepEqual(
      fullTrackResult.points,
      generateTrack(sampleVehicle),
      'getTrack 无 range 应返回与 generateTrack 一致的全窗轨迹',
    );
    const fullTrackAgain = await getTrack(sampleVehicle.id);
    fullTrackResult.points[0].lng = NaN;
    assert.deepEqual(
      fullTrackAgain.points,
      generateTrack(sampleVehicle),
      '污染上一次 getTrack 的 points 不应影响下一次（缓存返回深拷贝）',
    );

    // —— getTrack range 对齐采样网格：闭区间切片、端点保留 ——
    const alignedRange = {
      startMs: TRACK_WINDOW.startMs + 5 * TRACK_SAMPLE_INTERVAL_MS,
      endMs: TRACK_WINDOW.endMs - 5 * TRACK_SAMPLE_INTERVAL_MS,
    };
    const alignedResult = await getTrack(sampleVehicle.id, alignedRange);
    assert.equal(alignedResult.ok, true, '对齐网格的 range 应 { ok: true }');
    assert.ok(alignedResult.points.length > 0, '对齐网格的 range 应切出非空子序列');
    assert.equal(
      alignedResult.points[0].time,
      alignedRange.startMs,
      'range 起点恰为采样点时应保留端点（首点 time = startMs）',
    );
    assert.equal(
      alignedResult.points[alignedResult.points.length - 1].time,
      alignedRange.endMs,
      'range 终点恰为采样点时应保留端点（末点 time = endMs）',
    );
    alignedResult.points.forEach((trackPoint, pointIndex) => {
      assert.ok(
        trackPoint.time >= alignedRange.startMs && trackPoint.time <= alignedRange.endMs,
        `切片第 ${String(pointIndex)} 点应在闭区间 [startMs, endMs] 内`,
      );
      if (pointIndex > 0) {
        assert.equal(
          trackPoint.time - alignedResult.points[pointIndex - 1].time,
          TRACK_SAMPLE_INTERVAL_MS,
          `切片应保持等间隔（闭区间子序列不抽稀）`,
        );
      }
    });

    // —— getTrack range 不对齐网格：取区间内的采样点子序列 ——
    const unalignedRange = {
      startMs: TRACK_WINDOW.startMs + 3.5 * TRACK_SAMPLE_INTERVAL_MS,
      endMs: TRACK_WINDOW.endMs - 2.5 * TRACK_SAMPLE_INTERVAL_MS,
    };
    const unalignedResult = await getTrack(sampleVehicle.id, unalignedRange);
    assert.equal(unalignedResult.ok, true, '不对齐网格的 range 应 { ok: true }');
    assert.ok(unalignedResult.points.length > 0, '窗口中部 range 应切出非空子序列');
    const firstUnalignedTime = unalignedResult.points[0].time;
    assert.ok(
      firstUnalignedTime >= unalignedRange.startMs &&
        firstUnalignedTime - unalignedRange.startMs < TRACK_SAMPLE_INTERVAL_MS,
      '不对齐 startMs 时首点应取区间内首个采样点（落在 startMs 后一个采样间隔内）',
    );
    unalignedResult.points.forEach((trackPoint) => {
      assert.ok(
        trackPoint.time >= unalignedRange.startMs && trackPoint.time <= unalignedRange.endMs,
        '不对齐 range 的全部切片点应在闭区间内',
      );
    });

    // —— getTrack 未知 id：{ ok:false, error }，永不 reject ——
    let missResult;
    await assert.doesNotReject(
      async () => {
        missResult = await getTrack('no-such-vehicle-id');
      },
      'getTrack 未知 id 也不应 reject（mock 永不 reject，设计 §5 L143）',
    );
    assert.equal(missResult.ok, false, '未知 id 应 resolve { ok: false }');
    assert.ok(missResult.error, '未知 id 结果应携带 error 信息');

    // —— subscribePositions：intervalMs:10 真实定时器，200ms 内每车均收到推送 ——
    const pushesByVehicleId = new Map(VEHICLES_SEED.map((vehicle) => [vehicle.id, []]));
    const unsubscribePush = subscribeTracked(
      (positionRecord) => {
        assert.ok(
          pushesByVehicleId.has(positionRecord.vehicleId),
          `推送 vehicleId「${String(positionRecord.vehicleId)}」应 ∈ VEHICLES_SEED`,
        );
        pushesByVehicleId.get(positionRecord.vehicleId)?.push(positionRecord);
      },
      { intervalMs: 10 },
    );
    assert.equal(typeof unsubscribePush, 'function', 'subscribePositions 应返回取消函数');
    await waitFor(200);

    pushesByVehicleId.forEach((vehiclePushes, vehicleId) => {
      assert.ok(
        vehiclePushes.length >= 2,
        `intervalMs=10 下 200ms 内车辆「${vehicleId}」应至少收到 2 次推送（真实 setInterval 逐车生效）`,
      );
    });

    // 每条推送记录：形状 + 与 resolveRoutePositionAt / resolveCorrectedHeading 复算一致（评审2 复算断言）
    pushesByVehicleId.forEach((vehiclePushes, vehicleId) => {
      const vehicle = vehiclesById.get(vehicleId);
      vehiclePushes.forEach((positionRecord, pushIndex) => {
        const label = `车辆「${vehicleId}」第 ${String(pushIndex)} 次推送`;
        ['lng', 'lat', 'heading', 'time', 'speedKmh'].forEach((fieldName) => {
          assert.ok(Number.isFinite(positionRecord[fieldName]), `${label}：${fieldName} 应为有限数`);
        });
        const replayPosition = resolveRoutePositionAt(vehicle.route, positionRecord.time);
        assert.ok(
          Math.abs(positionRecord.lng - replayPosition.lng) <= POSITION_TOLERANCE,
          `${label}：lng 应与 resolveRoutePositionAt(route, time) 复算一致（沿路线推进）`,
        );
        assert.ok(
          Math.abs(positionRecord.lat - replayPosition.lat) <= POSITION_TOLERANCE,
          `${label}：lat 应与 resolveRoutePositionAt(route, time) 复算一致`,
        );
        assert.ok(
          Math.abs(positionRecord.speedKmh - replayPosition.speedKmh) <= SPEED_TOLERANCE,
          `${label}：speedKmh 应 = 所在腿配置速度`,
        );
        const legFrom = vehicle.route[replayPosition.legIndex];
        const legTo = vehicle.route[replayPosition.legIndex + 1];
        const expectedHeading = resolveCorrectedHeading(
          [legFrom.lng, legFrom.lat],
          [legTo.lng, legTo.lat],
        );
        assert.ok(
          Math.abs(positionRecord.heading - expectedHeading) <= HEADING_TOLERANCE,
          `${label}：heading 应与所在腿两端控制点的 resolveCorrectedHeading 一致（cos 修正、自北顺时针）`,
        );
      });
      // 同车连续推送 time 严格递增，增量 ≈ intervalMs × scale（scale=1）
      vehiclePushes.forEach((positionRecord, pushIndex) => {
        if (pushIndex > 0) {
          const timeStep = positionRecord.time - vehiclePushes[pushIndex - 1].time;
          assert.ok(timeStep > 0, `车辆「${vehicleId}」连续推送 time 应严格递增`);
          assert.ok(
            timeStep >= TIME_STEP_MIN_MS && timeStep <= TIME_STEP_MAX_MS,
            `车辆「${vehicleId}」推送 time 增量应 ≈ intervalMs×scale（实际 ${String(timeStep)}ms，注入 intervalMs=10、scale=${String(POSITION_ROUTE_TIME_SCALE)}）`,
          );
        }
      });
    });

    // 首订阅锚定 TRACK_WINDOW.startMs：首批推送的路线虚拟时间应从窗口起点出发
    pushesByVehicleId.forEach((vehiclePushes, vehicleId) => {
      const firstPushTime = vehiclePushes[0].time;
      assert.ok(
        firstPushTime >= TRACK_WINDOW.startMs && firstPushTime < TRACK_WINDOW.startMs + 2000,
        `车辆「${vehicleId}」首批推送 time 应锚定窗口起点（实际偏移 ${String(firstPushTime - TRACK_WINDOW.startMs)}ms < 2000）`,
      );
    });

    // 相邻推送位移 ∈ [最低腿速, 最高腿速] × 实际 Δt × 缓冲（锁 scale=1 位移预算，20–70km/h 量级）
    pushesByVehicleId.forEach((vehiclePushes, vehicleId) => {
      vehiclePushes.forEach((positionRecord, pushIndex) => {
        if (pushIndex > 0) {
          const previousRecord = vehiclePushes[pushIndex - 1];
          const actualTimeStep = positionRecord.time - previousRecord.time;
          const stepDistance = haversine(
            [previousRecord.lng, previousRecord.lat],
            [positionRecord.lng, positionRecord.lat],
          );
          // Δt 换算成秒（m/s × s = m，单位一致性修正，与计划原文算例「20-70km/h×2s=11-39m」对齐）
          assert.ok(
            stepDistance >= fleetMinSpeedMs * (actualTimeStep / 1000) * 0.9 - 1e-6,
            `车辆「${vehicleId}」相邻推送位移 ${String(stepDistance)}m 不应低于最低腿速×Δt×0.9`,
          );
          assert.ok(
            stepDistance <= fleetMaxSpeedMs * (actualTimeStep / 1000) * 1.1 + 1e-6,
            `车辆「${vehicleId}」相邻推送位移 ${String(stepDistance)}m 不应超过最高腿速×Δt×1.1（无瞬移）`,
          );
        }
      });
    });

    // —— 取消函数生效：宽限期内不再回调 ——
    unsubscribeTracked(unsubscribePush);
    const silencedCounts = new Map(
      [...pushesByVehicleId.entries()].map(([vehicleId, vehiclePushes]) => [vehicleId, vehiclePushes.length]),
    );
    await waitFor(80);
    pushesByVehicleId.forEach((vehiclePushes, vehicleId) => {
      assert.equal(
        vehiclePushes.length,
        silencedCounts.get(vehicleId),
        `取消订阅后车辆「${vehicleId}」不应再收到推送（80ms ≥ 8 个 intervalMs 周期）`,
      );
    });
    await waitFor(30); // 收尾余量，确保取消在 finally 前已生效
  } finally {
    activeUnsubscribers.forEach((unsubscribe) => {
      unsubscribe();
    });
  }
};
