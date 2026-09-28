// src/api/alarmsApi.js — 报警数据 mock API（设计 §4.2 L106-110、§5 L143）。
//
// 契约（api/alarmsApi.verify.js 断言）：
//   getAlarms()：resolve 模块内报警状态（初始 = ALARMS_SEED 深拷贝）；
//     每次调用各自深拷贝返回——污染上一次返回值不影响下一次（防状态污染）。
//   ackAlarm(id)：命中 → 该条 status 置 'acked'，resolve { ok: true, alarm }；
//     未命中 → resolve { ok: false, error }。任何分支均 resolve、永不 reject（§5 L143）。
//   addAlarm(alarm)：resolveAlarmRecord 定形后追加进模块状态，并★同步（不等下一 tick）
//     通知全部订阅者（推送单条新增记录对象——§4.5 L128 围栏报警经 addAlarm 与
//     报警列表/徽标/联动全套打通，依赖此单条推送形状）；定形失败 resolve { ok: false, error }。
//   subscribeAlarms(cb, { intervalMs } = ALARM_GENERATE_INTERVAL_MS)：返回取消函数；
//     共享 setInterval → generateRandomAlarm 生成 → addAlarm 追加 → 广播全部订阅者；
//     非最后订阅者取消不清除 interval；最后一个取消时 clearInterval；
//     再次订阅可重建定时器。
//
// ⚠ node 兼容（risks 红线）：模块导入时不启动任何定时器（首订阅才启动），
//   否则 alarmsApi.verify.js 的静态 import 阶段就会挂起 node 进程。
import { ALARM_GENERATE_INTERVAL_MS } from '../constants.js';
import { ALARMS_SEED, generateRandomAlarm, resolveAlarmRecord } from '../mock/alarms.js';
import { DEVICES_SEED } from '../mock/devices.js';

// 模块内报警状态（种子的深拷贝，绝不让调用方污染种子常量）
let alarmRecords = structuredClone(ALARMS_SEED);

// 订阅者集合 + 共享推送定时器（首订阅启动，最后一个取消时清除）
const alarmListeners = new Set();
let pushIntervalId = null;

// 通知全部订阅者：每户各发一份深拷贝（订阅方拿到的是自己的副本，互不串改）
const notifyAlarmListeners = (alarmRecord) => {
  alarmListeners.forEach((listener) => {
    listener(structuredClone(alarmRecord));
  });
};

// 取报警列表（模块状态的深拷贝）
export const getAlarms = async () => structuredClone(alarmRecords);

// 标记处理：命中置 acked 并回带该条；未命中/异常均 resolve 结构化结果，永不 reject
export const ackAlarm = async (alarmId) => {
  try {
    const targetIndex = alarmRecords.findIndex((alarm) => alarm.id === alarmId);
    if (targetIndex < 0) {
      return { ok: false, error: new Error(`报警「${String(alarmId)}」不存在或已被移除`) };
    }
    alarmRecords = alarmRecords.map((alarm, index) =>
      index === targetIndex ? { ...alarm, status: 'acked' } : alarm,
    );
    return { ok: true, alarm: structuredClone(alarmRecords[targetIndex]) };
  } catch (error) {
    console.error('[alarmsApi] ackAlarm 异常：', error);
    return { ok: false, error };
  }
};

// 追加报警（定形→入库→同步广播全部订阅者）；定形失败不 broadcast、不 reject
export const addAlarm = async (alarm) => {
  try {
    const alarmRecord = resolveAlarmRecord(alarm);
    alarmRecords = [...alarmRecords, structuredClone(alarmRecord)];
    notifyAlarmListeners(alarmRecord);
    return { ok: true, alarm: structuredClone(alarmRecord) };
  } catch (error) {
    console.error('[alarmsApi] addAlarm 记录非法，未入库：', error);
    return { ok: false, error };
  }
};

// 定时推送 tick：随机生成一条近设备报警，经 addAlarm 走统一入库+广播路径。
// statusPool 恒 ['pending']（评审拍板，收紧自任务原文的 pending/acked 随机）：
// 推送语义是「新报警事件到达」（time=now），恒以未处理状态置顶插入列表（§4.2 L110）
// ——新到事件随机带 acked 意为「刚发生就已处理」，语义矛盾且稀释置顶演示。
// 生成器 generateRandomAlarm 本身仍支持注入 acked（mock/alarms.verify.js 契约），
// 仅推送链路收紧。
const pushRandomAlarm = async () => {
  await addAlarm(
    generateRandomAlarm(DEVICES_SEED, {
      random: Math.random,
      now: Date.now(),
      statusPool: ['pending'],
    }),
  );
};

// 订阅实时报警推送：返回取消函数。intervalMs 可注入（node 自测把间隔压到亚秒级）；
// 将来换 WebSocket 时本函数形态不变（subscribe 返回取消函数——设计 §3.3 L88）。
export const subscribeAlarms = (listener, options = {}) => {
  const intervalMs = options?.intervalMs ?? ALARM_GENERATE_INTERVAL_MS;
  alarmListeners.add(listener);
  if (pushIntervalId === null) {
    pushIntervalId = setInterval(() => {
      pushRandomAlarm();
    }, intervalMs);
  }
  return () => {
    alarmListeners.delete(listener);
    if (alarmListeners.size === 0 && pushIntervalId !== null) {
      clearInterval(pushIntervalId);
      pushIntervalId = null;
    }
  };
};
