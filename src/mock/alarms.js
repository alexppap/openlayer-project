// src/mock/alarms.js — 报警种子数据 + 定时生成器纯函数（设计 §4.2 L106、§4.5 L128）。
//
// ⚠ 纯数据/纯函数模块：零 ol/vue import（mock/alarms.verify.js 在纯 node 下断言）。
//   定时逻辑全部依赖注入（random/now/statusPool），node 可确定性自测（设计 §6 L149）。
//
// 记录结构（§4.2 L106 全部核心字段 + deviceType 扩展，共恰 10 键）：
//   { id, deviceId, deviceName, deviceType, lng, lat, type, level, time, status }
//   deviceType 为「非聚合单点=设备图标」分摄像头/传感器提供分组依据（只增不删不改核心字段）。
// 坐标锚定所属设备（各轴差 ≤ ALARM_JITTER_RADIUS_DEG）；一条记录 = 一次报警事件。
import {
  ALARM_JITTER_RADIUS_DEG,
  ALARM_LEVEL_CONFIG,
  ALARM_SEVERITY_ORDER,
  ALARM_STATUS,
  DEVICE_TYPE_CONFIG,
} from '../constants.js';
import { DEVICES_SEED } from './devices.js';

// 按设备类型划分的报警类型池（摄像头→视频类事件、传感器→环境量超限）
const ALARM_TYPE_POOL = {
  camera: ['移动侦测', '视频信号丢失', '越界侦测'],
  sensor: ['温度超限', '气体浓度异常', '湿度异常'],
};

// 白名单定形（resolveZoneProperties 先例）：§4.2 L106 核心字段 + deviceType，
// 多余键不透传、值原样保留；枚举越界 / 坐标时间非有限数 / 必填缺失早抛 Error
// （§5 L145 的渲染侧静默过滤不豁免生成层——坏数据在 mock 层就该炸出来）。
export const resolveAlarmRecord = (raw) => {
  const requiredTextFields = ['id', 'deviceId', 'deviceName', 'type'];
  requiredTextFields.forEach((fieldName) => {
    const fieldValue = raw?.[fieldName];
    if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
      throw new Error(`报警记录字段 ${fieldName} 缺失或为空白字符串`);
    }
  });
  if (!Object.hasOwn(DEVICE_TYPE_CONFIG, raw.deviceType)) {
    throw new Error(`未知设备类型「${String(raw.deviceType)}」（应 ∈ camera/sensor）`);
  }
  if (!Object.hasOwn(ALARM_LEVEL_CONFIG, raw.level)) {
    throw new Error(`未知报警等级「${String(raw.level)}」（应 ∈ critical/major/minor）`);
  }
  if (!Object.hasOwn(ALARM_STATUS, raw.status)) {
    throw new Error(`未知报警状态「${String(raw.status)}」（应 ∈ pending/acked）`);
  }
  ['lng', 'lat', 'time'].forEach((fieldName) => {
    if (!Number.isFinite(raw[fieldName])) {
      throw new Error(`报警记录字段 ${fieldName} 应为有限数，实际「${String(raw[fieldName])}」`);
    }
  });
  return {
    id: raw.id,
    deviceId: raw.deviceId,
    deviceName: raw.deviceName,
    deviceType: raw.deviceType,
    lng: raw.lng,
    lat: raw.lat,
    type: raw.type,
    level: raw.level,
    time: raw.time,
    status: raw.status,
  };
};

// 报警 id 生成（时间戳 + 随机串，确定性：同 (now, random) 同输出；任一变化输出变化）
export const createAlarmId = (now, random) =>
  `alarm-${now.toString(36)}-${Math.floor(random() * 1e9).toString(36)}`;

// 在设备点位附近随机生成一条报警（全部依赖注入，node 可确定性自测）：
//   devices：候选设备池（随机选一台）；options.random：[0,1) 随机源；options.now：时间戳；
//   options.statusPool：status 取值池（默认 pending/acked——任务原文「status 取 pending/acked」）。
//   坐标 = 设备坐标 ± ALARM_JITTER_RADIUS_DEG 抖动；level 按 ALARM_SEVERITY_ORDER 随机；
//   type 按所选设备类型（camera/sensor）在 ALARM_TYPE_POOL 中随机。
export const generateRandomAlarm = (
  devices,
  { random = Math.random, now = Date.now(), statusPool = Object.keys(ALARM_STATUS) } = {},
) => {
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error('generateRandomAlarm：候选设备池为空，无从生成报警');
  }
  const device = devices[Math.floor(random() * devices.length)];
  const level = ALARM_SEVERITY_ORDER[Math.floor(random() * ALARM_SEVERITY_ORDER.length)];
  const status = statusPool[Math.floor(random() * statusPool.length)];
  const typePool = ALARM_TYPE_POOL[device.type] ?? ALARM_TYPE_POOL.camera;
  return resolveAlarmRecord({
    id: createAlarmId(now, random),
    deviceId: device.id,
    deviceName: device.name,
    deviceType: device.type,
    lng: device.lng + (random() - 0.5) * 2 * ALARM_JITTER_RADIUS_DEG,
    lat: device.lat + (random() - 0.5) * 2 * ALARM_JITTER_RADIUS_DEG,
    type: typePool[Math.floor(random() * typePool.length)],
    level,
    time: now,
    status,
  });
};

// ---- 初始报警数据（演示条数口径：pending 与 acked 并存，徽标数=pending 记录数）----
// 时间基准为固定值（非 Date.now），保证种子数据稳定可断言；坐标锚定所属设备。
const SEED_TIME_BASE = 1758000000000;

export const ALARMS_SEED = [
  {
    id: 'alarm-seed-001',
    deviceId: 'dev-cam-01',
    deviceName: '生产区西侧摄像头',
    deviceType: 'camera',
    lng: 121.4705,
    lat: 31.2295,
    type: '移动侦测',
    level: 'critical',
    time: SEED_TIME_BASE + 7 * 60 * 1000,
    status: 'pending',
  },
  {
    id: 'alarm-seed-002',
    deviceId: 'dev-cam-01',
    deviceName: '生产区西侧摄像头',
    deviceType: 'camera',
    lng: 121.4705,
    lat: 31.2295,
    type: '视频信号丢失',
    level: 'major',
    time: SEED_TIME_BASE + 5 * 60 * 1000,
    status: 'pending',
  },
  {
    id: 'alarm-seed-003',
    deviceId: 'dev-sensor-01',
    deviceName: '生产区温度传感器',
    deviceType: 'sensor',
    lng: 121.4703,
    lat: 31.23,
    type: '温度超限',
    level: 'major',
    time: SEED_TIME_BASE + 6 * 60 * 1000,
    status: 'pending',
  },
  {
    id: 'alarm-seed-004',
    deviceId: 'dev-cam-06',
    deviceName: '危险品区摄像头',
    deviceType: 'camera',
    lng: 121.4737,
    lat: 31.2267,
    type: '移动侦测',
    level: 'critical',
    time: SEED_TIME_BASE + 4 * 60 * 1000,
    status: 'acked',
  },
  {
    id: 'alarm-seed-005',
    deviceId: 'dev-sensor-06',
    deviceName: '危险品区气体传感器',
    deviceType: 'sensor',
    lng: 121.4733,
    lat: 31.2265,
    type: '气体浓度异常',
    level: 'major',
    time: SEED_TIME_BASE + 3 * 60 * 1000,
    status: 'pending',
  },
  {
    id: 'alarm-seed-006',
    deviceId: 'dev-cam-03',
    deviceName: '仓储区北门摄像头',
    deviceType: 'camera',
    lng: 121.476,
    lat: 31.2312,
    type: '越界侦测',
    level: 'minor',
    time: SEED_TIME_BASE + 2 * 60 * 1000,
    status: 'acked',
  },
  {
    id: 'alarm-seed-007',
    deviceId: 'dev-sensor-03',
    deviceName: '仓储区温度传感器',
    deviceType: 'sensor',
    lng: 121.4755,
    lat: 31.23,
    type: '温度超限',
    level: 'minor',
    time: SEED_TIME_BASE + 1 * 60 * 1000,
    status: 'acked',
  },
  {
    id: 'alarm-seed-008',
    deviceId: 'dev-cam-05',
    deviceName: '办公区入口摄像头',
    deviceType: 'camera',
    lng: 121.4735,
    lat: 31.2328,
    type: '移动侦测',
    level: 'minor',
    time: SEED_TIME_BASE,
    status: 'pending',
  },
].map((rawRecord) => resolveAlarmRecord(rawRecord));
