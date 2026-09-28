// src/composables/useNotice.js — App 级自定义顶部通知条（AGENTS.md 错误处理约定：
// 不引 UI 库消息组件，统一走本通知条 + console.error；渲染在 App.vue 顶部悬浮）。
// 模块级单例（不引 Pinia，跨组件状态由 composable 单例内聚——设计 §2 技术选型）。
import { ref } from 'vue';
import { NOTICE_DEFAULT_DURATION_MS } from '../constants.js';

// 通知条状态：{ id, type: 'info'|'success'|'warning'|'error', message }
const notices = ref([]);
let nextNoticeId = 1;
const noticeTimers = new Map();

const clearNoticeTimer = (id) => {
  const timer = noticeTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    noticeTimers.delete(id);
  }
};

const removeNotice = (id) => {
  clearNoticeTimer(id);
  notices.value = notices.value.filter((notice) => notice.id !== id);
};

const armNoticeTimer = (id, duration) => {
  clearNoticeTimer(id);
  if (duration <= 0) {
    return; // 显式传 0（或负值）表示不自动消失，仅手动关闭
  }
  const timer = setTimeout(() => removeNotice(id), duration);
  noticeTimers.set(id, timer);
};

// useNotice() 每次返回同一组单例引用与操作函数
export const useNotice = () => {
  // 弹出通知：同 type + message 的活动通知去重（不重复堆叠，仅刷新计时）；
  // duration 毫秒后自动移除，显式传 0 表示不自动消失。返回通知 id。
  const notify = ({ type = 'info', message, duration = NOTICE_DEFAULT_DURATION_MS }) => {
    const existing = notices.value.find(
      (notice) => notice.type === type && notice.message === message,
    );
    if (existing) {
      armNoticeTimer(existing.id, duration);
      return existing.id;
    }
    const id = nextNoticeId;
    nextNoticeId += 1;
    notices.value = [...notices.value, { id, type, message }];
    armNoticeTimer(id, duration);
    return id;
  };

  // 手动关闭（通知条关闭按钮）
  const dismissNotice = (id) => {
    removeNotice(id);
  };

  return { notices, notify, dismissNotice };
};
