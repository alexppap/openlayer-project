// src/constants.js — 枚举常量集中地（AGENTS.md：常量 UPPER_SNAKE_CASE 集中于本文件，具名导出）
// ★ 色值与 src/styles/_variables.scss 一一对应（constants.js 供地图渲染、SCSS 供面板 UI）：
//   修改任一处必须同步另一处，scripts/verify.js 断言本文件的 #RRGGBB 格式防笔误。
// 设计依据：docs/superpowers/specs/2026-09-22-openlayers-factory-prototype-design.md

// ---- 应用信息 ----
export const APP_TITLE = '智慧厂区监控台';

// ---- 报警等级（设计 §4.2 L106；热力权重 §4.7 L139：紧急 1 / 重要 0.6 / 一般 0.3）----
export const ALARM_LEVEL_CONFIG = {
  critical: { label: '紧急', color: '#f5222d', heatmapWeight: 1 },
  major: { label: '重要', color: '#fa8c16', heatmapWeight: 0.6 },
  minor: { label: '一般', color: '#fadb14', heatmapWeight: 0.3 },
};

// ---- 报警处理状态（设计 §4.2 L106：status: 'pending' | 'acked'）----
export const ALARM_STATUS = {
  pending: '未处理',
  acked: '已处理',
};

// ---- 报警等级优先序（徽标取色用：序即优先级，critical > major > minor）----
export const ALARM_SEVERITY_ORDER = ['critical', 'major', 'minor'];

// ---- 报警推送与生成（mock setInterval 模拟推送；risks 自选决策，锁值防漂移）----
// subscribeAlarms 的缺省推送间隔；statusPool 取 pending/acked 为任务原文逐字执行
export const ALARM_GENERATE_INTERVAL_MS = 8000;
// 生成器在设备点位附近的最大抖动半径（度，EPSG:4326）
export const ALARM_JITTER_RADIUS_DEG = 0.0003;

// 无 pending 记录时聚合圆/徽标的回退中性灰（与 ALARM_LEVEL_CONFIG 三色均不同）
export const ALARM_NEUTRAL_COLOR = '#8c8c8c';

// ---- 区域类型（设计 §4.1 L98：生产蓝 / 仓储绿 / 办公灰 / 危险红；L127 仅危险品区为围栏禁区）----
export const ZONE_TYPE_CONFIG = {
  production: { label: '生产区', color: '#1890ff' },
  warehouse: { label: '仓储区', color: '#52c41a' },
  office: { label: '办公区', color: '#8c8c8c' },
  danger: { label: '危险品区', color: '#f5222d', fence: true },
};

// ---- 地图交互模式（设计 §3.4 L92，App.vue 维护 mode 状态，同一时刻仅一个激活）----
export const MAP_MODES = ['pan', 'drawZone', 'editZone', 'measureLine', 'measureArea'];

// ---- 报警聚合（设计 §4.2 L107：Cluster distance 60px）----
export const CLUSTER_DISTANCE_PX = 60;

// ---- 车辆实时模式（设计 §4.3 L118：2s 推送一次位置，尾迹保留最近 30 个点）----
export const POSITION_PUSH_INTERVAL_MS = 2000;
export const TRAIL_POINT_COUNT = 30;

// ---- 车辆轨迹（设计 §4.3 L112-118）----
// 历史轨迹采样间隔（10s 一个轨迹点：10h 窗口 = 3600 点/车；mock 生成器与 api 切片共用）
export const TRACK_SAMPLE_INTERVAL_MS = 10000;

// 播放器倍速档位（设计 §4.3 L114：1×/2×/4×/8×/16× 五档）
export const PLAYBACK_SPEED_OPTIONS = [1, 2, 4, 8, 16];

// 实时模式「墙钟 → 路线虚拟时间」加速比。定档 = 1（实跑位移预算）：
// 厂区范围约 733.6×887.0m（mock/zones.js 种子各轴差 × 度-米换算），zoom17 分辨率约 1.02m/px；
// scale=1 时 20/70km/h 每 2s 推送位移 11.1/38.9m ≈ 10.9/38.1px，平滑移动清晰可见；
// scale=60 时 35km/h 每推送跳 1167m，超过厂区对角线 1148m，环线每 3 实秒一圈、
// 30 点尾迹跨 60 虚拟分钟（重描环线约 20 圈），「平滑 + 渐隐」双双失效——故取 1。
export const POSITION_ROUTE_TIME_SCALE = 1;

// ---- 厂区持久化（设计 §4.1 L102：localStorage key）----
export const ZONES_STORAGE_KEY = 'factory-zones';

// ---- 轨迹速度染色分段（设计 §4.3 L117：已走过段快红慢绿，未走段淡虚线）----
// 语义：速度（km/h）>= threshold 且 < 下一档 threshold 时取该档颜色；
// 首档 threshold=0 保证低速段全程覆盖，阈值严格升序（契约见 scripts/verify.js）。
export const SPEED_COLOR_STOPS = [
  { threshold: 0, color: '#52c41a' },
  { threshold: 20, color: '#fadb14' },
  { threshold: 40, color: '#fa8c16' },
  { threshold: 60, color: '#f5222d' },
];

// ---- 地图底座 ----
// 底图瓦片连续失败阈值（设计 §5 L144：tileloaderror 连续失败 ≥5 次提示降级）。
// 「连续」口径：无 tileloadend 成功间隔的错误事件计数；任一成功即复位，新一轮可再次触发。
export const BASEMAP_TILE_ERROR_THRESHOLD = 5;

// 底图降级提示文案（设计 §5 L144 原文；useMap 桥接 useNotice 时使用）
export const BASEMAP_DEGRADED_MESSAGE = '底图加载不畅，请检查外网连接';

// 底图图层 id（kebab-case，AGENTS.md 命名规范；mapCore 注册底图、LayerTree 渲染均用它）
export const BASEMAP_LAYER_ID = 'basemap-osm';

// 视图动画时长（flyTo / resetView 共用，毫秒）
export const VIEW_ANIMATE_DURATION_MS = 600;

// 默认视图（⚠ 显式占位坐标：设计文档与仓库均无厂区真实位置，
// 厂区数据任务接入后以厂区范围 fit 或替换本常量——本任务不编造厂区位置）。
export const MAP_DEFAULT_VIEW = { center: [121.4737, 31.2304], zoom: 15 };

// flyTo 未显式给 zoom 时的默认定位级别（厂区级特写）
export const FLY_TO_DEFAULT_ZOOM = 17;

// ---- App 级通知条（composables/useNotice.js，不引 UI 库）----
export const NOTICE_DEFAULT_DURATION_MS = 5000;

// ---- 厂区图层（设计 §4.1 L96-102 / §4.7 L138；ol 图层 id 用 kebab-case——AGENTS.md 命名规范）----
export const ZONES_LAYER_ID = 'zones-layer';

// ---- 报警图层（设计 §4.2 L106-110：聚合徽标/详情弹窗/列表联动）----
export const ALARMS_LAYER_ID = 'alarms-layer';

// ---- 车辆图层（设计 §4.3 L112-118：轨迹回放/染色/车头朝向/实时尾迹）----
export const VEHICLES_LAYER_ID = 'vehicles-layer';

// 「导出 GeoJSON」按钮触发浏览器下载的文件名（设计 §4.1 L101）
export const ZONES_EXPORT_FILENAME = 'factory-zones.geojson';

// ---- 区域渲染标量（设计 §4.1 L98：半透明填充 + 描边 + 多边形内部名称 Text 标注）----
export const ZONE_FILL_OPACITY = 0.25;
export const ZONE_STROKE_WIDTH = 2;
export const ZONE_LABEL_FONT = 'bold 13px sans-serif';
// 未知/缺 type 区域的回退中性灰（R === G === B，刻意不与任何一类区域配置色相同）
export const ZONE_FALLBACK_COLOR = '#9e9e9e';

// ---- 设备点位（设计 §4.4 L120-124：摄像头/环境传感器两类，为报警提供锚点；
// 本任务只落数据与报警联动，不做 useDevices/DevicePopup）----
export const DEVICE_TYPE_CONFIG = {
  camera: { label: '摄像头' },
  sensor: { label: '环境传感器' },
};

export const DEVICE_STATUS = {
  online: '在线',
  offline: '离线',
};

// ---- 图层树分组（设计 §4.7 L138：LayerTree 渲染为分组列表）----
// ★ 后续任务（车辆/设备/测量/热力图）在对应分组的 layerIds 中登记新图层 id；
//   未在此登记的图层 id 由 LayerTree 兜底归入「其他」分组（不静默隐藏）。
export const LAYER_TREE_GROUPS = [
  { label: '底图', layerIds: [BASEMAP_LAYER_ID] },
  { label: '厂区', layerIds: [ZONES_LAYER_ID] },
  { label: '报警', layerIds: [ALARMS_LAYER_ID] },
  { label: '车辆', layerIds: [VEHICLES_LAYER_ID] },
];
