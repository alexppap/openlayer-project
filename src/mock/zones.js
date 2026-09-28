// src/mock/zones.js — 厂区 GeoJSON 初始种子（设计 §4.1 L102：初始无 localStorage 数据时回退本种子）。
//
// ⚠ 纯数据模块：零 ol/vue import，保证 node 可导入（mock/zones.verify.js 在纯 node 下断言）。
// 坐标约定：业务坐标一律 EPSG:4326 [lng, lat]（设计 §2 L27），地图渲染前经 map/utils.js 转 3857。
// 布设说明：围绕 MAP_DEFAULT_VIEW.center=[121.4737, 31.2304]（上海占位中心，非真实厂区位置，
// constants.js 注释已言明）约 ±0.004° 布设四类区域各一，环闭合（首尾点相等，GeoJSON 规范）；
// properties = { id, name, type }，type 枚举对齐 constants.ZONE_TYPE_CONFIG 四键，
// 仅危险品区附加 fence: true（任务原文：危险品区 properties.fence=true，电子围栏禁区见设计 §4.5）。
export const ZONES_SEED_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { id: 'zone-production', name: '生产区', type: 'production' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [121.4698, 31.2282],
            [121.4722, 31.2282],
            [121.4722, 31.2315],
            [121.4698, 31.2315],
            [121.4698, 31.2282],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { id: 'zone-warehouse', name: '仓储区', type: 'warehouse' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [121.4751, 31.2282],
            [121.4775, 31.2282],
            [121.4775, 31.2318],
            [121.4751, 31.2318],
            [121.4751, 31.2282],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { id: 'zone-office', name: '办公区', type: 'office' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [121.4725, 31.2322],
            [121.4749, 31.2322],
            [121.4749, 31.234],
            [121.4725, 31.234],
            [121.4725, 31.2322],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { id: 'zone-danger', name: '危险品区', type: 'danger', fence: true },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [121.4729, 31.226],
            [121.4745, 31.226],
            [121.4745, 31.2274],
            [121.4729, 31.2274],
            [121.4729, 31.226],
          ],
        ],
      },
    },
  ],
};
