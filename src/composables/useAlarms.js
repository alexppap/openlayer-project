// src/composables/useAlarms.js — 报警聚合徽标/详情弹窗/列表联动（设计 §4.2 L104-110）。
//
// 模块级单例（不引 Pinia，AGENTS.md：跨组件状态由 composable 单例内聚）：
//   initAlarms() 由 App.vue setup 调用一次（幂等；HMR 重入先退订再订、重接线 watch）。
//
// ⚠ node 兼容（useAlarms.verify.js 在纯 node 下导入本模块，先例 useZones.js:7-9）：
//   模块顶层只创建 vue ref/computed 与纯函数，ol 实例（source/layer/Overlay）
//   一律在 initAlarms 内惰性构造；DOM（document）只在浏览器运行时函数内访问。
//
// ★条数口径（设计 §4.2 L106-107，上轮评审敏感点）：徽标数 = pending 记录数，
//   acked 不计；单点徽标 = 该位置 pending 数，聚合点徽标 = 聚合内各点 pending 之和。
import { computed, ref, watch } from 'vue';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import Overlay from 'ol/Overlay.js';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style.js';
import Cluster from 'ol/source/Cluster.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { ackAlarm, getAlarms, subscribeAlarms } from '../api/index.js';
import {
  ALARMS_LAYER_ID,
  ALARM_LEVEL_CONFIG,
  ALARM_NEUTRAL_COLOR,
  ALARM_SEVERITY_ORDER,
  CLUSTER_DISTANCE_PX,
  VIEW_ANIMATE_DURATION_MS,
} from '../constants.js';
import * as layerManager from '../map/layerManager.js';
import {
  createAlarmMarkerIcon,
  createDeviceMarkerIcon,
  isValidLngLat,
  toMapCoord,
  withAlpha,
} from '../map/utils.js';
import { useMap } from './useMap.js';
import { useNotice } from './useNotice.js';

// ---- 纯函数：分组与徽标（useAlarms.verify.js 断言对象）----

// 报警记录按 deviceId 分组（同设备多条报警归一个点位）：
//   - 坐标非法（NaN/±Infinity/越界）的记录★静默剔除不抛错（设计 §5 L145），
//     组内全部非法则整组不出现（无合法锚点可渲染）；空数组 → []；
//   - anchor = 组内 time 最大（最新）记录的 [lng, lat]（单点渲染锚点）；
//   - records 按时间倒序（新 → 旧，AlarmPopup 明细列表序）；
//   - pendingCount = 组内 status==='pending' 的条数（★acked 不计，条数口径）。
export const buildDeviceAlarmGroups = (alarms) => {
  if (!Array.isArray(alarms)) {
    return [];
  }
  const validRecords = alarms.filter((alarm) => isValidLngLat([alarm.lng, alarm.lat]));
  const recordsByDeviceId = new Map();
  validRecords.forEach((alarm) => {
    const deviceRecords = recordsByDeviceId.get(alarm.deviceId) ?? [];
    recordsByDeviceId.set(alarm.deviceId, [...deviceRecords, alarm]);
  });
  return [...recordsByDeviceId.entries()].map(([deviceId, deviceRecords]) => {
    const sortedRecords = [...deviceRecords].sort((earlier, later) => later.time - earlier.time);
    const newestRecord = sortedRecords[0];
    return {
      deviceId,
      deviceName: newestRecord.deviceName,
      deviceType: newestRecord.deviceType,
      anchor: [newestRecord.lng, newestRecord.lat],
      records: sortedRecords,
      pendingCount: sortedRecords.filter((record) => record.status === 'pending').length,
    };
  });
};

// 聚合徽标信息：pendingCount = 各组 pending 记录之和；color = 全部 pending 记录中
// 最高等级色（等级序 = ALARM_SEVERITY_ORDER；★acked 记录不参与取色）；
// 无 pending（含空数组）→ { pendingCount: 0, color: ALARM_NEUTRAL_COLOR }（回退中性灰）。
export const resolveAlarmBadgeInfo = (groups) => {
  const pendingRecords = (Array.isArray(groups) ? groups : []).flatMap((group) =>
    group.records.filter((record) => record.status === 'pending'),
  );
  if (pendingRecords.length === 0) {
    return { pendingCount: 0, color: ALARM_NEUTRAL_COLOR };
  }
  const highestPendingLevel = ALARM_SEVERITY_ORDER.find((level) =>
    pendingRecords.some((record) => record.level === level),
  );
  return {
    pendingCount: pendingRecords.length,
    color: ALARM_LEVEL_CONFIG[highestPendingLevel]?.color ?? ALARM_NEUTRAL_COLOR,
  };
};

// 面板行点击的定位目标（评审 finding 1 修复）：一律取该设备分组的锚点——
// buildDeviceAlarmGroups 产物坐标已过 isValidLngLat；行记录原始坐标可能是被
// §5 L145 静默过滤的 NaN/越界值（面板渲染全量镜像，不做地图侧过滤），
// 直接透传 flyTo 会把 View center 动画成 NaN（地图卡死需刷新）。
// 该设备无分组（全部记录坐标非法）→ 返回 null：只高亮不定位。
export const resolveAlarmLocateTarget = (groups, deviceId) => {
  const targetGroup = (Array.isArray(groups) ? groups : []).find(
    (group) => group.deviceId === deviceId,
  );
  return targetGroup ? targetGroup.anchor : null;
};

// ---- 模块级单例状态（alarmsInitialized 前均为 null/旗标占位，构造在 initAlarms）----
let alarmsSourceInstance = null;
let clusterSourceInstance = null;
let alarmsLayerInstance = null;
let alarmPopupOverlay = null;
let alarmPulseOverlay = null;
let registeredAlarmPopupElement = null;
let alarmsInitialized = false;
let alarmsAttached = false;
let alarmsLoaded = false;
let unsubscribeAlarmPush = null;
let stopAlarmsWatch = null;
let stopSelectionWatch = null;
let stopMapReadyWatch = null;

// 报警记录镜像（getAlarms 初始化 + subscribeAlarms 推送追加 + ack 就地更新）
const alarms = ref([]);
// 报警分组视图（徽标/点位/弹窗共用一份派生，条数口径集中在 buildDeviceAlarmGroups）
const alarmGroups = computed(() => buildDeviceAlarmGroups(alarms.value));
// 地图点选/面板行点击选中的报警记录 id（面板滚动高亮依据）
const selectedAlarmId = ref(null);
// 选中的设备分组 id（点位放大高亮 + 脉冲环 + 弹窗打开态依据）
const activeGroupId = ref(null);
// 选中态的设备分组 id（样式放大高亮依据；与弹窗打开态解耦）
const selectedDeviceId = ref(null);
// 弹窗当前展示的设备分组（activeGroupId 在分组视图中的实时快照，ack 后随镜像刷新）
const activeAlarmGroup = computed(
  () => alarmGroups.value.find((group) => group.deviceId === activeGroupId.value) ?? null,
);
// 选中态分组（样式放大 + 脉冲环定位）：面板行点击或地图点选点亮
const selectedAlarmGroup = computed(
  () => alarmGroups.value.find((group) => group.deviceId === selectedDeviceId.value) ?? null,
);

// ---- 样式函数（渲染时动态读 properties 与选中态 ref）----
const ALARM_CLUSTER_RADIUS = 20;
const ALARM_CLUSTER_FILL_OPACITY = 0.85;
const ALARM_MAX_ZOOM = 19; // 与 mapCore View maxZoom 对齐（OSM 源上限）

const styleAlarmFeature = (feature) => {
  const members = feature.get('features');
  if (Array.isArray(members) && members.length > 1) {
    // 聚合点：等级色圆 + 聚合内 pending 总条数徽标（§4.2 L107）
    const memberGroups = members.map((member) => member.get('group')).filter(Boolean);
    const badgeInfo = resolveAlarmBadgeInfo(memberGroups);
    const clusterStyles = [
      new Style({
        image: new CircleStyle({
          radius: ALARM_CLUSTER_RADIUS,
          fill: new Fill({ color: withAlpha(badgeInfo.color, ALARM_CLUSTER_FILL_OPACITY) }),
          stroke: new Stroke({ color: '#ffffff', width: 3 }),
        }),
      }),
    ];
    if (badgeInfo.pendingCount > 0) {
      clusterStyles.push(
        new Style({
          image: createAlarmMarkerIcon({
            color: badgeInfo.color,
            count: badgeInfo.pendingCount,
            variant: 'cluster',
          }),
        }),
      );
    }
    return clusterStyles;
  }
  // 非聚合单点：设备图标（按 deviceType 分摄像头/传感器）+ 该位置 pending 小徽标；
  // 选中态样式放大（列表-地图联动高亮）。count=0 不渲染徽标。
  const member = Array.isArray(members) ? members[0] : null;
  const group = member?.get('group');
  if (!group) {
    return new Style({});
  }
  const isSelected = group.deviceId === selectedDeviceId.value;
  const badgeInfo = resolveAlarmBadgeInfo([group]);
  const pointStyles = [
    new Style({ image: createDeviceMarkerIcon({ deviceType: group.deviceType, selected: isSelected }) }),
  ];
  if (badgeInfo.pendingCount > 0) {
    pointStyles.push(
      new Style({
        image: createAlarmMarkerIcon({
          color: badgeInfo.color,
          count: badgeInfo.pendingCount,
          variant: 'point',
          selected: isSelected,
        }),
      }),
    );
  }
  return pointStyles;
};

// ---- 报警点位重建（alarms 镜像变化 → 函数式重建 features；ol 命令式 API 按惯例使用）----
const rebuildAlarmFeatures = () => {
  if (!alarmsSourceInstance) {
    return;
  }
  const alarmFeatures = alarmGroups.value.map(
    (group) =>
      new Feature({
        geometry: new Point(toMapCoord(group.anchor)), // 业务坐标 4326 → 渲染 3857（map/utils 收敛）
        group, // 分组快照挂在 properties：聚类后经 member.get('group') 取回
      }),
  );
  alarmsSourceInstance.clear();
  alarmsSourceInstance.addFeatures(alarmFeatures);
};

// ---- 弹窗与联动 ----
const closeAlarmPopup = () => {
  activeGroupId.value = null;
  if (alarmPopupOverlay) {
    alarmPopupOverlay.setPosition(undefined);
  }
};

const handleAlarmPopupClose = () => {
  closeAlarmPopup();
};

// 地图 singleclick：聚合点→放大一级；单点→开 AlarmPopup + 面板滚动高亮；空白→关弹窗
const handleMapSingleClick = (event) => {
  const map = useMap().mapInstance.value;
  if (!map || !alarmsLayerInstance) {
    return;
  }
  const hitFeature = map.forEachFeatureAtPixel(event.pixel, (feature) => feature, {
    hitTolerance: 8,
    layerFilter: (layer) => layer === alarmsLayerInstance,
  });
  if (!hitFeature) {
    if (activeGroupId.value !== null) {
      closeAlarmPopup();
    }
    return;
  }
  const members = hitFeature.get('features');
  if (Array.isArray(members) && members.length > 1) {
    const view = map.getView();
    view.animate({
      center: hitFeature.getGeometry().getCoordinates(),
      zoom: Math.min(view.getZoom() + 1, ALARM_MAX_ZOOM),
      duration: VIEW_ANIMATE_DURATION_MS,
    });
    return;
  }
  const group = Array.isArray(members) ? members[0]?.get('group') : null;
  if (!group) {
    return;
  }
  activeGroupId.value = group.deviceId;
  selectedDeviceId.value = group.deviceId;
  selectedAlarmId.value = group.records[0]?.id ?? null; // 面板滚动到该位置最新一条
  if (alarmPopupOverlay) {
    alarmPopupOverlay.setPosition(toMapCoord(group.anchor));
  }
};

// 面板行点击 → flyTo 定位 + 点位高亮放大（选中态；脉冲环随 selectedAlarmGroup 挂位置）。
// 定位目标经 resolveAlarmLocateTarget 收敛到分组锚点（已过滤非法坐标）：
// NaN/越界原始坐标不进 View（评审 finding 1），无合法锚点时仅高亮不定位。
const handlePanelRowClick = (alarm) => {
  selectedAlarmId.value = alarm.id;
  selectedDeviceId.value = alarm.deviceId;
  closeAlarmPopup(); // 弹窗只跟随地图点选，面板定位不再叠开
  const locateTarget = resolveAlarmLocateTarget(alarmGroups.value, alarm.deviceId);
  if (locateTarget) {
    useMap().flyTo({ lng: locateTarget[0], lat: locateTarget[1] });
  }
};

// 标记处理一条报警：成功就地更新镜像（徽标/弹窗/列表同步刷新），失败 useNotice + console.error
const handleAckAlarm = async (alarmId) => {
  try {
    const result = await ackAlarm(alarmId);
    if (!result.ok) {
      console.error('报警标记处理失败：', result.error);
      useNotice().notify({ type: 'warning', message: '报警标记处理失败，请重试' });
      return;
    }
    alarms.value = alarms.value.map((alarm) => (alarm.id === alarmId ? result.alarm : alarm));
  } catch (error) {
    console.error('报警标记处理异常：', error);
    useNotice().notify({ type: 'error', message: '报警标记处理失败，请重试' });
  }
};

// AlarmPopup onMounted 时注册根 DOM 作为 Overlay 元素（可能早于 initAlarms，先暂存）
const registerAlarmPopupElement = (element) => {
  registeredAlarmPopupElement = element;
  if (alarmPopupOverlay) {
    alarmPopupOverlay.setElement(element);
  }
};

// ---- 数据加载与地图接线 ----
const loadAlarms = async () => {
  try {
    alarms.value = await getAlarms(); // 组件/composable 只调 api/*（AGENTS.md 分层约定）
    alarmsLoaded = true;
  } catch (error) {
    console.error('报警数据加载失败：', error);
    useNotice().notify({ type: 'error', message: '报警数据加载失败，请刷新页面重试' });
  }
};

// 地图就绪后接线：加图层/overlay/click（仅首次；重复 addLayer/addOverlay 会重复挂载）
const attachAlarmsToMap = (map) => {
  if (alarmsAttached) {
    return;
  }
  alarmsAttached = true;
  map.addLayer(alarmsLayerInstance);
  map.addOverlay(alarmPopupOverlay);
  map.addOverlay(alarmPulseOverlay);
  map.on('singleclick', handleMapSingleClick);
  if (!alarmsLoaded) {
    loadAlarms();
  }
};

// ---- 初始化（App.vue setup 调用；实例构造幂等，订阅与 watch 每次重接线）----
const initAlarms = () => {
  // HMR/重入：先停旧订阅与旧 watch 再重建（订阅泄漏会重复消费推送）
  if (typeof unsubscribeAlarmPush === 'function') {
    unsubscribeAlarmPush();
  }
  [stopAlarmsWatch, stopSelectionWatch, stopMapReadyWatch].forEach((stopWatch) => {
    if (typeof stopWatch === 'function') {
      stopWatch();
    }
  });

  // 实时推送：subscribe 返回取消函数（设计 §3.3 L88）；组件侧不在 onUnmounted 取消——
  // 单例随 App 存续，由下一次 initAlarms 重入或页面卸载收尾
  unsubscribeAlarmPush = subscribeAlarms((alarmRecord) => {
    alarms.value = [...alarms.value, alarmRecord];
  });

  const { mapInstance, isMapReady } = useMap();

  // 镜像变化 → 重建点位（含首次 loadAlarms 填充）
  stopAlarmsWatch = watch(alarms, () => {
    rebuildAlarmFeatures();
  });

  // 选中态变化 → 触发样式重算（放大高亮）+ 脉冲环随锚点移动/隐藏
  stopSelectionWatch = watch(selectedAlarmGroup, (group) => {
    clusterSourceInstance?.changed();
    if (alarmPulseOverlay) {
      alarmPulseOverlay.setPosition(group ? toMapCoord(group.anchor) : undefined);
    }
  });

  stopMapReadyWatch = watch(
    isMapReady,
    (ready) => {
      if (ready && mapInstance.value) {
        attachAlarmsToMap(mapInstance.value);
      }
    },
    { immediate: true }, // App setup 先于 MapCanvas 挂载，靠后续翻转触发
  );

  if (alarmsInitialized) {
    return;
  }
  alarmsInitialized = true;

  // HMR 自愈（评审 finding 3，仅开发期可达）：直接修改本文件触发 Vite HMR 时模块
  // 重执行、上面的守卫状态随模块重置为 false，而未变更的 layerManager/地图单例
  // 仍保留上一代 'alarms-layer' 注册与挂载——先摘旧图层、反注册旧 entry 再全新构造，
  // 否则 register 对重复 id 抛错（layerManager.js:32）令 App setup 崩溃白屏。
  // 旧 singleclick 处理器因旧图层已从地图移除而失活（layerFilter 不再命中）；
  // 旧 Overlay 元素残留为不可见惰性对象，仅开发期存在，无功能影响。
  const staleLayerEntry = layerManager.getLayerById(ALARMS_LAYER_ID);
  if (staleLayerEntry) {
    if (mapInstance.value?.getLayers().getArray().includes(staleLayerEntry.layer)) {
      mapInstance.value.removeLayer(staleLayerEntry.layer);
    }
    layerManager.unregister(ALARMS_LAYER_ID);
  }

  alarmsSourceInstance = new VectorSource();
  clusterSourceInstance = new Cluster({
    distance: CLUSTER_DISTANCE_PX, // 聚合距离 60px（设计 §4.2 L107）
    source: alarmsSourceInstance,
  });
  alarmsLayerInstance = new VectorLayer({
    source: clusterSourceInstance,
    style: styleAlarmFeature,
  });
  // 图层经 layerManager 注册，LayerTree 才能统一控制显隐（AGENTS.md 分层约定）
  layerManager.register({ id: ALARMS_LAYER_ID, name: '报警点位', layer: alarmsLayerInstance, visible: true });

  alarmPopupOverlay = new Overlay({
    element: registeredAlarmPopupElement ?? undefined,
    positioning: 'bottom-center',
    autoPan: true,
    stopEvent: true, // 弹窗内点击/滚动不透传给地图
  });

  // 选中高亮脉冲环（全局动画类见 styles/index.scss；不拦截地图事件）。
  // ★双层结构（评审 finding 0 修复）：ol Overlay 唯一定位手段是给 element 写内联
  // transform（Overlay.js updateRenderedPosition_），而运行中的 CSS 动画优先级高于
  // 内联样式——动画 transform 绝不能落在外层 element 上，否则 ol 的像素平移被覆盖，
  // 环恒错位在视口左上角。外层 anchor（0 尺寸）承接定位，内层 ring 跑动画。
  const pulseAnchorElement = document.createElement('div');
  pulseAnchorElement.className = 'alarm-pulse-ring-anchor';
  const pulseRingElement = document.createElement('div');
  pulseRingElement.className = 'alarm-pulse-ring';
  pulseAnchorElement.appendChild(pulseRingElement);
  alarmPulseOverlay = new Overlay({
    element: pulseAnchorElement,
    positioning: 'center-center', // 外层 0 尺寸，center 偏移为 0，锚点即点位
    stopEvent: false,
  });

  rebuildAlarmFeatures();
};

// useAlarms() 每次返回同一组单例引用与操作函数（与 useNotice/useZones 同构）
export const useAlarms = () => ({
  alarms,
  alarmGroups,
  activeAlarmGroup,
  selectedAlarmId,
  initAlarms,
  registerAlarmPopupElement,
  handleAlarmPopupClose,
  handleAckAlarm,
  handlePanelRowClick,
});
