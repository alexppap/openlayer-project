// src/api/zonesApi.verify.js — 厂区数据 mock API 契约自测（pnpm verify 自动发现挂载）
//
// ⚠ 测试先行：本文件先于 src/api/zonesApi.js 落地（实施计划步骤 4），
//   在被测模块实现前 pnpm verify 对本挂载点报「找不到模块」属预期红灯。
//
// ⚠ 运行环境约束：本文件在纯 node 下执行；node 默认无 globalThis.localStorage，
//   实现按计划步骤 4 须「经 globalThis.localStorage（node 下 undefined 不炸）」
//   在调用时读取（而非模块导入时快照），本文件的存取桩替换才有效。
//
// 被测契约（实施计划 testPoint「api/zonesApi」+ 步骤 4；设计 §5 L143/L145）：
//   getZones()：读 ZONES_STORAGE_KEY；存储不存在 / 内容非法 JSON 时回退深拷贝种子，
//     任何分支均 resolve、永不 reject（设计 §5 L143「mock 永不 reject」）。
//     两次调用结果互为深拷贝——污染上一次返回值不得影响下一次（防种子污染）。
//   saveZones(geojson)：序列化写 localStorage；成功 resolve { ok: true }；
//     失败（如 node 无 localStorage / 隐私模式 / 配额）console.error 后
//     resolve { ok: false, error } ——结构化结果而非 reject，
//     同时满足「永不 reject」与「保存失败可提示」（设计 §5 L143 并读 L145）。
//
// 诚实缺口（计划 risks 已声明）：saveZones 成功路径（真实写入/回读 round-trip）
//   依赖真实 localStorage，node 下无法断言，留待浏览器人工验收（计划步骤 10）。

import { getZones, saveZones } from './zonesApi.js';
import { ZONES_SEED_GEOJSON } from '../mock/zones.js';

// 构造「存储内容非法 JSON」桩：getItem 返回腐坏字符串，setItem 可正常记录
const createCorruptStorageStub = () => ({
  getItem: () => '{{{不是合法JSON',
  setItem: () => {},
});

export const verify = async (assert) => {
  // 环境控制：验证期间确保 globalThis.localStorage 缺位（node 默认如此；
  // 显式删除是为防未来 node 默认启用 webstorage 导致回退分支漂移），结束后还原。
  const localStorageExisted = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const savedLocalStorage = globalThis.localStorage;
  const dropLocalStorage = () => {
    delete globalThis.localStorage;
  };
  const restoreLocalStorage = () => {
    if (localStorageExisted) {
      globalThis.localStorage = savedLocalStorage;
    } else {
      delete globalThis.localStorage;
    }
  };

  try {
    dropLocalStorage();
    assert.equal(globalThis.localStorage, undefined, '前置：本分支验证须处于无 localStorage 环境');

    // —— 回退分支：无 localStorage 时 getZones() resolve 值 deepEqual 种子 ——
    const firstResult = await getZones();
    assert.deepEqual(
      firstResult,
      ZONES_SEED_GEOJSON,
      '无 localStorage 时 getZones() 应回退并 resolve 种子数据',
    );

    // —— 深拷贝：两次结果互为深拷贝，污染前者不影响后者（防种子污染）——
    const secondResult = await getZones();
    assert.notEqual(
      firstResult,
      secondResult,
      '两次 getZones() 不应返回同一引用（须各自深拷贝种子）',
    );
    firstResult.features[0].properties.name = '__污染测试__';
    firstResult.features[0].geometry.coordinates[0][0][0] = 999;
    const thirdResult = await getZones();
    assert.deepEqual(
      thirdResult,
      ZONES_SEED_GEOJSON,
      '污染上一次 getZones() 返回值不应影响下一次（每次均为种子深拷贝）',
    );

    // —— saveZones 失败契约：无 localStorage 时 resolve { ok:false } 且 await 不抛 ——
    // （assert.doesNotReject 返回 undefined，resolve 值须经回调内变量承接）
    let saveResult;
    await assert.doesNotReject(
      async () => {
        saveResult = await saveZones({ type: 'FeatureCollection', features: [] });
      },
      'saveZones 在无 localStorage 环境不应 reject（失败为结构化结果）',
    );
    assert.ok(saveResult && typeof saveResult === 'object', 'saveZones 应 resolve 结果对象');
    assert.equal(saveResult.ok, false, '无 localStorage 时 saveZones 应 resolve { ok: false }');
    assert.ok(
      saveResult.error,
      '失败结果应携带 error 信息（供 useNotice 提示「保存失败，刷新后编辑将丢失」）',
    );

    // —— 脏数据回退（计划步骤 4「JSON.parse 失败回退种子」）：
    //    存在 localStorage 但内容非法 JSON 时，getZones() 仍回退种子且不 reject ——
    globalThis.localStorage = createCorruptStorageStub();
    let fromCorrupt;
    await assert.doesNotReject(
      async () => {
        fromCorrupt = await getZones();
      },
      '存储内容非法 JSON 时 getZones() 也不应 reject',
    );
    assert.deepEqual(
      fromCorrupt,
      ZONES_SEED_GEOJSON,
      '存储内容非法 JSON 时 getZones() 应回退深拷贝种子',
    );
  } finally {
    restoreLocalStorage();
  }
};
