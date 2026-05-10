export const COMPLIANCE_DATA_LAYERS = [
  "zhixu_definition",
  "nucleus_profile",
  "supplier_profile",
  "order_summary",
  "signal_imprint",
  "signal_payload",
  "evidence_handle",
  "evidence_object",
  "payment_leg",
  "escrow_state"
] as const;

export type DataLayer = typeof COMPLIANCE_DATA_LAYERS[number];

export type ComplianceDecision = "allow" | "deny" | "not_configured";
export type ComplianceProviderMode = "noop" | "external";
export type ComplianceSourceOfAuthority = "none" | "provider" | "authority_grant";

export interface AuthorityGrant {
  readonly grantId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly scope: readonly string[];
  readonly jurisdiction: string;
  readonly expiresAt?: string;
  readonly proofRef?: string;
}

export interface ComplianceProviderCapabilities {
  readonly providerName: string;
  readonly providerMode: ComplianceProviderMode;
  readonly configured: boolean;
  readonly sourceOfAuthority: ComplianceSourceOfAuthority;
  readonly supportedDataLayers: readonly DataLayer[];
  readonly defaultAllow: readonly DataLayer[];
  readonly defaultNotConfigured: readonly DataLayer[];
  readonly defaultDeny: readonly DataLayer[];
  readonly authorityGrantInput: "accepted" | "ignored" | "not_supported";
  readonly privacy: {
    readonly selectiveDisclosure: boolean;
    readonly privacyCompute: "not_supported" | "reserved";
  };
}

export interface ComplianceAccessPreviewInput {
  readonly subject?: string;
  readonly role?: string;
  readonly jurisdiction?: string;
  readonly zhixuId?: string;
  readonly orderId?: string;
  readonly stageId?: string;
  readonly signalName?: string;
  readonly dataLayer: DataLayer;
  readonly resource?: ComplianceResourceRef;
  readonly authorityGrants?: readonly AuthorityGrant[];
}

export interface ComplianceResourceRef {
  readonly type: string;
  readonly id?: string;
  readonly parentId?: string;
}

export interface ComplianceAccessPreviewResult {
  readonly decision: ComplianceDecision;
  readonly reason: string;
  readonly requiredGrants: readonly string[];
  readonly providerMode: ComplianceProviderMode;
  readonly sourceOfAuthority: ComplianceSourceOfAuthority;
  readonly dataLayer: DataLayer;
}

export interface ComplianceService {
  getCapabilities(): Promise<ComplianceProviderCapabilities>;
  previewAccess(input: ComplianceAccessPreviewInput): Promise<ComplianceAccessPreviewResult>;
}

const NOOP_ALLOW: readonly DataLayer[] = ["zhixu_definition"];
const NOOP_NOT_CONFIGURED: readonly DataLayer[] = [
  "nucleus_profile",
  "supplier_profile",
  "order_summary",
  "signal_imprint",
  "evidence_handle"
];
const NOOP_DENY: readonly DataLayer[] = [
  "signal_payload",
  "evidence_object",
  "payment_leg",
  "escrow_state"
];

export function createNoopComplianceService(): ComplianceService {
  return {
    async getCapabilities() {
      return noopCapabilities();
    },
    async previewAccess(input) {
      if (NOOP_ALLOW.includes(input.dataLayer)) {
        return {
          decision: "allow",
          reason: "Zhixu definitions are public by default in the no-op Store compliance policy.",
          requiredGrants: [],
          providerMode: "noop",
          sourceOfAuthority: "none",
          dataLayer: input.dataLayer
        };
      }
      if (NOOP_NOT_CONFIGURED.includes(input.dataLayer)) {
        return {
          decision: "not_configured",
          reason: "No compliance provider is configured for this Store data layer.",
          requiredGrants: ["compliance_provider"],
          providerMode: "noop",
          sourceOfAuthority: "none",
          dataLayer: input.dataLayer
        };
      }
      return {
        decision: "deny",
        reason: "The no-op Store compliance policy denies sensitive data layers by default.",
        requiredGrants: ["authority_grant"],
        providerMode: "noop",
        sourceOfAuthority: "none",
        dataLayer: input.dataLayer
      };
    }
  };
}

function noopCapabilities(): ComplianceProviderCapabilities {
  return {
    providerName: "noop-store-compliance",
    providerMode: "noop",
    configured: false,
    sourceOfAuthority: "none",
    supportedDataLayers: COMPLIANCE_DATA_LAYERS,
    defaultAllow: NOOP_ALLOW,
    defaultNotConfigured: NOOP_NOT_CONFIGURED,
    defaultDeny: NOOP_DENY,
    authorityGrantInput: "accepted",
    privacy: {
      selectiveDisclosure: false,
      privacyCompute: "not_supported"
    }
  };
}
