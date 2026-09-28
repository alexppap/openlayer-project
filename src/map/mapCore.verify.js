// src/map/mapCore.verify.js — 底图瓦片错误计数状态机 + 新增常量契约（pnpm verify 自动发现挂载）
// 覆盖实施计划 testPoint「createTileErrorTracker 状态机」「新增常量契约」。
//
// ⚠ 运行环境约束：本文件在纯 node（无 vite/vue）下执行，被测 src/map/mapCore.js
//   必须保持 vue-free（不得 import vue / composables，底图降级经参数注入回调桥接），
//   且 ol 依赖须裸 ESM 可导入（'ol/Map.js' 等 import 统一带 .js 后缀）。
//
// createTileErrorTracker 契约（设计 §5 L144「连续失败 ≥ 5 次」的实施计划口径）：
//   createTileErrorTracker({ threshold }) 返回 tracker(eventType) 函数，
//   eventType 为 ol 事件类型 'tileloaderror' | 'tileloadend'；
//   返回 true 表示「无成功间隔的错误事件达到 threshold」本轮首次达成——
//   每轮连续失败仅返回一次 true，任一 'tileloadend' 复位计数并重新武装，
//   新一轮连续失败达到 threshold 可再次返回 true。
//   tracker 返回 true 后如何触发 onBasemapDegraded 属接线逻辑，不在本纯逻辑测试范围。

import {
  BASEMAP_TILE_ERROR_THRESHOLD,
  MAP_DEFAULT_VIEW,
  FLY_TO_DEFAULT_ZOOM,
  NOTICE_DEFAULT_DURATION_MS,
} from '../constants.js';
import { createTileErrorTracker } from './mapCore.js';

// 连续喂 count 次 tileloaderror，按序返回每次 tracker 的布尔返回值
const feedErrors = (tracker, count) =>
  Array.from({ length: count }, () => tracker('tileloaderror'));

export const verify = (assert) => {
  // —— 新增常量契约（实施计划 step 1）——
  assert.equal(BASEMAP_TILE_ERROR_THRESHOLD, 5, '底图瓦片连续失败阈值应为 5（设计 §5 L144）');
  assert.ok(MAP_DEFAULT_VIEW && typeof MAP_DEFAULT_VIEW === 'object', 'MAP_DEFAULT_VIEW 应为对象');
  assert.ok(Array.isArray(MAP_DEFAULT_VIEW.center), 'MAP_DEFAULT_VIEW.center 应为数组 [lng, lat]');
  assert.equal(MAP_DEFAULT_VIEW.center.length, 2, 'MAP_DEFAULT_VIEW.center 长度应为 2');
  MAP_DEFAULT_VIEW.center.forEach((value, index) => {
    assert.equal(typeof value, 'number', `MAP_DEFAULT_VIEW.center[${index}] 应为数值`);
    assert.ok(!Number.isNaN(value), `MAP_DEFAULT_VIEW.center[${index}] 不应为 NaN`);
  });
  assert.equal(typeof MAP_DEFAULT_VIEW.zoom, 'number', 'MAP_DEFAULT_VIEW.zoom 应为数值');
  assert.ok(!Number.isNaN(MAP_DEFAULT_VIEW.zoom), 'MAP_DEFAULT_VIEW.zoom 不应为 NaN');
  assert.equal(typeof FLY_TO_DEFAULT_ZOOM, 'number', 'FLY_TO_DEFAULT_ZOOM 应为数值');
  assert.ok(!Number.isNaN(FLY_TO_DEFAULT_ZOOM), 'FLY_TO_DEFAULT_ZOOM 不应为 NaN');
  assert.equal(typeof NOTICE_DEFAULT_DURATION_MS, 'number', 'NOTICE_DEFAULT_DURATION_MS 应为数值');
  assert.ok(NOTICE_DEFAULT_DURATION_MS > 0, 'NOTICE_DEFAULT_DURATION_MS 应大于 0');
  // 注：MAP_DEFAULT_VIEW.center/zoom 是显式占位值（厂区数据任务接入后以厂区范围 fit 或替换），
  //   此处只锁形状与数值类型，不锁具体数值——避免占位坐标调整时误伤。

  // —— 状态机：threshold=5 —— 连续第 1-4 次 false、第 5 次 true、第 6 次起仍 false ——
  const tracker = createTileErrorTracker({ threshold: 5 });
  assert.equal(typeof tracker, 'function', 'createTileErrorTracker 应返回函数');
  assert.deepEqual(
    feedErrors(tracker, 4),
    [false, false, false, false],
    '连续第 1-4 次 tileloaderror 不应触发',
  );
  assert.equal(tracker('tileloaderror'), true, '连续第 5 次 tileloaderror 达到 threshold 应返回 true');
  assert.equal(tracker('tileloaderror'), false, '连续第 6 次 tileloaderror 同一轮不应再次触发');
  assert.equal(tracker('tileloaderror'), false, '继续失败仍不应重复触发');

  // —— tileloadend 复位并重新武装，新一轮 5 连失败可再次 true ——
  assert.equal(tracker('tileloadend'), false, 'tileloadend 本身不应触发');
  assert.deepEqual(
    feedErrors(tracker, 4),
    [false, false, false, false],
    '复位后新一轮前 4 次失败不应触发',
  );
  assert.equal(tracker('tileloaderror'), true, '复位后新一轮第 5 次连续失败应再次返回 true');

  // —— 成功事件穿插打断连续计数（无成功间隔才累计）——
  const interleavedTracker = createTileErrorTracker({ threshold: 3 });
  assert.equal(interleavedTracker('tileloaderror'), false, 'threshold=3 第 1 次失败不触发');
  assert.equal(interleavedTracker('tileloaderror'), false, 'threshold=3 第 2 次失败不触发');
  assert.equal(interleavedTracker('tileloadend'), false, '穿插的成功事件不应触发');
  assert.deepEqual(
    feedErrors(interleavedTracker, 2),
    [false, false],
    '复位后须重新累计满 threshold，前 2 次不触发',
  );
  assert.equal(interleavedTracker('tileloaderror'), true, '复位后重新连续 3 次失败应触发');

  // —— threshold 参数生效 ——
  const smallTracker = createTileErrorTracker({ threshold: 2 });
  assert.equal(smallTracker('tileloaderror'), false, 'threshold=2 第 1 次失败不触发');
  assert.equal(smallTracker('tileloaderror'), true, 'threshold=2 第 2 次失败即触发');
  assert.equal(smallTracker('tileloaderror'), false, 'threshold=2 同轮后续失败不重复触发');

  // —— 纯工厂：实例间不共享计数 ——
  const trackerOne = createTileErrorTracker({ threshold: 2 });
  const trackerTwo = createTileErrorTracker({ threshold: 2 });
  trackerOne('tileloaderror');
  assert.equal(trackerTwo('tileloaderror'), false, '另一实例的失败不应累加到本实例');
  assert.equal(trackerOne('tileloaderror'), true, '实例自身累计达到 threshold 应触发');
};
