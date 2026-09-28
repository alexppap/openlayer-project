<template>
  <div class="layer-tree">
    <p class="layer-tree__title">图层</p>
    <div v-for="group in groupedLayers" :key="group.label" class="layer-tree__group">
      <p class="layer-tree__group-label">{{ group.label }}</p>
      <label v-for="entry in group.entries" :key="entry.id" class="layer-tree__item">
        <input
          class="layer-tree__checkbox"
          type="checkbox"
          :checked="entry.visible"
          @change="handleToggleVisible(entry.id, $event)"
        />
        <span class="layer-tree__name">{{ entry.name }}</span>
      </label>
    </div>
  </div>
</template>

<script setup>
// 图层树（设计 §4.7 L138）：订阅 layerManager 注册表，渲染为分组列表；
// 勾选切换 layerManager.setVisible（显隐控制唯一出口）。
// 分组依据 constants.LAYER_TREE_GROUPS 静态映射（register 签名无 group 字段）；
// 未登记分组的已注册图层兜底归入「其他」组，不静默隐藏。
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { LAYER_TREE_GROUPS } from '../constants.js';
import * as layerManager from '../map/layerManager.js';

const UNGROUPED_LABEL = '其他';

const layerEntries = ref([]);
let cancelSubscription = null;

const refreshEntries = () => {
  layerEntries.value = layerManager.getLayerEntries();
};

onMounted(() => {
  // 订阅即回调一次拿到初始状态；注册/反注册/显隐变更后续自动刷新
  cancelSubscription = layerManager.subscribeLayerRegistry(refreshEntries);
});

onUnmounted(() => {
  if (cancelSubscription) {
    cancelSubscription();
  }
});

// 分组渲染（模板零复杂逻辑）：已知分组按 LAYER_TREE_GROUPS 顺序，未登记 id 兜底「其他」
const groupedLayers = computed(() => {
  const groupedIds = new Set(LAYER_TREE_GROUPS.flatMap((group) => group.layerIds));
  const knownGroups = LAYER_TREE_GROUPS.map((group) => ({
    label: group.label,
    entries: group.layerIds
      .map((layerId) => layerEntries.value.find((entry) => entry.id === layerId))
      .filter(Boolean),
  }));
  const otherEntries = layerEntries.value.filter((entry) => !groupedIds.has(entry.id));
  const allGroups =
    otherEntries.length > 0 ? [...knownGroups, { label: UNGROUPED_LABEL, entries: otherEntries }] : knownGroups;
  return allGroups.filter((group) => group.entries.length > 0);
});

const handleToggleVisible = (entryId, event) => {
  layerManager.setVisible(entryId, event.target.checked);
};
</script>

<style scoped lang="scss">
@use '../styles/variables' as *;

.layer-tree {
  display: grid;
  gap: 12px;
  align-content: start;
  width: 100%;
}

.layer-tree__title {
  margin: 0;
  color: $text-primary;
  font-size: 14px;
  font-weight: 600;
}

.layer-tree__group {
  display: grid;
  gap: 4px;
}

.layer-tree__group-label {
  margin: 0 0 2px;
  color: $text-secondary;
  font-size: 12px;
}

.layer-tree__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    background: $bg;
  }
}

.layer-tree__checkbox {
  margin: 0;
  accent-color: $zone-production;
}

.layer-tree__name {
  color: $text-primary;
  font-size: 13px;
}
</style>
