// src/map/layerManager.verify.js — 图层注册表纯逻辑自测（pnpm verify 自动发现挂载）
//
// 被测契约（设计 §4.7 L138「所有图层经 layerManager.register({ id, name, layer, visible }) 注册」
// + 实施计划 testPoint「layerManager」）：
//   register({ id, name, layer, visible = true })：重复 id 抛 Error 且不覆盖原 entry；
//     注册即向 layer 下发一次 setVisible(visible)；entry 形状 { id, name, layer, visible }，
//     layer 为注册时传入的同一实例。
//   setVisible(id, visible)：同步更新 entry.visible 并透传 layer.setVisible。
//   getLayerById(id)：未命中返回 undefined。
//   getLayerEntries()：每次返回新数组快照，改快照不影响注册表。
//   unregister(id) / clearLayerRegistry()（仅测试用）：清理生效。
//
// ⚠ 测试先行（厂区绘制任务扩展，实施计划步骤 5）：subscribeLayerRegistry 尚未实现，
//   实现落地前本挂载点因「导出不存在」报错属预期红灯（旧断言随之暂不执行）；
//   实现落地后新旧断言须全部通过（计划步骤 8「旧断言零回归」）。
//   subscribeLayerRegistry(listener) 契约（LayerTree 响应异步注册时序的依赖）：
//     - 返回取消函数（对齐设计 §3.3 L88 subscribe 返回取消函数约定）；
//     - 订阅即同步回调一次（新 listener 立即拿到初始状态，不通知既有 listener）；
//     - register / unregister / setVisible 后同步通知全部存活 listener（各恰一次）；
//     - 取消订阅后不再被通知；多个 listener 互不影响（取消其一不影响其余）。
//     - 通知时机为同步（断言在操作后立即校验计数，不 await）。
//
// 说明：注册表为模块级单例，本文件开头与 finally 均 clearLayerRegistry()，
//   订阅取消函数同样在 finally 兜底回收，保证失败中途退出也不污染同进程其他 verify 挂载点。

import {
  register,
  unregister,
  setVisible,
  getLayerById,
  getLayerEntries,
  clearLayerRegistry,
  subscribeLayerRegistry,
} from './layerManager.js';

// ol Layer 的 setVisible 属命令式 API（AGENTS.md 例外条款），测试替身仅记录调用：
// visibleCalls 用展开赋值累积，遵循项目函数式约定。
const createFakeLayer = () => {
  const state = { visibleCalls: [] };
  const layer = {
    setVisible: (visible) => {
      state.visibleCalls = [...state.visibleCalls, visible];
    },
  };
  return { layer, state };
};

export const verify = (assert) => {
  clearLayerRegistry();
  // 订阅取消函数回收表：正常路径主动取消时移出，异常中断时由 finally 兜底回收
  const activeCancels = new Set();
  const cancelSubscription = (cancel) => {
    cancel();
    activeCancels.delete(cancel);
  };
  try {
    // —— register：entry 形状与「注册即 setVisible」——
    const fakeA = createFakeLayer();
    register({ id: 'test-layer-a', name: '图层甲', layer: fakeA.layer, visible: true });
    const entryA = getLayerById('test-layer-a');
    assert.ok(entryA, 'register 后 getLayerById 应命中');
    assert.equal(entryA.id, 'test-layer-a', 'entry.id 应保留注册 id');
    assert.equal(entryA.name, '图层甲', 'entry.name 应保留注册名称');
    assert.equal(entryA.layer, fakeA.layer, 'entry.layer 应为注册传入的同一实例');
    assert.equal(entryA.visible, true, 'entry.visible 应与注册值一致');
    assert.deepEqual(fakeA.state.visibleCalls, [true], '注册即应向 layer 下发一次 setVisible(true)');

    // —— register：缺省 visible 默认 true ——
    const fakeB = createFakeLayer();
    register({ id: 'test-layer-b', name: '图层乙', layer: fakeB.layer });
    assert.equal(getLayerById('test-layer-b').visible, true, '未传 visible 时默认 true');
    assert.deepEqual(fakeB.state.visibleCalls, [true], '缺省注册也应下发 setVisible(true)');

    // —— register：显式 visible:false ——
    const fakeC = createFakeLayer();
    register({ id: 'test-layer-c', name: '图层丙', layer: fakeC.layer, visible: false });
    assert.equal(getLayerById('test-layer-c').visible, false, '显式 false 注册 entry.visible 应为 false');
    assert.deepEqual(fakeC.state.visibleCalls, [false], '显式 false 注册应下发 setVisible(false)');

    // —— 重复 id 抛 Error 且不覆盖原 entry ——
    assert.throws(
      () => register({ id: 'test-layer-a', name: '重复注册', layer: createFakeLayer().layer }),
      Error,
      '重复 id 注册应抛 Error',
    );
    assert.equal(getLayerById('test-layer-a').name, '图层甲', '重复注册失败不应覆盖原 entry');

    // —— setVisible：同步 entry 与 layer ——
    setVisible('test-layer-a', false);
    assert.equal(getLayerById('test-layer-a').visible, false, 'setVisible 应同步更新 entry.visible');
    setVisible('test-layer-a', true);
    assert.deepEqual(
      fakeA.state.visibleCalls,
      [true, false, true],
      'setVisible 应逐次透传给 layer.setVisible',
    );

    // —— getLayerEntries：新数组快照，改快照不影响注册表 ——
    const snapshotOne = getLayerEntries();
    const snapshotTwo = getLayerEntries();
    assert.equal(snapshotTwo.length, 3, '当前应注册了 3 个图层');
    assert.notEqual(snapshotOne, snapshotTwo, '每次 getLayerEntries 应返回新数组');
    assert.deepEqual(
      snapshotTwo.map((entry) => entry.id).sort(),
      ['test-layer-a', 'test-layer-b', 'test-layer-c'],
      '快照应包含全部注册条目',
    );
    snapshotOne.length = 0;
    assert.equal(getLayerEntries().length, 3, '改快照（清空）不应影响注册表');

    // —— getLayerById 未命中 ——
    assert.equal(getLayerById('no-such-layer'), undefined, '未命中 id 应返回 undefined');

    // —— unregister ——
    unregister('test-layer-b');
    assert.equal(getLayerById('test-layer-b'), undefined, 'unregister 后应未命中');
    assert.equal(getLayerEntries().length, 2, 'unregister 后条目数应减一');

    // —— clearLayerRegistry（仅测试用）——
    clearLayerRegistry();
    assert.equal(getLayerEntries().length, 0, 'clearLayerRegistry 后注册表应为空');
    assert.equal(getLayerById('test-layer-a'), undefined, 'clearLayerRegistry 后原有条目应全部移除');

    // ================= 以下为厂区绘制任务新增契约（实施计划步骤 5 / testPoint「layerManager 扩展」）=================
    // 注册表此刻为空（上一段刚 clear），订阅计数不受前面用例干扰。

    // —— 订阅即同步回调一次；返回取消函数 ——
    const stateListenerA = { calls: 0 };
    const listenerA = () => {
      stateListenerA.calls += 1;
    };
    const cancelA = subscribeLayerRegistry(listenerA);
    activeCancels.add(cancelA);
    assert.equal(typeof cancelA, 'function', 'subscribeLayerRegistry 应返回取消函数');
    assert.equal(stateListenerA.calls, 1, '订阅即应同步回调一次（新 listener 立即拿到初始状态）');

    // —— register 触发已订阅 listener ——
    register({ id: 'test-layer-sub1', name: '订阅测试甲', layer: createFakeLayer().layer });
    assert.equal(stateListenerA.calls, 2, 'register 后应通知已订阅 listener（恰一次）');

    // —— 第二个 listener 订阅同样立即回调，且不影响既有 listener 计数（互不影响）——
    const stateListenerB = { calls: 0 };
    const listenerB = () => {
      stateListenerB.calls += 1;
    };
    const cancelB = subscribeLayerRegistry(listenerB);
    activeCancels.add(cancelB);
    assert.equal(typeof cancelB, 'function', '第二个订阅同样应返回取消函数');
    assert.equal(stateListenerB.calls, 1, '第二个 listener 订阅即应同步回调一次');
    assert.equal(
      stateListenerA.calls,
      2,
      '新 listener 订阅不应额外通知既有 listener（订阅不是注册表变更）',
    );

    // —— setVisible / unregister 触发全部存活 listener ——
    setVisible('test-layer-sub1', false);
    assert.equal(stateListenerA.calls, 3, 'setVisible 后应通知 listener A（恰一次）');
    assert.equal(stateListenerB.calls, 2, 'setVisible 后应通知 listener B（恰一次）');
    unregister('test-layer-sub1');
    assert.equal(stateListenerA.calls, 4, 'unregister 后应通知 listener A（恰一次）');
    assert.equal(stateListenerB.calls, 3, 'unregister 后应通知 listener B（恰一次）');

    // —— 取消订阅：取消者不再被通知，未取消者不受影响 ——
    cancelSubscription(cancelA);
    register({ id: 'test-layer-sub2', name: '订阅测试乙', layer: createFakeLayer().layer });
    assert.equal(stateListenerA.calls, 4, '取消订阅后 register 不应再通知 listener A');
    assert.equal(stateListenerB.calls, 4, '取消 A 不应影响 listener B 继续接收通知');

    // —— 双双取消后任何操作都不再通知 ——（unregister 同时清理 sub2）
    cancelSubscription(cancelB);
    unregister('test-layer-sub2');
    assert.equal(stateListenerA.calls, 4, '全部取消后 unregister 不应通知 listener A');
    assert.equal(stateListenerB.calls, 4, '全部取消后 unregister 不应通知 listener B');
  } finally {
    activeCancels.forEach((cancel) => cancel());
    clearLayerRegistry();
  }
};
