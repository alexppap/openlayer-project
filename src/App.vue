<template>
  <div class="monitor-shell">
    <header class="monitor-toolbar">
      <span class="monitor-title">{{ APP_TITLE }}</span>
      <ToolBar :mode="mode" @change-mode="handleModeChange" />
    </header>
    <div class="monitor-body">
      <aside class="monitor-sidebar-left">
        <div class="monitor-panel monitor-panel--layer-tree">
          <LayerTree />
        </div>
      </aside>
      <main class="monitor-map">
        <MapCanvas>
          <ZoneFormPopup />
          <AlarmPopup />
        </MapCanvas>
      </main>
      <aside class="monitor-sidebar-right">
        <section class="monitor-panel monitor-panel-alarms">
          <AlarmPanel />
        </section>
        <section class="monitor-panel monitor-panel-vehicles">
          <VehiclePanel />
        </section>
      </aside>
    </div>
    <div v-if="noticeItems.length > 0" class="monitor-notices">
      <div
        v-for="notice in noticeItems"
        :key="notice.id"
        class="monitor-notice"
        :class="notice.typeClass"
        role="status"
      >
        <span class="monitor-notice__message">{{ notice.message }}</span>
        <button
          type="button"
          class="monitor-notice__close"
          aria-label="关闭通知"
          @click="handleDismissNotice(notice.id)"
        >
          ×
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
// 全局交互互斥（设计 §3.4）：App 持唯一 mode，ToolBar 切换上报、useZones 读取驱动
// Draw/Modify/Translate 启停（同一时刻仅一个交互激活，切换自动停用上一个）。
import { computed, ref } from 'vue';
import AlarmPanel from './components/AlarmPanel.vue';
import AlarmPopup from './components/AlarmPopup.vue';
import LayerTree from './components/LayerTree.vue';
import MapCanvas from './components/MapCanvas.vue';
import ToolBar from './components/ToolBar.vue';
import VehiclePanel from './components/VehiclePanel.vue';
import ZoneFormPopup from './components/ZoneFormPopup.vue';
import { useAlarms } from './composables/useAlarms.js';
import { useNotice } from './composables/useNotice.js';
import { useVehicles } from './composables/useVehicles.js';
import { useZones } from './composables/useZones.js';
import { APP_TITLE, MAP_MODES } from './constants.js';

const mode = ref(MAP_MODES[0]);

// 厂区图层初始化（source/layer/交互/Overlay 构造 + layerManager 注册 + mode watch）
useZones().initZones({ mode });

// 车辆图层初始化（在厂区之上：轨迹/车头渲染压厂区区域，设计 §4.3）
useVehicles().initVehicles();

// 报警图层初始化（在车辆之后：报警点位压车辆轨迹之上，设计 §4.2）
useAlarms().initAlarms();

const handleModeChange = (nextMode) => {
  mode.value = nextMode;
};

const { notices, dismissNotice } = useNotice();

// 模板零复杂表达式：类型配色类名等视图逻辑收敛在计算属性
const noticeItems = computed(() =>
  notices.value.map((notice) => ({
    id: notice.id,
    message: notice.message,
    typeClass: `monitor-notice--${notice.type}`,
  })),
);

const handleDismissNotice = (id) => {
  dismissNotice(id);
};
</script>

<style scoped lang="scss">
@use './styles/variables' as *;

.monitor-shell {
  position: relative; // 顶部悬浮通知条的定位参照
  display: grid;
  grid-template-rows: $toolbar-height 1fr;
  height: 100%;
  overflow: hidden;
}

.monitor-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  background: $panel-bg;
  border-bottom: 1px solid $border-color;
}

.monitor-title {
  font-size: 16px;
  font-weight: 600;
  color: $text-primary;
}

.monitor-body {
  display: grid;
  grid-template-columns: $sidebar-left-width 1fr $sidebar-right-width;
  gap: 8px;
  min-height: 0;
  padding: 8px;
  overflow: hidden;
}

.monitor-sidebar-left,
.monitor-sidebar-right {
  display: grid;
  min-height: 0;
  overflow: hidden;
}

.monitor-sidebar-right {
  grid-template-rows: 1fr 1fr;
  gap: 8px;
}

.monitor-panel {
  @include panel;

  display: grid;
  place-items: center;
  min-height: 0;
  padding: 8px;
  color: $text-secondary;
  overflow: auto;
  @include thin-scrollbar;
}

// 图层树面板：内容顶格铺开（覆盖 .monitor-panel 的居中摆位）
.monitor-panel--layer-tree {
  place-items: stretch;
  justify-items: start;
}

// 报警列表面板：内容顶格铺开（列表自带滚动容器，覆盖 .monitor-panel 的居中摆位）
.monitor-panel-alarms {
  place-items: stretch;
  justify-items: stretch;
}

// 车辆面板：内容顶格铺开（面板自带滚动容器，覆盖 .monitor-panel 的居中摆位）
.monitor-panel-vehicles {
  place-items: stretch;
  justify-items: stretch;
}

.monitor-map {
  @include panel;

  min-height: 0;
  overflow: hidden; // 地图铺满面板并裁出圆角
}

// ---- App 级顶部通知条（useNotice）----
.monitor-notices {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: $notice-z-index;
  display: grid;
  gap: 8px;
  justify-items: center;
  pointer-events: none; // 容器不拦截地图交互，单条通知自身恢复事件响应
}

.monitor-notice {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: min(480px, 80vw);
  padding: 8px 12px;
  border-radius: 4px;
  color: #ffffff;
  box-shadow: 0 2px 8px rgb(0 0 0 / 15%);
  pointer-events: auto;
}

.monitor-notice--info {
  background: $notice-info;
}

.monitor-notice--success {
  background: $notice-success;
}

.monitor-notice--warning {
  background: $notice-warning;
}

.monitor-notice--error {
  background: $notice-error;
}

.monitor-notice__message {
  line-height: 20px;
}

.monitor-notice__close {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgb(255 255 255 / 25%);
  color: #ffffff;
  font-size: 14px;
  line-height: 20px;
  text-align: center;
  cursor: pointer;

  &:hover {
    background: rgb(255 255 255 / 40%);
  }
}
</style>
