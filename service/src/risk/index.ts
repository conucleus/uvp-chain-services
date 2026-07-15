export const RISK_GRAPH_SUPPORTED_SUBJECTS = ["zhixu", "order", "entity"] as const;
export const RISK_GRAPH_SUPPORTED_INPUTS = ["signal_metadata", "evidence_metadata"] as const;

export type RiskGraphSubjectType = typeof RISK_GRAPH_SUPPORTED_SUBJECTS[number];
export type RiskGraphInputKind = typeof RISK_GRAPH_SUPPORTED_INPUTS[number];
export type RiskGraphProviderMode = "noop" | "external";
export type RiskGraphRiskLevel = "not_configured" | "low" | "medium" | "high" | "critical";
export type RiskGraphDecision = "not_configured" | "observe" | "review" | "block";

export interface RiskAuthorityGrant {
  readonly grantId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly scope: readonly string[];
  readonly jurisdiction?: string;
  readonly expiresAt?: string;
  readonly proofRef?: string;
}

export interface RiskGraphCapabilities {
  readonly providerName: string;
  readonly providerMode: RiskGraphProviderMode;
  readonly configured: boolean;
  readonly supportedSubjects: readonly RiskGraphSubjectType[];
  readonly supportedInputs: readonly RiskGraphInputKind[];
  readonly readsBusinessPlaintext: boolean;
}

export interface RiskGraphAssessmentInput {
  readonly subjectType: RiskGraphSubjectType;
  readonly zhixuId?: string;
  readonly orderId?: string;
  readonly entityId?: string;
  readonly riskSemantics?: unknown;
  readonly authorityGrants?: readonly RiskAuthorityGrant[];
  readonly metadataOnly: true;
}

export interface RiskReason {
  readonly code: string;
  readonly message: string;
  readonly severity: RiskGraphRiskLevel;
}

export interface RiskEvidencePath {
  readonly pathId: string;
  readonly label: string;
  readonly nodes: readonly string[];
  readonly edges: readonly string[];
}

export interface RiskGraphAssessmentResult {
  readonly riskLevel: RiskGraphRiskLevel;
  readonly score: number | null;
  readonly decision: RiskGraphDecision;
  readonly reason: string;
  readonly reasons: readonly RiskReason[];
  readonly configured: boolean;
  readonly providerMode: RiskGraphProviderMode;
  readonly modelVersion: string;
  readonly evidencePaths: readonly RiskEvidencePath[];
  readonly subjectType: RiskGraphSubjectType;
}

export interface RiskGraphService {
  getCapabilities(): Promise<RiskGraphCapabilities>;
  assess(input: RiskGraphAssessmentInput): Promise<RiskGraphAssessmentResult>;
}

export function createNoopRiskGraphService(): RiskGraphService {
  return {
    async getCapabilities() {
      return noopRiskGraphCapabilities();
    },
    async assess(input) {
      return {
        riskLevel: "not_configured",
        score: null,
        decision: "not_configured",
        reason: "risk graph provider is not configured",
        reasons: [{
          code: "risk_graph_provider_not_configured",
          message: "risk graph provider is not configured",
          severity: "not_configured"
        }],
        configured: false,
        providerMode: "noop",
        modelVersion: "noop",
        evidencePaths: [],
        subjectType: input.subjectType
      };
    }
  };
}

export function noopRiskGraphCapabilities(): RiskGraphCapabilities {
  return {
    providerName: "noop-risk-graph",
    providerMode: "noop",
    configured: false,
    supportedSubjects: RISK_GRAPH_SUPPORTED_SUBJECTS,
    supportedInputs: RISK_GRAPH_SUPPORTED_INPUTS,
    readsBusinessPlaintext: false
  };
}
