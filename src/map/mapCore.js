// src/map/mapCore.js — Map/View/OSM 底图初始化，全站唯一实例（设计 §3.2 L52、§2 L21）。
//
// ⚠ 本文件必须保持 vue-free（禁止 import vue / composables）：mapCore.verify.js 在纯 node
//   （无 vite/vue 运行时）下直接 import 本模块断言 createTileErrorTracker 状态机；因此——
//   1) Map/View/图层对象一律在 initMapCore 内惰性构造，模块顶层只留纯函数与 null 占位；
//   2) 底图降级提示不直连 useNotice，经 initMapCore({ onBasemapDegraded }) 回调注入，
//      由 composables/useMap.js 桥接到通知条。
// ol import 统一带 .js 后缀：extensionless 写法在 plain node 报 ERR_UNSUPPORTED_DIR_IMPORT。
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import OSM from 'ol/source/OSM.js';
import { BASEMAP_LAYER_ID, BASEMAP_TILE_ERROR_THRESHOLD, MAP_DEFAULT_VIEW } from '../constants.js';
import { register } from './layerManager.js';
import { toMapCoord } from './utils.js';

// 全站唯一 Map 实例；mapCore 自身不导出「创建第二个实例」的任何路径
let mapInstance = null;

// 底图瓦片错误计数状态机（纯工厂，设计 §5 L144「连续失败 ≥5 次」的实施口径）：
//   tracker(eventType) 接收 ol 事件类型 'tileloaderror' | 'tileloadend'；
//   「连续失败 ≥ threshold」本轮首次达成时返回 true，同一轮后续失败不再返回 true；
//   任一 'tileloadend' 复位计数并重新武装，新一轮连续失败达到 threshold 可再次返回 true。
//   返回 true 后如何提示属接线逻辑（见 initMapCore 的 onBasemapDegraded 注入）。
export const createTileErrorTracker = ({ threshold }) => {
  let consecutiveErrorCount = 0;
  let firedThisRound = false;
  return (eventType) => {
    if (eventType === 'tileloadend') {
      consecutiveErrorCount = 0;
      firedThisRound = false;
      return false;
    }
    consecutiveErrorCount += 1;
    if (consecutiveErrorCount >= threshold && !firedThisRound) {
      firedThisRound = true;
      return true;
    }
    return false;
  };
};

// 创建全站唯一地图实例（幂等由 useMap 保证；直接二次调用属编程错误，显式抛错暴露）：
//   target：地图容器 DOM 元素；onBasemapDegraded：瓦片连续失败达标时的一次性回调（可省）。
export const initMapCore = (target, { onBasemapDegraded } = {}) => {
  if (mapInstance) {
    throw new Error('地图实例已初始化（全站唯一，禁止重复创建；重挂载请用 setMapTarget）');
  }

  const basemapLayer = new TileLayer({
    source: new OSM({ crossOrigin: 'anonymous' }),
  });
  register({ id: BASEMAP_LAYER_ID, name: 'OSM 底图', layer: basemapLayer, visible: true });

  // 底图降级监听：矢量功能数据独立于底图瓦片，降级提示不影响任何矢量图层交互（设计 §5 L144）
  const basemapSource = basemapLayer.getSource();
  const tileErrorTracker = createTileErrorTracker({ threshold: BASEMAP_TILE_ERROR_THRESHOLD });
  basemapSource.on('tileloaderror', () => {
    if (tileErrorTracker('tileloaderror') && typeof onBasemapDegraded === 'function') {
      onBasemapDegraded();
    }
  });
  basemapSource.on('tileloadend', () => {
    tileErrorTracker('tileloadend');
  });

  mapInstance = new Map({
    target,
    layers: [basemapLayer],
    view: new View({
      center: toMapCoord(MAP_DEFAULT_VIEW.center),
      zoom: MAP_DEFAULT_VIEW.zoom,
      minZoom: 3,
      maxZoom: 19, // OSM 源默认上限（node_modules/ol/source/OSM.js:29）
    }),
  });
  return mapInstance;
};

// 取全站唯一实例；未初始化时为 null（调用方自行判空，不在此抛错）
export const getMapInstance = () => mapInstance;

// 重绑/解绑渲染 target（MapCanvas 卸载时传 null 释放 DOM 引用；实例与图层保留）
export const setMapTarget = (target) => {
  if (!mapInstance) {
    return;
  }
  mapInstance.setTarget(target);
};
