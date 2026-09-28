<template>
  <!-- 根节点整体作为 OL Overlay 元素（由 useZones 的 Overlay 接管定位与显隐），
       表单本体只在有待确认的绘制要素（zoneForm 非 null）时渲染。 -->
  <div ref="popupRootRef" class="zone-form-popup">
    <form v-if="zoneForm" class="zone-form-popup__form" @submit.prevent="handleSubmit">
      <p class="zone-form-popup__title">新建厂区区域</p>
      <label class="zone-form-popup__field">
        <span class="zone-form-popup__field-label">名称</span>
        <input
          ref="nameInputRef"
          v-model="nameDraft"
          class="zone-form-popup__input"
          type="text"
          placeholder="如：一号车间"
        />
      </label>
      <label class="zone-form-popup__field">
        <span class="zone-form-popup__field-label">类型</span>
        <select v-model="typeDraft" class="zone-form-popup__select">
          <option v-for="option in typeOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <div class="zone-form-popup__actions">
        <button type="submit" class="zone-form-popup__button zone-form-popup__button--primary">
          保存
        </button>
        <button type="button" class="zone-form-popup__button" @click="handleCancel">取消</button>
      </div>
    </form>
  </div>
</template>

<script setup>
// 绘制完成后的贴图小表单（设计 §4.1 L99：双击完成后弹小表单填名称/类型入库）。
// AGENTS.md：贴图弹窗用 OL Overlay 挂载 Vue 组件，不用任何 UI 库 Dialog——
// 根 DOM 经 registerZonePopupElement 注册给 useZones 的 Overlay，本组件不持有 Overlay 实例。
import { nextTick, onMounted, ref, useTemplateRef, watch } from 'vue';
import { useZones } from '../composables/useZones.js';
import { ZONE_TYPE_CONFIG } from '../constants.js';

const { zoneForm, registerZonePopupElement, handleZoneFormSubmit, handleZoneFormCancel } = useZones();

const popupRootRef = useTemplateRef('popupRootRef');
const nameInputRef = useTemplateRef('nameInputRef');
const nameDraft = ref('');
const typeDraft = ref('');

// 类型下拉选项由 ZONE_TYPE_CONFIG 生成（模板零复杂逻辑）
const typeOptions = Object.entries(ZONE_TYPE_CONFIG).map(([value, config]) => ({
  value,
  label: config.label,
}));

// 每次表单打开重置草稿并聚焦名称输入
watch(zoneForm, (form) => {
  if (!form) {
    return;
  }
  nameDraft.value = '';
  typeDraft.value = form.defaultType;
  nextTick(() => nameInputRef.value?.focus());
});

onMounted(() => {
  registerZonePopupElement(popupRootRef.value);
});

const handleSubmit = () => {
  handleZoneFormSubmit({ name: nameDraft.value, type: typeDraft.value });
};

const handleCancel = () => {
  handleZoneFormCancel();
};
</script>

<style scoped lang="scss">
@use '../styles/variables' as *;

.zone-form-popup {
  // 尺寸/显隐由 ol Overlay 定位机制控制；这里只管卡片外观
  min-width: 220px;
}

.zone-form-popup__form {
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  background: $panel-bg;
  border: 1px solid $border-color;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgb(0 0 0 / 18%);
}

.zone-form-popup__title {
  margin: 0;
  color: $text-primary;
  font-size: 14px;
  font-weight: 600;
}

.zone-form-popup__field {
  display: grid;
  grid-template-columns: 36px 1fr;
  align-items: center;
  gap: 8px;
}

.zone-form-popup__field-label {
  color: $text-secondary;
  font-size: 13px;
}

.zone-form-popup__input,
.zone-form-popup__select {
  box-sizing: border-box;
  width: 100%;
  padding: 4px 8px;
  border: 1px solid $border-color;
  border-radius: 4px;
  color: $text-primary;
  font-size: 13px;

  &:focus {
    border-color: $zone-production;
    outline: none;
  }
}

.zone-form-popup__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.zone-form-popup__button {
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

.zone-form-popup__button--primary {
  border-color: $zone-production;
  background: $zone-production;
  color: #ffffff;

  &:hover {
    background: #40a9ff;
    border-color: #40a9ff;
    color: #ffffff;
  }
}
</style>
