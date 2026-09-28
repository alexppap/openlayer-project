<template>
  <div class="toolbar">
    <div class="toolbar__group">
      <button
        v-for="button in toolButtons"
        :key="button.mode"
        type="button"
        class="toolbar__button"
        :class="{ 'toolbar__button--active': button.active }"
        @click="handleToolClick(button.mode)"
      >
        {{ button.label }}
      </button>
    </div>
    <span class="toolbar__divider" />
    <button type="button" class="toolbar__button" @click="handleExportClick">导出 GeoJSON</button>
  </div>
</template>

<script setup>
// 工具栏（设计 §3.1 L34 / §4.1）：漫游/绘制厂区/编辑厂区按钮 + 导出 GeoJSON。
// mode 由 App.vue 维护并经 props 下发（设计 §3.4 交互互斥），切换经 change-mode 事件上报；
// 导出走 useZones 单例的 exportZones（浏览器下载，4326 GeoJSON）。
import { computed } from 'vue';
import { useZones } from '../composables/useZones.js';

const props = defineProps({
  mode: { type: String, required: true },
});

const emit = defineEmits(['change-mode']);

// 本任务只接 pan/drawZone/editZone 三态；测量按钮由测量任务接入
const TOOL_BUTTONS = [
  { mode: 'pan', label: '漫游' },
  { mode: 'drawZone', label: '绘制厂区' },
  { mode: 'editZone', label: '编辑厂区' },
];

const toolButtons = computed(() =>
  TOOL_BUTTONS.map((button) => ({ ...button, active: props.mode === button.mode })),
);

const handleToolClick = (nextMode) => {
  // 再次点击已激活的非漫游工具 → 回落漫游（同一时刻仅一个交互激活，设计 §3.4）
  const resolvedMode = props.mode === nextMode && nextMode !== 'pan' ? 'pan' : nextMode;
  emit('change-mode', resolvedMode);
};

const handleExportClick = () => {
  useZones().exportZones();
};
</script>

<style scoped lang="scss">
@use '../styles/variables' as *;

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.toolbar__group {
  display: flex;
  gap: 8px;
}

.toolbar__divider {
  width: 1px;
  height: 20px;
  background: $border-color;
}

.toolbar__button {
  padding: 4px 14px;
  border: 1px solid $border-color;
  border-radius: 4px;
  background: $panel-bg;
  color: $text-primary;
  font-size: 13px;
  cursor: pointer;

  &:hover {
    border-color: $zone-production;
    color: $zone-production;
  }
}

.toolbar__button--active {
  border-color: $zone-production;
  background: rgb(24 144 255 / 12%);
  color: $zone-production;
  font-weight: 600;
}
</style>
