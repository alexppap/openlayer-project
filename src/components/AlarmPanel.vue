<template>
  <div ref="panelRootRef" class="alarm-panel">
    <p class="alarm-panel__title">报警列表</p>
    <p v-if="isEmpty" class="alarm-panel__empty">暂无报警数据</p>
    <template v-else>
      <div v-for="section in sections" :key="section.label" class="alarm-panel__section">
        <p class="alarm-panel__section-label">
          {{ section.label }}（{{ section.rows.length }}）
        </p>
        <ul class="alarm-panel__list">
          <li
            v-for="row in section.rows"
            :key="row.id"
            :data-alarm-id="row.id"
            class="alarm-panel__row"
            :class="[row.levelClass, row.statusClass, row.selectedClass]"
            @click="handleRowClick(row.alarm)"
          >
            <div class="alarm-panel__row-main">
              <span class="alarm-panel__row-level" :style="row.levelStyle">
                {{ row.levelLabel }}
              </span>
              <span class="alarm-panel__row-device">{{ row.deviceName }}</span>
            </div>
            <div class="alarm-panel__row-meta">
              <span class="alarm-panel__row-type">{{ row.type }}</span>
              <span class="alarm-panel__row-time">{{ row.timeText }}</span>
            </div>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<script setup>
// 右侧报警列表（设计 §4.2 L109-110 列表-地图联动）：
//   pending 置顶插入（newest-first）、acked 其后；行点击 → flyTo 定位 + 点位高亮放大脉冲；
//   地图点选 → selectedAlarmId 变化 → 本列表滚动到对应行并高亮。
// 数据一律取自 useAlarms 单例，不直接 import api/mock（AGENTS.md 分层约定）。
import { computed, nextTick, useTemplateRef, watch } from 'vue';
import { useAlarms } from '../composables/useAlarms.js';
import { ALARM_LEVEL_CONFIG } from '../constants.js';

const { alarms, selectedAlarmId, handlePanelRowClick } = useAlarms();

const panelRootRef = useTemplateRef('panelRootRef');

// 行视图模型（模板零复杂逻辑）；时间倒序 = newest-first，pending 实时推送自然置顶插入
const buildRow = (alarm) => ({
  id: alarm.id,
  alarm,
  deviceName: alarm.deviceName,
  type: alarm.type,
  levelLabel: ALARM_LEVEL_CONFIG[alarm.level]?.label ?? alarm.level,
  levelStyle: { color: ALARM_LEVEL_CONFIG[alarm.level]?.color ?? undefined },
  levelClass: `alarm-panel__row--level-${alarm.level}`,
  statusClass: `alarm-panel__row--${alarm.status}`,
  selectedClass:
    alarm.id === selectedAlarmId.value ? 'alarm-panel__row--selected' : undefined,
  timeText: new Date(alarm.time).toLocaleTimeString('zh-CN', { hour12: false }),
});

const pendingRows = computed(() =>
  alarms.value
    .filter((alarm) => alarm.status === 'pending')
    .sort((earlier, later) => later.time - earlier.time)
    .map((alarm) => buildRow(alarm)),
);

const ackedRows = computed(() =>
  alarms.value
    .filter((alarm) => alarm.status === 'acked')
    .sort((earlier, later) => later.time - earlier.time)
    .map((alarm) => buildRow(alarm)),
);

const isEmpty = computed(() => alarms.value.length === 0);

// 分块：pending 置顶，acked 其后（设计 §4.2 L110「列表置顶插入」）
const sections = computed(() => [
  { label: '未处理', rows: pendingRows.value },
  { label: '已处理', rows: ackedRows.value },
].filter((section) => section.rows.length > 0));

// 地图点选联动：selectedAlarmId 变化 → 滚动到对应行并高亮（高亮类随 selectedClass 响应）
watch(selectedAlarmId, (alarmId) => {
  if (!alarmId) {
    return;
  }
  nextTick(() => {
    panelRootRef.value
      ?.querySelector(`[data-alarm-id="${alarmId}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
});

const handleRowClick = (alarm) => {
  handlePanelRowClick(alarm);
};
</script>

<style scoped lang="scss">
@use '../styles/variables' as *;

.alarm-panel {
  display: grid;
  gap: 8px;
  align-content: start;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  @include thin-scrollbar;
}

.alarm-panel__title {
  margin: 0;
  color: $text-primary;
  font-size: 14px;
  font-weight: 600;
}

.alarm-panel__empty {
  margin: 0;
  color: $text-secondary;
  font-size: 13px;
}

.alarm-panel__section {
  display: grid;
  gap: 4px;
}

.alarm-panel__section-label {
  margin: 0;
  color: $text-secondary;
  font-size: 12px;
}

.alarm-panel__list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.alarm-panel__row {
  display: grid;
  gap: 2px;
  padding: 6px 8px;
  border: 1px solid $border-color;
  border-left-width: 3px;
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    background: $bg;
  }
}

// 等级色左缘条（critical 红 / major 橙 / minor 黄——与 ALARM_LEVEL_CONFIG 同源）
.alarm-panel__row--level-critical {
  border-left-color: $alarm-critical;
}

.alarm-panel__row--level-major {
  border-left-color: $alarm-major;
}

.alarm-panel__row--level-minor {
  border-left-color: $alarm-minor;
}

// 已处理行淡显，视觉重心留给 pending
.alarm-panel__row--acked {
  opacity: 0.55;
}

// 地图点选/行点击选中高亮
.alarm-panel__row--selected {
  background: rgb(24 144 255 / 10%);
  border-color: $zone-production;
  border-left-color: $zone-production;
}

.alarm-panel__row-main {
  display: flex;
  align-items: center;
  gap: 6px;
}

.alarm-panel__row-level {
  flex: none;
  font-size: 12px;
  font-weight: 600;
}

.alarm-panel__row-device {
  overflow: hidden;
  color: $text-primary;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.alarm-panel__row-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: $text-secondary;
  font-size: 12px;
}

.alarm-panel__row-type {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.alarm-panel__row-time {
  flex: none;
}
</style>
