// src/map/utils.verify.js — 坐标转换收敛点纯逻辑自测（pnpm verify 自动发现挂载）
//
// 被测契约（AGENTS.md 分层约定「坐标转换统一走 map/utils.js」+ 实施计划 testPoint「utils 坐标转换」）：
//   src/map/utils.js 是全站坐标转换唯一入口，业务数据一律存 EPSG:4326、地图渲染前转 EPSG:3857：
//     toMapCoord([lng, lat]) ：4326 → 3857 单点
//     toDataCoord([x, y])    ：3857 → 4326 单点
//     toMapCoords(points)    ：线/面坐标数组批量 4326 → 3857，返回新数组（不改入参）
//     toDataCoords(points)   ：线/面坐标数组批量 3857 → 4326，返回新数组（不改入参）
//
// ⚠ 测试先行（厂区绘制任务扩展，实施计划步骤 3）：以下四个函数尚未实现——
//   withAlpha / featuresFromGeoJson / geoJsonFromFeatures / createZoneStyle，
//   实现落地前本挂载点因「导出不存在」报错属预期红灯，旧断言随之暂不执行；
//   实现落地后新旧断言须全部通过（计划步骤 8「新增不得回归」）。
//   withAlpha(hex, alpha) → [r, g, b, a]，非法 hex 抛 Error；
//   featuresFromGeoJson(geojson) / geoJsonFromFeatures(features)：封装 ol/GeoJSON format，
//     固定 dataProjection:'EPSG:4326' / featureProjection:'EPSG:3857'——全站 GeoJSON 读写唯一口；
//   createZoneStyle(feature)：按 properties.type 取 ZONE_TYPE_CONFIG 色，
//     半透明填充（alpha=ZONE_FILL_OPACITY）+ 描边（配置色原值，宽 ZONE_STROKE_WIDTH）
//     + 区域名称 Text 标注；未知/缺类型回退中性灰不抛。
//
// ⚠ 测试先行（报警聚合任务扩展，实施计划步骤 4）：isValidLngLat / resolveBadgeMetrics 尚未实现，
//   同上「导出不存在」属预期红灯；实现落地后新旧断言须全部通过。
//   isValidLngLat([lng, lat]) → boolean：坐标合法性谓词（设计 §5 L145 报警/设备坐标
//     NaN/越界静默过滤的统一判定口）。入参为 [lng, lat] 数组（对齐本模块 toMapCoord 家族的
//     数组入参约定）；两轴均为有限数且 lng ∈ [-180,180]、lat ∈ [-90,90]（含端点）返回 true；
//     NaN/±Infinity/越界/缺失轴一律 false，★永不抛错（谓词语义：消费侧 filter 直接安全调用）。
//   resolveBadgeMetrics(count) → { width, height, fontSize }：徽标数字长度自适应的纯尺寸函数
//     （设计 §4.2 L107 canvas 徽标「数字长度自适应」的可测数学部分；canvas 绘制本身留人工验收）。
//     三字段均为正有限数，width 随 String(count) 位数（1/2/3）严格递增。
//
// 期望值标定环境：node v22.16.0 + ol@^10.10.0 实测
//   fromLonLat([121.4737, 31.2304]) = [13522390.428774877, 3662707.2570504015]，
//   往返误差 ~3e-15 度（≪ 断言容差 1e-6）。
// 已知值断言独立于往返断言：防止 toMapCoord/toDataCoord 双双退化为恒等映射却往返自洽。

import {
  toMapCoord,
  toDataCoord,
  toMapCoords,
  toDataCoords,
  withAlpha,
  featuresFromGeoJson,
  geoJsonFromFeatures,
  createZoneStyle,
  isValidLngLat,
  resolveBadgeMetrics,
} from './utils.js';
import { ZONES_SEED_GEOJSON } from '../mock/zones.js';
import { ZONE_FILL_OPACITY, ZONE_STROKE_WIDTH, ZONE_TYPE_CONFIG } from '../constants.js';

const KNOWN_LNG_LAT = [121.4737, 31.2304];
const KNOWN_3857 = [13522390.428774877, 3662707.2570504015];
const SAMPLE_DATA_POINTS = [
  [121.4737, 31.2304],
  [121.4801, 31.2252],
  [121.4688, 31.2341],
];

// 手动解析 #RRGGBB → [r, g, b]：createZoneStyle 断言的期望值来源，
// 刻意不经被测的 withAlpha 推导，避免用被测函数自证（与文件头「已知值独立锚点」同思路）。
const parseHexRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

// 经被测的 featuresFromGeoJson 构造测试用 ol Feature（4326 输入、闭合五边形），
// createZoneStyle 断言直接复用真实读入路径，避免 verify 另行 import ol 构造器。
const buildZoneFeature = (properties) =>
  featuresFromGeoJson({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties,
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [121.4700, 31.2300],
              [121.4750, 31.2300],
              [121.4750, 31.2350],
              [121.4700, 31.2350],
              [121.4700, 31.2300],
            ],
          ],
        },
      },
    ],
  })[0];

export const verify = (assert) => {
  const assertValueCloseTo = (actual, expected, tolerance, label) =>
    assert.ok(
      Math.abs(actual - expected) <= tolerance,
      `${label}：期望 ${expected}（容差 ${tolerance}），实际 ${actual}`,
    );

  const assertPointCloseTo = (actual, expected, tolerance, label) => {
    assert.ok(Array.isArray(actual), `${label} 应返回数组，实际 ${typeof actual}`);
    assert.equal(actual.length, 2, `${label} 应为 [lng, lat] / [x, y] 二元坐标`);
    assertValueCloseTo(actual[0], expected[0], tolerance, `${label}[0]`);
    assertValueCloseTo(actual[1], expected[1], tolerance, `${label}[1]`);
  };

  // —— 单点已知值：4326 → 3857 ——
  assertPointCloseTo(toMapCoord(KNOWN_LNG_LAT), KNOWN_3857, 1e-6, 'toMapCoord([121.4737, 31.2304])');

  // —— 单点已知值：3857 → 4326（独立锚点，不依赖 toMapCoord 的正确性）——
  assertPointCloseTo(toDataCoord(KNOWN_3857), KNOWN_LNG_LAT, 1e-6, 'toDataCoord(已知 3857 点)');

  // —— 单点往返误差 < 1e-6 度 ——
  assertPointCloseTo(
    toDataCoord(toMapCoord(KNOWN_LNG_LAT)),
    KNOWN_LNG_LAT,
    1e-6,
    '单点 4326→3857→4326 往返',
  );

  // —— 批量：与单点逐点一致 ——
  const pristineInput = SAMPLE_DATA_POINTS.map((point) => [...point]);
  const batchMapped = toMapCoords(SAMPLE_DATA_POINTS);
  assert.ok(Array.isArray(batchMapped), 'toMapCoords 应返回数组');
  assert.equal(batchMapped.length, SAMPLE_DATA_POINTS.length, 'toMapCoords 结果点数应与输入一致');
  SAMPLE_DATA_POINTS.forEach((point, index) => {
    assert.deepEqual(
      batchMapped[index],
      toMapCoord(point),
      `toMapCoords 第 ${index} 点应与单点 toMapCoord 完全一致`,
    );
  });

  // —— 批量：返回新数组，改结果不影响输入（AGENTS.md 函数式约定）——
  assert.notEqual(batchMapped, SAMPLE_DATA_POINTS, 'toMapCoords 应返回新数组而非原引用');
  batchMapped.length = 0;
  assert.deepEqual(SAMPLE_DATA_POINTS, pristineInput, '清空批量结果不应影响输入坐标数组');

  // —— 批量往返 + toDataCoords 返回新数组 ——
  const mappedAgain = toMapCoords(SAMPLE_DATA_POINTS);
  const batchRoundTrip = toDataCoords(mappedAgain);
  SAMPLE_DATA_POINTS.forEach((point, index) => {
    assertPointCloseTo(
      batchRoundTrip[index],
      point,
      1e-6,
      `toDataCoords(toMapCoords(...)) 第 ${index} 点往返`,
    );
  });
  assert.notEqual(batchRoundTrip, mappedAgain, 'toDataCoords 应返回新数组而非原引用');

  // —— 空数组边界 ——
  assert.deepEqual(toMapCoords([]), [], 'toMapCoords([]) 应返回空数组');
  assert.deepEqual(toDataCoords([]), [], 'toDataCoords([]) 应返回空数组');

  // ================= 以下为厂区绘制任务新增契约（实施计划步骤 3 / testPoint「utils 扩展」）=================

  // —— withAlpha：'#RRGGBB' + alpha → [r, g, b, a] ——
  assert.deepEqual(
    withAlpha('#1890ff', 0.25),
    [24, 144, 255, 0.25],
    "withAlpha('#1890ff', 0.25) 应得 [24, 144, 255, 0.25]（0x18/0x90/0xff）",
  );
  assert.throws(() => withAlpha('#xyz', 1), Error, "withAlpha('#xyz', 1) 非法 hex 应抛 Error");
  assert.throws(() => withAlpha('#12345', 1), Error, '五位 hex 应抛 Error（仅支持六位 #RRGGBB）');
  assert.throws(() => withAlpha('1890ff', 1), Error, '缺 # 前缀应抛 Error');

  // —— featuresFromGeoJson：GeoJSON(4326) → ol Feature(3857)，properties 保留 ——
  const seedFeatures = featuresFromGeoJson(ZONES_SEED_GEOJSON);
  assert.ok(Array.isArray(seedFeatures), 'featuresFromGeoJson 应返回 Feature 数组');
  assert.equal(
    seedFeatures.length,
    ZONES_SEED_GEOJSON.features.length,
    'featuresFromGeoJson 返回的要素数应与种子 features 数一致',
  );
  const firstSeedPoint = ZONES_SEED_GEOJSON.features[0].geometry.coordinates[0][0];
  assert.deepEqual(
    seedFeatures[0].getGeometry().getCoordinates()[0][0],
    toMapCoord(firstSeedPoint),
    'featuresFromGeoJson 首坐标应 deepEqual toMapCoord(种子首坐标)（4326→3857 投影切换落地）',
  );
  ZONES_SEED_GEOJSON.features.forEach((seedFeature, index) => {
    const featureProperties = seedFeatures[index].getProperties();
    Object.entries(seedFeature.properties).forEach(([propertyKey, propertyValue]) => {
      assert.equal(
        featureProperties[propertyKey],
        propertyValue,
        `featuresFromGeoJson 应保留 properties.${propertyKey}（第 ${index} 个要素）`,
      );
    });
  });

  // —— geoJsonFromFeatures：ol Feature(3857) → GeoJSON(4326)，round-trip 坐标逐点差 < 1e-9 ——
  const roundTripGeoJson = geoJsonFromFeatures(featuresFromGeoJson(ZONES_SEED_GEOJSON));
  assert.equal(roundTripGeoJson.type, 'FeatureCollection', 'round-trip 后顶层应为 FeatureCollection');
  assert.equal(
    roundTripGeoJson.features.length,
    ZONES_SEED_GEOJSON.features.length,
    'round-trip 后要素数应不变',
  );
  roundTripGeoJson.features.forEach((outFeature, featureIndex) => {
    const seedFeature = ZONES_SEED_GEOJSON.features[featureIndex];
    assert.equal(
      outFeature.geometry.type,
      seedFeature.geometry.type,
      `round-trip 后第 ${featureIndex} 要素几何类型应保留`,
    );
    assert.deepEqual(
      outFeature.properties,
      seedFeature.properties,
      `round-trip 后第 ${featureIndex} 要素 properties 应原样保留（含 danger 的 fence:true）`,
    );
    outFeature.geometry.coordinates.forEach((outRing, ringIndex) => {
      const seedRing = seedFeature.geometry.coordinates[ringIndex];
      assert.equal(
        outRing.length,
        seedRing.length,
        `round-trip 后第 ${featureIndex} 要素第 ${ringIndex} 环点数应不变（含闭合点）`,
      );
      outRing.forEach((outPoint, pointIndex) => {
        const seedPoint = seedRing[pointIndex];
        assert.ok(
          Math.abs(outPoint[0] - seedPoint[0]) < 1e-9,
          `round-trip 经度误差应 <1e-9（要素 ${featureIndex} 环 ${ringIndex} 点 ${pointIndex}）`,
        );
        assert.ok(
          Math.abs(outPoint[1] - seedPoint[1]) < 1e-9,
          `round-trip 纬度误差应 <1e-9（要素 ${featureIndex} 环 ${ringIndex} 点 ${pointIndex}）`,
        );
      });
    });
  });

  // —— createZoneStyle：danger 区域 = 配置色半透明填充 + 配置色原值描边 + 名称 Text ——
  const dangerStyle = createZoneStyle(
    buildZoneFeature({ id: 'style-danger', name: '测试危险区', type: 'danger' }),
  );
  assert.ok(dangerStyle, 'createZoneStyle 应返回 Style 实例');
  const dangerFill = dangerStyle.getFill().getColor();
  assert.ok(Array.isArray(dangerFill), 'danger 填充色应为 [r, g, b, a] 数组');
  assert.equal(
    dangerFill[3],
    ZONE_FILL_OPACITY,
    'danger 填充色数组第 4 位（alpha）应 === ZONE_FILL_OPACITY',
  );
  assert.deepEqual(
    [dangerFill[0], dangerFill[1], dangerFill[2]],
    parseHexRgb(ZONE_TYPE_CONFIG.danger.color),
    'danger 填充 RGB 应与 ZONE_TYPE_CONFIG.danger.color 一致',
  );
  assert.equal(
    dangerStyle.getStroke().getColor(),
    ZONE_TYPE_CONFIG.danger.color,
    'danger 描边 color 应 === ZONE_TYPE_CONFIG.danger.color（配置色原值字符串）',
  );
  assert.equal(
    dangerStyle.getStroke().getWidth(),
    ZONE_STROKE_WIDTH,
    '描边宽度应 === ZONE_STROKE_WIDTH（计划步骤 1：区域描边宽标量）',
  );
  assert.ok(dangerStyle.getText(), 'danger 样式应含 Text 标注');
  assert.equal(
    dangerStyle.getText().getText(),
    '测试危险区',
    'Text.getText() 应 === 区域名称（多边形内部名称标注，设计 §4.1 L98）',
  );

  // —— createZoneStyle：未知/缺类型回退中性灰，不抛 ——
  let unknownTypeStyle;
  assert.doesNotThrow(() => {
    unknownTypeStyle = createZoneStyle(
      buildZoneFeature({ id: 'style-unknown', name: '未知类型区', type: 'unknown' }),
    );
  }, "type='unknown' 不应抛 Error（回退分支）");
  const unknownFill = unknownTypeStyle.getFill().getColor();
  assert.ok(
    Array.isArray(unknownFill) && unknownFill[3] === ZONE_FILL_OPACITY,
    '未知类型填充仍应为 [r, g, b, ZONE_FILL_OPACITY] 数组',
  );
  assert.equal(
    unknownFill[0],
    unknownFill[1],
    '未知类型回退色应为中性灰（R === G）',
  );
  assert.equal(
    unknownFill[1],
    unknownFill[2],
    '未知类型回退色应为中性灰（G === B）',
  );
  let missingTypeStyle;
  assert.doesNotThrow(() => {
    missingTypeStyle = createZoneStyle(
      buildZoneFeature({ id: 'style-missing', name: '缺类型区' }),
    );
  }, '缺 type（properties 无 type 键）不应抛 Error（回退分支）');
  assert.ok(
    missingTypeStyle.getFill(),
    '缺 type 仍应渲染填充（回退中性灰，不静默丢样式）',
  );

  // ============ 以下为报警聚合任务新增契约（实施计划步骤 4 / testPoint「utils 扩展」）============

  // —— isValidLngLat：坐标合法性谓词（§5 L145 静默过滤的统一判定口）——
  assert.equal(
    isValidLngLat([121.4737, 31.2304]),
    true,
    '厂区占位中心坐标应合法',
  );
  assert.equal(isValidLngLat([0, 0]), true, '[0, 0] 是合法经纬度（谓词只判合法性，不判是否在厂区）');
  assert.equal(isValidLngLat([-180, -90]), true, '边界含端点：[-180, -90] 应合法');
  assert.equal(isValidLngLat([180, 90]), true, '边界含端点：[180, 90] 应合法');
  assert.equal(
    isValidLngLat([181, 31.2304]),
    false,
    '经度 181 越界应返回 false（设计 §5 L145 点名越界过滤）',
  );
  assert.equal(
    isValidLngLat([121.4737, -91]),
    false,
    '纬度 -91 越界应返回 false（设计 §5 L145 点名越界过滤）',
  );
  assert.equal(isValidLngLat([-180.1, 31.2304]), false, '经度 -180.1 越界应返回 false');
  assert.equal(isValidLngLat([NaN, 31.2304]), false, '经度 NaN 应返回 false（设计 §5 L145 点名 NaN 过滤）');
  assert.equal(isValidLngLat([121.4737, NaN]), false, '纬度 NaN 应返回 false');
  assert.equal(isValidLngLat([Infinity, 31.2304]), false, '经度 Infinity 应返回 false（非有限数）');
  assert.equal(isValidLngLat([121.4737, -Infinity]), false, '纬度 -Infinity 应返回 false（非有限数）');
  assert.equal(
    isValidLngLat([undefined, 31.2304]),
    false,
    '轴缺失（undefined）应返回 false 而非抛错（谓词供消费侧 filter 安全调用）',
  );
  assert.equal(
    isValidLngLat([121.4737]),
    false,
    '缺第二轴应返回 false 而非抛错',
  );

  // —— resolveBadgeMetrics：徽标数字长度自适应的纯尺寸函数 ——
  const metricsOfOneDigit = resolveBadgeMetrics(5);
  const metricsOfTwoDigits = resolveBadgeMetrics(42);
  const metricsOfThreeDigits = resolveBadgeMetrics(123);
  [metricsOfOneDigit, metricsOfTwoDigits, metricsOfThreeDigits].forEach((metrics, index) => {
    const digitLabel = `${index + 1} 位数`;
    assert.ok(metrics && typeof metrics === 'object', `resolveBadgeMetrics 应返回对象（${digitLabel}）`);
    ['width', 'height', 'fontSize'].forEach((metricKey) => {
      assert.ok(
        Number.isFinite(metrics[metricKey]) && metrics[metricKey] > 0,
        `${digitLabel} 的 ${metricKey} 应为正有限数（实际 ${String(metrics?.[metricKey])}）`,
      );
    });
  });
  assert.ok(
    metricsOfTwoDigits.width > metricsOfOneDigit.width,
    `徽标宽度应随位数递增：2 位（${metricsOfTwoDigits.width}）应 > 1 位（${metricsOfOneDigit.width}）`,
  );
  assert.ok(
    metricsOfThreeDigits.width > metricsOfTwoDigits.width,
    `徽标宽度应随位数递增：3 位（${metricsOfThreeDigits.width}）应 > 2 位（${metricsOfTwoDigits.width}）`,
  );
};
