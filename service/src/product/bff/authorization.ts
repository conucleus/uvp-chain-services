import { keccak256, stringToBytes } from "viem";
import { onchainStageId } from "@uvp-eth/compiler";
import {
  ORDER_INITIAL_TRIGGER_PERMISSION_ID,
  ORDER_REGISTRAR_ROLE_SLOT_ID,
  ORDER_SYSTEM_STAGE_ID,
  type ParticipantAddOnManifestActionDTO,
  type OrderPermissionTableEntryDTO,
  type RoleSlotDTO,
  type ZhixuDetailDTO
} from "@uvp-eth/product-dto";
import { normalizeAddress, normalizeBytes32, type Address, type Hex } from "../../shared/types.js";
import {
  STAGE_EXECUTOR_PATCH_SIGNAL_ID,
  STAGE_RESOURCE_PATCH_SIGNAL_ID
} from "../../stage-patches/service.js";
import type {
  DraftParticipantDTO,
  ParticipantPermissionDTO,
  ProductOrderDraftDTO,
  SignalAuthorizationDTO
} from "./types.js";

export class ProductAuthorizationBuilderError extends Error {
  override readonly name = "ProductAuthorizationBuilderError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export interface ProductAuthorizationBuildInput {
  readonly zhixu: ZhixuDetailDTO;
  readonly draft: ProductOrderDraftDTO;
  readonly participants: readonly DraftParticipantDTO[];
  readonly orderId: Hex;
  readonly registrarAddress: Address;
}

export interface ProductAuthorizationBuildResult {
  readonly authorizations: readonly SignalAuthorizationDTO[];
  readonly permissions: readonly ParticipantPermissionDTO[];
}

export class ProductAuthorizationBuilder {
  build(input: ProductAuthorizationBuildInput): ProductAuthorizationBuildResult {
    const duplicateAuthorizations = new Set<string>();
    const authorizations: SignalAuthorizationDTO[] = [];
    const permissions: ParticipantPermissionDTO[] = [];
    const registrarAddress = normalizeAddress(input.registrarAddress, "registrarAddress");
    const resolvedPermissions = resolvePermissions(input, registrarAddress);

    for (const resolved of resolvedPermissions) {
      const authorization: SignalAuthorizationDTO = {
        sourceId: onchainSourceId(resolved.entry.source),
        signalId: onchainSignalId(resolved.entry.signalName),
        submitter: resolved.submitter,
        role: roleHash(resolved.entry.roleSlotId),
        metadataHash: metadataHash(input, resolved.entry, resolved.submitter)
      };
      addAuthorization(duplicateAuthorizations, authorization, resolved.entry);
      authorizations.push(authorization);
      permissions.push({
        permissionId: resolved.entry.permissionId,
        orderId: input.orderId,
        draftId: input.draft.draftId,
        participantId: resolved.participantId,
        roleSlotId: resolved.entry.roleSlotId,
        stageIdentifier: resolved.entry.stageId,
        source: resolved.entry.source,
        signalName: resolved.entry.signalName,
        submitterAddress: resolved.submitter,
        payloadPolicy: resolved.entry.payloadPolicy,
        requiredEvidence: resolved.entry.requiredEvidence
      });
    }
    for (const authorization of stagePatchAuthorizations(input, duplicateAuthorizations)) {
      authorizations.push(authorization);
    }

    return {
      authorizations,
      permissions: permissions.sort(comparePermission)
    };
  }
}

interface ResolvedPermission {
  readonly entry: OrderPermissionTableEntryDTO;
  readonly submitter: Address;
  readonly participantId: string;
  readonly stageIndex: number;
  readonly system: boolean;
}

function resolvePermissions(
  input: ProductAuthorizationBuildInput,
  registrarAddress: Address
): readonly ResolvedPermission[] {
  const entries = input.zhixu.orderPermissionTable;
  if (entries.length === 0) {
    throw new ProductAuthorizationBuilderError(409, "permission_table_missing", "zhixu orderPermissionTable is required before submit", {
      zhixuId: input.zhixu.zhixuId
    });
  }

  const roleSlots = new Map(input.zhixu.roleSlots.map((slot) => [slot.slotId, slot]));
  const stages = new Map(input.zhixu.stages.map((stage) => [stage.stageId, stage]));
  const participants = new Map(input.participants.map((participant) => [participant.roleSlotId, participant]));
  const permissionIds = new Set<string>();
  const resolved: ResolvedPermission[] = [];
  let hasInitialTrigger = false;

  validateRequiredRoleParticipants(input.zhixu.roleSlots, participants);

  for (const entry of entries) {
    validatePermissionShape(entry);
    if (permissionIds.has(entry.permissionId)) {
      throw new ProductAuthorizationBuilderError(409, "permission_id_duplicate", "orderPermissionTable has duplicate permissionId", {
        permissionId: entry.permissionId
      });
    }
    permissionIds.add(entry.permissionId);

    if (isInitialTriggerPermission(entry)) {
      hasInitialTrigger = true;
      resolved.push({
        entry,
        submitter: registrarAddress,
        participantId: entry.roleSlotId,
        stageIndex: -1,
        system: true
      });
      continue;
    }

    if (isSystemPermission(entry)) {
      throw new ProductAuthorizationBuilderError(409, "system_permission_not_allowed", "unknown system permission row", {
        permissionId: entry.permissionId,
        roleSlotId: entry.roleSlotId,
        stageId: entry.stageId,
        source: entry.source,
        signalName: entry.signalName
      });
    }

    const roleSlot = roleSlots.get(entry.roleSlotId);
    if (!roleSlot) {
      throw new ProductAuthorizationBuilderError(409, "permission_role_not_found", "orderPermissionTable references an unknown roleSlotId", {
        permissionId: entry.permissionId,
        roleSlotId: entry.roleSlotId
      });
    }
    const stage = stages.get(entry.stageId);
    if (!stage) {
      throw new ProductAuthorizationBuilderError(409, "permission_stage_not_found", "orderPermissionTable references an unknown stageId", {
        permissionId: entry.permissionId,
        stageId: entry.stageId
      });
    }
    if (entry.source.length === 0) {
      throw new ProductAuthorizationBuilderError(409, "permission_source_missing", "participant permission source must be explicit", {
        permissionId: entry.permissionId
      });
    }
    const participant = participants.get(entry.roleSlotId);
    if (!participant) {
      throw new ProductAuthorizationBuilderError(409, "permission_participant_missing", "permission role has no draft participant", {
        permissionId: entry.permissionId,
        roleSlotId: entry.roleSlotId
      });
    }
    if (participant.status !== "accepted" || !participant.walletAddress) {
      throw new ProductAuthorizationBuilderError(409, "permission_wallet_missing", "permission role has no accepted participant wallet", {
        permissionId: entry.permissionId,
        roleSlotId: entry.roleSlotId,
        participantId: participant.participantId
      });
    }
    resolved.push({
      entry,
      submitter: normalizeAddress(participant.walletAddress, "participant.walletAddress"),
      participantId: participant.participantId,
      stageIndex: stage.index,
      system: false
    });
  }

  if (!hasInitialTrigger) {
    throw new ProductAuthorizationBuilderError(409, "initial_trigger_permission_missing", "registrar initial trigger permission is required", {
      permissionId: ORDER_INITIAL_TRIGGER_PERMISSION_ID
    });
  }

  return resolved.sort(compareResolvedPermission);
}

function validateRequiredRoleParticipants(
  roleSlots: readonly RoleSlotDTO[],
  participants: ReadonlyMap<string, DraftParticipantDTO>
): void {
  for (const slot of roleSlots) {
    if (!slot.required) {
      continue;
    }
    const participant = participants.get(slot.slotId);
    if (!participant) {
      throw new ProductAuthorizationBuilderError(409, "required_role_missing", "required role has no draft participant", {
        roleSlotId: slot.slotId
      });
    }
    if (participant.status !== "accepted" || !participant.walletAddress) {
      throw new ProductAuthorizationBuilderError(409, "required_participant_missing", "required role has no accepted participant wallet", {
        roleSlotId: slot.slotId,
        participantId: participant.participantId
      });
    }
  }
}

function validatePermissionShape(entry: OrderPermissionTableEntryDTO): void {
  if (entry.permissionId.length === 0 || entry.roleSlotId.length === 0 || entry.stageId.length === 0 || entry.signalName.length === 0) {
    throw new ProductAuthorizationBuilderError(409, "permission_row_invalid", "orderPermissionTable row is missing a required field", {
      permissionId: entry.permissionId,
      roleSlotId: entry.roleSlotId,
      stageId: entry.stageId,
      signalName: entry.signalName
    });
  }
}

function isInitialTriggerPermission(entry: OrderPermissionTableEntryDTO): boolean {
  return entry.permissionId === ORDER_INITIAL_TRIGGER_PERMISSION_ID &&
    entry.roleSlotId === ORDER_REGISTRAR_ROLE_SLOT_ID &&
    entry.stageId === ORDER_SYSTEM_STAGE_ID &&
    entry.signalName.length > 0 &&
    entry.payloadPolicy === "optional" &&
    entry.requiredEvidence.length === 0;
}

function isSystemPermission(entry: OrderPermissionTableEntryDTO): boolean {
  return entry.permissionId.startsWith("system.") ||
    entry.roleSlotId.startsWith("system:") ||
    entry.stageId.startsWith("system:");
}

function addAuthorization(
  authorizations: Set<string>,
  authorization: SignalAuthorizationDTO,
  entry: OrderPermissionTableEntryDTO
): void {
  const key = `${authorization.sourceId}:${authorization.signalId}:${authorization.submitter}`;
  if (authorizations.has(key)) {
    throw new ProductAuthorizationBuilderError(409, "permission_authorization_duplicate", "orderPermissionTable generates duplicate signal authorization", {
      permissionId: entry.permissionId,
      source: entry.source,
      signalName: entry.signalName,
      submitter: authorization.submitter
    });
  }
  authorizations.add(key);
}

function onchainSourceId(source: string): Hex {
  return keccak256(stringToBytes(source));
}

function onchainSignalId(signalName: string): Hex {
  return keccak256(stringToBytes(signalName));
}

function roleHash(roleSlotId: string): Hex {
  return keccak256(stringToBytes(`role:${roleSlotId}`));
}

function stagePatchAuthorizations(
  input: ProductAuthorizationBuildInput,
  duplicateAuthorizations: Set<string>
): readonly SignalAuthorizationDTO[] {
  const participantsByRoleSlot = new Map(input.participants.map((participant) => [participant.roleSlotId, participant]));
  const stages = new Set(input.zhixu.stages.map((stage) => stage.stageId));
  const authorizations: SignalAuthorizationDTO[] = [];

  for (const slot of input.zhixu.roleSlots) {
    const manifest = slot.addOnManifest;
    if (!manifest || manifest.roleSlotId !== slot.slotId) {
      continue;
    }
    const participant = participantsByRoleSlot.get(slot.slotId);
    if (participant?.status !== "accepted" || !participant.walletAddress) {
      continue;
    }
    const submitter = normalizeAddress(participant.walletAddress, "participant.walletAddress");
    const sourceStages = sourceStagesForPatchActions(input.zhixu, slot, stages);
    if (sourceStages.length === 0) {
      continue;
    }
    for (const action of manifest.actions) {
      const signalId = signalIdForStagePatchAction(action);
      if (!signalId) {
        continue;
      }
      for (const stageId of sourceStages) {
        const entry = internalStagePatchPermissionEntry(slot.slotId, stageId, action);
        const authorization: SignalAuthorizationDTO = {
          sourceId: onchainStageSourceId(stageId),
          signalId,
          submitter,
          role: roleHash(slot.slotId),
          metadataHash: stagePatchMetadataHash(input, slot.slotId, stageId, action, submitter)
        };
        addAuthorization(duplicateAuthorizations, authorization, entry);
        authorizations.push(authorization);
      }
    }
  }

  return authorizations.sort(compareSignalAuthorization);
}

function sourceStagesForPatchActions(
  zhixu: ZhixuDetailDTO,
  slot: RoleSlotDTO,
  stages: ReadonlySet<string>
): readonly string[] {
  const stageIds = new Set<string>();
  for (const plugin of slot.capabilityPlugins ?? []) {
    for (const stageId of plugin.stageIds) {
      if (stages.has(stageId)) {
        stageIds.add(stageId);
      }
    }
  }
  for (const stage of zhixu.stages) {
    if (stage.staticExecutorRoleSlotId === slot.slotId) {
      stageIds.add(stage.stageId);
    }
  }
  return [...stageIds].sort();
}

function signalIdForStagePatchAction(action: ParticipantAddOnManifestActionDTO): Hex | undefined {
  switch (action.actionKind) {
    case "stage_executor_patch":
      return STAGE_EXECUTOR_PATCH_SIGNAL_ID;
    case "stage_resource_patch":
      return STAGE_RESOURCE_PATCH_SIGNAL_ID;
    default:
      return undefined;
  }
}

function internalStagePatchPermissionEntry(
  roleSlotId: string,
  stageId: string,
  action: ParticipantAddOnManifestActionDTO
): OrderPermissionTableEntryDTO {
  return {
    permissionId: `internal.stage-patch.${action.actionId}`,
    roleSlotId,
    stageId,
    source: stageId,
    signalName: action.actionKind,
    payloadPolicy: "optional",
    requiredEvidence: []
  };
}

function onchainStageSourceId(stageId: string): Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(stageId)
    ? normalizeBytes32(stageId, "stageId")
    : normalizeBytes32(onchainStageId(stageId), "stageId");
}

function stagePatchMetadataHash(
  input: ProductAuthorizationBuildInput,
  roleSlotId: string,
  stageId: string,
  action: ParticipantAddOnManifestActionDTO,
  submitter: Address
): Hex {
  return keccak256(stringToBytes([
    "uvp:product-bff:stage-patch-authorization:v1",
    input.draft.planId,
    action.actionId,
    action.actionKind,
    roleSlotId,
    stageId,
    submitter
  ].join(":")));
}

function compareSignalAuthorization(left: SignalAuthorizationDTO, right: SignalAuthorizationDTO): number {
  return [
    left.sourceId.localeCompare(right.sourceId),
    left.signalId.localeCompare(right.signalId),
    left.submitter.localeCompare(right.submitter),
    left.role.localeCompare(right.role),
    left.metadataHash.localeCompare(right.metadataHash)
  ].find((result) => result !== 0) ?? 0;
}

function metadataHash(
  input: ProductAuthorizationBuildInput,
  entry: OrderPermissionTableEntryDTO,
  submitter: Address
): Hex {
  return keccak256(stringToBytes([
    "uvp:product-bff:authorization:v3",
    input.draft.planId,
    entry.permissionId,
    entry.roleSlotId,
    entry.stageId,
    entry.source,
    entry.signalName,
    submitter
  ].join(":")));
}

function compareResolvedPermission(left: ResolvedPermission, right: ResolvedPermission): number {
  return [
    Number(right.system) - Number(left.system),
    left.stageIndex - right.stageIndex,
    left.entry.stageId.localeCompare(right.entry.stageId),
    left.entry.permissionId.localeCompare(right.entry.permissionId),
    left.entry.source.localeCompare(right.entry.source),
    left.entry.signalName.localeCompare(right.entry.signalName),
    left.entry.roleSlotId.localeCompare(right.entry.roleSlotId),
    left.submitter.localeCompare(right.submitter)
  ].find((result) => result !== 0) ?? 0;
}

function comparePermission(left: ParticipantPermissionDTO, right: ParticipantPermissionDTO): number {
  return [
    systemSort(left) - systemSort(right),
    left.stageIdentifier.localeCompare(right.stageIdentifier),
    left.permissionId.localeCompare(right.permissionId),
    left.source.localeCompare(right.source),
    left.signalName.localeCompare(right.signalName),
    left.roleSlotId.localeCompare(right.roleSlotId),
    left.submitterAddress.localeCompare(right.submitterAddress)
  ].find((result) => result !== 0) ?? 0;
}

function systemSort(permission: ParticipantPermissionDTO): number {
  return permission.roleSlotId.startsWith("system:") ? 0 : 1;
}
