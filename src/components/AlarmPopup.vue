<template>
  <!-- 根节点整体作为 OL Overlay 元素（由 useAlarms 的 Overlay 接管定位与显隐），
       弹窗本体只在有选中的报警分组（activeAlarmGroup 非 null）时渲染。 -->
  <div ref="popupRootRef" class="alarm-popup">
    <div v-if="popupGroup" class="alarm-popup__card">
      <div class="alarm-popup__header">
        <p class="alarm-popup__title">{{ popupGroup.deviceName }}</p>
        <span class="alarm-popup__pending-count">{{ pendingCountText }}</span>
        <button
          type="button"
          class="alarm-popup__close"
          aria-label="关闭报警详情"
          @click="handleClose"
        >
          ×
        </button>
      </div>
      <ul class="alarm-popup__records">
        <li
          v-for="record in recordRows"
          :key="record.id"
          class="alarm-popup__record"
          :class="record.statusClass"
        >
          <div class="alarm-popup__record-main">
            <span class="alarm-popup__record-type">{{ record.type }}</span>
            <span class="alarm-popup__record-level" :style="record.levelStyle">
              {{ record.levelLabel }}
            </span>
          </div>
          <div class="alarm-popup__record-meta">
            <span class="alarm-popup__record-time">{{ record.timeText }}</span>
            <span class="alarm-popup__record-status">{{ record.statusLabel }}</span>
          </div>
          <button
            v-if="record.isPending"
            type="button"
            class="alarm-popup__ack-button"
            :disabled="record.isAcking"
            @click="handleAck(record.id)"
          >
            {{ record.isAcking ? '处理中…' : '标记处理' }}
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup>
// 报警详情弹窗（设计 §4.2 L108）：点击非聚合单点后贴图展示该位置报警明细列表，
// 每条 pending 记录可「标记处理」→ ackAlarm → 徽标与右侧列表同步更新。
// AGENTS.md：贴图弹窗用 OL Overlay 挂载 Vue 组件，不用任何 UI 库 Dialog——
// 根 DOM 经 registerAlarmPopupElement 注册给 useAlarms 的 Overlay，本组件不持有 Overlay 实例；
// 数据一律取自 useAlarms 单例，不直接 import api/mock（AGENTS.md 分层约定）。
import { computed, onMounted, ref, useTemplateRef } from 'vue';
import { useAlarms } from '../composables/useAlarms.js';
import { ALARM_LEVEL_CONFIG, ALARM_STATUS } from '../constants.js';

const { activeAlarmGroup, registerAlarmPopupElement, handleAlarmPopupClose, handleAckAlarm } =
  useAlarms();

const popupRootRef = useTemplateRef('popupRootRef');
// 「标记处理」进行中的记录 id（按钮防重复点击）
const ackingAlarmId = ref(null);

onMounted(() => {
  registerAlarmPopupElement(popupRootRef.value);
});

const popupGroup = computed(() => activeAlarmGroup.value);

// 头部 pending 条数（条数口径：pending 记录数，acked 不计）
const pendingCountText = computed(() => {
  const pendingCount = popupGroup.value?.pendingCount ?? 0;
  return `未处理 ${pendingCount} 条`;
});

// 明细行视图模型（模板零复杂逻辑；组内已按时间倒序——buildDeviceAlarmGroups 契约）
const recordRows = computed(() =>
  (popupGroup.value?.records ?? []).map((record) => ({
    id: record.id,
    type: record.type,
    levelLabel: ALARM_LEVEL_CONFIG[record.level]?.label ?? record.level,
    levelStyle: { color: ALARM_LEVEL_CONFIG[record.level]?.color ?? undefined },
    timeText: new Date(record.time).toLocaleTimeString('zh-CN', { hour12: false }),
    statusLabel: ALARM_STATUS[record.status] ?? record.status,
    statusClass: `alarm-popup__record--${record.status}`,
    isPending: record.status === 'pending',
    isAcking: ackingAlarmId.value === record.id,
  })),
);

const handleClose = () => {
  handleAlarmPopupClose();
};

const handleAck = async (alarmId) => {
  ackingAlarmId.value = alarmId;
  try {
    await handleAckAlarm(alarmId);
  } finally {
    ackingAlarmId.value = null;
  }
};
</script>

<style scoped lang="scss">
@use '../styles/variables' as *;

.alarm-popup {
  // 尺寸/显隐由 ol Overlay 定位机制控制；这里只管卡片外观
  min-width: 260px;
}

.alarm-popup__card {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  background: $panel-bg;
  border: 1px solid $border-color;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgb(0 0 0 / 18%);
}

.alarm-popup__header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.alarm-popup__title {
  flex: 1;
  margin: 0;
  color: $text-primary;
  font-size: 14px;
  font-weight: 600;
}

.alarm-popup__pending-count {
  flex: none;
  color: $alarm-critical;
  font-size: 12px;
}

.alarm-popup__close {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: $bg;
  color: $text-secondary;
  font-size: 14px;
  line-height: 20px;
  text-align: center;
  cursor: pointer;

  &:hover {
    background: $border-color;
    color: $text-primary;
  }
}

.alarm-popup__records {
  display: grid;
  gap: 6px;
  max-height: 240px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  @include thin-scrollbar;
}

.alarm-popup__record {
  display: grid;
  gap: 2px;
  padding: 6px 8px;
  border: 1px solid $border-color;
  border-radius: 4px;
}

.alarm-popup__record--acked {
  opacity: 0.55; // 已处理记录淡显，视觉重心留给 pending
}

.alarm-popup__record-main {
  display: flex;
  align-items: center;
  gap: 8px;
}

.alarm-popup__record-type {
  color: $text-primary;
  font-size: 13px;
}

.alarm-popup__record-level {
  font-size: 12px;
  font-weight: 600;
}

.alarm-popup__record-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: $text-secondary;
  font-size: 12px;
}

.alarm-popup__record-status {
  flex: none;
}

.alarm-popup__ack-button {
  justify-self: end;
  padding: 2px 10px;
  border: 1px solid $zone-production;
  border-radius: 4px;
  background: $zone-production;
  color: #ffffff;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    border-color: #40a9ff;
    background: #40a9ff;
  }

  &:disabled {
    border-color: $border-color;
    background: $border-color;
    color: $text-secondary;
    cursor: not-allowed;
  }
}
</style>
