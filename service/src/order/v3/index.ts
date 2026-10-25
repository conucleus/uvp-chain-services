// V3 订单域出口：配置注册表、订单草稿/slot/邀请/EIP-712 接受、finalize
// 端口与 sqlite/postgres 持久化。行业内容不进入本模块。

export * from "./types.js";
export * from "./canonical.js";
export * from "./config-service.js";
export * from "./ports.js";
export * from "./birth-adapter.js";
export * from "./store.js";
export * from "./sqlite-store.js";
export * from "./postgres-store.js";
export {
  OrderV3Service,
  createOrderV3Service,
  type OrderV3ServiceOptions,
  type OrderV3VisibilitySnapshot,
} from "./service.js";
