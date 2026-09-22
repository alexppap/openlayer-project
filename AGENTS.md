# AGENTS.md — OpenLayers 智慧厂区监控原型

AI 助手在本项目工作的规范。设计文档：`docs/superpowers/specs/2026-09-22-openlayers-factory-prototype-design.md`。

<!-- TRELLIS:START -->
# Trellis 使用说明

以下说明供在本项目中工作的 AI 助手使用：

开始新会话时使用 `/trellis:start` 命令：
- 初始化你的开发者身份
- 了解当前项目上下文
- 阅读相关指南

通过 `@/.trellis/` 目录了解：
- 开发工作流（`workflow.md`）
- 项目结构规范（`spec/`）
- 开发者工作区（`workspace/`）

请保留此受管代码块，以便 `trellis update` 可以刷新其中的说明。

<!-- TRELLIS:END -->

# 架构
- Vue 3.5.16 + JavaScript + SCSS
- 状态管理：不引 Pinia，跨组件状态由 composable（`ref`/`reactive` 单例）内聚管理
- UI 组件库：不引，样式全部手写 SCSS；面板/工具栏用自定义组件
- 地图引擎：OpenLayers（ol）10.x，底图 OpenStreetMap
- 包管理：pnpm

# 开发命令
- 启动开发服务器：pnpm dev
- 安装依赖：pnpm install
- 生产构建：pnpm build
- 纯逻辑自测脚本：pnpm verify（node 原生断言，无测试框架）

# 代码风格
- 样式用 SCSS，组件内 `<style scoped lang="scss">`；全局变量/混入放 `src/styles/_variables.scss`
- 模板部分放置在 Vue 文件的顶部（顺序：template → script setup → style）
- Vue 组件必须使用 setup 语法糖
- template 中尽量不要放复杂的逻辑，复杂的逻辑放到 script setup 中，用计算属性或函数承接
- 错误处理使用 try-catch 包裹异步逻辑，catch 中不使用任何 UI 库消息组件（本项目不引 UI 库）；统一走 App 级自定义顶部通知条（`useNotice`）+ `console.error`
- forEach、find、map 等方法的参数不要用单个字母，使用 item、index 等参数名
- 函数使用具名导出，不要使用匿名/默认导出（Vue SFC 除外：`<script setup>` 使用框架默认导出机制）
- 尽量遵循函数式编程原则，少使用 push、splice 等会改变原数组的方法，使用 map、filter 等返回新数组的方法
  - 例外：ol 的 VectorSource / Cluster 等 API 本身为命令式（addFeature/clear 等），按 ol 惯例使用，不受此约束
- `<script setup>` 内部统一使用 `const` + 箭头函数，禁止使用 `function` 声明

# 命名规范
- 组件文件名用 PascalCase（`components/` 下的 `.vue`）
- 组合式函数用 `useXxx` 具名导出（`composables/`）
- Vue 3 推荐使用 `handle` 前缀命名事件处理函数（如 handleSubmit、handleZoneDrawn）
- 常量用 UPPER_SNAKE_CASE（集中在 `constants.js`）
- ol 图层 id 用 kebab-case（如 `'zones-layer'`、`'alarms-layer'`）

# 项目分层约定（重要）
- `api/` 是唯一数据入口：组件与 composable 只能调用 `api/*`，禁止直接 `import` `mock/*`
- 实时数据一律走 `subscribeXxx(callback)` 接口（返回取消函数），组件在 `onUnmounted` 中调用取消
- 地图实例全站唯一：从 `useMap()` 获取，禁止自行 `new Map`
- 新增图层必须经 `map/layerManager.js` 注册，图层树才能统一控制显隐
- 坐标转换统一走 `map/utils.js`；业务数据存 EPSG:4326，地图渲染用 EPSG:3857
- 地图交互互斥：绘制/编辑/测量交互的启停由 App.vue 维护的 `mode` 状态驱动（composable 读取），同一时刻只允许一个激活
- 报警详情、设备信息等贴地图弹窗用 OL Overlay 挂载 Vue 组件（自定义样式），不用任何 UI 库 Dialog
