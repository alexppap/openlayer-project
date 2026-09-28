// src/map/layerManager.js — 图层注册表（设计 §4.7 L138：
// 所有图层经 layerManager.register({ id, name, layer, visible }) 注册，
// LayerTree 渲染分组列表并经 setVisible 统一控制显隐——图层树 UI 由后续任务接入）。
// 零 import 依赖的纯注册表：不持有 Map 实例，注册/反注册不自动增删图层对象，
// 由调用方（mapCore / 各业务 composable）负责把 layer 加进 Map。
// ol 图层 id 用 kebab-case（AGENTS.md 命名规范）。

const layerRegistry = new Map();

// 注册表订阅通知（LayerTree 依赖）：listener 无参回调，注册表变更后自行经
// getLayerEntries() 取最新快照。订阅即同步回调一次（新 listener 立即拿到初始状态，
// 不通知既有 listener）；register / unregister / setVisible 成功后同步通知全部存活 listener
//（对齐设计 §3.3 L88「subscribe 返回取消函数」约定）。返回取消订阅函数。
const layerRegistryListeners = new Set();

const notifyLayerRegistryChange = () => {
  layerRegistryListeners.forEach((listener) => {
    listener();
  });
};

export const subscribeLayerRegistry = (listener) => {
  layerRegistryListeners.add(listener);
  listener();
  return () => {
    layerRegistryListeners.delete(listener);
  };
};

// 注册图层：重复 id 抛 Error 且不覆盖原 entry；注册即向 layer 下发一次 setVisible(visible)，
// 保证 entry.visible 与图层实际可见状态从一开始就一致。
export const register = ({ id, name, layer, visible = true }) => {
  if (layerRegistry.has(id)) {
    throw new Error(`图层 id「${id}」已注册，禁止重复注册`);
  }
  layerRegistry.set(id, { id, name, layer, visible });
  layer.setVisible(visible);
  notifyLayerRegistryChange();
};

// 反注册（仅移除登记，不动 layer 实例本身）；未命中 id 为 no-op 不通知
export const unregister = (id) => {
  const removed = layerRegistry.delete(id);
  if (removed) {
    notifyLayerRegistryChange();
  }
};

// 切换显隐：同步 entry.visible 并透传 layer.setVisible（LayerTree 勾选的唯一出口）
export const setVisible = (id, visible) => {
  const entry = layerRegistry.get(id);
  if (!entry) {
    return;
  }
  entry.visible = visible;
  entry.layer.setVisible(visible);
  notifyLayerRegistryChange();
};

// 按 id 查询，未命中返回 undefined
export const getLayerById = (id) => layerRegistry.get(id);

// 全量快照：每次返回新数组，改快照不影响注册表
export const getLayerEntries = () => [...layerRegistry.values()];

// 清空注册表（仅测试用：*.verify.js 复用同进程模块单例时隔离状态）
export const clearLayerRegistry = () => {
  layerRegistry.clear();
};
