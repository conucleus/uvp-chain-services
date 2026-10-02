// 协议常量的服务侧再导出面：值本体单源于 @uvp-eth/protocol-bindings
//（与合约常量/ABI 同源生成），本仓不再自持第二份词表——自持副本会在
// 上游换代时漂移成错签名的 typed-data。REPLACEMENT 模式已随 UB-36④/UB-39
// 退役（patch 词表封闭为 assign/handoff，非协作换人走 forkOrder 车道）。
export {
  EXECUTOR_PATCH_MODE_ASSIGN,
  EXECUTOR_PATCH_MODE_HANDOFF,
  STAGE_EXECUTOR_PATCH_DOMAIN_VERSION,
} from "@uvp-eth/protocol-bindings";

export const STAGE_EXECUTOR_PATCH_SIGNAL_ID = "0xbbb1770c9313f4029a89e03f4719037cdad52864ab4da5f623bc7c8a0c489e97" as const;
export const STAGE_RESOURCE_PATCH_SIGNAL_ID = "0x6dff331f2bb7b785cbcd99a911e6d30dc8714f43b3b9ba80c658215445ddd0ba" as const;
