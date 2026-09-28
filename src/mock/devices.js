// src/mock/devices.js — 设备点位种子（设计 §4.4 L120-124：摄像头/环境传感器，
// 为报警提供锚点「随机在设备点位附近生成」；本任务只落数据，不做 useDevices/DevicePopup）。
//
// ⚠ 纯数据模块：零 ol/vue import，保证 node 可导入（mock/devices.verify.js 在纯 node 下断言）。
// 坐标约定：业务坐标一律 EPSG:4326 [lng, lat]（设计 §2 L27），渲染前经 map/utils.js 转 3857。
// 布设说明：12 台（摄像头 6 + 环境传感器 6）分散在 mock/zones.js 四类区域内部及其包围盒内
// （生产区/仓储区/办公区/危险品区各布点，危险品区与出入口摄像头为主），全部距
// MAP_DEFAULT_VIEW.center 各轴 ≤0.02°，保证设备与厂区同域、报警抖动不漂出厂区。
export const DEVICES_SEED = [
  // ---- 摄像头（camera）×6 ----
  { id: 'dev-cam-01', name: '生产区西侧摄像头', type: 'camera', status: 'online', lng: 121.4705, lat: 31.2295 },
  { id: 'dev-cam-02', name: '生产区东侧摄像头', type: 'camera', status: 'online', lng: 121.4718, lat: 31.2308 },
  { id: 'dev-cam-03', name: '仓储区北门摄像头', type: 'camera', status: 'online', lng: 121.476, lat: 31.2312 },
  { id: 'dev-cam-04', name: '仓储区南门摄像头', type: 'camera', status: 'online', lng: 121.4765, lat: 31.229 },
  { id: 'dev-cam-05', name: '办公区入口摄像头', type: 'camera', status: 'online', lng: 121.4735, lat: 31.2328 },
  { id: 'dev-cam-06', name: '危险品区摄像头', type: 'camera', status: 'online', lng: 121.4737, lat: 31.2267 },
  // ---- 环境传感器（sensor）×6 ----
  { id: 'dev-sensor-01', name: '生产区温度传感器', type: 'sensor', status: 'online', lng: 121.4703, lat: 31.23 },
  { id: 'dev-sensor-02', name: '生产区湿度传感器', type: 'sensor', status: 'online', lng: 121.4715, lat: 31.229 },
  { id: 'dev-sensor-03', name: '仓储区温度传感器', type: 'sensor', status: 'online', lng: 121.4755, lat: 31.23 },
  { id: 'dev-sensor-04', name: '仓储区气体传感器', type: 'sensor', status: 'offline', lng: 121.477, lat: 31.2288 },
  { id: 'dev-sensor-05', name: '办公区空气质量传感器', type: 'sensor', status: 'online', lng: 121.4742, lat: 31.2333 },
  { id: 'dev-sensor-06', name: '危险品区气体传感器', type: 'sensor', status: 'online', lng: 121.4733, lat: 31.2265 },
];
