// 订单域出口：配置注册表、订单草稿/slot/邀请/EIP-712 接受、finalize
// 端口、信号授权、验收校验与 postgres 持久化。行业内容不进入本模块。

export * from "./types.js";
export * from "./canonical.js";
export * from "./config-service.js";
export * from "./ports.js";
export * from "./birth-adapter.js";
export * from "./postgres-store.js";
export * from "./signal-service.js";
export * from "./acceptance-service.js";
export * from "./chain-status.js";
export {
  OrderService,
  createOrderService,
  type OrderServiceOptions,
  type OrderVisibilitySnapshot,
} from "./service.js";
