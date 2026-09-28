// src/api/zonesApi.js — 厂区数据 mock API（设计 §4.1 L102、§5 L143/L145）。
//
// 契约（api/zonesApi.verify.js 断言）：
//   getZones()：读 localStorage key ZONES_STORAGE_KEY；无存储 / 内容非法 JSON / 非法结构
//     时回退种子的深拷贝（每次调用各自独立，污染上一次返回值不影响下一次）；
//     任何分支均 resolve、永不 reject（设计 §5 L143「mock 永不 reject」）。
//   saveZones(geojson)：序列化写 localStorage；成功 resolve { ok: true }；
//     失败（node 无 localStorage / 隐私模式 / 配额超限）console.error 后
//     resolve { ok: false, error } ——结构化结果而非 reject，调用方据此提示
//     「保存失败，刷新后编辑将丢失」（设计 §5 L145）且不阻断当前会话。
//
// ⚠ node 兼容：globalThis.localStorage 于调用时读取（node 下为 undefined 不炸），
//   不在模块导入时快照，测试/运行环境替换存储实现才生效。
import { ZONES_STORAGE_KEY } from '../constants.js';
import { ZONES_SEED_GEOJSON } from '../mock/zones.js';

// 读取并解析 localStorage 中的厂区数据；无存储 / 无内容 / JSON 非法 / 结构非法均返回 null
const readStoredZones = () => {
  try {
    const stored = globalThis.localStorage?.getItem(ZONES_STORAGE_KEY);
    if (!stored) {
      return null;
    }
    const parsed = JSON.parse(stored);
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.features)) {
      console.error('[zonesApi] localStorage 厂区数据结构非法，回退种子数据');
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('[zonesApi] localStorage 厂区数据解析失败，回退种子数据：', error);
    return null;
  }
};

// 取厂区 GeoJSON（EPSG:4326）：有合法持久化数据用之，否则回退种子深拷贝
export const getZones = async () => {
  const stored = readStoredZones();
  // structuredClone 深拷贝：种子是模块级共享常量，绝不能把它的引用交出去被污染
  return stored ?? structuredClone(ZONES_SEED_GEOJSON);
};

// 保存厂区 GeoJSON 到 localStorage：失败不抛（resolve { ok:false, error }），
// 注意 setItem 故意不用可选链——无 localStorage 时须走进 catch 走失败分支
export const saveZones = async (geojson) => {
  try {
    globalThis.localStorage.setItem(ZONES_STORAGE_KEY, JSON.stringify(geojson));
    return { ok: true };
  } catch (error) {
    console.error('[zonesApi] 厂区数据保存失败（localStorage 不可用或配额超限）：', error);
    return { ok: false, error };
  }
};
