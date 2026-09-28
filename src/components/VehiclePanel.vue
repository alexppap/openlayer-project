<template>
  <div class="vehicle-panel">
    <p class="vehicle-panel__title">车辆监控</p>
    <p v-if="isEmpty" class="vehicle-panel__empty">暂无车辆数据</p>
    <template v-else>
      <ul class="vehicle-panel__list">
        <li
          v-for="row in vehicleRows"
          :key="row.id"
          class="vehicle-panel__row"
          :class="row.rowClass"
          role="radio"
          :aria-checked="row.selected"
          tabindex="0"
          @click="handleRowClick(row.id)"
          @keydown.enter="handleRowClick(row.id)"
        >
          <span class="vehicle-panel__dot" :style="row.dotStyle"></span>
          <span class="vehicle-panel__name">{{ row.name }}</span>
          <span class="vehicle-panel__speed">{{ row.speedText }}</span>
        </li>
      </ul>

      <button
        type="button"
        class="vehicle-panel__live-toggle"
        :class="liveToggleClass"
        @click="handleLiveModeClick"
      >
        {{ liveToggleText }}
      </button>

      <div class="vehicle-panel__player" :class="{ 'vehicle-panel__player--disabled': !canPlayback }">
        <div class="vehicle-panel__player-controls">
          <button
            type="button"
            class="vehicle-panel__play"
            :disabled="!canPlayback"
            @click="handlePlayClick"
          >
            {{ playButtonText }}
          </button>
          <span class="vehicle-panel__time">{{ playheadTimeText }}</span>
        </div>
        <input
          type="range"
          class="vehicle-panel__slider"
          :min="sliderMin"
          :max="sliderMax"
          :step="sliderStep"
          :value="playheadSliderValue"
          :disabled="!canPlayback"
          @input="handleSliderInput"
        />
        <div class="vehicle-panel__speeds">
          <button
            v-for="option in speedOptions"
            :key="option.label"
            type="button"
            class="vehicle-panel__speed"
            :class="option.buttonClass"
            :disabled="!canPlayback"
            @click="handleSpeedClick(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <dl class="vehicle-panel__stats">
        <div v-for="stat in statCards" :key="stat.label" class="vehicle-panel__stat">
          <dt>{{ stat.label }}</dt>
          <dd>{{ stat.value }}</dd>
        </div>
      </dl>
    </template>
  </div>
</template>

<script setup>
// 右侧下方车辆面板（设计 §4.3 L113-118 多车切换/播放器/统计卡片）：
//   车辆列表单选（其他车地图淡显保留）、实时模式开关、回放播放器
//   （播放/暂停、进度条拖动、1×-16× 倍速）、轨迹统计四卡片。
//   轨迹点 <2 时回放控件禁用（提示由 useVehicles 加载时弹出——设计 §5 L145）。
// 数据一律取自 useVehicles 单例，不直接 import api/mock（AGENTS.md 分层约定）。
// 原生 input[type=range]/button，不引任何 UI 库（AGENTS.md）。
import { computed } from 'vue';
import { useVehicles } from '../composables/useVehicles.js';
import { PLAYBACK_SPEED_OPTIONS } from '../constants.js';

const {
  vehicles,
  selectedVehicleId,
  playing,
  playheadMs,
  playbackSpeed,
  liveMode,
  livePositions,
  trackStartMs,
  trackEndMs,
  canPlayback,
  trackStats,
  sliderStepMs,
  handleSelectVehicle,
  handleTogglePlayback,
  handleSeek,
  handlePlaybackSpeedSelect,
  handleToggleLiveMode,
} = useVehicles();

const isEmpty = computed(() => vehicles.value.length === 0);

// 车辆列表行视图模型（模板零复杂逻辑；实时速度实时模式下来自最近一条推送）
const vehicleRows = computed(() =>
  vehicles.value.map((vehicle) => {
    const selected = vehicle.id === selectedVehicleId.value;
    const liveRecord = livePositions.value[vehicle.id];
    const speedKmh = liveMode.value && liveRecord ? Math.round(liveRecord.speedKmh) : null;
    return {
      id: vehicle.id,
      name: vehicle.name,
      dotStyle: { background: vehicle.color },
      rowClass: selected ? 'vehicle-panel__row--selected' : undefined,
      selected,
      speedText: speedKmh === null ? '--' : `${String(speedKmh)} km/h`,
    };
  }),
);

const liveToggleText = computed(() => (liveMode.value ? '退出实时模式' : '进入实时模式'));
const liveToggleClass = computed(() =>
  liveMode.value ? 'vehicle-panel__live-toggle--active' : undefined,
);

const playButtonText = computed(() => (playing.value ? '暂停' : '播放'));

// 进度条：窗口毫秒直接作 min/max/value（等差单调），展示态取整避免逐帧小数重排
const sliderMin = computed(() => Math.round(trackStartMs.value));
const sliderMax = computed(() => Math.round(trackEndMs.value));
const playheadSliderValue = computed(() => Math.round(playheadMs.value));

// 播放头时钟：TRACK_WINDOW 基准为北京 08:00（mock/vehicles.js，2026-09-18T00:00Z），
// 固定以 Asia/Shanghai 渲染——任何机器上面板都显示 08:00–18:00 窗口语义（设计 §4.3）；
// 不指定 timeZone 时非 UTC+8 机器会显示 00:00–10:00（评审 finding 2）
const playheadTimeText = computed(() =>
  new Date(playheadMs.value).toLocaleTimeString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }),
);

const speedOptions = computed(() =>
  PLAYBACK_SPEED_OPTIONS.map((speedValue) => ({
    value: speedValue,
    label: `${String(speedValue)}×`,
    buttonClass: speedValue === playbackSpeed.value ? 'vehicle-panel__speed--active' : undefined,
  })),
);

// 统计卡片视图模型（总里程 km / 总时长 时分 / 平均、最高速度 km/h）
const statCards = computed(() => {
  const durationMs = trackStats.value.totalDurationMs;
  const durationHours = Math.floor(durationMs / 3600000);
  const durationMinutes = Math.round((durationMs % 3600000) / 60000);
  return [
    { label: '总里程', value: `${(trackStats.value.totalDistanceM / 1000).toFixed(1)} km` },
    { label: '总时长', value: `${String(durationHours)} 小时 ${String(durationMinutes)} 分` },
    { label: '平均速度', value: `${trackStats.value.averageSpeedKmh.toFixed(1)} km/h` },
    { label: '最高速度', value: `${trackStats.value.maxSpeedKmh.toFixed(1)} km/h` },
  ];
});

const handleRowClick = (vehicleId) => {
  handleSelectVehicle(vehicleId);
};

const handleLiveModeClick = () => {
  handleToggleLiveMode();
};

const handlePlayClick = () => {
  handleTogglePlayback();
};

const handleSliderInput = (event) => {
  handleSeek(Number(event.target.value));
};

const handleSpeedClick = (speedValue) => {
  handlePlaybackSpeedSelect(speedValue);
};
</script>

<style scoped lang="scss">
@use '../styles/variables' as *;

.vehicle-panel {
  display: grid;
  gap: 8px;
  align-content: start;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  @include thin-scrollbar;
}

.vehicle-panel__title {
  margin: 0;
  color: $text-primary;
  font-size: 14px;
  font-weight: 600;
}

.vehicle-panel__empty {
  margin: 0;
  color: $text-secondary;
  font-size: 13px;
}

.vehicle-panel__list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.vehicle-panel__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid $border-color;
  border-radius: 4px;
  cursor: pointer;

  &:hover {
    background: $bg;
  }
}

.vehicle-panel__row--selected {
  background: rgb(24 144 255 / 10%);
  border-color: $zone-production;
}

.vehicle-panel__dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.vehicle-panel__name {
  flex: 1;
  overflow: hidden;
  color: $text-primary;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vehicle-panel__speed {
  flex: none;
  color: $text-secondary;
  font-size: 12px;
}

.vehicle-panel__live-toggle {
  padding: 5px 10px;
  border: 1px solid $zone-production;
  border-radius: 4px;
  background: #ffffff;
  color: $zone-production;
  font-size: 13px;
  cursor: pointer;

  &:hover {
    background: rgb(24 144 255 / 8%);
  }
}

.vehicle-panel__live-toggle--active {
  background: $zone-production;
  color: #ffffff;

  &:hover {
    background: $zone-production;
  }
}

.vehicle-panel__player {
  display: grid;
  gap: 6px;
  padding: 8px;
  border: 1px solid $border-color;
  border-radius: 4px;
}

.vehicle-panel__player--disabled {
  opacity: 0.55;
}

.vehicle-panel__player-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.vehicle-panel__play {
  flex: none;
  padding: 4px 14px;
  border: none;
  border-radius: 4px;
  background: $zone-production;
  color: #ffffff;
  font-size: 13px;
  cursor: pointer;

  &:disabled {
    background: $border-color;
    cursor: not-allowed;
  }
}

.vehicle-panel__time {
  color: $text-primary;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.vehicle-panel__slider {
  width: 100%;
  margin: 0;
  accent-color: $zone-production;
}

.vehicle-panel__speeds {
  display: flex;
  gap: 4px;
}

.vehicle-panel__speed {
  flex: 1;
  padding: 3px 0;
  border: 1px solid $border-color;
  border-radius: 4px;
  background: #ffffff;
  color: $text-secondary;
  font-size: 12px;
  cursor: pointer;

  &:disabled {
    cursor: not-allowed;
  }
}

.vehicle-panel__speed--active {
  border-color: $zone-production;
  background: rgb(24 144 255 / 10%);
  color: $zone-production;
  font-weight: 600;
}

.vehicle-panel__stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin: 0;
}

.vehicle-panel__stat {
  display: grid;
  gap: 2px;
  padding: 6px 8px;
  border: 1px solid $border-color;
  border-radius: 4px;
  background: $bg;
}

.vehicle-panel__stat dt {
  color: $text-secondary;
  font-size: 12px;
}

.vehicle-panel__stat dd {
  margin: 0;
  color: $text-primary;
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
