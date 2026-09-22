# OpenLayers 智慧厂区监控原型 — 设计文档

- 日期：2026-09-22
- 状态：已与用户逐节确认
- 项目路径：`D:\project\openlayer-project`（全新空目录）

## 1. 项目定位

智慧厂区 GIS 监控台的**实际项目原型**：模拟数据先行跑通全部功能，预留后端（HTTP / WebSocket）接入层，将来接入真实系统时只替换 `api/` 层实现，组件与 composable 零改动。

**非目标**：登录/权限、真实视频流解码、多租户、移动端适配、大屏炫酷 UI。

## 2. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 框架 | Vue 3（`<script setup>`）+ Vite 5 | 与用户已有 my-ol 项目习惯一致 |
| 语言 | 纯 JavaScript | 原型速度优先，用户熟悉 |
| 地图库 | ol 10.x | 项目本体 |
| 底图 | OpenStreetMap（XYZ，EPSG:3857） | 用户指定；需外网，失败有提示降级 |
| 状态管理 | 不引 Pinia | 单页原型，composable 内聚足够 |
| UI 库 | 不引 | 手写少量样式，保持精简 |
| 路由 | 不引 | 单页面 |

**坐标系约定**：地图视图 EPSG:3857（OL 默认）；业务数据与 GeoJSON 统一存 EPSG:4326，转换收敛在 `map/utils.js`（`fromLonLat` / `toLonLat`）。

## 3. 总体架构（方案 A：监控台单页 + composable 分层）

### 3.1 布局

```
┌──────────────── ToolBar（绘制/编辑/测量/导出）────────────────┐
│ LayerTree │                                          │ AlarmPanel │
│ （左侧，   │            MapCanvas（地图铺满）          │ （右侧上，  │
│  图层显隐  │      Overlay 弹窗：AlarmPopup /          │  报警列表） │
│  +热力图） │              DevicePopup                 │ VehiclePanel│
│           │                                          │ （右侧下）  │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 目录结构

```
src/
├── main.js
├── App.vue                  # 布局骨架 + mode 交互互斥状态
├── styles/                  # 全局样式
├── constants.js             # 报警等级色、区域类型色、枚举
├── map/
│   ├── mapCore.js           # Map/View/OSM 底图初始化，全站唯一实例
│   ├── layerManager.js      # 图层注册表 {id, name, layer, visible}
│   └── utils.js             # 坐标转换、样式工厂、canvas 徽标图标生成
├── composables/
│   ├── useMap.js            # 地图单例 + flyTo 等视图操作
│   ├── useZones.js          # 厂区渲染/绘制/编辑/导出/持久化
│   ├── useAlarms.js         # 聚合徽标/详情弹窗/列表联动
│   ├── useVehicles.js       # 回放/实时/染色统计/多车
│   ├── useDevices.js        # 设备点位 + 信息面板
│   ├── useGeofence.js       # 进出禁区判断 → 生成报警
│   └── useMeasure.js        # 距离/面积测量
├── components/
│   ├── MapCanvas.vue        # 地图容器 + Overlay 挂载点
│   ├── ToolBar.vue          # 工具栏
│   ├── LayerTree.vue        # 图层树
│   ├── AlarmPanel.vue       # 报警列表（联动）
│   ├── VehiclePanel.vue     # 车辆选择/播放器/统计
│   ├── AlarmPopup.vue       # 报警详情（Overlay）
│   └── DevicePopup.vue      # 设备信息（Overlay）
├── api/                     # ★ 适配层，组件与 composable 只调这里
│   ├── index.js             # 统一导出；mock/real 切换开关（环境变量）
│   ├── zonesApi.js          # getZones() / saveZones(geojson)
│   ├── alarmsApi.js         # getAlarms() / ackAlarm(id) / addAlarm() / subscribeAlarms(cb)
│   ├── vehiclesApi.js       # getVehicles() / getTrack(id, range) / subscribePositions(cb)
│   └── devicesApi.js        # getDevices()
└── mock/
    ├── zones.js             # 厂区 GeoJSON 初始数据
    ├── alarms.js            # 报警数据 + 定时生成器
    ├── vehicles.js          # 车辆清单 + 轨迹插值生成器（纯函数）
    └── devices.js           # 设备点位
```

### 3.3 数据流（单向）

UI 组件 → `api/` 适配层 → mock（将来换真实 HTTP/WebSocket）→ composable 落到 ol Feature/Layer → 地图渲染。

实时数据统一走 `subscribeXxx(callback)` 接口：mock 内部用 `setInterval` 模拟推送；将来替换为 WebSocket，调用方代码不变。

### 3.4 交互互斥

App 维护全局 `mode`：`pan` | `drawZone` | `editZone` | `measureLine` | `measureArea`。切换工具自动停用上一个交互；Draw/Measure 激活时禁用 `DoubleClickZoom`。

## 4. 功能模块设计

### 4.1 厂区绘制（useZones）

- **渲染**：`zonesApi.getZones()` 返回 GeoJSON → VectorLayer。按区域类型着色（生产区蓝、仓储区绿、办公区灰、危险品区红），半透明填充 + 描边，区域名称以 Text style 标注在多边形内部（可用 interior point）。
- **绘制**：ToolBar「绘制厂区」→ `Draw(Polygon)`，双击完成；弹小表单填名称/类型后入库（进入 source + `saveZones`）。
- **编辑**：「编辑厂区」→ `Modify` + `Translate`（拖顶点、挪整体）；编辑结束（模式退出）时自动保存。
- **导出**：「导出 GeoJSON」按钮，`format.writeFeatures` 后触发浏览器下载。
- **持久化**：mock 实现落 `localStorage`（key 如 `factory-zones`），刷新保留；初始无数据时用 `mock/zones.js` 种子。

### 4.2 报警（useAlarms）

- **数据结构**：`{ id, deviceId, deviceName, lng, lat, type, level: 'critical'|'major'|'minor', time, status: 'pending'|'acked' }`。一条记录 = 一次报警事件；等级配色在 constants（紧急红/重要橙/一般黄）。**条数口径**：单点徽标 = 该位置 `pending` 记录数；聚合点徽标 = 聚合内所有点 `pending` 记录数之和。
- **聚合**：`ol/source/Cluster`（distance 60px）。聚合点样式：等级色圆 + **聚合内总报警条数**徽标；非聚合单点：设备图标 + 该位置未处理条数小徽标。徽标图标由 `map/utils.js` 用 canvas 动态生成（数字长度自适应）。
- **详情弹窗**：点击非聚合点 → AlarmPopup（Overlay 贴图）：该位置报警明细列表（时间/类型/等级/条数），每条可「标记处理」→ `alarmsApi.ackAlarm(id)` → 徽标与右侧列表同步更新。
- **列表-地图联动**：AlarmPanel 行点击 → `flyTo` 定位 + 点位高亮（放大脉冲样式）；地图点位点击 → 列表滚动到对应行并高亮。
- **实时**：`subscribeAlarms` 定时新增报警（mock 随机生成于设备点位附近），列表置顶插入。

### 4.3 车辆轨迹（useVehicles）

- **mock 数据**：3 辆车，各一条沿厂区道路的路线；轨迹生成器为纯函数：给定路线控制点 + 速度曲线，按时间插值出带时间戳的轨迹点序列。其中 1 辆的路线故意穿越危险品区（服务 4.5 围栏演示）。
- **多车切换**：VehiclePanel 车辆列表（不同颜色车图标），单选当前车；其他车以淡显方式保留在图上（可图层树关掉）。
- **历史回放**：选车 + 时间段（mock 提供 08:00–18:00 数据）→ 轨迹线渲染；已走过段实线、未走段淡虚线（两个动态分段 Feature 实现）；播放器：播放/暂停、进度条拖动、1×/2×/4×/8×/16× 倍速；车头图标按行进方向旋转（`rotation` 属性 + 累计角度）。
- **染色统计**：**已走过段**按速度分段着色（快红慢绿，分段阈值入 constants），未走段保持淡虚线；面板统计：总里程 / 总时长 / 平均速度 / 最高速度（`ol/sphere.getLength` 累计 + 时间差）。
- **实时模式**：`subscribePositions` 每 2s 推送当前车位置（mock 沿路线推进），车辆平滑移动，尾迹保留最近 30 个点（透明度渐隐）。

### 4.4 设备点位（useDevices）

- 摄像头 / 环境传感器两类图标（canvas 生成或 SVG data URL）。
- 点击 → DevicePopup：设备名称/类型/状态 + 视频占位区（灰底「视频流占位」）+ 关联未处理报警数（与报警数据 join）。

### 4.5 电子围栏（useGeofence）

- zones 中 `properties.fence: true` 的区域（危险品区）为禁区。
- 实时模式下每次车辆位置更新：对每辆车 × 每个禁区做 `Polygon.containsXY`（EPSG:3857 投影坐标）判断；状态机记录「车在区内/区外」，**进入瞬间**触发一次报警（不重复），离开时恢复正常。围栏报警走 `alarmsApi.addAlarm()`，与报警列表/徽标/联动全套自动打通。
- 纯逻辑（进出状态机）抽为纯函数，便于 `npm run verify` 断言。

### 4.6 测量（useMeasure）

- 距离（LineString）/ 面积（Polygon）两种；绘制过程中 Overlay tip 实时显示当前量算值；双击结束出最终值；「清除测量」移除全部测量图形与标注。
- 量算用 `ol/sphere` 的 `getLength` / `getArea`（测地线）。

### 4.7 图层树 + 热力图（layerManager + LayerTree）

- 所有图层经 `layerManager.register({ id, name, layer, visible })` 注册；LayerTree 渲染为分组列表（厂区 / 报警 / 车辆 / 设备 / 测量 / 热力图），勾选切换 `layer.setVisible`。
- 热力图：`HeatmapLayer`，数据源为当前报警点，`weight` 取报警等级（紧急 1 / 重要 0.6 / 一般 0.3），默认关闭。

## 5. 错误处理

- **api 层**：所有方法返回 Promise；组件侧统一 catch → 顶部消息条提示。mock 永不 reject；将来 HTTP 实现内部处理超时/非 2xx，转 reject。
- **底图**：监听 `tileloaderror` 计数，连续失败 ≥ 5 次时顶部提示「底图加载不畅，请检查外网连接」；矢量功能不受影响（数据独立于底图）。
- **数据防御**：报警/设备坐标非法（NaN/越界）静默过滤；轨迹点 < 2 时禁用回放按钮并提示；`saveZones` 写 localStorage 失败（隐私模式等）捕获后提示「保存失败，刷新后编辑将丢失」，不阻断当前会话。

## 6. 验证方式

- **纯逻辑自测**：mock 生成器与围栏状态机中的纯函数（轨迹插值、速度染色分段、进出判断、徽标数字格式化）抽为纯函数，`npm run verify`（node 原生断言脚本，无测试框架）覆盖。
- **手动验收清单**（实现完成后浏览器逐项过 + 截图）：
  1. `npm run dev` 启动，OSM 底图正常显示。
  2. 厂区四类区域渲染正确、可绘制新区域、可编辑顶点、刷新后保留、可导出 GeoJSON。
  3. 报警：缩小地图聚合点显示总条数；放大出单点徽标；弹窗可标记处理且徽标/列表同步；列表点选定位地图、地图点选高亮列表。
  4. 轨迹：三车切换正常；回放播放/暂停/拖动/倍速可用；车头方向正确；轨迹按速度染色；统计数值合理。
  5. 实时模式：车辆平滑移动；穿越危险品区时自动产生围栏报警且列表/徽标更新。
  6. 设备弹窗信息完整、显示关联报警数。
  7. 测量：距离/面积实时 tip 与最终值正确，可清除。
  8. 图层树：各图层显隐生效；热力图开关生效。
- **成功标准**：上述清单全过；`api/` 目录可被真实后端实现整体替换而组件与 composable 零改动。

## 7. 决策记录

- 选单页监控台而非多路由示例集：电子围栏、列表-地图联动需要跨功能共存。
- 不引 Pinia / Router / UI 库 / turf：单页原型足够，减少依赖面；围栏判断用 OL 自带 `containsXY`。
- 纯 JS 而非 TS：用户习惯（my-ol 同栈），原型速度优先；接入真实后端时再评估迁移。
- mock 推送用 `setInterval` 模拟，接口形态按 WebSocket 设计（`subscribe(cb)` 返回取消函数），保证替换成本最低。
