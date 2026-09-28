// src/api/index.js — api 适配层统一出口（设计 §3.2 L71-72、§3.3 L86）。
//
// AGENTS.md 分层约定：组件与 composable 只能 import 本目录（api/*），禁止直接 import mock/*；
// 将来接入真实后端时只替换本层实现，组件与 composable 零改动（设计 §1）。
//
// mock/real 切换：环境变量 VITE_API_MODE（缺省 'mock'）。
// import.meta.env?. 的可选链写法在纯 node（无 vite 运行时）下安全（undefined 短路）；
// 'real' 为预留开关——真实后端实现尚未接入，调用时显式抛错占位，不虚构实现。
import { getZones as getZonesMock, saveZones as saveZonesMock } from './zonesApi.js';
import {
  getAlarms as getAlarmsMock,
  ackAlarm as ackAlarmMock,
  addAlarm as addAlarmMock,
  subscribeAlarms as subscribeAlarmsMock,
} from './alarmsApi.js';
import {
  getVehicles as getVehiclesMock,
  getTrack as getTrackMock,
  subscribePositions as subscribePositionsMock,
} from './vehiclesApi.js';

export const API_MODE = import.meta.env?.VITE_API_MODE ?? 'mock';

const assertApiModeAvailable = (methodName) => {
  if (API_MODE === 'real') {
    throw new Error(`api.${methodName}：真实后端实现尚未接入（VITE_API_MODE='real' 仅预留开关）`);
  }
};

// 取厂区 GeoJSON（EPSG:4326 FeatureCollection）
export const getZones = async () => {
  assertApiModeAvailable('getZones');
  return getZonesMock();
};

// 保存厂区 GeoJSON；resolve { ok: true } 或 { ok: false, error }（不 reject）
export const saveZones = async (geojson) => {
  assertApiModeAvailable('saveZones');
  return saveZonesMock(geojson);
};

// 取报警列表（设计 §4.2 L106：每条记录 = 一次报警事件）
export const getAlarms = async () => {
  assertApiModeAvailable('getAlarms');
  return getAlarmsMock();
};

// 标记处理一条报警；resolve { ok: true, alarm } 或 { ok: false, error }（不 reject）
export const ackAlarm = async (alarmId) => {
  assertApiModeAvailable('ackAlarm');
  return ackAlarmMock(alarmId);
};

// 追加报警并同步通知全部订阅者（§4.5 L128 围栏报警经此与报警联动全套打通）
export const addAlarm = async (alarm) => {
  assertApiModeAvailable('addAlarm');
  return addAlarmMock(alarm);
};

// 订阅实时报警推送（mock setInterval 模拟，将来换 WebSocket 调用方不变）；返回取消函数
export const subscribeAlarms = (listener, options) => {
  assertApiModeAvailable('subscribeAlarms');
  return subscribeAlarmsMock(listener, options);
};

// 取车辆清单（设计 §4.3 L112：id/name/color 各异的巡逻车队）
export const getVehicles = async () => {
  assertApiModeAvailable('getVehicles');
  return getVehiclesMock();
};

// 取历史轨迹（mock 08:00–18:00 全窗或 range 闭区间切片）；
// resolve { ok: true, points } 或 { ok: false, error }（不 reject）
export const getTrack = async (vehicleId, range) => {
  assertApiModeAvailable('getTrack');
  return getTrackMock(vehicleId, range);
};

// 订阅实时位置推送（mock setInterval 沿路线推进，将来换 WebSocket 调用方不变）；返回取消函数
export const subscribePositions = (listener, options) => {
  assertApiModeAvailable('subscribePositions');
  return subscribePositionsMock(listener, options);
};
