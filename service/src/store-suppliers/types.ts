import type { StoreSupplierReviewStatus } from "@uvp-eth/product-dto";
import type { SupplierNotificationProfile } from "../notifications/profile.js";
import type { Address, Hex } from "../shared/types.js";

export interface StoreOperatorPrincipal {
  readonly operatorId: string;
  readonly role: string;
}

export interface StoreSupplierMetadataRecord {
  readonly supplierId: string;
  readonly supplierSubjectId: Hex;
  readonly displayName: string;
  readonly wallet?: Address;
  readonly notificationProfile?: SupplierNotificationProfile;
  readonly notificationProfileHash?: Hex;
  readonly notificationUpdatedAt?: string;
  readonly capabilityTags: readonly string[];
  readonly supportedRoleSlotIds: readonly string[];
  readonly supportedStageIds: readonly string[];
  readonly registryAddresses: readonly Address[];
  readonly reviewStatus: StoreSupplierReviewStatus;
  readonly metadataURI?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type StoreSupplierAuditAction =
  | "create"
  | "review"
  | "tags_updated"
  | "notification_profile_updated"
  | "request_attestation"
  | "request_revocation";

export interface StoreSupplierAuditRecord {
  readonly auditId: string;
  readonly supplierId: string;
  readonly supplierSubjectId: Hex;
  readonly action: StoreSupplierAuditAction;
  readonly actor: string;
  readonly beforeTags?: readonly string[];
  readonly afterTags?: readonly string[];
  readonly beforeSupportedRoleSlotIds?: readonly string[];
  readonly afterSupportedRoleSlotIds?: readonly string[];
  readonly beforeSupportedStageIds?: readonly string[];
  readonly afterSupportedStageIds?: readonly string[];
  readonly reviewStatus?: StoreSupplierReviewStatus;
  readonly createdAt: string;
}

export interface StoreSupplierMetadataStore {
  getSupplier(supplierId: string): Promise<StoreSupplierMetadataRecord | undefined>;
  findSupplierBySubjectId(supplierSubjectId: Hex): Promise<StoreSupplierMetadataRecord | undefined>;
  listSuppliers(): Promise<readonly StoreSupplierMetadataRecord[]>;
  putSupplier(record: StoreSupplierMetadataRecord): Promise<void>;
  appendAudit(record: StoreSupplierAuditRecord): Promise<void>;
  listAudits(supplierId?: string): Promise<readonly StoreSupplierAuditRecord[]>;
}
