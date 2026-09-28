// src/composables/useMap.js — 地图单例 + flyTo 等视图操作（设计 §3.2 L56）。
// AGENTS.md：地图实例全站唯一，组件禁止自行 new Map——唯一创建口在这里（内部走 mapCore）。
// mapCore 保持 vue-free（node 可导入），本文件负责把它接进 Vue 响应式世界并桥接通知条。
import { ref, shallowRef } from 'vue';
import {
  BASEMAP_DEGRADED_MESSAGE,
  FLY_TO_DEFAULT_ZOOM,
  MAP_DEFAULT_VIEW,
  VIEW_ANIMATE_DURATION_MS,
} from '../constants.js';
import { initMapCore, setMapTarget } from '../map/mapCore.js';
import { toMapCoord } from '../map/utils.js';
import { useNotice } from './useNotice.js';

// 模块级单例状态（不引 Pinia，composable 单例内聚）
const mapInstance = shallowRef(null);
const isMapReady = ref(false);

// 底图瓦片连续失败达标回调：console.error + 顶部通知条（AGENTS.md 错误处理约定）
const handleBasemapDegraded = () => {
  console.error('[basemap] OSM 瓦片连续加载失败，底图降级（矢量功能不受影响）');
  useNotice().notify({ type: 'warning', message: BASEMAP_DEGRADED_MESSAGE });
};

export const useMap = () => {
  // 初始化/重挂载（幂等）：已有实例仅重绑 target（HMR/异常重挂载兜底），不创建第二个实例
  const initMap = (target) => {
    try {
      if (mapInstance.value) {
        setMapTarget(target);
        return mapInstance.value;
      }
      mapInstance.value = initMapCore(target, { onBasemapDegraded: handleBasemapDegraded });
      isMapReady.value = true;
      return mapInstance.value;
    } catch (error) {
      console.error('地图初始化失败：', error);
      useNotice().notify({ type: 'error', message: '地图初始化失败，请刷新页面重试' });
      return null;
    }
  };

  // 定位到 [lng, lat]（EPSG:4326，渲染前经 utils 转 3857）；未就绪时安全 no-op
  const flyTo = ({ lng, lat, zoom = FLY_TO_DEFAULT_ZOOM, duration = VIEW_ANIMATE_DURATION_MS }) => {
    if (!mapInstance.value) {
      console.warn('flyTo：地图尚未初始化，忽略本次定位');
      return;
    }
    mapInstance.value.getView().animate({ center: toMapCoord([lng, lat]), zoom, duration });
  };

  // 动画复位到默认视图（MAP_DEFAULT_VIEW 占位中心，厂区任务接入后随常量调整）
  const resetView = () => {
    if (!mapInstance.value) {
      console.warn('resetView：地图尚未初始化，忽略本次复位');
      return;
    }
    mapInstance.value.getView().animate({
      center: toMapCoord(MAP_DEFAULT_VIEW.center),
      zoom: MAP_DEFAULT_VIEW.zoom,
      duration: VIEW_ANIMATE_DURATION_MS,
    });
  };

  return { mapInstance, isMapReady, initMap, flyTo, resetView };
};
