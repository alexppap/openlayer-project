// src/composables/useVehicles.js — 车辆轨迹回放/速度染色/实时模式（设计 §4.3 L112-118）。
//
// 模块级单例（不引 Pinia，AGENTS.md：跨组件状态由 composable 单例内聚）：
//   initVehicles() 由 App.vue setup 调用一次（幂等；HMR 重入先退订再接线、重挂 watch）。
//
// ⚠ node 兼容（useVehicles.verify.js 在纯 node 下导入本模块，先例 useAlarms.js:6-8）：
//   模块顶层只创建 vue ref/computed 与纯函数；ol 实例（source/layer/Feature）、canvas、
//   rAF 一律在 initVehicles 及运行时函数内惰性构造；DOM 只在浏览器运行时函数内访问。
//
// 渲染口径：
//   - 历史回放：两个动态分段 Feature——已走段按 buildSpeedSegments 分色实线（快红慢绿，
//     多 Style 子 geometry）+ 未走段淡虚线；车头 rotation 每帧经 resolveUnwrappedHeading
//     累计更新（设计 L116「rotation 属性 + 累计角度」）。
//   - 实时模式：subscribePositions 每 2s 推送 → rAF 在推送间隔内线性插值平滑移动；
//     尾迹 buildTrailSegments 保留最近 TRAIL_POINT_COUNT 个点、透明度渐隐；
//     多车淡显单选（非选中车 opacity 0.45 保留在图上）。
//   - 车头图标不复用共享 Icon 实例：rotation/opacity 是 Icon 实例状态，多 feature 共享
//     会互相覆盖——map/utils.createVehicleMarkerSrc 只缓存 dataURL（canvas 本体朝正北），
//     Icon 实例由本模块按车各自持有（ol 内部按 src 共享解码图，无重复解码开销）。
import { computed, ref, watch } from 'vue';
import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import { getLength } from 'ol/sphere.js';
import Icon from 'ol/style/Icon.js';
import { Stroke, Style } from 'ol/style.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { getTrack, getVehicles, subscribePositions } from '../api/index.js';
import {
  PLAYBACK_SPEED_OPTIONS,
  POSITION_PUSH_INTERVAL_MS,
  SPEED_COLOR_STOPS,
  TRAIL_POINT_COUNT,
  VEHICLES_LAYER_ID,
} from '../constants.js';
import * as layerManager from '../map/layerManager.js';
import { createVehicleMarkerSrc, toMapCoord, withAlpha } from '../map/utils.js';
import { useMap } from './useMap.js';
import { useNotice } from './useNotice.js';

// ---- 纯函数（useVehicles.verify.js 断言对象；「轨迹点」统一形状——
//      { coord: [x, y], time: number, speedKmh: number }，投影由调用方决定）----

// 速度（km/h）→ SPEED_COLOR_STOPS 档色（升序阈值：speed ∈ [t_k, t_{k+1}) 取第 k 档，
// 末档无上界，快红慢绿）；负数/NaN 回退首档色（慢端兜底），不抛错。
export const resolveSpeedColor = (speedKmh) =>
  SPEED_COLOR_STOPS.reduce(
    (matchedColor, stop) => (speedKmh >= stop.threshold ? stop.color : matchedColor),
    SPEED_COLOR_STOPS[0].color,
  );

// 速度染色分段：底层每个相邻点对 (i, i+1) 为一段、段色按出发点速度取档，
// 连续同色段合并为 run = { startIndex, coords, color }（相邻 run 无缝衔接、颜色必不同）；
// walkedIndex 截断只覆盖点 0..walkedIndex 之间的段（Σ(coords.length-1) = walkedIndex）；
// 空/单点输入 → []。
// run 累积用局部可变数组（每帧渲染热路径，避免 O(n²) 拷贝；入参数组不被改动）。
export const buildSpeedSegments = (points, walkedIndex = points?.length - 1) => {
  if (!Array.isArray(points) || points.length < 2 || !Number.isFinite(walkedIndex) || walkedIndex <= 0) {
    return [];
  }
  const targetIndex = Math.min(walkedIndex, points.length - 1);
  const runs = [];
  for (let segmentIndex = 0; segmentIndex < targetIndex; segmentIndex += 1) {
    const color = resolveSpeedColor(points[segmentIndex].speedKmh);
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.color === color) {
      lastRun.coords.push(points[segmentIndex + 1].coord);
    } else {
      runs.push({
        startIndex: segmentIndex,
        coords: [points[segmentIndex].coord, points[segmentIndex + 1].coord],
        color,
      });
    }
  }
  return runs;
};

// 播放进度 → 轨迹点映射：points 按时间升序，返回 { index, fraction }——
// t ≤ 首点钳制 { 0, 0 }；t ≥ 末点钳制末段 fraction=1；恰在采样点 k 命中 { k, 0 }；
// 两点之间取左端点索引与时间线性比例 fraction ∈ (0, 1)。
export const resolvePlayheadIndex = (points, timeMs) => {
  if (!Array.isArray(points) || points.length < 2 || !Number.isFinite(timeMs)) {
    return { index: 0, fraction: 0 };
  }
  if (timeMs <= points[0].time) {
    return { index: 0, fraction: 0 };
  }
  const lastPoint = points[points.length - 1];
  if (timeMs >= lastPoint.time) {
    return { index: points.length - 2, fraction: 1 };
  }
  let index = 0;
  for (let cursor = points.length - 2; cursor >= 0; cursor -= 1) {
    if (timeMs >= points[cursor].time) {
      index = cursor;
      break;
    }
  }
  const startTime = points[index].time;
  if (timeMs <= startTime) {
    return { index, fraction: 0 };
  }
  const endTime = points[index + 1].time;
  return { index, fraction: Math.min(1, Math.max(0, (timeMs - startTime) / (endTime - startTime))) };
};

// 行进方向（弧度，自北顺时针）——3857 平面口径 atan2(dx, dy)，回放侧消费；
// 与 mock 端 cos(lat) 修正的 4326 口径在 Mercator 正形投影下代数等价
// （mock/vehicles.js resolveCorrectedHeading 头注互指）；零向量返回 0 不抛错。
export const resolveSegmentHeading = (fromCoord, toCoord) => {
  const deltaX = toCoord[0] - fromCoord[0];
  const deltaY = toCoord[1] - fromCoord[1];
  if (deltaX === 0 && deltaY === 0) {
    return 0;
  }
  return Math.atan2(deltaX, deltaY);
};

// 跨 ±π 最短路径的累计角度（设计 §4.3 L116「rotation 属性 + 累计角度」）：
// 返回 target ± 2kπ 中与 previous 最近者（|结果 - previous| ≤ π 且结果 ≡ target (mod 2π)）；
// 回放每帧与实时每次推送的车头 rotation 均经它累计更新，跨 ±π 不回绕突跳。
// （诚实说明：ol 对 rotation 按模 2π 渲染，直接设绝对角本不会视觉跳变；保留累计口径
//   是设计原文要求，且为基于增量的动画/累计转角统计提供正确原语。）
export const resolveUnwrappedHeading = (previousRad, targetRad) => {
  const TAU = Math.PI * 2;
  const previous = Number.isFinite(previousRad) ? previousRad : 0;
  const target = Number.isFinite(targetRad) ? targetRad : 0;
  const shortestOffset = ((target - previous + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return previous + shortestOffset;
};

// 渲染层测地线测距默认实现（ol/sphere.getLength，设计 §4.3 L117 统计口径；
// 仅调用时构造 LineString——node 自测恒注入桩，不触本默认）
const measureGeodesicDistance = (coordA, coordB) => getLength(new LineString([coordA, coordB]));

// 轨迹统计：总里程 = Σ 段距；总时长 = 末首时间差；平均速度 = 总里程/总时长×3.6（km/h）；
// 最高速度 = 最快段速度；点数 < 2 → 全零结构不抛错。
export const buildTrackStats = (points, { measureDistance } = {}) => {
  if (!Array.isArray(points) || points.length < 2) {
    return { totalDistanceM: 0, totalDurationMs: 0, averageSpeedKmh: 0, maxSpeedKmh: 0 };
  }
  const measure = typeof measureDistance === 'function' ? measureDistance : measureGeodesicDistance;
  // 每段测距恰一次（段速与总里程共用），注入桩（可能带调用计数）不被重复消费；
  // 速度换算口径：m / (ms/1000) = m/s，×3.6 → km/h
  const segmentStats = points.slice(0, -1).map((point, index) => {
    const nextPoint = points[index + 1];
    const distanceM = measure(point.coord, nextPoint.coord);
    const durationMs = Math.max(0, nextPoint.time - point.time);
    return { distanceM, segmentSpeedKmh: durationMs > 0 ? (distanceM / (durationMs / 1000)) * 3.6 : 0 };
  });
  const totalDistanceM = segmentStats.reduce((total, segment) => total + segment.distanceM, 0);
  const totalDurationMs = points[points.length - 1].time - points[0].time;
  return {
    totalDistanceM,
    totalDurationMs,
    averageSpeedKmh:
      totalDurationMs > 0 ? (totalDistanceM / (totalDurationMs / 1000)) * 3.6 : 0,
    maxSpeedKmh: Math.max(...segmentStats.map((segment) => segment.segmentSpeedKmh)),
  };
};

// 实时尾迹分段：只保留最近 TRAIL_POINT_COUNT 个点的相邻段，
// alpha 沿索引严格递增（最新段最不透明，渐隐）；点数不足时全量输出；<2 点 → []。
export const buildTrailSegments = (points) => {
  if (!Array.isArray(points) || points.length < 2) {
    return [];
  }
  const recentPoints = points.slice(-TRAIL_POINT_COUNT);
  return recentPoints.slice(0, -1).map((point, index) => ({
    coords: [point.coord, recentPoints[index + 1].coord],
    alpha: (index + 1) / (recentPoints.length - 1),
  }));
};

// ---- 渲染标量 ----
const WALKED_STROKE_WIDTH = 4;
const UNWALKED_STROKE_WIDTH = 2;
const UNWALKED_STROKE_COLOR = '#8c8c8c';
const UNWALKED_STROKE_DASH = [6, 6];
const TRAIL_STROKE_WIDTH = 3;
const DIMMED_MARKER_OPACITY = 0.45;
const WALKED_RERENDER_INTERVAL_MS = 120; // 已走段样式重建节流（尾段随 playhead 增长）
const SLIDER_STEP_MS = 1000;

// ---- 模块级单例状态（vehiclesInitialized 前均为 null/旗标占位，构造在 initVehicles）----
let vehiclesSourceInstance = null;
let vehiclesLayerInstance = null;
let vehiclesInitialized = false;
let vehiclesAttached = false;
let vehiclesLoaded = false;
let stopMapReadyWatch = null;
let unsubscribePositionPush = null;
let vehicleFrameId = null;
let lastFrameWallMs = null;
let walkedFeature = null;
let unwalkedFeature = null;
let lastWalkedIndex = -1;
let lastWalkedRenderMs = 0;

// vehicleId → 运行时渲染对象（Feature/Icon 实例按车各自持有，见文件头注）
const markerEntries = new Map();
const trailFeatures = new Map();
const headingByVehicleId = new Map();
const trailByVehicleId = new Map();
const liveTelemetry = new Map();
// vehicleId → 全窗轨迹（3857 coord + time + speedKmh）：回放模式下其他车按同一
// 播放头时刻淡显摆位在各自轨迹上（设计 §4.3 L115「其他车以淡显方式保留在图上」不区分模式）
const fleetTracksByVehicleId = new Map();
let fleetTracksLoaded = false;

// ---- 面板可见状态（ref/computed，VehiclePanel 视图模型数据源）----
const vehicles = ref([]);
const selectedVehicleId = ref(null);
const trackPoints = ref([]); // 当前选中车轨迹（3857 coord + time + speedKmh）
const playing = ref(false);
const playheadMs = ref(0);
const playbackSpeed = ref(PLAYBACK_SPEED_OPTIONS[0]);
const liveMode = ref(false);
const livePositions = ref({}); // vehicleId → 最近一条推送记录（列表实时速度展示）

const trackStartMs = computed(() => trackPoints.value[0]?.time ?? 0);
const trackEndMs = computed(() => trackPoints.value[trackPoints.value.length - 1]?.time ?? 0);
// 轨迹点 <2 禁用回放（设计 §5 L145）；实时模式下回放控件让位
const canPlayback = computed(() => !liveMode.value && trackPoints.value.length >= 2);
const trackStats = computed(() => buildTrackStats(trackPoints.value));

const resolveSelectedVehicle = () =>
  vehicles.value.find((vehicle) => vehicle.id === selectedVehicleId.value) ?? null;

// ---- 车头 marker（Icon 实例按车持有；dim 变化才重建，rotation 走 setRotation 增量）----
const ensureMarkerEntry = (vehicle) => {
  let entry = markerEntries.get(vehicle.id);
  if (!entry) {
    entry = { feature: new Feature({ vehicleId: vehicle.id }), icon: null, style: null, dim: null };
    markerEntries.set(vehicle.id, entry);
    vehiclesSourceInstance?.addFeature(entry.feature);
  }
  return entry;
};

const applyMarkerVisual = (vehicle, { rotation, dim }) => {
  const entry = ensureMarkerEntry(vehicle);
  if (entry.dim !== dim || !entry.icon) {
    entry.icon = new Icon({
      src: createVehicleMarkerSrc({ color: vehicle.color, dim }),
      opacity: dim ? DIMMED_MARKER_OPACITY : 1,
    });
    entry.style = new Style({ image: entry.icon });
    entry.dim = dim;
  }
  entry.icon.setRotation(rotation);
  entry.feature.setStyle(entry.style);
};

// ---- 历史回放渲染（每帧：marker 移动；已走/未走分段按节流重建）----
const renderPlaybackFrame = () => {
  const points = trackPoints.value;
  const vehicle = resolveSelectedVehicle();
  if (!vehicle || points.length < 2 || !vehiclesSourceInstance) {
    return;
  }
  const { index, fraction } = resolvePlayheadIndex(points, playheadMs.value);
  const fromPoint = points[index];
  const toPoint = points[index + 1] ?? fromPoint;
  const playheadCoord = [
    fromPoint.coord[0] + (toPoint.coord[0] - fromPoint.coord[0]) * fraction,
    fromPoint.coord[1] + (toPoint.coord[1] - fromPoint.coord[1]) * fraction,
  ];

  // 车头：方向取所在采样段（直线段），rotation 经解缠累计（不因零位移漂移）
  const segmentHeading = resolveSegmentHeading(fromPoint.coord, toPoint.coord);
  const nextRotation = resolveUnwrappedHeading(headingByVehicleId.get(vehicle.id) ?? 0, segmentHeading);
  headingByVehicleId.set(vehicle.id, nextRotation);
  markerEntries.get(vehicle.id)?.feature.setGeometry(new Point(playheadCoord));
  applyMarkerVisual(vehicle, { rotation: nextRotation, dim: false });

  // 已走段（含 playhead 所在的部分段）/ 未走段：段索引变化或超时节流窗才重建
  const nowPerfMs = performance.now();
  if (index !== lastWalkedIndex || nowPerfMs - lastWalkedRenderMs > WALKED_RERENDER_INTERVAL_MS) {
    lastWalkedIndex = index;
    lastWalkedRenderMs = nowPerfMs;
    const walkedPoints = [
      ...points.slice(0, index + 1),
      { coord: playheadCoord, time: playheadMs.value, speedKmh: fromPoint.speedKmh },
    ];
    const segmentRuns = buildSpeedSegments(walkedPoints);
    walkedFeature?.setStyle(
      segmentRuns.map(
        (run) =>
          new Style({
            geometry: new LineString(run.coords),
            stroke: new Stroke({ color: run.color, width: WALKED_STROKE_WIDTH }),
          }),
      ),
    );
    const remainingCoords = [playheadCoord, ...points.slice(index + 1).map((point) => point.coord)];
    if (unwalkedFeature) {
      if (remainingCoords.length >= 2) {
        unwalkedFeature.setGeometry(new LineString(remainingCoords));
      } else {
        // 已播放到末点：未走段退化为空，摘除几何避免单点 LineString
        unwalkedFeature.setGeometry(undefined);
      }
    }
  }

  // 其他车淡显保留在图上（设计 §4.3 L115 不区分模式）：按同一播放头时刻摆在各自
  // 轨迹的线性插值位置，仅 marker 不画轨迹线（回放视觉焦点留给当前车）
  vehicles.value.forEach((otherVehicle) => {
    if (otherVehicle.id === vehicle.id) {
      return;
    }
    const otherEntry = markerEntries.get(otherVehicle.id);
    const otherTrack = fleetTracksByVehicleId.get(otherVehicle.id);
    if (!otherEntry || !otherTrack || otherTrack.length < 2) {
      return;
    }
    const otherPlayhead = resolvePlayheadIndex(otherTrack, playheadMs.value);
    const otherFrom = otherTrack[otherPlayhead.index];
    const otherTo = otherTrack[otherPlayhead.index + 1] ?? otherFrom;
    otherEntry.feature.setGeometry(
      new Point([
        otherFrom.coord[0] + (otherTo.coord[0] - otherFrom.coord[0]) * otherPlayhead.fraction,
        otherFrom.coord[1] + (otherTo.coord[1] - otherFrom.coord[1]) * otherPlayhead.fraction,
      ]),
    );
    const otherHeading = resolveSegmentHeading(otherFrom.coord, otherTo.coord);
    const otherRotation = resolveUnwrappedHeading(
      headingByVehicleId.get(otherVehicle.id) ?? 0,
      otherHeading,
    );
    headingByVehicleId.set(otherVehicle.id, otherRotation);
    applyMarkerVisual(otherVehicle, { rotation: otherRotation, dim: true });
  });
};

// ---- 实时模式渲染（rAF 在推送间隔内线性插值 → 平滑移动）----
const renderLiveFrame = (wallPerfMs) => {
  if (!vehiclesSourceInstance) {
    return;
  }
  liveTelemetry.forEach((telemetry, vehicleId) => {
    const vehicle = vehicles.value.find((item) => item.id === vehicleId);
    const entry = markerEntries.get(vehicleId);
    if (!vehicle || !entry) {
      return;
    }
    const { latest, previous, receivedPerfMs } = telemetry;
    const progress = Math.min(
      1,
      Math.max(0, (wallPerfMs - receivedPerfMs) / POSITION_PUSH_INTERVAL_MS),
    );
    const coord = previous
      ? [
          previous.coord[0] + (latest.coord[0] - previous.coord[0]) * progress,
          previous.coord[1] + (latest.coord[1] - previous.coord[1]) * progress,
        ]
      : latest.coord;
    entry.feature.setGeometry(new Point(coord));
    // 多车淡显单选：非当前车 opacity 0.45 保留在图上（可图层树整体关掉）
    const dim = vehicleId !== selectedVehicleId.value;
    // 推送 heading 为 mock 端 cos 修正口径（4326），正形投影下与 3857 口径一致，直接消费
    const nextRotation = resolveUnwrappedHeading(headingByVehicleId.get(vehicleId) ?? 0, latest.heading);
    headingByVehicleId.set(vehicleId, nextRotation);
    applyMarkerVisual(vehicle, { rotation: nextRotation, dim });
  });
};

// ---- 实时尾迹样式（多车淡显单选：非当前车整条尾迹透明度再乘 0.45，渐隐梯度保留）----
const resolveTrailStrokeAlpha = (vehicleId, segmentAlpha) =>
  vehicleId === selectedVehicleId.value ? segmentAlpha : segmentAlpha * DIMMED_MARKER_OPACITY;

const buildTrailStyles = (vehicle, trailSegments) =>
  trailSegments.map(
    (trailSegment) =>
      new Style({
        geometry: new LineString(trailSegment.coords),
        stroke: new Stroke({
          color: withAlpha(vehicle.color, resolveTrailStrokeAlpha(vehicle.id, trailSegment.alpha)),
          width: TRAIL_STROKE_WIDTH,
        }),
      }),
  );

// 选中车切换（实时模式）后整队尾迹按新淡显态重刷（marker 淡显由 renderLiveFrame 每帧自理）
const restyleLiveTrails = () => {
  vehicles.value.forEach((vehicle) => {
    const trailFeature = trailFeatures.get(vehicle.id);
    if (!trailFeature) {
      return;
    }
    trailFeature.setStyle(
      buildTrailStyles(vehicle, buildTrailSegments(trailByVehicleId.get(vehicle.id) ?? [])),
    );
  });
};

// 实时会话状态清场（进入/退出实时模式时调用，评审 finding 1）：上一会话的
// telemetry/尾迹/面板镜像若不清理，再进入时首条新推送会以旧会话末位置为插值起点、
// 向重新锚定的环线起点「飞越」2 秒（subscribePositions 首订阅重锚 TRACK_WINDOW.startMs，
// vehiclesApi.js），且尾迹把新旧会话点位连成跨厂区长线——全部作废重开。
const resetLiveState = () => {
  liveTelemetry.clear();
  trailByVehicleId.clear();
  livePositions.value = {};
};

// ---- 实时推送落点：更新 telemetry/尾迹/面板镜像，尾迹样式随推送重建（2s 一次）----
const handleLivePosition = (positionRecord) => {
  const coord = toMapCoord([positionRecord.lng, positionRecord.lat]);
  const previousTelemetry = liveTelemetry.get(positionRecord.vehicleId);
  liveTelemetry.set(positionRecord.vehicleId, {
    latest: {
      coord,
      heading: positionRecord.heading,
      time: positionRecord.time,
      speedKmh: positionRecord.speedKmh,
    },
    previous: previousTelemetry?.latest ?? null,
    receivedPerfMs: performance.now(),
  });
  const trail = [
    ...(trailByVehicleId.get(positionRecord.vehicleId) ?? []),
    { coord, time: positionRecord.time },
  ].slice(-TRAIL_POINT_COUNT);
  trailByVehicleId.set(positionRecord.vehicleId, trail);
  livePositions.value = { ...livePositions.value, [positionRecord.vehicleId]: positionRecord };

  const vehicle = vehicles.value.find((item) => item.id === positionRecord.vehicleId);
  const trailFeature = trailFeatures.get(positionRecord.vehicleId);
  if (vehicle && trailFeature) {
    trailFeature.setStyle(buildTrailStyles(vehicle, buildTrailSegments(trail)));
  }
};

// ---- 渲染形态总调度：按 liveMode/选中车重建全部 Feature ----
const renderSelectionState = () => {
  if (!vehiclesSourceInstance) {
    return;
  }
  vehiclesSourceInstance.clear(); // ol 命令式 API（AGENTS.md 例外条款）
  markerEntries.clear();
  trailFeatures.clear();
  walkedFeature = null;
  unwalkedFeature = null;
  lastWalkedIndex = -1;

  if (liveMode.value) {
    vehicles.value.forEach((vehicle) => {
      ensureMarkerEntry(vehicle);
      const trailFeature = new Feature({ vehicleId: vehicle.id });
      trailFeatures.set(vehicle.id, trailFeature);
      vehiclesSourceInstance.addFeature(trailFeature);
    });
    renderLiveFrame(performance.now()); // telemetry 已清场：首推前无几何不可见，无旧位置残留
    return;
  }

  const vehicle = resolveSelectedVehicle();
  const points = trackPoints.value;
  if (!vehicle || points.length === 0) {
    return;
  }
  walkedFeature = new Feature({ vehicleId: vehicle.id });
  unwalkedFeature = new Feature({ vehicleId: vehicle.id });
  unwalkedFeature.setGeometry(new LineString(points.map((point) => point.coord)));
  unwalkedFeature.setStyle(
    new Style({
      stroke: new Stroke({
        color: UNWALKED_STROKE_COLOR,
        width: UNWALKED_STROKE_WIDTH,
        lineDash: UNWALKED_STROKE_DASH,
      }),
    }),
  );
  vehiclesSourceInstance.addFeatures([walkedFeature, unwalkedFeature]);
  // 全队 marker 挨个建档：其他车淡显摆位由 renderPlaybackFrame 按各自轨迹推进
  vehicles.value.forEach((fleetVehicle) => {
    ensureMarkerEntry(fleetVehicle);
  });
  renderPlaybackFrame();
};

// ---- 数据加载 ----
// 全队轨迹一次载入（mock 端有缓存，开销可忽略）：回放模式下其他车淡显摆位需要
// 各自轨迹；单辆失败不阻断其余（空数组占位，对应车不摆位），任一失败统一提示一次。
const loadFleetTracks = async () => {
  if (fleetTracksLoaded) {
    return;
  }
  const trackEntries = await Promise.all(
    vehicles.value.map(async (vehicle) => {
      try {
        const result = await getTrack(vehicle.id); // 组件/composable 只调 api/*（分层约定）
        if (!result.ok) {
          console.error(`车辆「${vehicle.name}」轨迹加载失败：`, result.error);
          return [vehicle.id, []];
        }
        return [
          vehicle.id,
          result.points.map((point) => ({
            coord: toMapCoord([point.lng, point.lat]), // 业务坐标 4326 → 渲染 3857（map/utils 收敛）
            time: point.time,
            speedKmh: point.speedKmh,
          })),
        ];
      } catch (error) {
        console.error(`车辆「${vehicle.name}」轨迹加载异常：`, error);
        return [vehicle.id, []];
      }
    }),
  );
  fleetTracksByVehicleId.clear();
  trackEntries.forEach(([vehicleId, points]) => {
    fleetTracksByVehicleId.set(vehicleId, points);
  });
  fleetTracksLoaded = true;
  if ([...fleetTracksByVehicleId.values()].some((points) => points.length === 0)) {
    useNotice().notify({ type: 'error', message: '部分车辆轨迹加载失败，请刷新页面重试' });
  }
};

const loadVehicleTrack = async (vehicleId) => {
  try {
    await loadFleetTracks();
    const points = fleetTracksByVehicleId.get(vehicleId) ?? [];
    trackPoints.value = points;
    playheadMs.value = points[0]?.time ?? 0;
    playing.value = false;
    if (points.length === 1) {
      // 设计 §5 L145：轨迹点 <2 禁用回放按钮并提示（空数组 = 加载失败，已在 loadFleetTracks 提示）
      console.error('车辆轨迹点不足 2 个，无法回放：', { vehicleId, pointCount: points.length });
      useNotice().notify({ type: 'warning', message: '该车辆轨迹点不足，无法回放' });
    }
    renderSelectionState();
  } catch (error) {
    trackPoints.value = [];
    console.error('车辆轨迹加载异常：', error);
    useNotice().notify({ type: 'error', message: '车辆轨迹加载失败，请刷新页面重试' });
    renderSelectionState();
  }
};

const loadVehicles = async () => {
  try {
    vehicles.value = await getVehicles();
    vehiclesLoaded = true;
    if (!selectedVehicleId.value && vehicles.value.length > 0) {
      selectedVehicleId.value = vehicles.value[0].id; // 默认选中首车，立即出轨迹/统计
      await loadVehicleTrack(vehicles.value[0].id);
    }
  } catch (error) {
    console.error('车辆数据加载失败：', error);
    useNotice().notify({ type: 'error', message: '车辆数据加载失败，请刷新页面重试' });
  }
};

// ---- 面板操作（handle* 前缀，AGENTS.md 命名规范）----
const handleSelectVehicle = async (vehicleId) => {
  if (vehicleId === selectedVehicleId.value) {
    return;
  }
  selectedVehicleId.value = vehicleId;
  headingByVehicleId.delete(vehicleId); // 新车头累计角重新起算（解缠选最近等价角）
  playing.value = false;
  if (!liveMode.value) {
    await loadVehicleTrack(vehicleId);
    return;
  }
  // 实时模式下切换：marker 淡显由 renderLiveFrame 每帧重读选中态，
  // 尾迹为推送频率重建的静态样式，需在此即时重刷新淡显态
  restyleLiveTrails();
};

const handleTogglePlayback = () => {
  if (!canPlayback.value) {
    return;
  }
  playing.value = !playing.value;
};

const handleSeek = (nextMs) => {
  if (!canPlayback.value || !Number.isFinite(nextMs)) {
    return;
  }
  playheadMs.value = Math.min(trackEndMs.value, Math.max(trackStartMs.value, nextMs));
  if (!playing.value) {
    renderPlaybackFrame();
  }
};

const handlePlaybackSpeedSelect = (speedMultiplier) => {
  if (PLAYBACK_SPEED_OPTIONS.includes(speedMultiplier)) {
    playbackSpeed.value = speedMultiplier;
  }
};

const handleToggleLiveMode = () => {
  if (liveMode.value) {
    // 退出实时：停订阅（返回取消函数——设计 §3.3 L88）、清空本会话 telemetry/尾迹/镜像
    // （防再进入时旧末位置参与插值与尾迹串线，评审 finding 1），回到选中车回放视图
    liveMode.value = false;
    if (typeof unsubscribePositionPush === 'function') {
      unsubscribePositionPush();
      unsubscribePositionPush = null;
    }
    resetLiveState();
    renderSelectionState();
    return;
  }
  // 进入实时：暂停回放、清空可能残留的上一会话状态，再订阅推送
  //（首订阅重新锚定路线时间，mock 端语义；旧状态混入会造成跨会话「飞越」插值）
  playing.value = false;
  resetLiveState();
  liveMode.value = true;
  unsubscribePositionPush = subscribePositions(handleLivePosition);
  renderSelectionState();
};

// ---- 帧循环（常驻 rAF：空闲时仅记账时间戳，回放/实时各自分支渲染）----
const stepVehicleFrame = (wallPerfMs) => {
  vehicleFrameId = requestAnimationFrame(stepVehicleFrame);
  const elapsedMs = lastFrameWallMs === null ? 0 : wallPerfMs - lastFrameWallMs;
  lastFrameWallMs = wallPerfMs;
  if (liveMode.value) {
    renderLiveFrame(wallPerfMs);
    return;
  }
  if (!playing.value || trackPoints.value.length < 2) {
    return;
  }
  const nextPlayheadMs = playheadMs.value + elapsedMs * playbackSpeed.value;
  if (nextPlayheadMs >= trackEndMs.value) {
    playheadMs.value = trackEndMs.value;
    playing.value = false; // 播放到窗口终点自动暂停
    renderPlaybackFrame();
    return;
  }
  playheadMs.value = nextPlayheadMs;
  renderPlaybackFrame();
};

// ---- 地图就绪后接线（仅首次；重复 addLayer 会重复挂载）----
const attachVehiclesToMap = (map) => {
  if (vehiclesAttached) {
    return;
  }
  vehiclesAttached = true;
  map.addLayer(vehiclesLayerInstance);
  vehicleFrameId = requestAnimationFrame(stepVehicleFrame);
  if (!vehiclesLoaded) {
    loadVehicles();
  }
};

// ---- 初始化（App.vue setup 调用；实例构造幂等，watch 每次重接线）----
const initVehicles = () => {
  // HMR/重入：先停旧 watch 再重建（新组件实例的 isMapReady 需重新接线）
  if (typeof stopMapReadyWatch === 'function') {
    stopMapReadyWatch();
  }
  const { mapInstance, isMapReady } = useMap();
  stopMapReadyWatch = watch(
    isMapReady,
    (ready) => {
      if (ready && mapInstance.value) {
        attachVehiclesToMap(mapInstance.value);
      }
    },
    { immediate: true }, // App setup 先于 MapCanvas 挂载，靠后续翻转触发
  );

  if (vehiclesInitialized) {
    return;
  }
  vehiclesInitialized = true;

  // HMR 自愈（照 useAlarms.js:374-386 先例，仅开发期可达）：直接修改本文件触发 Vite HMR
  // 时模块重执行、守卫状态随模块重置为 false，而未变更的 layerManager/地图单例仍保留
  // 上一代 'vehicles-layer' 注册与挂载——先摘旧图层、反注册旧 entry 再全新构造，
  // 否则 register 对重复 id 抛错（layerManager.js:32）令 App setup 崩溃白屏。
  // 旧 rAF 循环/订阅随页面整刷回收；旧 Feature 残留为失活惰性对象，无功能影响。
  const staleLayerEntry = layerManager.getLayerById(VEHICLES_LAYER_ID);
  if (staleLayerEntry) {
    if (mapInstance.value?.getLayers().getArray().includes(staleLayerEntry.layer)) {
      mapInstance.value.removeLayer(staleLayerEntry.layer);
    }
    layerManager.unregister(VEHICLES_LAYER_ID);
  }

  vehiclesSourceInstance = new VectorSource();
  vehiclesLayerInstance = new VectorLayer({ source: vehiclesSourceInstance });
  // 图层经 layerManager 注册，LayerTree 才能统一控制显隐（AGENTS.md 分层约定）
  layerManager.register({
    id: VEHICLES_LAYER_ID,
    name: '车辆轨迹',
    layer: vehiclesLayerInstance,
    visible: true,
  });
};

// useVehicles() 每次返回同一组单例引用与操作函数（与 useNotice/useZones/useAlarms 同构）
export const useVehicles = () => ({
  vehicles,
  selectedVehicleId,
  trackPoints,
  playing,
  playheadMs,
  playbackSpeed,
  liveMode,
  livePositions,
  trackStartMs,
  trackEndMs,
  canPlayback,
  trackStats,
  sliderStepMs: SLIDER_STEP_MS,
  initVehicles,
  handleSelectVehicle,
  handleTogglePlayback,
  handleSeek,
  handlePlaybackSpeedSelect,
  handleToggleLiveMode,
});
