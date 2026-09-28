// src/composables/useZones.js — 厂区渲染/绘制/编辑/导出/持久化（设计 §4.1 L96-102）。
//
// 模块级单例（不引 Pinia，AGENTS.md：跨组件状态由 composable 单例内聚）：
//   initZones({ mode }) 由 App.vue setup 调用一次，mode 为 App 持有的全局交互模式 ref
//   （设计 §3.4：App 维护 mode，composable 读取驱动交互互斥）。
//
// ⚠ node 兼容（useZones.verify.js 在纯 node 下导入本模块）：
//   模块顶层只创建 vue ref 与纯函数，ol 实例（source/layer/interaction/overlay）
//   一律在 initZones 内惰性构造；DOM（document/URL）只在浏览器动作函数内访问。
import { ref, watch } from 'vue';
import Draw from 'ol/interaction/Draw.js';
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom.js';
import Modify from 'ol/interaction/Modify.js';
import Translate from 'ol/interaction/Translate.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Overlay from 'ol/Overlay.js';
import { getZones, saveZones } from '../api/index.js';
import {
  FLY_TO_DEFAULT_ZOOM,
  ZONES_EXPORT_FILENAME,
  ZONES_LAYER_ID,
  ZONE_TYPE_CONFIG,
} from '../constants.js';
import * as layerManager from '../map/layerManager.js';
import { createZoneStyle, featuresFromGeoJson, geoJsonFromFeatures } from '../map/utils.js';
import { useMap } from './useMap.js';
import { useNotice } from './useNotice.js';

// ---- 模块级单例状态（zonesInitialized 前均为 null/旗标占位，构造在 initZones）----
let zonesLayerInstance = null;
let zonesSourceInstance = null;
let zonePopupOverlay = null;
let drawInteraction = null;
let modifyInteraction = null;
let translateInteraction = null;
let zonesInitialized = false;
let zonesLoaded = false; // 首次加载完成旗标（重挂载地图时不重复 addFeatures）
let zonesDirty = false; // 编辑脏标记：模式退出时据此自动保存（设计 §4.1 L100）
let pendingDrawnFeature = null; // 双击完成、等待小表单确认入库的绘制要素
let registeredPopupElement = null; // ZoneFormPopup 注册的根 DOM（Overlay 元素）
let doubleClickZoomPreviousActive = null; // Draw 激活前 DoubleClickZoom 的原状态，退出恢复
let modeRef = null; // App 持有的全局交互模式 ref（initZones 传入，closeZoneForm 恢复 Draw 时读取）
let stopModeWatch = null; // mode watch 的停止函数（initZones 重接线前先停旧表）

// 绘制完成后弹出的小表单状态：null（隐藏）| { defaultType }（ZoneFormPopup 据此渲染）
const zoneForm = ref(null);
const DEFAULT_ZONE_TYPE = Object.keys(ZONE_TYPE_CONFIG)[0];

// 新建区域 properties 的 id 生成（时间戳 + 随机串，避免与既有 id 撞车）
const createZoneId = () => `zone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ---- 纯函数：ZoneFormPopup 保存时的属性校验/定形（useZones.verify.js 断言对象）----
// 白名单定形 { id, name, type }：名称非空白、类型 ∈ ZONE_TYPE_CONFIG 键集合，否则抛 Error；
// 仅 type === 'danger' 附加 fence: true（设计 §4.1 L98/§4.5 L127：危险品区为围栏禁区），
// 输入携带的其他键（含伪造的 fence）一律不透传。
export const resolveZoneProperties = ({ id, name, type }) => {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('区域名称不能为空');
  }
  if (!Object.prototype.hasOwnProperty.call(ZONE_TYPE_CONFIG, type)) {
    throw new Error(`未知区域类型「${String(type)}」`);
  }
  const properties = { id, name: name.trim(), type };
  if (type === 'danger') {
    properties.fence = true;
  }
  return properties;
};

// 持久化当前 source 全部要素（4326 GeoJSON）：失败 console.error + 顶部通知条警告
// 「保存失败，刷新后编辑将丢失」且不阻断会话（设计 §5 L145）；返回结构化结果供调用方分支。
const persistZones = async () => {
  if (!zonesSourceInstance) {
    return { ok: false, error: new Error('厂区图层尚未初始化') };
  }
  const geojson = geoJsonFromFeatures(zonesSourceInstance.getFeatures());
  const result = await saveZones(geojson);
  if (!result.ok) {
    console.error('厂区保存失败：', result.error);
    useNotice().notify({ type: 'warning', message: '保存失败，刷新后编辑将丢失' });
  }
  return result;
};

// ---- 绘制小表单（OL Overlay + ZoneFormPopup，AGENTS.md：贴图弹窗不用 UI 库 Dialog）----
const closeZoneForm = () => {
  pendingDrawnFeature = null;
  zoneForm.value = null;
  if (zonePopupOverlay) {
    zonePopupOverlay.setPosition(undefined); // ol 据此隐藏 overlay 元素
  }
  // 表单待确认期间 Draw 处于暂停（见 handleDrawEnd）；关闭后若仍处于绘制模式则恢复，
  // 用户可继续绘制下一个区域。模式切换退出路径中 mode 已翻转为非 drawZone，不会误恢复
  //（deactivateMode 随后仍会 setActive(false) 兜底，重复关闭对 ol 无副作用）。
  if (modeRef?.value === 'drawZone' && drawInteraction) {
    drawInteraction.setActive(true);
  }
};

const handleZoneFormCancel = () => {
  closeZoneForm(); // 取消即丢弃待入库的绘制要素（未进 source，无需回滚）
};

const handleZoneFormSubmit = async ({ name, type }) => {
  const feature = pendingDrawnFeature;
  if (!feature) {
    return;
  }
  let properties;
  try {
    properties = resolveZoneProperties({ id: createZoneId(), name, type });
  } catch (error) {
    console.error('区域属性校验失败：', error);
    useNotice().notify({ type: 'error', message: error.message });
    return; // 校验失败保持表单打开，修正后可再提交
  }
  feature.setProperties(properties);
  zonesSourceInstance.addFeature(feature); // ol VectorSource 为命令式 API（AGENTS.md 例外条款）
  closeZoneForm();
  await persistZones(); // 入库即持久化，刷新后保留（设计 §4.1 L102）
};

// ZoneFormPopup onMounted 时注册根 DOM 作为 Overlay 元素（可能早于 initZones，先暂存）
const registerZonePopupElement = (element) => {
  registeredPopupElement = element;
  if (zonePopupOverlay) {
    zonePopupOverlay.setElement(element);
  }
};

// 取要素的表单锚点：多边形 interior point（表单弹在图形内部），退化时回退首点
const resolveFeatureAnchor = (feature) => {
  const geometry = feature.getGeometry();
  if (geometry && typeof geometry.getInteriorPoint === 'function') {
    const interiorPoint = geometry.getInteriorPoint();
    if (interiorPoint) {
      return interiorPoint.getCoordinates();
    }
  }
  return geometry.getFirstCoordinate();
};

// 双击完成绘制（Draw 无 source：要素仅在表单确认入库时才进 source）。
// 表单待确认期间暂停 Draw：Overlay 的 stopEvent 只挡表单元素内的事件，地图区域仍可
// 画出第二个多边形——若不暂停，第二次 drawend 会覆盖 pendingDrawnFeature，
// 前一个已画好的草稿被静默丢弃。恢复时机见 closeZoneForm。
// ★守卫（上轮评审未回应项）：pendingDrawnFeature 非 null（表单待确认）时再进 drawend，
//   拒绝新草图（warning 通知提示先处理当前表单）并保持 Draw 停用，绝不静默覆盖草稿。
//   纵深防御：常规事件流中第二个 drawend 已因 setActive(false) 不可达，
//   守卫把「不静默丢数据」变成显式不变量并覆盖未来重构/边界。
//   具名导出供 useZones.verify.js 在 node 下直接调用（overlay/interaction 为 null 占位时路径安全）。
export const handleDrawEnd = (event) => {
  if (pendingDrawnFeature) {
    useNotice().notify({ type: 'warning', message: '请先处理当前待确认的区域表单（保存或取消）' });
    if (drawInteraction) {
      drawInteraction.setActive(false); // 新草图因 Draw 无 source 自然不入库，无须回滚
    }
    return;
  }
  pendingDrawnFeature = event.feature;
  zoneForm.value = { defaultType: DEFAULT_ZONE_TYPE };
  if (zonePopupOverlay) {
    zonePopupOverlay.setPosition(resolveFeatureAnchor(event.feature)); // EPSG:3857
  }
  if (drawInteraction) {
    drawInteraction.setActive(false);
  }
};

// ---- DoubleClickZoom 禁停（设计 §3.4 L92：Draw/Measure 激活时禁用，退出恢复原状态）----
const findDoubleClickZoom = (map) =>
  map
    .getInteractions()
    .getArray()
    .find((interaction) => interaction instanceof DoubleClickZoom);

const setDoubleClickZoomEnabled = (enabled) => {
  const map = useMap().mapInstance.value;
  if (!map) {
    return;
  }
  const doubleClickZoom = findDoubleClickZoom(map);
  if (!doubleClickZoom) {
    return;
  }
  if (enabled) {
    doubleClickZoom.setActive(doubleClickZoomPreviousActive ?? true);
    doubleClickZoomPreviousActive = null;
  } else {
    doubleClickZoomPreviousActive = doubleClickZoom.getActive();
    doubleClickZoom.setActive(false);
  }
};

// ---- mode 互斥（设计 §3.4：切换工具自动停用上一交互，同一时刻仅一个激活）----
const deactivateMode = (mode) => {
  if (mode === 'drawZone') {
    closeZoneForm(); // 退出绘制即丢弃未确认的表单与暂存要素
    if (drawInteraction) {
      drawInteraction.setActive(false);
    }
    setDoubleClickZoomEnabled(true);
  } else if (mode === 'editZone') {
    if (modifyInteraction) {
      modifyInteraction.setActive(false);
    }
    if (translateInteraction) {
      translateInteraction.setActive(false);
    }
    if (zonesDirty) {
      zonesDirty = false;
      persistZones(); // 编辑结束（模式退出）自动保存（设计 §4.1 L100）；失败提示在 persistZones 内
    }
  }
};

const activateMode = (mode) => {
  if (mode === 'drawZone') {
    setDoubleClickZoomEnabled(false);
    if (drawInteraction) {
      drawInteraction.setActive(true);
    }
  } else if (mode === 'editZone') {
    if (modifyInteraction) {
      modifyInteraction.setActive(true);
    }
    if (translateInteraction) {
      translateInteraction.setActive(true);
    }
  }
};

// ---- 数据加载与视图 ----
const fitToZones = () => {
  const map = useMap().mapInstance.value;
  if (!map || !zonesSourceInstance) {
    return;
  }
  const extent = zonesSourceInstance.getExtent();
  if (!Number.isFinite(extent[0]) || !Number.isFinite(extent[3])) {
    return; // 空 source 的 extent 为 ±Infinity，无从 fit
  }
  map.getView().fit(extent, { padding: [48, 48, 48, 48], maxZoom: FLY_TO_DEFAULT_ZOOM });
};

const loadZones = async () => {
  try {
    const geojson = await getZones(); // 组件/composable 只调 api/*（AGENTS.md 分层约定）
    zonesSourceInstance.addFeatures(featuresFromGeoJson(geojson));
    zonesLoaded = true;
    fitToZones(); // 首次加载 fit 使厂区居中（MAP_DEFAULT_VIEW 为占位中心，不改动）
  } catch (error) {
    console.error('厂区数据加载失败：', error);
    useNotice().notify({ type: 'error', message: '厂区数据加载失败，请刷新页面重试' });
  }
};

// 地图就绪后接线：加图层/overlay/交互（全部交互初始 inactive，由 mode watch 激活）
const attachToMap = (map) => {
  map.addLayer(zonesLayerInstance);
  map.addOverlay(zonePopupOverlay);
  map.addInteraction(drawInteraction);
  map.addInteraction(modifyInteraction);
  map.addInteraction(translateInteraction);
  if (!zonesLoaded) {
    loadZones();
  }
};

// ---- 初始化（App.vue setup 调用；实例构造幂等，mode watch 每次重接线）----
const initZones = ({ mode }) => {
  // mode watch 重接线放在幂等守卫之前：App.vue script 热更新（HMR reload）后 setup
  // 重新执行、传入新的 mode ref，而 useZones 模块不重载、旧 watch 已随旧组件实例销毁——
  // 若守卫先行 return，新 ref 将无人 watch，工具栏交互启停失联直至手动刷新。
  // watch 创建于调用方组件的 effect scope（随组件销毁自动停止），
  // 此处先手动停上一张旧表再重建，双重停止对 watch 是幂等安全的。
  if (typeof stopModeWatch === 'function') {
    stopModeWatch();
  }
  modeRef = mode;
  stopModeWatch = watch(mode, (nextMode, previousMode) => {
    deactivateMode(previousMode);
    activateMode(nextMode);
  });

  if (zonesInitialized) {
    return;
  }
  zonesInitialized = true;

  // HMR 自愈（照 useAlarms.js:374-386 先例复用，仅开发期可达）：直接修改本文件触发
  // Vite HMR 时模块重执行、上面的守卫状态随模块重置为 false，而未变更的
  // layerManager/地图单例仍保留上一代 'zones-layer' 注册与挂载——先摘旧图层、
  // 反注册旧 entry 再全新构造，否则 register 对重复 id 抛错（layerManager.js:32）
  // 令 App setup 崩溃白屏。旧 Draw/Modify/Translate/Overlay 残留为失活惰性对象
  // （先例注释 useAlarms.js:378-379），仅开发期存在，无功能影响。
  const { mapInstance, isMapReady } = useMap();
  const staleLayerEntry = layerManager.getLayerById(ZONES_LAYER_ID);
  if (staleLayerEntry) {
    if (mapInstance.value?.getLayers().getArray().includes(staleLayerEntry.layer)) {
      mapInstance.value.removeLayer(staleLayerEntry.layer);
    }
    layerManager.unregister(ZONES_LAYER_ID);
  }

  zonesSourceInstance = new VectorSource();
  zonesLayerInstance = new VectorLayer({
    source: zonesSourceInstance,
    style: createZoneStyle, // 按区域类型着色 + 内部名称标注（设计 §4.1 L98）
  });
  // 图层经 layerManager 注册，LayerTree 才能统一控制显隐（AGENTS.md 分层约定）
  layerManager.register({ id: ZONES_LAYER_ID, name: '厂区区域', layer: zonesLayerInstance, visible: true });

  zonePopupOverlay = new Overlay({
    element: registeredPopupElement ?? undefined,
    positioning: 'bottom-center',
    autoPan: true,
    stopEvent: true, // 表单内点击/拖选不透传给地图
  });

  drawInteraction = new Draw({ type: 'Polygon' }); // 不绑 source：表单确认入库时才 addFeature
  drawInteraction.setActive(false);
  drawInteraction.on('drawend', handleDrawEnd);

  modifyInteraction = new Modify({ source: zonesSourceInstance }); // 拖顶点/加删点
  modifyInteraction.setActive(false);
  modifyInteraction.on('modifyend', () => {
    zonesDirty = true;
  });

  translateInteraction = new Translate({ layers: [zonesLayerInstance] }); // 挪整体
  translateInteraction.setActive(false);
  translateInteraction.on('translateend', () => {
    zonesDirty = true;
  });

  watch(
    isMapReady,
    (ready) => {
      if (ready && mapInstance.value) {
        attachToMap(mapInstance.value); // 仅首次接线：重复 addLayer/addOverlay 会重复挂载
      }
    },
    { immediate: true }, // App setup 先于 MapCanvas 挂载，靠后续翻转触发
  );
};

// ---- 导出 GeoJSON（设计 §4.1 L101：writeFeatures 后触发浏览器下载）----
const exportZones = () => {
  if (!zonesSourceInstance) {
    return;
  }
  try {
    const geojson = geoJsonFromFeatures(zonesSourceInstance.getFeatures()); // 4326
    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = ZONES_EXPORT_FILENAME;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 0); // 下一轮宏任务再回收，避免先于下载生效
  } catch (error) {
    console.error('厂区 GeoJSON 导出失败：', error);
    useNotice().notify({ type: 'error', message: '厂区 GeoJSON 导出失败' });
  }
};

// useZones() 每次返回同一组单例引用与操作函数（与 useNotice/useMap 同构）
export const useZones = () => ({
  zoneForm,
  initZones,
  registerZonePopupElement,
  handleZoneFormSubmit,
  handleZoneFormCancel,
  exportZones,
});
