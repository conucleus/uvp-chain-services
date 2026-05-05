import { stringToHex } from "viem";
import type { Hex } from "./types.js";

export const STAGE_EXECUTOR_PATCH_SIGNAL_ID = "0xbbb1770c9313f4029a89e03f4719037cdad52864ab4da5f623bc7c8a0c489e97" as const;
export const STAGE_RESOURCE_PATCH_SIGNAL_ID = "0x6dff331f2bb7b785cbcd99a911e6d30dc8714f43b3b9ba80c658215445ddd0ba" as const;
export const DOCKED_ORDER_LINK_SIGNAL_ID = "0x52b1d5b596f048e1b5e95de9dbd94755a086b00efb351fbd7810a9afc9ce1e83" as const;

export const EXECUTOR_PATCH_MODE_ASSIGN = stringToHex("assign", { size: 32 }) as Hex;
export const EXECUTOR_PATCH_MODE_HANDOFF = stringToHex("handoff", { size: 32 }) as Hex;
export const EXECUTOR_PATCH_MODE_REPLACEMENT = stringToHex("replacement", { size: 32 }) as Hex;
