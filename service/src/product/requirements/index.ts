// V1 订单要求包（句柄集合 + 预设引用 + 相对方合意）服务面：DTO 形状在
// @uvp-eth/product-dto，服务端算 requirementsHash 并落 store。

export * from "./types.js";
export * from "./postgres-store.js";
export {
  parseOrderRequirementsDeclaration,
  requirementsHashOf
} from "./validate.js";
export {
  createOrderRequirementsService,
  type CreateOrderRequirementsServiceOptions
} from "./service.js";
