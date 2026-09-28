<template>
  <div ref="mapTargetRef" class="map-canvas">
    <slot />
  </div>
</template>

<script setup>
// 地图容器 + Overlay 挂载点（设计 §3.2 L64）：slot 供后续 AlarmPopup/DevicePopup 等
// OL Overlay 渲染的元素挂载；地图实例由 useMap 单例创建，组件自身不 new Map（AGENTS.md）。
import { onMounted, onUnmounted, useTemplateRef } from 'vue';
import 'ol/ol.css'; // Overlay 定位等 ol 基础样式必需
import { useMap } from '../composables/useMap.js';
import { setMapTarget } from '../map/mapCore.js';

const mapTargetRef = useTemplateRef('mapTargetRef');

const { initMap } = useMap();

onMounted(() => {
  initMap(mapTargetRef.value);
});

// App 生命周期内地图实例不销毁：卸载仅解绑 target（释放 DOM 引用），
// 重挂载靠 initMap 幂等重绑 target（HMR/异常兜底），实例与图层注册表原样保留。
onUnmounted(() => {
  setMapTarget(null);
});
</script>

<style scoped lang="scss">
.map-canvas {
  position: relative; // OL Overlay 以容器为定位参照
  width: 100%;
  height: 100%;
}
</style>
