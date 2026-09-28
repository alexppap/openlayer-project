// src/api/alarmsApi.verify.js — 报警 mock API 契约自测（pnpm verify 自动发现挂载）
//
// ⚠ 测试先行：本文件先于 src/api/alarmsApi.js 落地（实施计划步骤 5），
//   在被测模块实现前 pnpm verify 对本挂载点报「找不到模块」属预期红灯（先例：api/zonesApi.verify.js）。
//
// ⚠ 运行环境约束：本文件在纯 node 下执行。subscribeAlarms 以真实 setInterval 模拟推送，
//   本文件用 intervalMs:10 注入把等待压到亚秒级；★全部订阅必须在收尾取消——
//   残留 interval 会让 node 进程挂起（scripts/verify.js 等事件循环清空才退出），
//   故用 activeUnsubscribers 集合追踪、finally 兜底全取消。
//
// 被测契约（实施计划 testPoint「api/alarmsApi」+ 步骤 5；设计 §5 L143 mock 永不 reject、§4.5 L128 围栏打通）：
//   getAlarms()：resolve 模块内报警状态（初始 = ALARMS_SEED 深拷贝）；
//     两次调用互为深拷贝——污染上一次返回值不得影响下一次（防状态污染，对齐 zonesApi.verify 先例）。
//   ackAlarm(id)：命中 → resolve { ok: true, alarm } 且 alarm.status==='acked'，
//     随后 getAlarms 仅该条 status 变化、其余条目逐字段不变；未命中 → resolve { ok: false, error }。
//     任何分支均 resolve、永不 reject（§5 L143）。
//   addAlarm(alarm)：追加进模块状态，且★同步通知全部订阅者——
//     cb 收到的是新增的那条报警记录（单对象）。★本文件断言即契约：若实现选择推送全量列表，
//     本挂载点红灯显式暴露契约分歧，须回到计划/评审对齐而不是静默改测试。
//     （§4.5 L128 围栏报警走 addAlarm 与报警列表/徽标/联动全套打通，依赖此单条推送形状。）
//   subscribeAlarms(cb, { intervalMs } = ALARM_GENERATE_INTERVAL_MS)：返回取消函数；
//     共享 setInterval → generateRandomAlarm 生成 → addAlarm 追加 → 广播全部订阅者；
//     非最后订阅者取消不清除 interval（其余订阅者继续收）；
//     最后一个订阅者取消时 clearInterval（此后不再推送；再次订阅可重建定时器）。
//     推送记录：deviceId ∈ DEVICES_SEED 且坐标距所属设备各轴 ≤ ALARM_JITTER_RADIUS_DEG、
//     level ∈ critical/major/minor、status ∈ {pending, acked}——
//     ★推送 status 是否恒为 pending 是计划 risks 声明的开放点（任务原文「status 取 pending/acked」
//     逐字执行 vs 推送恒 pending 待评审拍板），本测试不替评审决定，只锁 ∈ 枚举与「近设备」。
//   定时器生命周期：模块导入时不得启动定时器（首订阅才启动——计划 risks node 兼容红线，
//     否则本 verify 静态 import 阶段就会挂起 node 进程）。
//   api/index.js re-export：getAlarms/ackAlarm/addAlarm/subscribeAlarms 经统一出口导出
//     （AGENTS.md 分层约定：组件与 composable 只能 import api/*）。
//   常量：ALARM_GENERATE_INTERVAL_MS = 8000（计划 risks 自选决策，断言锁值防漂移）。
//
// 诚实缺口：ackAlarm 后是否广播订阅者、addAlarm 的 resolve 返回形状计划未约定，本测试不锁。

import { ackAlarm, addAlarm, getAlarms, subscribeAlarms } from './alarmsApi.js';
import * as apiIndex from './index.js';
import { ALARMS_SEED } from '../mock/alarms.js';
import { DEVICES_SEED } from '../mock/devices.js';
import {
  ALARM_GENERATE_INTERVAL_MS,
  ALARM_JITTER_RADIUS_DEG,
  ALARM_LEVEL_CONFIG,
} from '../constants.js';

const ALARM_STATUS_POOL = ['pending', 'acked'];
const JITTER_TOLERANCE = 1e-9; // 抖动边界的浮点容差
const waitFor = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

export const verify = async (assert) => {
  // 订阅句柄追踪：成功路径主动移出，异常中断由 finally 兜底全取消（防残留 interval 挂起 node）
  const activeUnsubscribers = new Set();
  const subscribeTracked = (callback, options) => {
    const unsubscribe = subscribeAlarms(callback, options);
    activeUnsubscribers.add(unsubscribe);
    return unsubscribe;
  };
  const unsubscribeTracked = (unsubscribe) => {
    unsubscribe();
    activeUnsubscribers.delete(unsubscribe);
  };

  try {
    // —— 常量：默认推送间隔 8000ms ——
    assert.equal(
      ALARM_GENERATE_INTERVAL_MS,
      8000,
      'ALARM_GENERATE_INTERVAL_MS 应为 8000（subscribeAlarms 缺省 intervalMs）',
    );

    // —— api/index.js 统一出口（AGENTS.md 分层约定）——
    ['getAlarms', 'ackAlarm', 'addAlarm', 'subscribeAlarms'].forEach((methodName) => {
      assert.equal(
        typeof apiIndex[methodName],
        'function',
        `api/index.js 应 re-export ${methodName}（组件/composable 只调 api/*）`,
      );
    });

    // —— 初始状态：resolve ALARMS_SEED 深拷贝 ——
    const initialAlarms = await getAlarms();
    assert.ok(Array.isArray(initialAlarms), 'getAlarms 应 resolve 数组');
    assert.deepEqual(
      initialAlarms,
      ALARMS_SEED,
      '初始 getAlarms 应 resolve 种子数据（模块内状态 = 种子深拷贝）',
    );

    // —— 深拷贝互证：污染前者不影响后者（对齐 zonesApi.verify 先例）——
    const secondCall = await getAlarms();
    assert.notEqual(initialAlarms, secondCall, '两次 getAlarms 不应返回同一引用');
    initialAlarms[0].status = '__污染测试__';
    const thirdCall = await getAlarms();
    assert.deepEqual(
      thirdCall,
      ALARMS_SEED,
      '污染上一次 getAlarms 返回值不应影响下一次（每次均为模块状态深拷贝）',
    );

    // —— ackAlarm 命中：resolve { ok:true, alarm }，仅目标条变化 ——
    const beforeAck = await getAlarms();
    const pendingTarget = beforeAck.find((alarm) => alarm.status === 'pending');
    assert.ok(pendingTarget, '种子应含 pending 记录可供 ack（ALARMS_SEED 契约由 alarms.verify 另行锁定）');
    let ackResult;
    await assert.doesNotReject(
      async () => {
        ackResult = await ackAlarm(pendingTarget.id);
      },
      'ackAlarm 命中不应 reject',
    );
    assert.equal(ackResult.ok, true, '命中应 resolve { ok: true }');
    assert.equal(ackResult.alarm.id, pendingTarget.id, '结果应回带目标记录（alarm.id 一致）');
    assert.equal(ackResult.alarm.status, 'acked', '回带记录 status 应已置 acked');
    const afterAck = await getAlarms();
    assert.equal(afterAck.length, beforeAck.length, 'ack 不应增删记录');
    afterAck.forEach((alarm, index) => {
      if (alarm.id === pendingTarget.id) {
        assert.equal(alarm.status, 'acked', '目标条在 getAlarms 中应已置 acked');
        assert.equal(alarm.level, beforeAck[index].level, '目标条除 status 外字段不应变化（level）');
        assert.equal(alarm.time, beforeAck[index].time, '目标条除 status 外字段不应变化（time）');
      } else {
        assert.deepEqual(
          alarm,
          beforeAck[index],
          `非目标条「${alarm.id}」应逐字段保持不变（仅目标条被 ack）`,
        );
      }
    });

    // —— ackAlarm 未命中：resolve { ok:false, error }，不 reject ——
    let missResult;
    await assert.doesNotReject(
      async () => {
        missResult = await ackAlarm('no-such-alarm-id');
      },
      'ackAlarm 未命中也不应 reject（mock 永不 reject，设计 §5 L143）',
    );
    assert.equal(missResult.ok, false, '未命中应 resolve { ok: false }');
    assert.ok(missResult.error, '未命中结果应携带 error 信息');

    // —— subscribeAlarms：intervalMs:10 真实定时器，150ms 内收到形状合法且近设备的推送 ——
    const pushedAlarms = [];
    const unsubscribeFirst = subscribeTracked(
      (alarm) => {
        pushedAlarms.push(alarm);
      },
      { intervalMs: 10 },
    );
    assert.equal(typeof unsubscribeFirst, 'function', 'subscribeAlarms 应返回取消函数');
    await waitFor(150);
    assert.ok(
      pushedAlarms.length >= 1,
      'intervalMs=10 下 150ms 内应至少收到一次定时推送（真实 setInterval 生效）',
    );
    pushedAlarms.forEach((alarm, index) => {
      const label = `推送 ${index}（id=${String(alarm.id)}）`;
      assert.ok(
        Object.hasOwn(ALARM_LEVEL_CONFIG, alarm.level),
        `${label}：level 应 ∈ critical/major/minor`,
      );
      assert.ok(
        ALARM_STATUS_POOL.includes(alarm.status),
        `${label}：status 应 ∈ pending/acked（推送是否恒 pending 为计划 risks 开放点，不在此锁死）`,
      );
      assert.ok(Number.isFinite(alarm.time), `${label}：time 应为有限数`);
      const matchedDevice = DEVICES_SEED.find((device) => device.id === alarm.deviceId);
      assert.ok(matchedDevice, `${label}：deviceId 应存在于 DEVICES_SEED（随机生成于设备点位附近）`);
      assert.ok(
        Math.abs(alarm.lng - matchedDevice.lng) <= ALARM_JITTER_RADIUS_DEG + JITTER_TOLERANCE,
        `${label}：经度应距所属设备 ≤ ALARM_JITTER_RADIUS_DEG`,
      );
      assert.ok(
        Math.abs(alarm.lat - matchedDevice.lat) <= ALARM_JITTER_RADIUS_DEG + JITTER_TOLERANCE,
        `${label}：纬度应距所属设备 ≤ ALARM_JITTER_RADIUS_DEG`,
      );
    });

    // —— 取消后不再收到 ——
    unsubscribeTracked(unsubscribeFirst);
    const pushedCountAfterCancel = pushedAlarms.length;
    await waitFor(60);
    assert.equal(
      pushedAlarms.length,
      pushedCountAfterCancel,
      '取消订阅后不应再收到推送（60ms ≥ 6 个 intervalMs 周期）',
    );

    // —— addAlarm：追加 + 同步通知全部订阅者 ——
    const anchorDevice = DEVICES_SEED[0];
    const manualAlarm = {
      id: 'alarm-verify-manual-1',
      deviceId: anchorDevice.id,
      deviceName: anchorDevice.name,
      deviceType: anchorDevice.type,
      lng: anchorDevice.lng,
      lat: anchorDevice.lat,
      type: '围栏入侵（verify 注入）',
      level: 'critical',
      time: 1758600000000,
      status: 'pending',
    };
    const receivedByA = [];
    const receivedByB = [];
    const unsubscribeA = subscribeTracked(
      (alarm) => {
        receivedByA.push(alarm);
      },
      { intervalMs: 10 },
    );
    const unsubscribeB = subscribeTracked(
      (alarm) => {
        receivedByB.push(alarm);
      },
      { intervalMs: 10 },
    );
    await waitFor(60);
    assert.ok(
      receivedByA.length >= 1 && receivedByB.length >= 1,
      '前置：双订阅应均已收到定时推送（interval 已在运行）',
    );
    await assert.doesNotReject(
      async () => {
        await addAlarm(manualAlarm);
      },
      'addAlarm 不应 reject',
    );
    // 同步通知：await addAlarm 返回后立即检查，不等待下一个 interval tick
    assert.ok(
      receivedByA.some((alarm) => alarm.id === manualAlarm.id),
      'addAlarm 应同步通知订阅者 A（收到新增记录单对象，非等下一 tick）',
    );
    assert.ok(
      receivedByB.some((alarm) => alarm.id === manualAlarm.id),
      'addAlarm 应同步通知全部订阅者（A 与 B 都收到）',
    );
    const alarmsAfterAdd = await getAlarms();
    const addedInState = alarmsAfterAdd.find((alarm) => alarm.id === manualAlarm.id);
    assert.ok(addedInState, 'addAlarm 后 getAlarms 应反映新增记录');
    assert.deepEqual(addedInState, manualAlarm, '状态中的新增记录应与传入记录逐字段一致');

    // —— 共享 interval：非最后取消不清除；最后一个取消时 clearInterval ——
    unsubscribeTracked(unsubscribeA);
    const bCountAtCancelA = receivedByB.length;
    await waitFor(100);
    assert.ok(
      receivedByB.length > bCountAtCancelA,
      '取消非最后订阅者后，剩余订阅者应继续收到推送（共享 interval 未被误清除）',
    );
    unsubscribeTracked(unsubscribeB);
    const aCountFinal = receivedByA.length;
    const bCountFinal = receivedByB.length;
    await waitFor(80);
    assert.equal(receivedByA.length, aCountFinal, '全部取消后订阅者 A 不应再收到推送');
    assert.equal(
      receivedByB.length,
      bCountFinal,
      '全部取消后订阅者 B 不应再收到推送（最后一个订阅者取消时 clearInterval）',
    );

    // —— 复订可重建定时器（clearInterval 后状态可复用，不残留「已停止」死态）——
    let resubscribeCount = 0;
    const unsubscribeResub = subscribeTracked(
      () => {
        resubscribeCount += 1;
      },
      { intervalMs: 10 },
    );
    await waitFor(100);
    assert.ok(
      resubscribeCount >= 1,
      '全部取消后再次订阅应能重新收到推送（首订阅才启动、可重复启停）',
    );
    unsubscribeTracked(unsubscribeResub);
    await waitFor(30); // 留出最后一跳余量，确保取消在收尾前已生效
  } finally {
    activeUnsubscribers.forEach((unsubscribe) => {
      unsubscribe();
    });
  }
};
