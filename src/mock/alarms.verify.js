// src/mock/alarms.verify.js — 报警种子与生成器纯函数契约自测（pnpm verify 自动发现挂载）
//
// ⚠ 测试先行：本文件先于 src/mock/alarms.js 与 constants.js 报警扩展落地（实施计划步骤 3），
//   在被测模块实现前 pnpm verify 对本挂载点报「找不到模块」属预期红灯（先例：mock/zones.verify.js）。
//
// ⚠ 运行环境约束：本文件在纯 node 下执行，被测 src/mock/alarms.js 零 ol/vue import；
//   定时生成逻辑全部拍成纯函数并支持依赖注入（random/now/statusPool）——node 可测性是本契约核心
//  （设计 §6 L149「mock 生成器……抽为纯函数」）。
//
// 被测契约（实施计划 testPoint「mock/alarms」+ 步骤 3；设计 §4.2 L106 数据结构）：
//   报警记录 = §4.2 L106 全部核心字段 + deviceType 扩展（计划 risks：用于单点设备图标分摄像头/传感器），
//     恰含 10 键：{ id, deviceId, deviceName, deviceType, lng, lat, type, level, time, status }。
//   ALARMS_SEED：非空初始数组，每条恰含上述 10 键；level ∈ critical/major/minor、status ∈ pending/acked、
//     id 唯一；deviceId 均存在于 DEVICES_SEED 且 deviceType/deviceName 与该设备一致（锚点不撒谎）；
//     坐标锚定所属设备（各轴差 ≤ ALARM_JITTER_RADIUS_DEG）；
//     pending 与 acked 并存（「含部分 acked 演示条数口径」：徽标数=pending 记录数，acked 不计）。
//   resolveAlarmRecord(raw)：白名单定形上表 10 键（多余键不透传，值原样保留）；
//     level/status/deviceType 枚举越界、lng/lat/time 非有限数、必填（含 id）缺失 → 抛 Error。
//     （越界坐标如 lng=181 不在此断言抛错——§5 L145 把「NaN/越界静默过滤」放在渲染消费侧
//      （buildDeviceAlarmGroups），两层职责不混；此处只锁 mock 层「坏数据早抛」。）
//   createAlarmId(now, random)：同输入同输出（确定性）；now 或 random 任一变化 → 输出变化；
//     输出为非空字符串。
//   generateRandomAlarm(devices, { random, now, statusPool })：注入固定 random/now 输出完全确定；
//     status ∈ statusPool；level ∈ critical/major/minor；输出恰含 10 键；
//     deviceId ∈ devices、deviceType 与所选设备 type 一致；
//     坐标距所选设备各轴 ≤ ALARM_JITTER_RADIUS_DEG；不同 now 连续生成 N 条 id 互不相同。
//   常量：ALARM_JITTER_RADIUS_DEG = 0.0003（计划 risks 自选决策，断言锁值防漂移）。

import { ALARMS_SEED, createAlarmId, generateRandomAlarm, resolveAlarmRecord } from './alarms.js';
import { DEVICES_SEED } from './devices.js';
import { ALARM_JITTER_RADIUS_DEG, ALARM_LEVEL_CONFIG } from '../constants.js';

// §4.2 L106 核心字段 + deviceType 的键集合（字典序，供 Object.keys().sort() deepEqual）
const EXPECTED_ALARM_KEYS = [
  'deviceId',
  'deviceName',
  'deviceType',
  'id',
  'lat',
  'level',
  'lng',
  'status',
  'time',
  'type',
];
const ALARM_LEVEL_KEYS = Object.keys(ALARM_LEVEL_CONFIG);
const ALARM_STATUS_POOL = ['pending', 'acked'];
// 抖动半径的浮点容差：实现如 (random()-0.5)*2*R 取边界时可能有 ~1e-18 级误差
const JITTER_TOLERANCE = 1e-9;

// 合法定形样例（resolveZoneProperties 先例：自造设备 id，deviceId 是否真实存在由 join 层负责，不在纯定形职责内）
const VALID_ALARM_INPUT = {
  id: 'alarm-record-sample',
  deviceId: 'device-sample',
  deviceName: '样例设备',
  deviceType: 'camera',
  lng: 121.4737,
  lat: 31.2304,
  type: '移动侦测',
  level: 'major',
  time: 1758000000000,
  status: 'pending',
};

// 反查报警所属设备（找不到返回 undefined，由调用处断言）
const findDeviceById = (deviceId) => DEVICES_SEED.find((device) => device.id === deviceId);

// 断言一条报警记录「锚定设备」：deviceId 存在 + deviceType 一致 + 坐标各轴差 ≤ 抖动半径
const assertAnchoredToDevice = (assert, alarm, label) => {
  const matchedDevice = findDeviceById(alarm.deviceId);
  assert.ok(matchedDevice, `${label}：deviceId「${String(alarm.deviceId)}」应存在于 DEVICES_SEED`);
  assert.equal(
    alarm.deviceType,
    matchedDevice.type,
    `${label}：deviceType 应与所属设备 type 一致（单点设备图标的分组依据）`,
  );
  assert.ok(
    Math.abs(alarm.lng - matchedDevice.lng) <= ALARM_JITTER_RADIUS_DEG + JITTER_TOLERANCE,
    `${label}：经度距所属设备 ${Math.abs(alarm.lng - matchedDevice.lng)} 应 ≤ ALARM_JITTER_RADIUS_DEG（${ALARM_JITTER_RADIUS_DEG}）`,
  );
  assert.ok(
    Math.abs(alarm.lat - matchedDevice.lat) <= ALARM_JITTER_RADIUS_DEG + JITTER_TOLERANCE,
    `${label}：纬度距所属设备 ${Math.abs(alarm.lat - matchedDevice.lat)} 应 ≤ ALARM_JITTER_RADIUS_DEG（${ALARM_JITTER_RADIUS_DEG}）`,
  );
};

export const verify = (assert) => {
  // —— 常量：抖动半径 0.0003° ——
  assert.equal(ALARM_JITTER_RADIUS_DEG, 0.0003, 'ALARM_JITTER_RADIUS_DEG 应为 0.0003°（计划 risks 自选决策）');

  // ================= resolveAlarmRecord：白名单定形 + 非法抛 Error =================

  const resolvedRecord = resolveAlarmRecord(VALID_ALARM_INPUT);
  assert.deepEqual(
    Object.keys(resolvedRecord).sort(),
    EXPECTED_ALARM_KEYS,
    'resolveAlarmRecord 输出应恰含 §4.2 L106 核心字段 + deviceType（共 10 键）',
  );
  assert.deepEqual(
    resolvedRecord,
    VALID_ALARM_INPUT,
    '合法输入的定形结果应与输入逐字段一致（值原样保留）',
  );

  // 白名单：多余键不透传
  const resolvedWithExtra = resolveAlarmRecord({ ...VALID_ALARM_INPUT, extra: '不应透传' });
  assert.deepEqual(
    Object.keys(resolvedWithExtra).sort(),
    EXPECTED_ALARM_KEYS,
    '输入携带越界键（extra）不应透传进定形结果（白名单定形）',
  );

  // 非法输入抛 Error：枚举越界 / 非有限数 / 必填缺失
  assert.throws(
    () => resolveAlarmRecord({ ...VALID_ALARM_INPUT, level: 'urgent' }),
    Error,
    "level='urgent' 不在 critical/major/minor 应抛 Error",
  );
  assert.throws(
    () => resolveAlarmRecord({ ...VALID_ALARM_INPUT, status: 'open' }),
    Error,
    "status='open' 不在 pending/acked 应抛 Error",
  );
  assert.throws(
    () => resolveAlarmRecord({ ...VALID_ALARM_INPUT, deviceType: 'drone' }),
    Error,
    "deviceType='drone' 不在 DEVICE_TYPE_CONFIG 键集合应抛 Error",
  );
  assert.throws(
    () => resolveAlarmRecord({ ...VALID_ALARM_INPUT, lng: NaN }),
    Error,
    'lng=NaN 应抛 Error（mock 层坏数据早暴露；渲染侧静默过滤不豁免生成层）',
  );
  assert.throws(
    () => resolveAlarmRecord({ ...VALID_ALARM_INPUT, lat: Infinity }),
    Error,
    'lat=Infinity 应抛 Error（非有限数）',
  );
  assert.throws(
    () => resolveAlarmRecord({ ...VALID_ALARM_INPUT, time: NaN }),
    Error,
    'time=NaN 应抛 Error（时间驱动列表倒序与锚点取最新，坏时间必须早抛）',
  );
  assert.throws(
    () => resolveAlarmRecord({ ...VALID_ALARM_INPUT, id: undefined }),
    Error,
    'id 缺失应抛 Error（必填字段）',
  );

  // ================= createAlarmId：确定性 + 扰动敏感性 =================

  assert.equal(typeof createAlarmId, 'function', 'createAlarmId 应为具名导出函数');
  const FIXED_RANDOM = () => 0.42;
  const FIXED_NOW = 1758000000000;
  assert.equal(
    createAlarmId(FIXED_NOW, FIXED_RANDOM),
    createAlarmId(FIXED_NOW, FIXED_RANDOM),
    '同 (now, random) 输入应产出相同 id（确定性）',
  );
  assert.notEqual(
    createAlarmId(FIXED_NOW, FIXED_RANDOM),
    createAlarmId(FIXED_NOW + 1, FIXED_RANDOM),
    'now 变化后 id 应变化（时间戳参与 id 生成）',
  );
  assert.notEqual(
    createAlarmId(FIXED_NOW, FIXED_RANDOM),
    createAlarmId(FIXED_NOW, () => 0.9),
    'random 变化后 id 应变化（随机串参与 id 生成）',
  );
  assert.ok(
    typeof createAlarmId(FIXED_NOW, FIXED_RANDOM) === 'string' &&
      createAlarmId(FIXED_NOW, FIXED_RANDOM).length > 0,
    'id 应为非空字符串',
  );

  // ================= generateRandomAlarm：注入确定性 + 形状 + 近设备 =================

  const buildFixedOptions = () => ({ random: () => 0.42, now: FIXED_NOW, statusPool: ['pending'] });
  assert.deepEqual(
    generateRandomAlarm(DEVICES_SEED, buildFixedOptions()),
    generateRandomAlarm(DEVICES_SEED, buildFixedOptions()),
    '注入固定 random/now 应产出完全确定的记录（两次调用 deepEqual）',
  );

  // statusPool 生效
  assert.equal(
    generateRandomAlarm(DEVICES_SEED, { ...buildFixedOptions(), statusPool: ['pending'] }).status,
    'pending',
    "statusPool=['pending'] 时生成记录 status 应恰为 pending",
  );
  assert.equal(
    generateRandomAlarm(DEVICES_SEED, { ...buildFixedOptions(), statusPool: ['acked'] }).status,
    'acked',
    "statusPool=['acked'] 时生成记录 status 应恰为 acked",
  );

  // 多档 random 值：形状 + 枚举 + 锚定设备（选择因实现而异，断言按输出的 deviceId 反查，与选中逻辑解耦）
  const RANDOM_SAMPLES = [0.01, 0.17, 0.33, 0.5, 0.66, 0.83, 0.99];
  RANDOM_SAMPLES.forEach((randomValue, index) => {
    const generated = generateRandomAlarm(DEVICES_SEED, {
      random: () => randomValue,
      now: FIXED_NOW,
      statusPool: ['pending', 'acked'],
    });
    const label = `random=${randomValue} 样例 ${index}`;
    assert.deepEqual(
      Object.keys(generated).sort(),
      EXPECTED_ALARM_KEYS,
      `${label}：应恰含 §4.2 L106 全部核心字段 + deviceType`,
    );
    assert.ok(
      ALARM_LEVEL_KEYS.includes(generated.level),
      `${label}：level 应 ∈ critical/major/minor`,
    );
    assert.ok(
      ALARM_STATUS_POOL.includes(generated.status),
      `${label}：status 应 ∈ pending/acked`,
    );
    assert.ok(Number.isFinite(generated.time), `${label}：time 应为有限数`);
    assert.ok(
      Number.isFinite(generated.lng) && Number.isFinite(generated.lat),
      `${label}：坐标应为有限数（生成器不得产出 NaN——§5 静默过滤是渲染侧兜底，不是生成许可）`,
    );
    assertAnchoredToDevice(assert, generated, label);
  });

  // 连续生成 N 条 id 互不相同（now 递增驱动——同一秒级时间窗内多台设备同时报警不得互相覆盖）
  const SEQUENCE_LENGTH = 8;
  const generatedSequence = Array.from({ length: SEQUENCE_LENGTH }, (unused, index) =>
    generateRandomAlarm(DEVICES_SEED, {
      random: () => 0.42,
      now: FIXED_NOW + index,
      statusPool: ['pending'],
    }),
  );
  assert.equal(
    new Set(generatedSequence.map((alarm) => alarm.id)).size,
    SEQUENCE_LENGTH,
    `不同 now 连续生成 ${SEQUENCE_LENGTH} 条 id 应互不相同`,
  );

  // ================= ALARMS_SEED：初始数据契约 =================

  assert.ok(Array.isArray(ALARMS_SEED), 'ALARMS_SEED 应为数组');
  assert.ok(ALARMS_SEED.length > 0, 'ALARMS_SEED 应为非空数组（初始演示数据）');
  ALARMS_SEED.forEach((alarm, index) => {
    const label = `种子第 ${index} 条`;
    assert.deepEqual(
      Object.keys(alarm).sort(),
      EXPECTED_ALARM_KEYS,
      `${label}：应恰含 §4.2 L106 全部核心字段 + deviceType`,
    );
    assert.ok(ALARM_LEVEL_KEYS.includes(alarm.level), `${label}：level 应 ∈ critical/major/minor`);
    assert.ok(ALARM_STATUS_POOL.includes(alarm.status), `${label}：status 应 ∈ pending/acked`);
    assert.ok(Number.isFinite(alarm.time), `${label}：time 应为有限数`);
    assertAnchoredToDevice(assert, alarm, label);
  });
  assert.equal(
    new Set(ALARMS_SEED.map((alarm) => alarm.id)).size,
    ALARMS_SEED.length,
    '种子 id 应互不相同',
  );
  assert.ok(
    ALARMS_SEED.some((alarm) => alarm.status === 'pending'),
    '种子应含 pending 记录（右侧列表与徽标的数据来源）',
  );
  assert.ok(
    ALARMS_SEED.some((alarm) => alarm.status === 'acked'),
    '种子应含 acked 记录（演示条数口径：徽标数=pending 记录数，acked 不计——种子须同时存在两类才能演示）',
  );
};
