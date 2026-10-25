import {
  type ChainProofRowDTO,
  type FulfillmentRequiredInputDTO,
  type ParticipantDTO,
  type ParticipantAddOnKind,
  type ParticipantAddOnManifestDTO,
  type ProductCatalogDTO,
  type ProductExecutorPatchRequirementDTO,
  type ProductResourceAccessPolicyDTO,
  type ProductResourceRequirementDTO,
  type ProductOrderDTO,
  type ProductSelectableTargetDTO,
  type ProductTaskDTO,
  type ZhixuDetailDTO,
  type ZhixuStageDTO
} from "@uvp-eth/product-dto";

// Demo-only catalog for explicit fixture and local fallback modes.
/** 派生身份演示值（zx-+32hex，与编译产物 zhixuId 同形态）。 */
export const CROSS_BORDER_ZHIXU_ID = "zx-3fa636e0229362fa4f6db3db37737a17";
export const DEMO_ORDER_ID = "order-cross-border-car-001";
export const DEMO_TASK_ID = "task-customs-complete-001";

export const crossBorderPlanIds = {
  planId: "0x0000000000000000000000000000000000000000000000000000000000000101",
  planHash: "0x0000000000000000000000000000000000000000000000000000000000000201",
  artifactHash: "0x0000000000000000000000000000000000000000000000000000000000000301"
} as const;

const demoCreateOrderTrigger = {
  source: "order",
  signalName: "registered",
  triggerHookId: "0x0000000000000000000000000000000000000000000000000000000000001101",
  triggerStageId: "0x0000000000000000000000000000000000000000000000000000000000001201",
  submitterRoleSlotId: "funds"
} as const;

type DemoFundingSignalActorKind = "buyer" | "guarantor" | "adapter";

interface DemoFundingSignalContainerActor {
  readonly actorKind: DemoFundingSignalActorKind;
  readonly label: string;
  readonly wallet: string;
  readonly authorizationLabel: string;
  readonly supplierSubjectId?: string;
}

interface DemoFundingSignalContainerMetadata {
  readonly fundingMethodLabel: string;
  readonly amountDisplay: string;
  readonly currencyDisplay: string;
  readonly policyHash: string;
  readonly evidenceIds: readonly string[];
  readonly guarantorSupplierSubjectId?: string;
  readonly adapterProofRows: readonly ChainProofRowDTO[];
}

interface DemoFundingSignalContainerFixture {
  readonly scenarioId: string;
  readonly schemaVersion: "uvp.signal-container.v1";
  readonly taskId: string;
  readonly orderId: string;
  readonly planId: string;
  readonly stageId: string;
  readonly capabilityKind: "payment_placeholder";
  readonly actionKind: "submit_signal";
  readonly requiredInputs: readonly FulfillmentRequiredInputDTO[];
  readonly acceptedActor: DemoFundingSignalContainerActor;
  readonly fundingMetadata: DemoFundingSignalContainerMetadata;
  readonly prepare: {
    readonly typedData: {
      readonly stateMachineLabel: string;
      readonly primaryType: "SubmitSignal";
      readonly messageHint: string;
    };
    readonly submitter: string;
    readonly payloadHash: string;
    readonly payloadRef: string;
    readonly idempotencyKey: string;
    readonly deadline: string;
  };
  readonly proof: {
    readonly txHash: string;
    readonly blockNumber: string;
    readonly eventName: "SignalSubmitted";
    readonly rows: readonly ChainProofRowDTO[];
  };
  readonly productCopy: {
    readonly title: string;
    readonly summary: string;
    readonly disclaimer: string;
  };
}

export const demoStages: readonly ZhixuStageDTO[] = [
  { stageId: "order-confirmed", index: 1, name: "订单确认", evidence: ["合同"], ownerRole: "买家", status: "done", updatedAt: "2026-04-18 10:15" },
  { stageId: "funds-protected", index: 2, name: "资金保障", evidence: ["付款凭证"], ownerRole: "资金方", status: "done", updatedAt: "2026-04-18 10:27" },
  { stageId: "stock-ready", index: 3, name: "备货", evidence: ["装箱清单", "备货照片"], ownerRole: "供给方", status: "done", updatedAt: "2026-04-20 14:32" },
  { stageId: "export-documents", index: 4, name: "出口单证", evidence: ["商业发票", "原产地证", "出口单证"], ownerRole: "供给方", status: "done", updatedAt: "2026-04-22 16:45" },
  { stageId: "customs-complete", index: 5, name: "报关完成", evidence: ["报关单"], ownerRole: "交付方", status: "active", updatedAt: "2026-04-29 09:12" },
  { stageId: "shipping", index: 6, name: "装船/物流", evidence: ["提单", "装船通知"], ownerRole: "交付方", status: "pending" },
  { stageId: "arrival", index: 7, name: "到港/入仓", evidence: ["到港通知", "入仓单", "仓储凭证"], ownerRole: "交付方", status: "pending" },
  { stageId: "inspection", index: 8, name: "检验验收", evidence: ["检验报告", "验收单", "签收照片"], ownerRole: "验收方", status: "pending" },
  { stageId: "close-or-dispute", index: 9, name: "完成或争议", evidence: ["完成确认书", "争议说明"], ownerRole: "维护方", status: "pending" }
];

const demoStageSignalNames = ["str", "cmp", "pass", "fail", "confirm_stage", "reject_stage"] as const;

const demoPaymentRequiredInputs: readonly FulfillmentRequiredInputDTO[] = [
  {
    inputId: "funding-condition",
    label: "确认付款条件",
    inputType: "payment_placeholder",
    required: true,
    completed: true
  },
  {
    inputId: "funding-evidence",
    label: "资金凭证指纹",
    inputType: "evidence",
    required: true,
    completed: true
  }
];

const demoCustomsRequiredInputs: readonly FulfillmentRequiredInputDTO[] = [
  {
    inputId: "customs-declaration",
    label: "报关单 PDF",
    inputType: "evidence",
    required: true,
    completed: false
  },
  {
    inputId: "customs-declaration-no",
    label: "报关单号",
    inputType: "text",
    required: true,
    completed: false
  },
  {
    inputId: "customs-confirmation",
    label: "确认报关事实",
    inputType: "confirmation",
    required: true,
    completed: false
  }
];

const demoOrderParticipantPolicy: ProductResourceAccessPolicyDTO = {
  visibility: "protected",
  readers: [
    { kind: "role", label: "买家" },
    { kind: "role", label: "交付方" },
    { kind: "role", label: "验收方" }
  ],
  writers: [
    { kind: "role", label: "交付方" }
  ],
  controllers: [
    { kind: "role", label: "买家" }
  ],
  policyHash: "0x0000000000000000000000000000000000000000000000000000000000000901"
};

const demoCustomsResourceRequirements: readonly ProductResourceRequirementDTO[] = [
  {
    resourceId: "customs-declaration-pdf",
    resourceKey: "customs_declaration_pdf",
    label: "报关单 PDF",
    resourceType: "document",
    required: true,
    source: "plan_default",
    visibility: "protected",
    sourceStageId: "customs-complete",
    description: "提交加密内容寻址清单和凭证指纹，业务文件原文不写入链上。",
    manifestURI: "ipfs://bafyuvp-demo-customs-declaration-manifest",
    manifestHash: "0x0000000000000000000000000000000000000000000000000000000000000801",
    ciphertextHash: "0x0000000000000000000000000000000000000000000000000000000000000802",
    storageCID: "bafyuvp-demo-customs-declaration-ciphertext",
    accessPolicy: demoOrderParticipantPolicy,
    accessStatus: {
      state: "request_required",
      label: "需要授权后查看加密文件",
      canRead: false,
      canWrite: true,
      reason: "当前钱包可以提交新清单，读取需匹配资源权限。"
    }
  },
  {
    resourceId: "customs-declaration-number",
    resourceKey: "customs_declaration_number",
    label: "报关单号",
    resourceType: "metadata",
    required: true,
    source: "plan_default",
    visibility: "protected",
    sourceStageId: "customs-complete",
    manifestURI: "ipfs://bafyuvp-demo-customs-number-manifest",
    manifestHash: "0x0000000000000000000000000000000000000000000000000000000000000803",
    accessPolicy: demoOrderParticipantPolicy,
    accessStatus: {
      state: "available",
      label: "当前参与方可查看",
      canRead: true,
      canWrite: true
    }
  },
  {
    resourceId: "customs-completion-time",
    resourceKey: "customs_completion_time",
    label: "完成时间",
    resourceType: "metadata",
    required: true,
    source: "plan_default",
    visibility: "public",
    sourceStageId: "customs-complete",
    manifestURI: "ipfs://bafyuvp-demo-customs-completion-time-manifest",
    manifestHash: "0x0000000000000000000000000000000000000000000000000000000000000804",
    contentHash: "0x0000000000000000000000000000000000000000000000000000000000000805",
    accessPolicy: {
      visibility: "public",
      readers: [{ kind: "participant", label: "订单参与方" }],
      writers: [{ kind: "role", label: "交付方" }],
      controllers: [{ kind: "role", label: "买家" }],
      policyHash: "0x0000000000000000000000000000000000000000000000000000000000000902"
    },
    accessStatus: {
      state: "available",
      label: "公开可核对",
      canRead: true,
      canWrite: true
    }
  }
];

const demoPreviousExecutorWallet = "0x2222222222222222222222222222222222222222";

const demoAssignPatchMode: ProductExecutorPatchRequirementDTO = {
  mode: "assign",
  modeLabel: "选择履约者",
  allowed: true,
  workStarted: false,
  requiresSelectorSignature: true,
  requiresPreviousExecutorSignature: false,
  requiresApprovalSignal: false,
  priorAuthorityLabel: "阶段尚未开始",
  futureAuthorityLabel: "确认后由新履约者处理后续提交",
  guidanceLabel: "选择履约者"
};

const demoHandoffPatchMode: ProductExecutorPatchRequirementDTO = {
  mode: "handoff",
  modeLabel: "交接履约者",
  allowed: true,
  workStarted: true,
  requiresSelectorSignature: true,
  requiresPreviousExecutorSignature: true,
  requiresApprovalSignal: false,
  previousExecutor: demoPreviousExecutorWallet,
  previousExecutorWallet: demoPreviousExecutorWallet,
  previousExecutorLabel: "现任报关履约者",
  priorAuthorityLabel: "已完成部分不变",
  futureAuthorityLabel: "交接确认后，新履约者只接续后续工作",
  guidanceLabel: "需要原履约者签名"
};

const demoSelectableTargets: readonly ProductSelectableTargetDTO[] = [
  {
    selectorStageId: "order-confirmed",
    targetStageId: "shipping",
    targetStageName: "装船/物流",
    allowed: true,
    workStarted: false,
    stageSignalCount: 0,
    currentExecutorLabel: "待选择履约者",
    executorPatchMode: "assign",
    executorPatchModes: [demoAssignPatchMode],
    priorAuthorityLabel: "阶段尚未开始",
    futureAuthorityLabel: "确认后由新履约者处理后续提交"
  },
  {
    selectorStageId: "order-confirmed",
    targetStageId: "customs-complete",
    targetStageName: "出口报关",
    allowed: true,
    workStarted: true,
  }
]

function submitSignalAddOnManifest(input: {
  readonly roleSlotId: string;
  readonly addOnKind: ParticipantAddOnKind;
  readonly title: string;
  readonly summary: string;
  readonly stageBindings: readonly string[];
  readonly actionLabel: string;
  readonly evidenceLabel: string;
}): ParticipantAddOnManifestDTO {
  return {
    schemaVersion: "participant-addon-manifest.v1",
    manifestId: `${input.roleSlotId}:submit-signal:v1`,
    roleSlotId: input.roleSlotId,
    addOnKind: input.addOnKind,
    title: input.title,
    summary: input.summary,
    stageBindings: input.stageBindings,
    pages: [
      {
        pageId: "main",
        title: input.title,
        summary: input.summary,
        sections: [
          {
            sectionId: "inputs",
            title: "提交材料",
            components: [
              {
                componentId: "wallet",
                componentKind: "wallet",
                inputId: `${input.roleSlotId}.wallet`,
                label: "参与方钱包",
                required: true
              },
              {
                componentId: "evidence",
                componentKind: "evidence_refs",
                inputId: `${input.roleSlotId}.evidence`,
                label: input.evidenceLabel,
                required: true,
                placeholder: "输入 evidenceId、CID 或凭证指纹；多个值可换行"
              },
              {
                componentId: "confirmation",
                componentKind: "confirmation",
                inputId: `${input.roleSlotId}.confirmation`,
                label: input.actionLabel,
                required: true
              },
              {
                componentId: "proof",
                componentKind: "proof_rows",
                label: "证明"
              }
            ]
          }
        ]
      }
    ],
    actions: [
      {
        actionId: `${input.roleSlotId}.confirm`,
        actionKind: "submit_signal",
        label: input.actionLabel,
        primary: true,
        // 不硬编码 intent：共享 helper 会同时喂给 confirm 型与 dispute 型
        // 插件槽位，硬编码 confirm_stage 会让 dispute_material 槽位的
        // manifest 声明覆盖插件类型推导，争议任务以确认口径提交。
        inputBindings: {
          walletAddress: `${input.roleSlotId}.wallet`,
          evidenceIds: `${input.roleSlotId}.evidence`,
          confirmation: `${input.roleSlotId}.confirmation`
        }
      }
    ]
  };
}

const selectorAddOnManifest: ParticipantAddOnManifestDTO = {
  schemaVersion: "participant-addon-manifest.v1",
  manifestId: "buyer-selector:v1",
  roleSlotId: "buyer-selector",
  addOnKind: "stage_executor_patch",
  title: "选择履约者",
  summary: "为目标阶段选择、交接或替换后续履约者。",
  stageBindings: ["customs-complete"],
  pages: [
    {
      pageId: "executor-selection",
      title: "履约者选择",
      sections: [
        {
          sectionId: "selection",
          title: "选择设置",
          components: [
            { componentId: "target-stage", componentKind: "stage_select", inputId: "selector.targetStageId", label: "目标阶段", required: true },
            { componentId: "mode", componentKind: "select", inputId: "selector.mode", label: "处理方式", required: true, defaultValue: "assign", options: [
              { value: "assign", label: "选择履约者" },
              { value: "handoff", label: "交接履约者" }
            ] },
            { componentId: "selector-wallet", componentKind: "wallet", inputId: "selector.selectorWallet", label: "选择方钱包", required: true },
            { componentId: "executor-wallet", componentKind: "wallet", inputId: "selector.executorWallet", label: "履约者钱包", required: true },
            { componentId: "executor-metadata-hash", componentKind: "hash", inputId: "selector.executorMetadataHash", label: "履约者元数据指纹", required: true },
            { componentId: "executor-reference", componentKind: "text", inputId: "selector.executorReference", label: "履约者参考" },
            { componentId: "metadata-uri", componentKind: "uri", inputId: "selector.metadataURI", label: "补充说明 URI", required: true },
            { componentId: "proof", componentKind: "proof_rows", label: "证明" }
          ]
        }
      ]
    }
  ],
  actions: [
    {
      actionId: "selector.apply-executor-patch",
      actionKind: "stage_executor_patch",
      label: "选择履约者",
      primary: true,
      inputBindings: {
        selectorWallet: "selector.selectorWallet",
        targetStageId: "selector.targetStageId",
        mode: "selector.mode",
        executorWallet: "selector.executorWallet",
        executorMetadataHash: "selector.executorMetadataHash",
        metadataURI: "selector.metadataURI"
      }
    }
  ]
};

const resourcePatchAddOnManifest: ParticipantAddOnManifestDTO = {
  schemaVersion: "participant-addon-manifest.v1",
  manifestId: "buyer-resource-controller:v1",
  roleSlotId: "buyer-resource-controller",
  addOnKind: "stage_resource_patch",
  title: "补充凭证要求",
  summary: "为目标阶段发布内容寻址资源清单和访问策略。",
  stageBindings: ["customs-complete"],
  pages: [
    {
      pageId: "resource-requirements",
      title: "资源清单",
      sections: [
        {
          sectionId: "resource",
          title: "补充资源",
          components: [
            { componentId: "target-stage", componentKind: "stage_select", inputId: "resourcePatch.targetStageId", label: "目标阶段", required: true },
            { componentId: "selector-wallet", componentKind: "wallet", inputId: "resourcePatch.selectorWallet", label: "资源配置钱包", required: true },
            { componentId: "resource-key", componentKind: "text", inputId: "resourcePatch.resourceKey", label: "资源键", required: true },
            { componentId: "manifest-uri", componentKind: "uri", inputId: "resourcePatch.manifestURI", label: "资源清单 URI", required: true },
            { componentId: "manifest-hash", componentKind: "hash", inputId: "resourcePatch.manifestHash", label: "清单指纹", required: true },
            { componentId: "policy-hash", componentKind: "hash", inputId: "resourcePatch.policyHash", label: "权限指纹", required: true },
            { componentId: "requirements", componentKind: "resource_requirements", label: "有效凭证要求" },
            { componentId: "proof", componentKind: "proof_rows", label: "证明" }
          ]
        }
      ]
    }
  ],
  actions: [
    {
      actionId: "resourcePatch.apply-resource-patch",
      actionKind: "stage_resource_patch",
      label: "补充凭证要求",
      primary: true,
      inputBindings: {
        selectorWallet: "resourcePatch.selectorWallet",
        targetStageId: "resourcePatch.targetStageId",
        resourceKey: "resourcePatch.resourceKey",
        manifestURI: "resourcePatch.manifestURI",
        manifestHash: "resourcePatch.manifestHash",
        policyHash: "resourcePatch.policyHash"
      }
    }
  ]
};

const fundsAddOnManifest = submitSignalAddOnManifest({
  roleSlotId: "funds",
  addOnKind: "submit_signal",
  title: "资金条件记录",
  summary: "记录付款条件和资金凭证；当前不处理任何资金动作。",
  stageBindings: ["order-confirmed", "funds-protected"],
  actionLabel: "确认付款条件",
  evidenceLabel: "资金凭证指纹"
});

const supplyAddOnManifest = submitSignalAddOnManifest({
  roleSlotId: "supply",
  addOnKind: "submit_signal",
  title: "供给侧凭证提交",
  summary: "提交备货、装箱、商业发票和出口单证等供给侧履约凭证。",
  stageBindings: ["stock-ready", "export-documents"],
  actionLabel: "提交供给凭证",
  evidenceLabel: "供给侧履约凭证"
});

const deliveryAddOnManifest = submitSignalAddOnManifest({
  roleSlotId: "delivery",
  addOnKind: "submit_signal",
  title: "交付进度更新",
  summary: "提交报关、装船、物流和到港凭证，更新交付环节状态。",
  stageBindings: ["customs-complete", "export.customs", "shipping", "arrival"],
  actionLabel: "确认报关完成",
  evidenceLabel: "交付凭证引用"
});

const validationAddOnManifest = submitSignalAddOnManifest({
  roleSlotId: "validation",
  addOnKind: "submit_signal",
  title: "检验验收确认",
  summary: "核对检验报告和验收单，确认阶段条件是否满足。",
  stageBindings: ["inspection"],
  actionLabel: "确认验收结果",
  evidenceLabel: "验收凭证引用"
});

const disputeAddOnManifest = submitSignalAddOnManifest({
  roleSlotId: "dispute",
  addOnKind: "submit_signal",
  title: "争议材料提交",
  summary: "提交争议说明、补充凭证和裁定材料，供订单参与方核对。",
  stageBindings: ["close-or-dispute"],
  actionLabel: "提交争议材料",
  evidenceLabel: "争议材料引用"
});

const maintainerAddOnManifest = submitSignalAddOnManifest({
  roleSlotId: "maintainer",
  addOnKind: "submit_signal",
  title: "完成或争议流转确认",
  summary: "维护秩序版本和订单收口状态，确认完成或争议流转记录。",
  stageBindings: ["close-or-dispute"],
  actionLabel: "确认订单收口",
  evidenceLabel: "收口记录引用"
});

export const demoZhixuDetail: ZhixuDetailDTO = {
  zhixuId: CROSS_BORDER_ZHIXU_ID,
  title: "跨境高价值货物分阶段付款秩序",
  subtitle: "适用于平行出口车、工业设备、跨境高价值货物的多角色对接、凭证确认与付款条件管理。",
  reviewStatus: "approved",
  reviewLabel: "已由共同秩序审核",
  riskLevel: "标准",
  applicableBusiness: ["平行出口车", "工业设备", "跨境高价值货物"],
  excludedBusiness: ["违禁品", "规避监管", "无法提供凭证的交易"],
  stageCount: demoStages.length,
  roleSlotCount: 6,
  supportedPaymentMethods: ["外部付款凭证", "资金适配器证明（占位）"],
  maintainer: "共同秩序",
  updatedAt: "2026-04-28",
  planPublication: {
    status: "not_found",
    label: "等待 Plan 发布",
    stateMachineLabel: "UVPStateMachine",
    planId: crossBorderPlanIds.planId,
    planHash: crossBorderPlanIds.planHash,
    artifactHash: crossBorderPlanIds.artifactHash
  },
  roleSlots: [
    {
      slotId: "funds",
      title: "资金方",
      label: "资金方",
      duty: "确认资金保障、付款条件和外部凭证规则",
      evidence: ["付款凭证", "验收确认"],
      status: "required",
      tone: "warn",
      required: true,
      performanceSlotLabel: "资金保障履约者",
      businessPersonaLabels: ["买家", "资金提供者"],
      addOnManifest: fundsAddOnManifest
    },
    {
      slotId: "supply",
      title: "供给方",
      label: "供给方",
      duty: "完成备货、出口单证和供给侧声明",
      evidence: ["合同", "装箱清单", "出口单证"],
      status: "required",
      tone: "warn",
      required: true,
      performanceSlotLabel: "供给履约者",
      businessPersonaLabels: ["卖家", "车商", "供应商"],
      addOnManifest: supplyAddOnManifest
    },
    {
      slotId: "delivery",
      title: "交付方",
      label: "物流/报关",
      duty: "提交报关、装船、物流和到港凭证",
      evidence: ["报关单", "提单", "到港通知"],
      status: "required",
      tone: "warn",
      required: true,
      performanceSlotLabel: "交付履约者",
      businessPersonaLabels: ["报关行", "物流/货代"],
      addOnManifest: deliveryAddOnManifest
    },
    {
      slotId: "validation",
      title: "验收方",
      label: "验收方",
      duty: "核对阶段凭证并确认是否满足付款条件",
      evidence: ["检验报告", "验收单"],
      status: "connected",
      tone: "ok",
      required: true,
      performanceSlotLabel: "验收执行者",
      businessPersonaLabels: ["检验方", "验收方"],
      addOnManifest: validationAddOnManifest
    },
    {
      slotId: "dispute",
      title: "裁定方",
      label: "裁定方",
      duty: "处理争议、要求补证并出具裁定",
      evidence: ["争议说明", "裁定通知"],
      status: "optional",
      tone: "info",
      required: false,
      performanceSlotLabel: "争议裁定履约者",
      businessPersonaLabels: ["裁定方", "争议处理方"],
      addOnManifest: disputeAddOnManifest
    },
    {
      slotId: "maintainer",
      title: "维护方",
      label: "共同秩序",
      duty: "维护秩序版本并审核执行方风险",
      evidence: ["审核记录", "风险记录"],
      status: "connected",
      tone: "ok",
      required: true,
      performanceSlotLabel: "秩序维护履约者",
      businessPersonaLabels: ["共同秩序", "治理维护方"],
      addOnManifest: maintainerAddOnManifest
    }
  ],
  dockableModules: [
    {
      interfaceName: "funds_protection",
      orderModes: ["new"],
      title: "资金保障秩序",
      desc: "对接外部付款凭证、担保证明或资金适配器证明；不处理资金。",
      inputs: [
        { portName: "payment_evidence", label: "资金条件确认", hook: "intake#EXECUTE" }
      ],
      outputs: [
        { portName: "guarantee_proof", label: "担保证明", signal: "guarantor::escrow.guarantee" },
        { portName: "adapter_proof", label: "适配器证明", signal: "adapter::escrow.backing" }
      ],
      status: "connected"
    },
    {
      interfaceName: "logistics_delivery",
      orderModes: ["new"],
      title: "物流交付秩序",
      desc: "对接报关、装船、到港和入仓节点。",
      inputs: [
        { portName: "dispatch", label: "报关完成", hook: "intake#EXECUTE" }
      ],
      outputs: [
        { portName: "bill_of_lading", label: "提单", signal: "carrier::transit.bl" },
        { portName: "warehouse_receipt", label: "入仓凭证", signal: "warehouse::arrival.receipt" }
      ],
      status: "available"
    },
    {
      interfaceName: "inspection_acceptance",
      orderModes: ["new", "existing"],
      title: "检验验收秩序",
      desc: "对接第三方检验、买方验收和补证请求。",
      inputs: [
        { portName: "amend", label: "补证", hook: "review#AMEND" }
      ],
      outputs: [
        { portName: "inspection_report", label: "检验报告", signal: "inspector::review.report" },
        { portName: "acceptance", label: "验收单", signal: "buyer::review.acceptance" }
      ],
      status: "available"
    },
    {
      interfaceName: "dispute_resolution",
      orderModes: ["existing"],
      title: "争议裁定秩序",
      desc: "对接争议暂停、双方补证和裁定结果。",
      inputs: [],
      outputs: [
        { portName: "ruling", label: "裁定", signal: "arbiter::hearing.ruling" }
      ],
      status: "planned"
    }
  ],
  stages: demoStages,
  proofRows: [
    { label: "秩序编号", value: CROSS_BORDER_ZHIXU_ID },
    { label: "审核域", value: "共同秩序官方审核" },
    { label: "秩序指纹", value: `${crossBorderPlanIds.planHash.slice(0, 14)}...${crossBorderPlanIds.planHash.slice(-10)}` },
    { label: "Plan 发布", value: "等待 StateMachine finalized 投影" }
  ],
  createOrderHint: "创建订单后，可填写参与方与商品信息并发起协作。"
};

export const demoParticipants: readonly ParticipantDTO[] = [
  {
    participantId: "buyer",
    role: "买家",
    duty: "负责资金保障和验收确认",
    evidence: ["付款凭证", "验收单"],
    status: "joined",
    tone: "ok"
  },
  {
    participantId: "seller",
    role: "卖家 / 车商",
    duty: "负责备货和出口单证",
    evidence: ["装箱清单", "出口单证"],
    status: "invited",
    tone: "warn"
  },
  {
    participantId: "customs",
    role: "报关行",
    duty: "负责提交报关完成凭证",
    evidence: ["报关单", "报关完成凭证"],
    status: "pending_confirmation",
    tone: "warn"
  },
  {
    participantId: "logistics",
    role: "物流 / 货代",
    duty: "负责装船或物流凭证",
    evidence: ["提单", "装船通知"],
    status: "invited",
    tone: "warn"
  },
  {
    participantId: "inspector",
    role: "检验方",
    duty: "负责检验验收",
    evidence: ["检验报告", "验收单"],
    status: "joined",
    tone: "ok"
  },
  {
    participantId: "arbiter",
    role: "裁定方",
    duty: "负责争议处理",
    evidence: ["裁定通知", "争议说明"],
    status: "assigned",
    tone: "info"
  }
];

export const demoOrder: ProductOrderDTO = {
  orderId: DEMO_ORDER_ID,
  zhixuId: CROSS_BORDER_ZHIXU_ID,
  title: "A 公司采购 10 台车辆",
  status: "registered",
  statusLabel: "进行中",
  totalAmount: {
    amount: "10000",
    currency: "USDC",
    display: "10,000 USDC"
  },
  fundingStatus: "已确认资金保障",
  currentStageId: "customs-complete",
  currentStageName: "出口报关",
  currentTaskId: DEMO_TASK_ID,
  currentTaskTitle: "等待报关行提交报关完成凭证",
  currentTaskSummary: "凭证通过后，第 2 阶段付款条件满足",
  stages: demoStages,
  executorOverlays: {},
  resourceOverlays: {},
  resourceRequirements: {
    "customs-complete": demoCustomsResourceRequirements
  },
  selectableTargets: demoSelectableTargets,
  participants: demoParticipants,
  recentEvents: [
    { eventId: "evt-customs-received", text: "报关行已接收出口单证", time: "2026-04-29 09:12" },
    { eventId: "evt-invoice", text: "供应商上传商业发票", time: "2026-04-22 16:45" },
    { eventId: "evt-funds", text: "资金条件信号已确认", time: "2026-04-18 10:27" }
  ],
  proofRows: [
    { label: "交易编号", value: "0x7a3b...9c2f8e1d4a7" },
    { label: "区块高度", value: "18,734,562" },
    { label: "提交人", value: "张经理（XX 报关行）" },
    { label: "凭证指纹", value: "a9f3b2c8d4e7...1f6a9b0c3d5e8" }
  ]
};

const demoPaymentProofRows: readonly ChainProofRowDTO[] = [
  { label: "链上事件", value: "SignalSubmitted" },
  { label: "区块高度", value: "18,734,562" },
  { label: "提交钱包", value: "0x1111111111111111111111111111111111111111" },
  { label: "凭证指纹", value: "a9f3b2c8d4e7...1f6a9b0c3d5e8" }
];

export const demoPaymentTask: ProductTaskDTO = {
  taskId: "task-funding-placeholder-001",
  orderId: DEMO_ORDER_ID,
  orderTitle: demoOrder.title,
  zhixuId: CROSS_BORDER_ZHIXU_ID,
  title: "确认资金条件证明",
  subtitle: "你作为资金方，需要确认付款条件和资金凭证；当前仅为资金适配器占位。",
  assigneeRole: "资金方",
  stageId: "funds-protected",
  stageName: "资金保障",
  deadline: "2026-04-30 18:00",
  fundingImpact: "资金适配器占位：仅记录付款条件和证明，不托管、不划转、不释放、不退款任何资金",
  // 任务词表没有完成态：占位确认已提交、等待链上索引按 submitted 呈现。
  status: "submitted",
  performanceSlotId: "funds",
  performanceSlotLabel: "资金保障履约者",
  businessPersonaLabels: ["买家", "资金提供者"],
  addOnManifest: fundsAddOnManifest,
  primaryActionLabel: "确认付款条件",
  requiredInputs: demoPaymentRequiredInputs,
  settlementPreview: {
    label: "资金适配器占位",
    statusLabel: "等待后续 funding adapter 接入",
    adapterStatus: "placeholder",
    disclaimer: "当前不托管、不划转、不释放、不退款任何资金，只记录付款条件和证明。"
  },
  participantRoleLabel: "资金方",
  canSubmit: false,
  proofSummary: {
    label: "付款条件已确认",
    txHash: "0x7a3b...9c2f8e1d4a7",
    blockNumber: "18,734,562",
    payloadHash: "a9f3b2c8d4e7...1f6a9b0c3d5e8"
  },
  responsibilityStatements: [
    {
      title: "我理解当前不托管资金",
      desc: "本阶段只确认付款条件和凭证，真实付款、担保或稳定币适配器需后续接入。"
    }
  ],
  proofRows: demoPaymentProofRows
};

export const demoFundingGuaranteeSignalContainers = [
  {
    scenarioId: "buyer-payment-evidence",
    schemaVersion: "uvp.signal-container.v1",
    taskId: demoPaymentTask.taskId,
    orderId: DEMO_ORDER_ID,
    planId: crossBorderPlanIds.planId,
    stageId: demoPaymentTask.stageId,
    capabilityKind: "payment_placeholder",
    actionKind: "submit_signal",
    requiredInputs: demoPaymentTask.requiredInputs ?? [],
    acceptedActor: {
      actorKind: "buyer",
      label: "买家付款凭证提交",
      wallet: "0x1111111111111111111111111111111111111111",
      authorizationLabel: "订单级买家钱包授权"
    },
    fundingMetadata: {
      fundingMethodLabel: "买家付款凭证",
      amountDisplay: demoOrder.totalAmount.display,
      currencyDisplay: demoOrder.totalAmount.currency,
      policyHash: "0x0f00000000000000000000000000000000000000000000000000000000000101",
      evidenceIds: ["evidence:buyer-payment-condition-hash"],
      adapterProofRows: [
        { label: "资金方式", value: "买家付款凭证" },
        { label: "凭证指纹", value: "0x0f00000000000000000000000000000000000000000000000000000000000102" }
      ]
    },
    prepare: {
      typedData: {
        stateMachineLabel: "UVPStateMachine 0.15",
        primaryType: "SubmitSignal",
        messageHint: "funding_condition_satisfied"
      },
      submitter: "0x1111111111111111111111111111111111111111",
      payloadHash: "0x0f00000000000000000000000000000000000000000000000000000000000103",
      payloadRef: "uvp-resource://demo/funding/buyer-payment-evidence/v1",
      idempotencyKey: "funding:buyer-payment-evidence:order-cross-border-car-001",
      deadline: "2026-04-30T10:00:00.000Z"
    },
    proof: {
      txHash: "0x0f00000000000000000000000000000000000000000000000000000000000104",
      blockNumber: "18,734,562",
      eventName: "SignalSubmitted",
      rows: [
        { label: "链上事件", value: "SignalSubmitted" },
        { label: "提交钱包", value: "0x1111111111111111111111111111111111111111" },
        { label: "Payload Hash", value: "0x0f00000000000000000000000000000000000000000000000000000000000103" }
      ]
    },
    productCopy: {
      title: "提交资金条件信号",
      summary: "买家钱包提交付款凭证指纹，表示订单的资金条件证据已备齐。",
      disclaimer: "UVP 只记录钱包签名、凭证指纹和链上事件；不托管、不划转、不释放、不退款任何资金。"
    }
  },
  {
    scenarioId: "guarantor-backing-proof",
    schemaVersion: "uvp.signal-container.v1",
    taskId: demoPaymentTask.taskId,
    orderId: DEMO_ORDER_ID,
    planId: crossBorderPlanIds.planId,
    stageId: demoPaymentTask.stageId,
    capabilityKind: "payment_placeholder",
    actionKind: "submit_signal",
    requiredInputs: demoPaymentTask.requiredInputs ?? [],
    acceptedActor: {
      actorKind: "guarantor",
      label: "担保方证明提交",
      wallet: "0x4444444444444444444444444444444444444444",
      authorizationLabel: "订单级担保方授权",
      supplierSubjectId: "supplier:guarantor:demo-001"
    },
    fundingMetadata: {
      fundingMethodLabel: "担保方证明",
      amountDisplay: demoOrder.totalAmount.display,
      currencyDisplay: demoOrder.totalAmount.currency,
      policyHash: "0x0f00000000000000000000000000000000000000000000000000000000000201",
      evidenceIds: ["evidence:guarantee-policy-hash", "evidence:guarantee-coverage-ref"],
      guarantorSupplierSubjectId: "supplier:guarantor:demo-001",
      adapterProofRows: [
        { label: "担保方主体", value: "supplier:guarantor:demo-001" },
        { label: "担保策略指纹", value: "0x0f00000000000000000000000000000000000000000000000000000000000202" }
      ]
    },
    prepare: {
      typedData: {
        stateMachineLabel: "UVPStateMachine 0.15",
        primaryType: "SubmitSignal",
        messageHint: "funding_condition_satisfied"
      },
      submitter: "0x4444444444444444444444444444444444444444",
      payloadHash: "0x0f00000000000000000000000000000000000000000000000000000000000203",
      payloadRef: "uvp-resource://demo/funding/guarantor-backing-proof/v1",
      idempotencyKey: "funding:guarantor-backing-proof:order-cross-border-car-001",
      deadline: "2026-04-30T10:00:00.000Z"
    },
    proof: {
      txHash: "0x0f00000000000000000000000000000000000000000000000000000000000204",
      blockNumber: "18,734,563",
      eventName: "SignalSubmitted",
      rows: [
        { label: "链上事件", value: "SignalSubmitted" },
        { label: "提交钱包", value: "0x4444444444444444444444444444444444444444" },
        { label: "Payload Hash", value: "0x0f00000000000000000000000000000000000000000000000000000000000203" }
      ]
    },
    productCopy: {
      title: "提交担保证明信号",
      summary: "担保方钱包提交外部担保证明指纹，表示资金条件可由授权担保方证明。",
      disclaimer: "UVP 只记录担保方签名、证明指纹和链上事件；不托管、不划转、不释放、不退款任何资金。"
    }
  },
  {
    scenarioId: "stablecoin-adapter-proof",
    schemaVersion: "uvp.signal-container.v1",
    taskId: demoPaymentTask.taskId,
    orderId: DEMO_ORDER_ID,
    planId: crossBorderPlanIds.planId,
    stageId: demoPaymentTask.stageId,
    capabilityKind: "payment_placeholder",
    actionKind: "submit_signal",
    requiredInputs: demoPaymentTask.requiredInputs ?? [],
    acceptedActor: {
      actorKind: "adapter",
      label: "资金适配器证明提交",
      wallet: "0x5555555555555555555555555555555555555555",
      authorizationLabel: "订单级资金适配器授权",
      supplierSubjectId: "supplier:stablecoin-adapter:demo-001"
    },
    fundingMetadata: {
      fundingMethodLabel: "稳定币适配器证明",
      amountDisplay: demoOrder.totalAmount.display,
      currencyDisplay: demoOrder.totalAmount.currency,
      policyHash: "0x0f00000000000000000000000000000000000000000000000000000000000301",
      evidenceIds: ["evidence:adapter-proof-root", "evidence:adapter-policy-hash"],
      adapterProofRows: [
        { label: "适配器主体", value: "supplier:stablecoin-adapter:demo-001" },
        { label: "外部状态", value: "funding_condition_satisfied" },
        { label: "证明根", value: "0x0f00000000000000000000000000000000000000000000000000000000000302" }
      ]
    },
    prepare: {
      typedData: {
        stateMachineLabel: "UVPStateMachine 0.15",
        primaryType: "SubmitSignal",
        messageHint: "funding_condition_satisfied"
      },
      submitter: "0x5555555555555555555555555555555555555555",
      payloadHash: "0x0f00000000000000000000000000000000000000000000000000000000000303",
      payloadRef: "uvp-resource://demo/funding/stablecoin-adapter-proof/v1",
      idempotencyKey: "funding:stablecoin-adapter-proof:order-cross-border-car-001",
      deadline: "2026-04-30T10:00:00.000Z"
    },
    proof: {
      txHash: "0x0f00000000000000000000000000000000000000000000000000000000000304",
      blockNumber: "18,734,564",
      eventName: "SignalSubmitted",
      rows: [
        { label: "链上事件", value: "SignalSubmitted" },
        { label: "提交钱包", value: "0x5555555555555555555555555555555555555555" },
        { label: "Payload Hash", value: "0x0f00000000000000000000000000000000000000000000000000000000000303" }
      ]
    },
    productCopy: {
      title: "提交适配器证明信号",
      summary: "资金适配器钱包提交外部证明根，表示资金条件已由外部适配器核对。",
      disclaimer: "UVP 只记录适配器签名、证明指纹和链上事件；不托管、不划转、不释放、不退款任何资金。"
    }
  }
] satisfies readonly DemoFundingSignalContainerFixture[];

export const demoSelectorTask: ProductTaskDTO = {
  taskId: "task-selector-customs-001",
  orderId: DEMO_ORDER_ID,
  orderTitle: demoOrder.title,
  zhixuId: CROSS_BORDER_ZHIXU_ID,
  title: "选择或交接履约者",
  subtitle: "未开始阶段可选择履约者；已开始阶段需原履约者共签交接。",
  assigneeRole: "买家",
  stageId: "order-confirmed",
  stageName: "订单确认",
  deadline: "2026-04-30 18:00",
  fundingImpact: "不涉及任何资金动作，只更新后续阶段的履约安排",
  status: "open",
  addOnKind: "stage_executor_patch",
  addOnManifest: selectorAddOnManifest,
  selectableTargets: demoSelectableTargets,
  executorPatchModes: [demoAssignPatchMode, demoHandoffPatchMode],
  primaryActionLabel: "选择履约者",
  participantRoleLabel: "买家",
  canSubmit: true,
  proofSummary: {
    label: "等待链上确认"
  },
  responsibilityStatements: [
    {
      title: "我确认履约者由授权参与方选择",
      desc: "提交后需要钱包签名，服务只负责转发，不代替参与方做业务确认。"
    },
    {
      title: "已完成部分不变",
      desc: "履约者补充只影响后续履约权限，不改写已提交的阶段事实。"
    },
    {
      title: "我理解履约者选择只提交引用和指纹",
      desc: "合同、发票、物流文件等业务原文不会写入链上。"
    }
  ],
  proofRows: [
    { label: "选择状态", value: "等待提交" },
    { label: "链上补充证明", value: "提交并同步后显示" }
  ]
};

export const demoResourcePatchTask: ProductTaskDTO = {
  taskId: "task-resource-controller-001",
  orderId: DEMO_ORDER_ID,
  orderTitle: demoOrder.title,
  zhixuId: CROSS_BORDER_ZHIXU_ID,
  title: "补充报关凭证要求",
  subtitle: "你可以为目标阶段发布加密内容寻址资源清单和访问策略。",
  assigneeRole: "买家",
  stageId: "order-confirmed",
  stageName: "订单确认",
  deadline: "2026-04-30 18:00",
  fundingImpact: "不涉及任何资金动作，只更新后续阶段的凭证清单要求",
  status: "open",
  addOnKind: "stage_resource_patch",
  addOnManifest: resourcePatchAddOnManifest,
  selectableTargets: [
    {
      selectorStageId: "order-confirmed",
      targetStageId: "customs-complete",
      targetStageName: "出口报关",
      allowed: true,
      currentExecutorLabel: "待选择履约者",
      resourceRequirements: demoCustomsResourceRequirements
    }
  ],
  resourceRequirements: demoCustomsResourceRequirements,
  primaryActionLabel: "补充凭证要求",
  participantRoleLabel: "买家",
  canSubmit: true,
  proofSummary: {
    label: "等待资源清单确认"
  },
  responsibilityStatements: [
    {
      title: "我确认资源清单不包含文件原文",
      desc: "提交内容只包含清单 URI、清单指纹、权限指纹和访问范围。"
    }
  ],
  proofRows: [
    { label: "资源清单状态", value: "等待提交" },
    { label: "链上补充证明", value: "提交并同步后显示" }
  ]
};

export const demoTask: ProductTaskDTO = {
  taskId: DEMO_TASK_ID,
  orderId: DEMO_ORDER_ID,
  orderTitle: demoOrder.title,
  zhixuId: CROSS_BORDER_ZHIXU_ID,
  title: "确认出口报关完成",
  subtitle: "你代表 XX 报关行，需要提交本阶段凭证。",
  assigneeRole: "XX 报关行",
  stageId: "customs-complete",
  stageName: "出口报关",
  deadline: "2026-05-03 18:00",
  fundingImpact: "进入验收；通过后第 2 阶段付款条件满足",
  status: "open",
  addOnKind: "submit_signal",
  resourceRequirements: demoCustomsResourceRequirements,
  performanceSlotId: "delivery",
  performanceSlotLabel: "交付履约者",
  businessPersonaLabels: ["报关行", "物流/货代"],
  addOnManifest: deliveryAddOnManifest,
  primaryActionLabel: "确认报关完成",
  requiredInputs: demoCustomsRequiredInputs,
  participantRoleLabel: "报关行",
  canSubmit: false,
  proofSummary: {
    label: "等待提交凭证"
  },
  responsibilityStatements: [
    {
      title: "我确认以上凭证真实、完整",
      desc: "我已核对上传的报关单真实有效，内容完整无误。"
    },
    {
      title: "我理解提交后不可删除，只能追加更正或争议",
      desc: "提交后该凭证将进入验收流程，无法删除，如需更正请追加凭证。"
    },
    {
      title: "我理解平台会生成可核对记录",
      desc: "平台会把本次确认转换为可核对的证明记录，无需我方处理底层提交。"
    }
  ],
  proofRows: demoOrder.proofRows
};

export const demoProductCatalog: ProductCatalogDTO = {
  zhixus: [demoZhixuDetail],
  orders: [demoOrder],
  tasks: [demoPaymentTask, demoSelectorTask, demoResourcePatchTask, demoTask]
};

function demoRoleSlotIdForStage(stageId: string): string {
  switch (stageId) {
    case "order-confirmed":
    case "funds-protected":
      return "funds";
    case "stock-ready":
    case "export-documents":
      return "supply";
    case "customs-complete":
    case "shipping":
    case "arrival":
      return "delivery";
    case "inspection":
      return "validation";
    case "close-or-dispute":
      return "maintainer";
    default:
      throw new Error(`demo stage has no explicit permission role: ${stageId}`);
  }
}
