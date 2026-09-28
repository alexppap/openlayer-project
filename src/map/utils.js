// src/map/utils.js — 坐标转换收敛点（AGENTS.md：坐标转换统一走 map/utils.js）
// 约定（设计 §2 L27）：业务数据与 GeoJSON 一律存 EPSG:4326，地图渲染前转 EPSG:3857。
// 全站除本文件外禁止直接 import ol/proj 的 fromLonLat/toLonLat；
// GeoJSON 读写也收敛在本文件（featuresFromGeoJson / geoJsonFromFeatures 为全站唯一口）。
// ol import 统一带 .js 后缀：extensionless 写法在 plain node 报 ERR_UNSUPPORTED_DIR_IMPORT，
// 带 .js 后缀 vite/node 双兼容（本文件被 utils.verify.js 在纯 node 下导入）。
import { fromLonLat, toLonLat } from 'ol/proj.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import Icon from 'ol/style/Icon.js';
import { Fill, Stroke, Style, Text } from 'ol/style.js';
import {
  DEVICE_TYPE_CONFIG,
  ZONE_FALLBACK_COLOR,
  ZONE_FILL_OPACITY,
  ZONE_LABEL_FONT,
  ZONE_STROKE_WIDTH,
  ZONE_TYPE_CONFIG,
} from '../constants.js';

// 单点：EPSG:4326 [lng, lat] → EPSG:3857 [x, y]
export const toMapCoord = (lngLat) => fromLonLat(lngLat);

// 单点：EPSG:3857 [x, y] → EPSG:4326 [lng, lat]
export const toDataCoord = (xy) => toLonLat(xy);

// 批量：线/面坐标数组 4326 → 3857，返回新数组（不改入参，AGENTS.md 函数式约定）
export const toMapCoords = (lngLatPoints) => lngLatPoints.map((point) => toMapCoord(point));

// 批量：线/面坐标数组 3857 → 4326，返回新数组（不改入参）
export const toDataCoords = (xyPoints) => xyPoints.map((point) => toDataCoord(point));

// '#RRGGBB' + alpha → ol 颜色数组 [r, g, b, a]；仅支持六位十六进制，非法输入抛 Error
export const withAlpha = (hex, alpha) => {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`非法颜色值「${hex}」：仅支持 #RRGGBB 六位十六进制`);
  }
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
    alpha,
  ];
};

// GeoJSON 格式实例（全站唯一）：dataProjection 固定 4326（业务/持久化坐标系），
// featureProjection 固定 3857（地图渲染坐标系）——所有 GeoJSON 出入都经此实例。
const zoneGeoJsonFormat = new GeoJSON({
  dataProjection: 'EPSG:4326',
  featureProjection: 'EPSG:3857',
});

// GeoJSON(EPSG:4326) → ol Feature(EPSG:3857) 数组，properties 原样保留
export const featuresFromGeoJson = (geojson) => zoneGeoJsonFormat.readFeatures(geojson);

// ol Feature(EPSG:3857) 数组 → GeoJSON(EPSG:4326) 对象（FeatureCollection）
export const geoJsonFromFeatures = (features) => zoneGeoJsonFormat.writeFeaturesObject(features);

// 区域样式工厂（设计 §4.1 L98）：按 properties.type 取 ZONE_TYPE_CONFIG 配置色，
// 半透明填充（alpha=ZONE_FILL_OPACITY）+ 配置色原值描边（宽 ZONE_STROKE_WIDTH）
// + 区域名称 Text 标注（ol 对 Polygon 的 Text 默认锚在 interior point，即多边形内部）；
// 未知/缺类型回退中性灰不抛。feature 为 ol.Feature。
export const createZoneStyle = (feature) => {
  const properties = feature.getProperties();
  const typeConfig = ZONE_TYPE_CONFIG[properties.type];
  const color = typeConfig ? typeConfig.color : ZONE_FALLBACK_COLOR;
  const name = typeof properties.name === 'string' ? properties.name : '';
  return new Style({
    fill: new Fill({ color: withAlpha(color, ZONE_FILL_OPACITY) }),
    stroke: new Stroke({ color, width: ZONE_STROKE_WIDTH }),
    text: name
      ? new Text({
          text: name,
          font: ZONE_LABEL_FONT,
          fill: new Fill({ color: '#1f2329' }),
          stroke: new Stroke({ color: '#ffffff', width: 3 }), // 白描边保证名称在任意底色上可读
        })
      : undefined,
  });
};

// 坐标合法性谓词（设计 §5 L145：报警/设备坐标 NaN/越界静默过滤的统一判定口）：
// 入参 [lng, lat]，两轴均为有限数且 lng ∈ [-180,180]、lat ∈ [-90,90]（含端点）→ true；
// NaN/±Infinity/越界/缺轴一律 false。★永不抛错——供消费侧 filter 直接安全调用。
export const isValidLngLat = (lngLat) => {
  if (!Array.isArray(lngLat) || lngLat.length < 2) {
    return false;
  }
  const [lng, lat] = lngLat;
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
};

// 徽标数字长度自适应的纯尺寸函数（设计 §4.2 L107 canvas 徽标「数字长度自适应」
// 的可测数学部分；canvas 绘制本身留浏览器人工验收）。位数越多宽度越大（严格递增），
// 高度/字号恒定；非法输入按 0 处理（纯函数不抛错）。
export const resolveBadgeMetrics = (count) => {
  const digitCount = String(Math.trunc(Math.abs(Number(count)) || 0)).length;
  return {
    width: 14 + digitCount * 7,
    height: 16,
    fontSize: 11,
  };
};

// ---- canvas 图标生成（设计 §4.2 L107；仅调用时触碰 document——本文件被
//      utils.verify.js 在纯 node 下导入，模块顶层不得访问 DOM）----
// 按 cacheKey 缓存 Icon 实例：样式函数每帧重算，同一 (形状,颜色,数字,状态) 复用，
// 避免每帧新建 canvas。以 2x 作画再按逻辑尺寸交给 ol，高分屏不糊。
const markerIconCache = new Map();

const createCachedCanvasIcon = (cacheKey, width, height, drawIcon, iconOptions = {}) => {
  if (markerIconCache.has(cacheKey)) {
    return markerIconCache.get(cacheKey);
  }
  const drawScale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * drawScale;
  canvas.height = height * drawScale;
  const context = canvas.getContext('2d');
  context.scale(drawScale, drawScale);
  drawIcon(context, width, height);
  // ★ol Icon 断言禁止 width/height 与 scale 共存（ol/style/Icon.js「cannot be
  //   provided together with `scale`」）——iconOptions 里的放大倍数（选中态放大）
  //   必须折算进 width/height 再传给 ol，否则 Icon 构造函数抛错。该异常发生在
  //   图层样式函数内、渲染帧中段，会把整帧渲染中断（composite 未执行
  //   replaceChildren），表现为进入页面地图空白、交互触发新帧后才显示。
  //   anchor（像素单位）的坐标系是画布自然尺寸（drawScale 倍），需同步换算；
  //   选中放大倍数已并入内部 scale（视觉偏移 = anchor × scale），锚点只乘
  //   drawScale 即可在放大时按比例保持徽标相对点位的视觉位置。
  const { scale = 1, anchor, ...restIconOptions } = iconOptions;
  const icon = new Icon({
    src: canvas.toDataURL('image/png'),
    width: width * scale,
    height: height * scale,
    ...(Array.isArray(anchor) ? { anchor: anchor.map((axis) => axis * drawScale) } : {}),
    ...restIconOptions,
  });
  markerIconCache.set(cacheKey, icon);
  return icon;
};

// 手绘圆角矩形路径（兼容无 ctx.roundRect 的环境），不 fill/stroke 交调用方定色
const traceRoundedRect = (context, left, top, width, height, radius) => {
  context.beginPath();
  context.moveTo(left + radius, top);
  context.lineTo(left + width - radius, top);
  context.arcTo(left + width, top, left + width, top + radius, radius);
  context.lineTo(left + width, top + height - radius);
  context.arcTo(left + width, top + height, left + width - radius, top + height, radius);
  context.lineTo(left + radius, top + height);
  context.arcTo(left, top + height, left, top + height - radius, radius);
  context.lineTo(left, top + radius);
  context.arcTo(left, top, left + radius, top, radius);
  context.closePath();
};

// 报警条数徽标图标：等级色圆角胶囊 + 白字数字（数字长度自适应，§4.2 L107）。
//   variant 'cluster'：聚合圆右上角徽标（锚点向右上偏移，盖在聚合圆边缘）；
//   variant 'point'：单点设备图标右上角的小徽标（偏移略小）。
//   selected：选中态整体放大（列表面板/地图点选联动的高亮放大样式）。
export const createAlarmMarkerIcon = ({ color, count, variant = 'cluster', selected = false }) => {
  const metrics = resolveBadgeMetrics(count);
  const badgeOffset = variant === 'point' ? 13 : 15;
  // 锚点（像素，自图像左上）：使徽标中心落在点位右上 offset 处
  const anchor = [metrics.width / 2 - badgeOffset, metrics.height / 2 + badgeOffset];
  return createCachedCanvasIcon(
    `alarm-badge:${variant}:${color}:${count}:${selected}`,
    metrics.width,
    metrics.height,
    (context, width, height) => {
      traceRoundedRect(context, 0.75, 0.75, width - 1.5, height - 1.5, (height - 1.5) / 2);
      context.fillStyle = color;
      context.fill();
      context.lineWidth = 1.5;
      context.strokeStyle = '#ffffff';
      context.stroke();
      context.fillStyle = '#ffffff';
      context.font = `bold ${metrics.fontSize}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(String(count), width / 2, height / 2 + 0.5);
    },
    {
      anchor,
      anchorXUnits: 'pixels',
      anchorYUnits: 'pixels',
      scale: selected ? 1.2 : 1,
    },
  );
};

// 设备点位图标：白底圆 + 蓝描边，内部按 deviceType 画摄像头（机身+镜头）/
// 环境传感器（同心弧+触点）两类可区分图形（设计 §4.4 L122 两类图标）。
export const createDeviceMarkerIcon = ({ deviceType = Object.keys(DEVICE_TYPE_CONFIG)[0], selected = false }) => {
  const size = 34;
  const half = size / 2;
  return createCachedCanvasIcon(
    `device-marker:${deviceType}:${selected}`,
    size,
    size,
    (context) => {
      context.beginPath();
      context.arc(half, half, 14, 0, Math.PI * 2);
      context.fillStyle = '#ffffff';
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = '#1890ff';
      context.stroke();
      context.fillStyle = '#1890ff';
      context.strokeStyle = '#1890ff';
      if (deviceType === 'camera') {
        // 摄像头：机身矩形 + 右侧镜头圆 + 支架
        context.fillRect(half - 8, half - 4, 9, 7);
        context.beginPath();
        context.arc(half + 5, half - 1, 3.5, 0, Math.PI * 2);
        context.stroke();
        context.beginPath();
        context.moveTo(half - 5, half + 3);
        context.lineTo(half - 5, half + 7);
        context.stroke();
      } else {
        // 环境传感器：同心信号弧 + 中心触点
        context.beginPath();
        context.arc(half, half + 4, 2.2, 0, Math.PI * 2);
        context.fill();
        [4.5, 8].forEach((radius) => {
          context.beginPath();
          context.arc(half, half + 4, radius, Math.PI * 1.2, Math.PI * 1.8);
          context.stroke();
        });
      }
    },
    { scale: selected ? 1.35 : 1 },
  );
};

// ---- 车辆车头图标（设计 §4.3 L116：车头图标按行进方向旋转）----
// ★与上面徽标/设备图标不同：这里只缓存 dataURL（src），Icon 实例由调用方
//   （useVehicles 样式逻辑）按车各自 new——rotation/opacity 是 ol Icon 实例状态，
//   多 feature 共享同一 Icon 实例会互相覆盖旋转角；ol 内部按 src 共享解码图，
//   多实例引用同一 dataURL 不会重复解码。
// canvas 本体朝正北绘制（圆形底盘 + 车色三角箭头指北），行进方向由 ol Icon 的
// rotation（弧度，自北顺时针——与 mock 端 resolveCorrectedHeading / 渲染端
// resolveSegmentHeading 的朝向口径一致）表达；dim 为多车淡显态（灰底盘 + 降饱和箭头）。
const vehicleMarkerSrcCache = new Map();

export const createVehicleMarkerSrc = ({ color, dim = false }) => {
  const cacheKey = `vehicle-marker:${color}:${dim}`;
  if (vehicleMarkerSrcCache.has(cacheKey)) {
    return vehicleMarkerSrcCache.get(cacheKey);
  }
  const size = 36;
  const half = size / 2;
  const drawScale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = size * drawScale;
  canvas.height = size * drawScale;
  const context = canvas.getContext('2d');
  context.scale(drawScale, drawScale);

  // 圆形底盘：白底 + 车色描边（dim 态灰描边、底色半透明）
  context.beginPath();
  context.arc(half, half, 15, 0, Math.PI * 2);
  context.fillStyle = dim ? 'rgba(255, 255, 255, 0.6)' : '#ffffff';
  context.fill();
  context.lineWidth = 2.5;
  context.strokeStyle = dim ? '#b9bec7' : color;
  context.stroke();

  // 车色三角箭头：顶点朝正北（图像上方），底边在南侧
  context.beginPath();
  context.moveTo(half, half - 9);
  context.lineTo(half + 6.5, half + 7);
  context.lineTo(half, half + 3.5);
  context.lineTo(half - 6.5, half + 7);
  context.closePath();
  context.fillStyle = dim ? '#b9bec7' : color;
  context.fill();

  const markerSrc = canvas.toDataURL('image/png');
  vehicleMarkerSrcCache.set(cacheKey, markerSrc);
  return markerSrc;
};

