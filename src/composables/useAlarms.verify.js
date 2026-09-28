// src/composables/useAlarms.verify.js — 报警分组/徽标纯函数与图层常量契约自测（pnpm verify 自动发现挂载）
//
// ⚠ 测试先行：本文件先于 src/composables/useAlarms.js 与 constants.js 报警扩展落地（实施计划步骤 7），
//   在被测模块实现前 pnpm verify 对本挂载点报「找不到模块/导出不存在」属预期红灯
//  （先例：useZones.verify.js 头注）。
//
// ⚠ 运行环境约束：本文件在纯 node 下执行。useAlarms.js 模块顶层只允许 vue ref 与纯函数
//   （ol 实例/Overlay/DOM 一律在 initAlarms 惰性构造——计划 risks node 兼容红线，先例 useZones.js:7-9）。
//
// 被测契约（实施计划 testPoint「useAlarms 纯函数」+ 步骤 1/7；
// 设计 §4.2 L106-107 条数口径、§5 L145 坐标静默过滤）：
//
// ★ 本文件断言即契约（组形状由本文件定义，实现须对齐——手法先例：scripts/verify.js 的 SPEED_COLOR_STOPS）：
//   buildDeviceAlarmGroups(alarms) → Array<DeviceAlarmGroup>：
//     DeviceAlarmGroup = {
//       deviceId, deviceName, deviceType,   // 透传组内记录（同一设备的记录这些字段一致）
//       anchor: [lng, lat],                 // 组内 time 最大（最新）记录的坐标（单点渲染锚点）
//       records: AlarmRecord[],             // 组内记录按 time 倒序（新 → 旧，AlarmPopup 明细列表序）
//       pendingCount: number,               // ★条数口径：records 中 status==='pending' 的条数，acked 不计
//     }
//     - 按 deviceId 分组（同设备多条报警归一个点位）；
//     - 坐标非法（NaN/±Infinity/越界如 181/-91）的记录★静默剔除不抛错（设计 §5 L145），
//       组内全部非法则整组不出现（无合法锚点可渲染）；空数组 → []。
//   resolveAlarmBadgeInfo(groups) → { pendingCount, color }：
//     - pendingCount = 各组 pendingCount 之和（聚合点徽标 = 聚合内所有点 pending 之和，§4.2 L106）；
//     - color = 全部 pending 记录中最高等级的 ALARM_LEVEL_CONFIG 色
//      （等级序 = ALARM_SEVERITY_ORDER：critical > major > minor；★acked 记录不参与取色）；
//     - 无 pending（含空数组）→ { pendingCount: 0, color: ALARM_NEUTRAL_COLOR }（回退中性灰）。
//   常量（计划步骤 1）：ALARMS_LAYER_ID='alarms-layer'（kebab-case，AGENTS.md 命名规范）；
//     LAYER_TREE_GROUPS 含 { label:'报警', layerIds:[ALARMS_LAYER_ID] }（图层树统一显隐）；
//     ALARM_NEUTRAL_COLOR='#8c8c8c'；ALARM_SEVERITY_ORDER=['critical','major','minor']。
//
// 诚实缺口（计划 risks 已声明）：canvas 徽标绘制、Cluster 聚合渲染、弹窗/列表双向联动、
//   flyTo/滚动/脉冲高亮均为浏览器行为，node 无法断言，留待人工验收（设计 §6 L153 item 3）；
//   徽标可测的尺寸数学在 map/utils.verify.js 的 resolveBadgeMetrics 断言。

import { buildDeviceAlarmGroups, resolveAlarmBadgeInfo, resolveAlarmLocateTarget } from './useAlarms.js';
import {
  ALARM_LEVEL_CONFIG,
  ALARM_NEUTRAL_COLOR,
  ALARM_SEVERITY_ORDER,
  ALARMS_LAYER_ID,
  LAYER_TREE_GROUPS,
} from '../constants.js';

const GROUP_TIME_BASE = 1758000000000;

// 构造一条形状对齐 §4.2 L106 + deviceType 的报警记录（用例字段值自造，与真实种子无关）
const makeAlarmRecord = (overrides) => ({
  id: 'alarm-case',
  deviceId: 'dev-cam-01',
  deviceName: '一号摄像头',
  deviceType: 'camera',
  lng: 121.47,
  lat: 31.23,
  type: '移动侦测',
  level: 'major',
  time: GROUP_TIME_BASE,
  status: 'pending',
  ...overrides,
});

// 手工构造对齐上述契约的组（resolveAlarmBadgeInfo 的单测输入，刻意不经 buildDeviceAlarmGroups，
// 保证两函数互不背锅：分组函数的回归不应使徽标函数的用例悄悄变形）
const makeDeviceGroup = ({ records, deviceId = 'dev-badge-01' }) => ({
  deviceId,
  deviceName: '徽标用例设备',
  deviceType: 'camera',
  anchor: [121.47, 31.23],
  records,
  pendingCount: records.filter((record) => record.status === 'pending').length,
});

const pendingRecordOfLevel = (level) =>
  makeAlarmRecord({ id: `pending-${level}`, level, status: 'pending' });

export const verify = (assert) => {
  // ================= 常量契约（计划步骤 1）=================

  assert.equal(ALARMS_LAYER_ID, 'alarms-layer', "ALARMS_LAYER_ID 应为 'alarms-layer'（kebab-case）");
  assert.equal(ALARM_NEUTRAL_COLOR, '#8c8c8c', "ALARM_NEUTRAL_COLOR 应为 '#8c8c8c'（全 acked 回退中性灰）");
  assert.deepEqual(
    ALARM_SEVERITY_ORDER,
    ['critical', 'major', 'minor'],
    'ALARM_SEVERITY_ORDER 应恰为 [critical, major, minor]（序即优先级，供徽标取最高 pending 等级）',
  );
  const alarmTreeGroup = LAYER_TREE_GROUPS.find((group) => group.label === '报警');
  assert.ok(alarmTreeGroup, "LAYER_TREE_GROUPS 应含 label='报警' 分组（图层树统一控制显隐）");
  assert.deepEqual(
    alarmTreeGroup.layerIds,
    [ALARMS_LAYER_ID],
    '报警分组的 layerIds 应恰为 [ALARMS_LAYER_ID]',
  );

  // ================= buildDeviceAlarmGroups =================

  // —— 案例一：同设备 3 pending + 2 acked → 一组，pendingCount=3（★条数口径核心断言），组内时间倒序，锚点=最新记录坐标 ——
  const singleDeviceAlarms = [
    makeAlarmRecord({ id: 'a-oldest', status: 'acked', time: GROUP_TIME_BASE }),
    makeAlarmRecord({ id: 'a-2', status: 'pending', time: GROUP_TIME_BASE + 2000 }),
    makeAlarmRecord({ id: 'a-3', status: 'acked', time: GROUP_TIME_BASE + 3000 }),
    makeAlarmRecord({
      id: 'a-newest',
      status: 'pending',
      time: GROUP_TIME_BASE + 5000,
      lng: 121.4705,
      lat: 31.2306,
    }),
    makeAlarmRecord({ id: 'a-5', status: 'pending', time: GROUP_TIME_BASE + 1000 }),
  ];
  const singleGroups = buildDeviceAlarmGroups(singleDeviceAlarms);
  assert.ok(Array.isArray(singleGroups), 'buildDeviceAlarmGroups 应返回数组');
  assert.equal(singleGroups.length, 1, '同 deviceId 的 5 条记录应归为一组');
  const [singleGroup] = singleGroups;
  assert.equal(
    singleGroup.pendingCount,
    3,
    '★条数口径：3 pending + 2 acked → pendingCount 应恰为 3（acked 不计入徽标，设计 §4.2 L106-107）',
  );
  assert.equal(singleGroup.records.length, 5, '组内应保留全部 5 条记录（过滤只剔非法坐标，不剔 acked）');
  const recordTimes = singleGroup.records.map((record) => record.time);
  assert.deepEqual(
    recordTimes,
    [...recordTimes].sort((earlier, later) => later - earlier),
    '组内记录应按 time 倒序（新 → 旧）',
  );
  assert.deepEqual(
    singleGroup.anchor,
    [121.4705, 31.2306],
    '锚点应取组内最新记录（time 最大，a-newest）的 [lng, lat]',
  );
  assert.equal(singleGroup.deviceId, 'dev-cam-01', '组应透传 deviceId');
  assert.equal(singleGroup.deviceName, '一号摄像头', '组应透传 deviceName（弹窗标题）');
  assert.equal(singleGroup.deviceType, 'camera', '组应透传 deviceType（单点设备图标分摄像头/传感器）');

  // —— 案例二：不同设备各自成组 ——
  const twoDeviceAlarms = [
    makeAlarmRecord({ id: 'b-cam', deviceId: 'dev-cam-01' }),
    makeAlarmRecord({
      id: 'b-sensor',
      deviceId: 'dev-sensor-01',
      deviceType: 'sensor',
      deviceName: '一号传感器',
    }),
  ];
  const twoGroups = buildDeviceAlarmGroups(twoDeviceAlarms);
  assert.equal(twoGroups.length, 2, '两台设备的记录应各自成组');
  assert.deepEqual(
    twoGroups.map((group) => group.deviceId).sort(),
    ['dev-cam-01', 'dev-sensor-01'],
    '分组应按 deviceId 归属，不错组',
  );

  // —— 案例三：非法坐标静默过滤（NaN/Infinity/越界），不抛错 ——
  const dirtyAlarms = [
    makeAlarmRecord({ id: 'c-valid', time: GROUP_TIME_BASE + 100 }),
    makeAlarmRecord({ id: 'c-nan-lng', lng: NaN, time: GROUP_TIME_BASE + 200 }),
    makeAlarmRecord({ id: 'c-inf-lat', lat: Infinity, time: GROUP_TIME_BASE + 300 }),
    makeAlarmRecord({ id: 'c-lng-181', lng: 181, time: GROUP_TIME_BASE + 400 }),
    makeAlarmRecord({ id: 'c-lat-neg91', lat: -91, time: GROUP_TIME_BASE + 500 }),
  ];
  let dirtyGroups;
  assert.doesNotThrow(
    () => {
      dirtyGroups = buildDeviceAlarmGroups(dirtyAlarms);
    },
    '坐标非法（NaN/±Infinity/越界）应静默过滤不抛错（设计 §5 L145）',
  );
  assert.equal(dirtyGroups.length, 1, '含非法坐标记录的设备仍应成组（合法记录保留）');
  assert.equal(dirtyGroups[0].records.length, 1, '仅合法坐标记录保留（NaN/Infinity/181/-91 四条全部剔除）');
  assert.equal(dirtyGroups[0].records[0].id, 'c-valid', '保留的应是坐标合法的那条');

  // 组内全部非法 → 整组消失
  const allInvalidGroups = buildDeviceAlarmGroups([
    makeAlarmRecord({ id: 'd-1', deviceId: 'dev-all-invalid', lng: NaN }),
    makeAlarmRecord({ id: 'd-2', deviceId: 'dev-all-invalid', lat: Infinity }),
  ]);
  assert.equal(
    allInvalidGroups.length,
    0,
    '组内全部记录坐标非法时该组不应出现（无合法锚点可渲染，静默丢弃而非抛错）',
  );

  // —— 案例四：空数组边界 ——
  assert.deepEqual(buildDeviceAlarmGroups([]), [], '空输入应返回空数组');

  // ================= resolveAlarmBadgeInfo =================

  // —— 多组 pending 求和 + 最高 pending 等级取色（major 压过 minor）——
  const sumBadgeInfo = resolveAlarmBadgeInfo([
    makeDeviceGroup({ records: [pendingRecordOfLevel('major'), pendingRecordOfLevel('major')] }),
    makeDeviceGroup({ records: [pendingRecordOfLevel('minor')] }),
  ]);
  assert.equal(sumBadgeInfo.pendingCount, 3, '聚合徽标条数 = 各组 pendingCount 之和（2+1）');
  assert.equal(
    sumBadgeInfo.color,
    ALARM_LEVEL_CONFIG.major.color,
    '徽标色应为最高 pending 等级色（major 压过 minor）',
  );

  // —— critical 单条压过任意多条 major/minor ——
  const criticalBadgeInfo = resolveAlarmBadgeInfo([
    makeDeviceGroup({ records: [pendingRecordOfLevel('critical')] }),
    makeDeviceGroup({
      records: [
        pendingRecordOfLevel('major'),
        pendingRecordOfLevel('major'),
        pendingRecordOfLevel('major'),
        pendingRecordOfLevel('major'),
        pendingRecordOfLevel('minor'),
      ],
    }),
  ]);
  assert.equal(criticalBadgeInfo.pendingCount, 6, 'critical 1 + 其他 5 → pendingCount 求和为 6');
  assert.equal(
    criticalBadgeInfo.color,
    ALARM_LEVEL_CONFIG.critical.color,
    '徽标色应为 critical 色（最高 pending 等级，与条数多寡无关）',
  );

  // —— 取色与组顺序无关（minor 组在前，仍取 major）——
  const orderBadgeInfo = resolveAlarmBadgeInfo([
    makeDeviceGroup({ records: [pendingRecordOfLevel('minor'), pendingRecordOfLevel('minor')] }),
    makeDeviceGroup({ records: [pendingRecordOfLevel('major')] }),
  ]);
  assert.equal(
    orderBadgeInfo.color,
    ALARM_LEVEL_CONFIG.major.color,
    '取色应与组顺序无关：minor 组在前时仍取最高等级 major 色',
  );

  // —— ★取色只看 pending：acked 的 critical 不参与决定徽标色（条数口径同源）——
  const ackedCriticalBadgeInfo = resolveAlarmBadgeInfo([
    makeDeviceGroup({
      records: [
        makeAlarmRecord({ id: 'acked-critical', level: 'critical', status: 'acked' }),
        pendingRecordOfLevel('minor'),
      ],
    }),
  ]);
  assert.equal(ackedCriticalBadgeInfo.pendingCount, 1, 'acked 不计入 pendingCount');
  assert.equal(
    ackedCriticalBadgeInfo.color,
    ALARM_LEVEL_CONFIG.minor.color,
    '★取色只看 pending 记录：acked 的 critical 不应决定徽标色（此处应取 minor 色）',
  );

  // —— 全 acked：pendingCount=0 且回退中性灰 ——
  const allAckedBadgeInfo = resolveAlarmBadgeInfo([
    makeDeviceGroup({ records: [makeAlarmRecord({ id: 'acked-1', status: 'acked' })] }),
    makeDeviceGroup({ records: [makeAlarmRecord({ id: 'acked-2', status: 'acked' })] }),
  ]);
  assert.equal(allAckedBadgeInfo.pendingCount, 0, '全 acked → pendingCount 应为 0');
  assert.equal(
    allAckedBadgeInfo.color,
    ALARM_NEUTRAL_COLOR,
    '全 acked 徽标色应回退 ALARM_NEUTRAL_COLOR（中性灰）',
  );

  // —— 空组集：同全 acked 回退 ——
  const emptyBadgeInfo = resolveAlarmBadgeInfo([]);
  assert.equal(emptyBadgeInfo.pendingCount, 0, '空组集 → pendingCount 应为 0');
  assert.equal(emptyBadgeInfo.color, ALARM_NEUTRAL_COLOR, '空组集徽标色应回退中性灰');

  // ============ 以下为评审修复新增契约（评审 finding 1：行点击定位不得透传未过滤坐标）============
  // resolveAlarmLocateTarget(groups, deviceId)：定位目标 = 该设备分组锚点
  //   （buildDeviceAlarmGroups 产物，坐标已过 isValidLngLat——面板行点击的 flyTo
  //   只能吃这个口子出的坐标，防止 NaN/越界原始记录把 View center 动画成 NaN）；
  //   该设备无分组（全部记录坐标非法被 §5 L145 静默过滤）或未知设备 → null（只高亮不定位）。

  const locateGroups = buildDeviceAlarmGroups([
    makeAlarmRecord({ id: 'loc-1', deviceId: 'dev-locate-01', lng: 121.4701, lat: 31.2302 }),
    makeAlarmRecord({ id: 'loc-nan', deviceId: 'dev-locate-bad', lng: NaN }),
  ]);
  assert.deepEqual(
    resolveAlarmLocateTarget(locateGroups, 'dev-locate-01'),
    [121.4701, 31.2302],
    '定位目标应为该设备分组锚点（坐标已经 buildDeviceAlarmGroups 过滤，可安全进 flyTo）',
  );
  assert.equal(
    resolveAlarmLocateTarget(locateGroups, 'dev-locate-bad'),
    null,
    '坐标全非法的设备无分组 → 返回 null（不定位，防 NaN 进 View center）',
  );
  assert.equal(
    resolveAlarmLocateTarget(locateGroups, 'dev-locate-not-exist'),
    null,
    '未知设备 → 返回 null',
  );

  // 混合组（组内既有合法也有非法记录）：锚点 = 组内最新合法记录坐标，绝无 NaN 逃逸
  const mixedLocateGroups = buildDeviceAlarmGroups([
    makeAlarmRecord({
      id: 'loc-mix-invalid-newest',
      deviceId: 'dev-locate-mix',
      lng: NaN,
      time: GROUP_TIME_BASE + 10,
    }),
    makeAlarmRecord({ id: 'loc-mix-valid', deviceId: 'dev-locate-mix', lng: 121.471, lat: 31.231 }),
  ]);
  assert.deepEqual(
    resolveAlarmLocateTarget(mixedLocateGroups, 'dev-locate-mix'),
    [121.471, 31.231],
    '混合组定位锚点 = 组内合法记录坐标（非法记录已在分组层剔除，锚点永不 NaN）',
  );
};
