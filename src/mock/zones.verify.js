// src/mock/zones.verify.js — 厂区 GeoJSON 种子契约自测（pnpm verify 自动发现挂载）
//
// ⚠ 测试先行：本文件先于 src/mock/zones.js 落地（实施计划步骤 2），
//   在被测模块实现前 pnpm verify 对本挂载点报「找不到模块」属预期红灯。
//
// ⚠ 运行环境约束：本文件在纯 node（无 vite/vue/ol）下执行，
//   被测 src/mock/zones.js 必须是纯数据模块（零 ol/vue import，node 可导入——实施计划步骤 2）。
//
// 被测契约（实施计划 testPoint「mock/zones」+ 步骤 2，设计 §4.1 L98）：
//   ZONES_SEED_GEOJSON 为 GeoJSON FeatureCollection，恰含 4 个 Polygon feature：
//     - properties = { id, name, type }，type 枚举对齐 constants.ZONE_TYPE_CONFIG 四键
//       （生产 production / 仓储 warehouse / 办公 office / 危险 danger 各一）；
//     - 仅 danger feature 附加 properties.fence === true，其余 feature 不携带 fence 键；
//     - 每个环 ≥ 4 个位置点且首尾点相等（GeoJSON 环闭合规范）；
//     - 全部坐标为 EPSG:4326 经纬度（lng ∈ [-180,180]、lat ∈ [-90,90]，
//       若误存 3857 米制坐标将立刻越界暴露）；
//     - 全部坐标围绕 constants.MAP_DEFAULT_VIEW.center 各轴差 ≤ 0.02°
//       （任务原文「围绕当前默认视野布设」；种子实际布设约 ±0.004°，断言取计划口径 0.02°）。

import { ZONES_SEED_GEOJSON } from './zones.js';
import { MAP_DEFAULT_VIEW, ZONE_TYPE_CONFIG } from '../constants.js';

// 展平全部环的全部位置点（含外环/内环），供逐点断言
const collectAllPoints = (features) =>
  features.flatMap((feature) => feature.geometry.coordinates.flat());

export const verify = (assert) => {
  // —— 顶层形状：FeatureCollection + features 数组 ——
  assert.equal(ZONES_SEED_GEOJSON.type, 'FeatureCollection', '种子顶层 type 应为 FeatureCollection');
  assert.ok(Array.isArray(ZONES_SEED_GEOJSON.features), '种子 features 应为数组');

  // —— 恰 4 个 Polygon feature，properties 形状 { id, name, type } ——
  assert.equal(ZONES_SEED_GEOJSON.features.length, 4, '种子应恰含 4 个 feature（四类区域各一）');
  ZONES_SEED_GEOJSON.features.forEach((feature, index) => {
    assert.equal(feature.type, 'Feature', `第 ${index} 个种子要素 type 应为 Feature`);
    assert.equal(feature.geometry.type, 'Polygon', `第 ${index} 个种子要素几何应为 Polygon`);
    assert.ok(feature.properties, `第 ${index} 个种子要素应有 properties`);
    assert.ok(feature.properties.id, `第 ${index} 个种子要素 properties.id 应存在且非空`);
    assert.equal(
      typeof feature.properties.name,
      'string',
      `第 ${index} 个种子要素 properties.name 应为字符串`,
    );
    assert.ok(
      feature.properties.name.trim().length > 0,
      `第 ${index} 个种子要素 properties.name 应为非空白名称`,
    );
  });

  // —— 类型枚举：与 ZONE_TYPE_CONFIG 键集合一一对应（各出现一次）——
  const seedTypeList = ZONES_SEED_GEOJSON.features.map((feature) => feature.properties.type).sort();
  assert.deepEqual(
    seedTypeList,
    Object.keys(ZONE_TYPE_CONFIG).sort(),
    '种子 properties.type 集合应与 ZONE_TYPE_CONFIG 键集合一致（四类各一）',
  );

  // —— 围栏语义：仅 danger feature 携带 fence === true ——
  const dangerFeatures = ZONES_SEED_GEOJSON.features.filter(
    (feature) => feature.properties.type === 'danger',
  );
  assert.equal(dangerFeatures.length, 1, '种子应恰含 1 个 danger 类型区域');
  assert.equal(
    dangerFeatures[0].properties.fence,
    true,
    'danger（危险品区）feature 的 properties.fence 应为 true',
  );
  ZONES_SEED_GEOJSON.features
    .filter((feature) => feature.properties.type !== 'danger')
    .forEach((feature, index) => {
      assert.ok(
        !('fence' in feature.properties),
        `非 danger 区域（第 ${index} 个）不应携带 fence 键（仅危险品区附加 fence:true）`,
      );
    });

  // —— 环闭合：每个环 ≥ 4 点且首尾点相等 ——
  ZONES_SEED_GEOJSON.features.forEach((feature, featureIndex) => {
    assert.ok(
      feature.geometry.coordinates.length >= 1,
      `第 ${featureIndex} 个种子要素应至少含 1 个环`,
    );
    feature.geometry.coordinates.forEach((ring, ringIndex) => {
      assert.ok(Array.isArray(ring), `第 ${featureIndex} 要素第 ${ringIndex} 环应为数组`);
      assert.ok(
        ring.length >= 4,
        `第 ${featureIndex} 要素第 ${ringIndex} 环应 ≥4 个位置点（实际 ${ring.length}）`,
      );
      assert.deepEqual(
        ring[ring.length - 1],
        ring[0],
        `第 ${featureIndex} 要素第 ${ringIndex} 环首尾点应相等（GeoJSON 环闭合）`,
      );
    });
  });

  // —— 坐标系：全部点位为有限数、经纬度合法范围（证 4326 而非 3857）——
  const allPoints = collectAllPoints(ZONES_SEED_GEOJSON.features);
  assert.ok(allPoints.length > 0, '种子应含至少一个位置点');
  allPoints.forEach((point, index) => {
    assert.equal(point.length, 2, `第 ${index} 个位置点应为 [lng, lat] 二元`);
    const [lng, lat] = point;
    assert.ok(Number.isFinite(lng), `第 ${index} 个位置点经度应为有限数`);
    assert.ok(Number.isFinite(lat), `第 ${index} 个位置点纬度应为有限数`);
    assert.ok(
      lng >= -180 && lng <= 180,
      `第 ${index} 个位置点经度 ${lng} 应在 [-180,180]（业务坐标存 EPSG:4326，非 3857 米制）`,
    );
    assert.ok(
      lat >= -90 && lat <= 90,
      `第 ${index} 个位置点纬度 ${lat} 应在 [-90,90]（业务坐标存 EPSG:4326，非 3857 米制）`,
    );
  });

  // —— 布设范围：围绕 MAP_DEFAULT_VIEW.center 各轴差 ≤ 0.02°（任务原文「围绕当前默认视野布设」）——
  const [centerLng, centerLat] = MAP_DEFAULT_VIEW.center;
  allPoints.forEach((point, index) => {
    const [lng, lat] = point;
    assert.ok(
      Math.abs(lng - centerLng) <= 0.02,
      `第 ${index} 个位置点经度偏离默认视野中心 ${Math.abs(lng - centerLng)}° 应 ≤ 0.02°`,
    );
    assert.ok(
      Math.abs(lat - centerLat) <= 0.02,
      `第 ${index} 个位置点纬度偏离默认视野中心 ${Math.abs(lat - centerLat)}° 应 ≤ 0.02°`,
    );
  });
};
