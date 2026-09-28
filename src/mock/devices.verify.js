// src/mock/devices.verify.js — 设备点位种子契约自测（pnpm verify 自动发现挂载）
//
// ⚠ 测试先行：本文件先于 src/mock/devices.js 与 constants.js 设备枚举落地（实施计划步骤 2），
//   在被测模块实现前 pnpm verify 对本挂载点报「找不到模块」属预期红灯（先例：mock/zones.verify.js）。
//
// ⚠ 运行环境约束：本文件在纯 node（无 vite/vue/ol）下执行，
//   被测 src/mock/devices.js 必须是纯数据模块（零 ol/vue import，node 可导入——实施计划步骤 2）。
//
// 被测契约（实施计划 testPoint「mock/devices」+ 步骤 2；设计 §4.4 L124 设备点位为报警提供锚点，
// 本任务只落数据，不做 useDevices/DevicePopup）：
//   DEVICES_SEED：恰 12 台设备（摄像头 camera 6 + 环境传感器 sensor 6），每条白名单定形
//     { id, name, type, status, lng, lat }（恰六键，多余键不透传——对齐 resolveZoneProperties 白名单精神）；
//     type ∈ DEVICE_TYPE_CONFIG 键、status ∈ DEVICE_STATUS 键（两枚举为计划步骤 1 constants.js 新增）；
//     id 唯一非空、name 非空白；坐标为有限数且经纬度合法（业务坐标 EPSG:4326）；
//     距 MAP_DEFAULT_VIEW.center 各轴 ≤ 0.02°，且落在 mock/zones.js 四区域整体包围盒内
//     （「报警在设备点位附近生成」的空间前提：设备必须与厂区同域，不能漂到厂区外）。
//   DEVICE_TYPE_CONFIG：键集合恰 camera/sensor，每项含非空 label（摄像头/环境传感器——计划步骤 1）；
//   DEVICE_STATUS：键集合恰 online/offline，值为非空中文文案（断言风格对齐 scripts/verify.js 的 ALARM_STATUS 项）。

import { DEVICES_SEED } from './devices.js';
import { ZONES_SEED_GEOJSON } from './zones.js';
import { DEVICE_STATUS, DEVICE_TYPE_CONFIG, MAP_DEFAULT_VIEW } from '../constants.js';

// 四区域种子的整体包围盒（从 ZONES_SEED_GEOJSON 动态计算，不在测试里双处硬编码坐标；
// 设备须落在该盒内——lng ∈ [约121.4698, 约121.4775]、lat ∈ [约31.226, 约31.234]）
const ZONE_SEED_POINTS = ZONES_SEED_GEOJSON.features.flatMap((feature) => feature.geometry.coordinates.flat());
const ZONES_BBOX = {
  lngMin: Math.min(...ZONE_SEED_POINTS.map((point) => point[0])),
  lngMax: Math.max(...ZONE_SEED_POINTS.map((point) => point[0])),
  latMin: Math.min(...ZONE_SEED_POINTS.map((point) => point[1])),
  latMax: Math.max(...ZONE_SEED_POINTS.map((point) => point[1])),
};

export const verify = (assert) => {
  // —— 枚举契约：DEVICE_TYPE_CONFIG 键集合恰 camera/sensor，每项含非空 label ——
  assert.deepEqual(
    Object.keys(DEVICE_TYPE_CONFIG),
    ['camera', 'sensor'],
    'DEVICE_TYPE_CONFIG 键集合应为 camera（摄像头）/ sensor（环境传感器）',
  );
  Object.entries(DEVICE_TYPE_CONFIG).forEach(([deviceType, config]) => {
    assert.equal(typeof config.label, 'string', `DEVICE_TYPE_CONFIG.${deviceType}.label 应为字符串`);
    assert.ok(
      config.label.trim().length > 0,
      `DEVICE_TYPE_CONFIG.${deviceType}.label 应为非空白文案`,
    );
  });

  // —— 枚举契约：DEVICE_STATUS 键集合恰 online/offline，值为非空中文 ——
  assert.deepEqual(
    Object.keys(DEVICE_STATUS),
    ['online', 'offline'],
    'DEVICE_STATUS 键集合应为 online/offline',
  );
  Object.entries(DEVICE_STATUS).forEach(([status, label]) => {
    assert.equal(typeof label, 'string', `DEVICE_STATUS.${status} 应为字符串`);
    assert.match(label, /[\u4e00-\u9fff]/, `DEVICE_STATUS.${status} 应为中文文案`);
    assert.ok(label.trim().length > 0, `DEVICE_STATUS.${status} 不应为空白串`);
  });

  // —— 种子形状：恰 12 台，camera 6 + sensor 6 ——
  assert.ok(Array.isArray(DEVICES_SEED), 'DEVICES_SEED 应为数组');
  assert.equal(
    DEVICES_SEED.length,
    12,
    'DEVICES_SEED 应恰含 12 台设备（实施计划步骤 2：摄像头 6 + 传感器 6）',
  );
  const typeCounts = DEVICES_SEED.reduce((accumulator, device) => {
    accumulator[device.type] = (accumulator[device.type] ?? 0) + 1;
    return accumulator;
  }, {});
  assert.equal(typeCounts.camera, 6, '摄像头（camera）应恰 6 台');
  assert.equal(typeCounts.sensor, 6, '环境传感器（sensor）应恰 6 台');

  // —— 逐台：白名单定形 + 字段类型 + 枚举归属 ——
  DEVICES_SEED.forEach((device, index) => {
    const label = `第 ${index} 台设备`;
    assert.deepEqual(
      Object.keys(device).sort(),
      ['id', 'lat', 'lng', 'name', 'status', 'type'],
      `${label} 应恰含 { id, name, type, status, lng, lat } 六键（白名单定形，多余键不透传）`,
    );
    assert.equal(typeof device.id, 'string', `${label} id 应为字符串`);
    assert.ok(device.id.trim().length > 0, `${label} id 应为非空白`);
    assert.equal(typeof device.name, 'string', `${label} name 应为字符串`);
    assert.ok(device.name.trim().length > 0, `${label} name 应为非空白名称`);
    assert.ok(
      Object.hasOwn(DEVICE_TYPE_CONFIG, device.type),
      `${label} type「${String(device.type)}」应 ∈ DEVICE_TYPE_CONFIG 键集合`,
    );
    assert.ok(
      Object.hasOwn(DEVICE_STATUS, device.status),
      `${label} status「${String(device.status)}」应 ∈ DEVICE_STATUS 键集合`,
    );
    assert.ok(Number.isFinite(device.lng), `${label} lng 应为有限数`);
    assert.ok(Number.isFinite(device.lat), `${label} lat 应为有限数`);
  });

  // —— id 唯一 ——
  assert.equal(
    new Set(DEVICES_SEED.map((device) => device.id)).size,
    DEVICES_SEED.length,
    '全部设备 id 应互不相同',
  );

  // —— 坐标域：经纬度合法范围 + 距默认视野中心 ≤0.02° + 落厂区四区域包围盒 ——
  const [centerLng, centerLat] = MAP_DEFAULT_VIEW.center;
  DEVICES_SEED.forEach((device, index) => {
    const label = `第 ${index} 台设备（${device.id}）`;
    assert.ok(
      device.lng >= -180 && device.lng <= 180,
      `${label} 经度 ${device.lng} 应在 [-180,180]（业务坐标存 EPSG:4326，非 3857 米制）`,
    );
    assert.ok(
      device.lat >= -90 && device.lat <= 90,
      `${label} 纬度 ${device.lat} 应在 [-90,90]（业务坐标存 EPSG:4326，非 3857 米制）`,
    );
    assert.ok(
      Math.abs(device.lng - centerLng) <= 0.02,
      `${label} 经度偏离默认视野中心 ${Math.abs(device.lng - centerLng)}° 应 ≤ 0.02°`,
    );
    assert.ok(
      Math.abs(device.lat - centerLat) <= 0.02,
      `${label} 纬度偏离默认视野中心 ${Math.abs(device.lat - centerLat)}° 应 ≤ 0.02°`,
    );
    assert.ok(
      device.lng >= ZONES_BBOX.lngMin && device.lng <= ZONES_BBOX.lngMax,
      `${label} 经度 ${device.lng} 应落在厂区四区域包围盒 [${ZONES_BBOX.lngMin}, ${ZONES_BBOX.lngMax}] 内`,
    );
    assert.ok(
      device.lat >= ZONES_BBOX.latMin && device.lat <= ZONES_BBOX.latMax,
      `${label} 纬度 ${device.lat} 应落在厂区四区域包围盒 [${ZONES_BBOX.latMin}, ${ZONES_BBOX.latMax}] 内`,
    );
  });
};
