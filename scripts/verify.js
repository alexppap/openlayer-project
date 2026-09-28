// scripts/verify.js — 纯逻辑自测入口（node 原生断言，无测试框架）。运行：pnpm verify
//
// 组成：
//   1) 内联校验 src/constants.js 枚举常量完整性（脚手架阶段纯逻辑测试点，
//      依据 docs/superpowers/specs/2026-09-22-openlayers-factory-prototype-design.md：
//      §3.4 L92 模式枚举、L98/L127 区域类型与围栏、L102 存储 key、
//      §4.2 L106/L139 报警等级与热力权重、L107 聚合距离、L117 速度染色、L118 尾迹/推送间隔）
//   2) 递归发现并执行 src/**/*.verify.js —— 后续任务纯函数测试的统一挂载点
//      （设计 §4.5 L129、§6 L149：轨迹插值、速度染色分段、进出围栏判断、徽标数字格式化等）
//
// *.verify.js 挂载约定（供后续任务遵循）：
//   - 具名导出 verify(assert)；assert 形参为 node:assert/strict（本入口传入），同步/异步均可
//   - 执行中抛错即该文件计为失败；不使用默认导出（遵循 AGENTS.md 具名导出规范）
//
// SPEED_COLOR_STOPS 契约（本文件断言即契约，constants.js 实现须对齐）：
//   升序数组，每项 { threshold: number, color: '#RRGGBB' }，
//   首项 threshold === 0（低速段全程覆盖），相邻阈值严格递增，至少 2 段（快红慢绿）。

import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = join(PROJECT_ROOT, 'src');
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const importConstants = () => import(pathToFileURL(join(SRC_DIR, 'constants.js')).href);

const TESTS = [
  {
    name: 'ALARM_LEVEL_CONFIG 键集合恰为 critical/major/minor，每项含 label/color/heatmapWeight，权重 critical=1 / major=0.6 / minor=0.3（设计 L106、L139）',
    run: async () => {
      const { ALARM_LEVEL_CONFIG } = await importConstants();
      assert.deepEqual(
        Object.keys(ALARM_LEVEL_CONFIG),
        ['critical', 'major', 'minor'],
        'ALARM_LEVEL_CONFIG 键集合应为 critical/major/minor',
      );
      for (const [level, config] of Object.entries(ALARM_LEVEL_CONFIG)) {
        assert.equal(typeof config.label, 'string', `ALARM_LEVEL_CONFIG.${level}.label 应为字符串`);
        assert.match(config.color, HEX_COLOR_RE, `ALARM_LEVEL_CONFIG.${level}.color 应为 #RRGGBB`);
        assert.equal(
          typeof config.heatmapWeight,
          'number',
          `ALARM_LEVEL_CONFIG.${level}.heatmapWeight 应为数值`,
        );
      }
      assert.equal(ALARM_LEVEL_CONFIG.critical.heatmapWeight, 1, '紧急（critical）热力权重应为 1');
      assert.equal(ALARM_LEVEL_CONFIG.major.heatmapWeight, 0.6, '重要（major）热力权重应为 0.6');
      assert.equal(ALARM_LEVEL_CONFIG.minor.heatmapWeight, 0.3, '一般（minor）热力权重应为 0.3');
    },
  },
  {
    name: 'ZONE_TYPE_CONFIG 键集合恰为 production/warehouse/office/danger，每项含 label/color，仅 danger 项 fence=true（设计 L98、L127）',
    run: async () => {
      const { ZONE_TYPE_CONFIG } = await importConstants();
      assert.deepEqual(
        Object.keys(ZONE_TYPE_CONFIG),
        ['production', 'warehouse', 'office', 'danger'],
        'ZONE_TYPE_CONFIG 键集合应为 production/warehouse/office/danger',
      );
      for (const [zoneType, config] of Object.entries(ZONE_TYPE_CONFIG)) {
        assert.equal(typeof config.label, 'string', `ZONE_TYPE_CONFIG.${zoneType}.label 应为字符串`);
        assert.match(config.color, HEX_COLOR_RE, `ZONE_TYPE_CONFIG.${zoneType}.color 应为 #RRGGBB`);
        if (zoneType === 'danger') {
          assert.equal(config.fence, true, 'danger（危险品区）必须 fence=true 作为围栏禁区');
        } else {
          assert.notEqual(
            config.fence,
            true,
            `ZONE_TYPE_CONFIG.${zoneType}.fence 不应为 true（仅 danger 是围栏禁区）`,
          );
        }
      }
    },
  },
  {
    name: 'MAP_MODES 恰为 pan/drawZone/editZone/measureLine/measureArea 且无重复（设计 §3.4 L92）',
    run: async () => {
      const { MAP_MODES } = await importConstants();
      assert.ok(Array.isArray(MAP_MODES), 'MAP_MODES 应为数组');
      assert.deepEqual(
        MAP_MODES,
        ['pan', 'drawZone', 'editZone', 'measureLine', 'measureArea'],
        'MAP_MODES 内容与顺序应恰为五种交互模式',
      );
      assert.equal(new Set(MAP_MODES).size, MAP_MODES.length, 'MAP_MODES 不应含重复项');
    },
  },
  {
    name: '标量常量：CLUSTER_DISTANCE_PX=60、TRAIL_POINT_COUNT=30、POSITION_PUSH_INTERVAL_MS=2000、ZONES_STORAGE_KEY="factory-zones"（设计 L107、L118、L102）',
    run: async () => {
      const constants = await importConstants();
      assert.equal(constants.CLUSTER_DISTANCE_PX, 60, '聚合距离应为 60px');
      assert.equal(constants.TRAIL_POINT_COUNT, 30, '实时尾迹应保留最近 30 个点');
      assert.equal(constants.POSITION_PUSH_INTERVAL_MS, 2000, '实时位置推送间隔应为 2000ms');
      assert.equal(constants.ZONES_STORAGE_KEY, 'factory-zones', '厂区持久化 localStorage key 应为 factory-zones');
    },
  },
  {
    name: 'ALARM_STATUS 键集合恰为 pending/acked 且值为非空中文文案（设计 L106 status 枚举）',
    run: async () => {
      const { ALARM_STATUS } = await importConstants();
      assert.deepEqual(
        Object.keys(ALARM_STATUS),
        ['pending', 'acked'],
        'ALARM_STATUS 键集合应为 pending/acked',
      );
      for (const [status, label] of Object.entries(ALARM_STATUS)) {
        assert.equal(typeof label, 'string', `ALARM_STATUS.${status} 应为字符串`);
        assert.match(label, /[\u4e00-\u9fff]/, `ALARM_STATUS.${status} 应为中文文案`);
        assert.ok(label.trim().length > 0, `ALARM_STATUS.${status} 不应为空白串`);
      }
    },
  },
  {
    name: 'SPEED_COLOR_STOPS 为速度染色分段：每项 { threshold, color }、首项 threshold=0 覆盖全程、阈值严格升序、至少 2 段（设计 L117）',
    run: async () => {
      const { SPEED_COLOR_STOPS } = await importConstants();
      assert.ok(Array.isArray(SPEED_COLOR_STOPS), 'SPEED_COLOR_STOPS 应为数组');
      assert.ok(SPEED_COLOR_STOPS.length >= 2, '至少需要 2 个分段才能体现快红慢绿');
      SPEED_COLOR_STOPS.forEach((stop, index) => {
        assert.equal(typeof stop.threshold, 'number', `第 ${index} 段 threshold 应为数值`);
        assert.ok(!Number.isNaN(stop.threshold), `第 ${index} 段 threshold 不应为 NaN`);
        assert.match(stop.color, HEX_COLOR_RE, `第 ${index} 段 color 应为 #RRGGBB`);
      });
      assert.equal(SPEED_COLOR_STOPS[0].threshold, 0, '首段阈值应从 0 起，保证低速段全程覆盖');
      const thresholds = SPEED_COLOR_STOPS.map((stop) => stop.threshold);
      thresholds.forEach((threshold, index) => {
        if (index > 0) {
          assert.ok(
            threshold > thresholds[index - 1],
            `阈值应严格升序：第 ${index} 段 ${threshold} 未大于前一段 ${thresholds[index - 1]}`,
          );
        }
      });
    },
  },
  {
    name: '全部 color 字段匹配 /^#[0-9a-fA-F]{6}$/（防止 constants.js 与 _variables.scss 两处手写笔误）',
    run: async () => {
      const constants = await importConstants();
      const colors = [
        ...Object.values(constants.ALARM_LEVEL_CONFIG).map((config) => config.color),
        ...Object.values(constants.ZONE_TYPE_CONFIG).map((config) => config.color),
        ...constants.SPEED_COLOR_STOPS.map((stop) => stop.color),
      ];
      colors.forEach((color, index) => {
        assert.match(
          color,
          HEX_COLOR_RE,
          `第 ${index} 个 color 值「${String(color)}」应为 #RRGGBB 六位十六进制`,
        );
      });
    },
  },
];

// 递归发现 src 下全部 *.verify.js（win32 安全：动态 import 统一走 pathToFileURL）
const discoverVerifyFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) return discoverVerifyFiles(entryPath);
    return entry.name.endsWith('.verify.js') ? [entryPath] : [];
  });

const toPosixPath = (filePath) => filePath.replaceAll('\\', '/');

const buildFileTests = (files) =>
  files.map((filePath) => ({
    name: `挂载点 ${toPosixPath(relative(PROJECT_ROOT, filePath))}`,
    run: async () => {
      const testModule = await import(pathToFileURL(filePath).href);
      if (typeof testModule.verify !== 'function') {
        throw new Error('未具名导出 verify(assert) 函数（挂载约定见本文件头部注释）');
      }
      await testModule.verify(assert);
    },
  }));

const runTests = async (tests) =>
  Promise.all(
    tests.map(async (test) => {
      try {
        await test.run();
        return { name: test.name, error: null };
      } catch (error) {
        return { name: test.name, error };
      }
    }),
  );

const main = async () => {
  if (!existsSync(SRC_DIR)) {
    console.warn('（src/ 目录尚不存在，跳过 *.verify.js 挂载点发现——脚手架落地后自动生效）');
  }
  const discoveredFiles = existsSync(SRC_DIR) ? discoverVerifyFiles(SRC_DIR) : [];
  const results = await runTests([...TESTS, ...buildFileTests(discoveredFiles)]);
  const failures = results.filter((result) => result.error !== null);
  results
    .filter((result) => result.error === null)
    .forEach((result) => console.log(`  ✔ ${result.name}`));
  if (failures.length > 0) {
    console.error(`\n自测失败 ${failures.length}/${results.length} 项：`);
    failures.forEach((result) =>
      console.error(`  ✘ ${result.name}\n      ${result.error.message}`),
    );
    process.exit(1);
  }
  console.log(`\n自测全部通过：共 ${results.length} 项（pnpm verify）`);
};

main().catch((error) => {
  console.error('verify 运行器自身出错：', error);
  process.exit(1);
});
