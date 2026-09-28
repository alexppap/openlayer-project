// src/composables/useZones.verify.js — 区域表单属性解析纯函数自测（pnpm verify 自动发现挂载）
//
// ⚠ 测试先行：本文件先于 src/composables/useZones.js 落地（实施计划步骤 6），
//   在被测模块实现前 pnpm verify 对本挂载点报「找不到模块」属预期红灯。
//
// ⚠ 运行环境约束：本文件在纯 node（无 vite/DOM）下执行。
//   resolveZoneProperties 须自 src/composables/useZones.js 具名导出（计划步骤 6），
//   且 useZones.js 的模块级依赖链须保持 node 可导入：
//     - vue / ol 裸 ESM import 带 .js 后缀均可入 node（先例：utils.verify.js 导 ol/proj.js）；
//     - 不得在模块顶层访问 DOM（document/window）或裸取 import.meta.env 的属性
//       （api/index.js 的 import.meta.env?.VITE_API_MODE 写法 node 下安全）。
//
// 被测契约（实施计划 testPoint「useZones」+ 步骤 6）：
//   resolveZoneProperties({ id, name, type }) —— ZoneFormPopup 保存时校验/定形区域属性：
//     - 名称非空白（'' / 纯空格 / 缺失均抛 Error）；
//     - 类型 ∈ ZONE_TYPE_CONFIG 键集合（非法/缺失均抛 Error）；
//     - 合法输入返回白名单字段 { id, name, type }（不透传输入中的多余键）；
//     - 仅 type === 'danger' 落 fence: true，其余类型返回值不含 fence 键。
//
// ⚠ 测试先行（报警聚合任务附带修复扩展，实施计划步骤 9）：handleDrawEnd 守卫尚未实现——
//   现状 useZones.js 的 handleDrawEnd 为模块内私有 const、未具名导出且无守卫，
//   本挂载点因「导出不存在」报错属预期红灯（旧断言随之暂不执行）；实现落地后新旧断言须全部通过。
//   守卫契约（上轮评审未回应项：表单待确认期间完成第二个多边形时，第一个草稿被静默覆盖丢弃）：
//     - handleDrawEnd 须自 useZones.js 具名导出（供本 verify 挂载，node 下可调）；
//     - pendingDrawnFeature 非 null（表单待确认）时再进 drawend：
//       不抛错、不覆盖第一个草稿（zoneForm 保持打开且为同一引用）、
//       经 useNotice 发出 type='warning' 的新通知提示先处理当前表单（不得静默丢数据）；
//     - node 下 zonePopupOverlay / drawInteraction 为 null 占位，守卫路径须不依赖它们。
//   纵深防御说明：现有 setActive(false) + ol 10.10.0 对 inactive 交互不派发事件使常规事件流中
//   第二个 drawend 已不可达；守卫把「不静默丢数据」变成显式不变量并覆盖未来重构/边界（计划 risks）。

import Feature from 'ol/Feature.js';
import Polygon from 'ol/geom/Polygon.js';
import { handleDrawEnd, resolveZoneProperties, useZones } from './useZones.js';
import { useNotice } from './useNotice.js';

export const verify = (assert) => {
  assert.equal(
    typeof resolveZoneProperties,
    'function',
    'useZones.js 应具名导出纯函数 resolveZoneProperties（供本 verify 挂载）',
  );

  // —— 合法普通类型：返回恰为 { id, name, type }，无 fence 键 ——
  assert.deepEqual(
    resolveZoneProperties({ id: 'z1', name: '新仓储', type: 'warehouse' }),
    { id: 'z1', name: '新仓储', type: 'warehouse' },
    'warehouse 输入应返回恰 { id, name, type }（白名单定形，无 fence 键）',
  );

  // —— danger 类型：附加 fence === true（设计 §4.1 L98 仅危险品区为围栏禁区）——
  const dangerResolved = resolveZoneProperties({ id: 'z2', name: '危险品仓', type: 'danger' });
  assert.equal(dangerResolved.fence, true, 'danger 输入应在返回值附加 fence: true');
  assert.equal(dangerResolved.name, '危险品仓', 'danger 返回值应保留名称');
  assert.equal(dangerResolved.type, 'danger', 'danger 返回值应保留类型');

  // —— 非法输入抛 Error：名称空白 / 类型越界 ——
  assert.throws(
    () => resolveZoneProperties({ id: 'z3', name: '', type: 'office' }),
    Error,
    '名称为空字符串应抛 Error',
  );
  assert.throws(
    () => resolveZoneProperties({ id: 'z4', name: '   ', type: 'office' }),
    Error,
    '名称为纯空格应抛 Error（非空白校验须 trim）',
  );
  assert.throws(
    () => resolveZoneProperties({ id: 'z5', type: 'office' }),
    Error,
    '名称缺失（undefined）同样不满足非空白校验，应抛 Error',
  );
  assert.throws(
    () => resolveZoneProperties({ id: 'z6', name: '未知区', type: 'nope' }),
    Error,
    '类型不在 ZONE_TYPE_CONFIG 键集合应抛 Error',
  );
  assert.throws(
    () => resolveZoneProperties({ id: 'z7', name: '缺类型区' }),
    Error,
    '类型缺失（undefined）应抛 Error',
  );

  // —— 白名单定形：输入携带越界键（如伪造 fence）不得透传进返回值 ——
  assert.deepEqual(
    resolveZoneProperties({ id: 'z8', name: '伪围栏', type: 'warehouse', fence: true }),
    { id: 'z8', name: '伪围栏', type: 'warehouse' },
    '非 danger 输入即使携带 fence:true，返回值也不应包含 fence（仅 danger 落 fence）',
  );

  // ============ 以下为报警聚合任务附带修复新增契约（实施计划步骤 9：handleDrawEnd 守卫）============

  const { zoneForm, handleZoneFormCancel } = useZones();
  const { notices, dismissNotice } = useNotice();

  // 前置复位（防本模块单例残留状态影响用例起点）
  handleZoneFormCancel();
  assert.equal(zoneForm.value, null, '前置：守卫用例开始前表单应处关闭态');

  // 构造带 Polygon 几何的真实 ol Feature（handleDrawEnd 经 resolveFeatureAnchor 读几何内点；
  // node 下 overlay/interaction 为 null 占位，路径不依赖 DOM）
  const buildDrawnPolygonFeature = (offset) =>
    new Feature({
      geometry: new Polygon([
        [
          [offset, offset],
          [offset + 4, offset],
          [offset + 4, offset + 4],
          [offset, offset],
        ],
      ]),
    });
  const firstDraftFeature = buildDrawnPolygonFeature(0);
  const secondDraftFeature = buildDrawnPolygonFeature(100);

  // —— 第一次 drawend：正常打开表单 ——
  assert.doesNotThrow(
    () => handleDrawEnd({ feature: firstDraftFeature }),
    '第一次 handleDrawEnd（无待确认草稿）不应抛错',
  );
  assert.ok(zoneForm.value !== null, '第一次绘制完成后表单应打开（zoneForm 非 null）');
  const formValueAfterFirst = zoneForm.value;

  // —— 守卫核心：表单待确认期间第二次 drawend 不得静默覆盖第一个草稿 ——
  const noticeIdsBeforeGuard = new Set(notices.value.map((notice) => notice.id));
  assert.doesNotThrow(
    () => handleDrawEnd({ feature: secondDraftFeature }),
    '表单待确认期间第二次 handleDrawEnd 不应抛错（守卫拒绝新草图，返回结构化处理）',
  );
  assert.ok(
    zoneForm.value !== null,
    '第二次 handleDrawEnd 后表单仍应打开——第一个草稿未被静默覆盖丢弃',
  );
  assert.equal(
    zoneForm.value,
    formValueAfterFirst,
    '守卫应早退：zoneForm 保持第一次的同一引用（未重开新表单实例覆盖草稿上下文）',
  );
  const newWarningNotices = notices.value.filter(
    (notice) => !noticeIdsBeforeGuard.has(notice.id) && notice.type === 'warning',
  );
  assert.ok(
    newWarningNotices.length >= 1,
    "守卫应经 useNotice 发出 type='warning' 的新通知（提示先处理当前待确认表单，不得静默丢数据）",
  );
  newWarningNotices.forEach((notice) => {
    assert.equal(
      typeof notice.message,
      'string',
      '守卫通知应携带非空 message（文案不逐字锁定，实现可自拟）',
    );
  });

  // —— 收尾：复位模块单例状态并清理本用例产生的通知，不污染同进程其他 verify 挂载点 ——
  handleZoneFormCancel();
  assert.equal(zoneForm.value, null, '收尾：handleZoneFormCancel 后表单应复位关闭');
  newWarningNotices.forEach((notice) => dismissNotice(notice.id));
};
