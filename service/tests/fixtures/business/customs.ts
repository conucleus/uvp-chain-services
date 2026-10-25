import {
  type ParticipantAddOnManifestDTO,
  type ParticipantDTO,
  type ProductCatalogDTO,
  type ProductOrderDTO,
  type ProductResourceAccessPolicyDTO,
  type ProductResourceManifestDTO,
  type ProductResourceRequirementDTO,
  type ProductTaskDTO,
  type RoleSlotDTO,
  type StoreProductSchemaDTO,
  type ZhixuDetailDTO,
  type ZhixuStageDTO
} from "@uvp-eth/product-dto";

/** 派生身份演示值（zx-+32hex，与编译产物 zhixuId 同形态）。 */
export const CUSTOMS_ZHIXU_ID = "zx-dbfac16c36b253ae56bc322280a3a66d";
export const CUSTOMS_ORDER_ID = "order-customs-001";

export const customsStageIds = {
  buyerSelectCustomsExecutor: "buyer.select-customs-executor",
  buyerPublishCustomsResources: "buyer.publish-customs-resources",
  customsComplete: "customs-complete"
} as const;

export const customsRoleSlotIds = {
  buyerSelector: "buyer-selector",
  buyerResourceController: "buyer-resource-controller",
  customsExecutor: "customs-executor"
} as const;

export const customsActionIds = {
  applyExecutorPatch: "buyer-selector.apply-executor-patch",
  applyResourcePatch: "buyer-resource-controller.apply-resource-patch",
  submitCustomsComplete: "customs-executor.submit-customs-complete"
} as const;

export const customsResourceKeys = {
  customsDeclarationPdf: "customs_declaration_pdf"
} as const;

export const customsSignalIds = {
  orderRegistered: "registered",
  executorSelected: "buyer.select-customs-executor.executor_selected",
  resourcesPublished: "buyer.publish-customs-resources.resources_published",
  customsCompleteConfirmed: "customs-complete.confirm_stage"
} as const;

export const customsInitialTriggerSource = "order";

export const customsWallets = {
  buyer: "0x1111111111111111111111111111111111111111",
  customsExecutor: "0x2222222222222222222222222222222222222222"
} as const;

export const customsPlanIds = {
  // 三值按公式同批复算钉住（planId 变更会改写 canonical payload 哈希）：
  // planId = planIdOf(zhixuId, zhixuName, platform)；planHash = 链 runtime
  // hash（PlanCommit 注册哈希，与链上 planHash(planId) getter 同名同值）；
  // artifactHash = 制品 canonical payload hash（hashOnchainPlanPayload）。
  planId: "0xc17ec525b4686fa302e21811ed15c1f7888d9ee1313665393defc396b7702519",
  planHash: "0xa990f484cc8b97561f6dd6adddd978a09976b24100b439e6debba3c18615935a",
  artifactHash: "0xd0c73aff30c51014acdc04f1fc89458884aa5ae0d8e3766a9cc181cf5393765a"
} as const;

export const customsResourceManifest: ProductResourceManifestDTO = {
  schemaVersion: "uvp-resource-manifest-v1",
  orderId: CUSTOMS_ORDER_ID,
  targetStageId: customsStageIds.customsComplete,
  resourceKey: customsResourceKeys.customsDeclarationPdf,
  visibility: "protected",
  manifestURI: "uvp-resource://customs/customs-declaration-pdf/v1",
  manifestHash: "0xdac56fa990b9253da7a5773a657adbe3d170f1b428169858b3f2545b2d562405",
  policyHash: "0xc7ff3c7a9a1d12181aba887281be556416beedb1e600e132e57e1cfddf78e490",
  ciphertextHash: "0x3cf67bf9b98b52d4ba6c00f6d26f0541098fca706ff68707a7c59c7284dd64b5",
  storageCID: "bafyuvpcustomsdeclarationpdfciphertext",
  recipientEnvelopeRoot: "0xf4d441f65f7ef2b91f664d4bd0c14c980f35e5f0e5f481f678d5f7e59a43d071",
  createdBy: customsWallets.buyer,
  createdAt: "2026-05-01T00:00:00.000Z"
};

const customsResourcePolicy: ProductResourceAccessPolicyDTO = {
  visibility: "protected",
  readers: [
    { kind: "role", label: "买家", value: customsRoleSlotIds.buyerResourceController },
    { kind: "role", label: "报关履约者", value: customsRoleSlotIds.customsExecutor }
  ],
  writers: [
    { kind: "role", label: "买家资源请求方", value: customsRoleSlotIds.buyerResourceController }
  ],
  controllers: [
    { kind: "wallet", label: "买家钱包", value: customsWallets.buyer }
  ],
  policyHash: customsResourceManifest.policyHash
};

export const customsResourceRequirements: readonly ProductResourceRequirementDTO[] = [
  {
    resourceId: "customs-declaration-pdf",
    resourceKey: customsResourceKeys.customsDeclarationPdf,
    label: "报关单 PDF",
    required: true,
    source: "resource_patch",
    resourceType: "document",
    visibility: "protected",
    sourceStageId: customsStageIds.customsComplete,
    description: "报关单以加密内容寻址清单和指纹形式提供，文件原文不写入链上。",
    manifestURI: customsResourceManifest.manifestURI,
    manifestHash: customsResourceManifest.manifestHash,
    manifest: customsResourceManifest,
    accessPolicy: customsResourcePolicy,
    accessStatus: {
      state: "available",
      label: "授权参与方可核对资源清单",
      canRead: true,
      canWrite: true,
      canControl: true
    },
    proofRows: [
      { label: "链上事件", value: "StageResourcePatchApplied" },
      { label: "Resource Key", value: customsResourceKeys.customsDeclarationPdf },
      { label: "Manifest Hash", value: customsResourceManifest.manifestHash },
      { label: "Policy Hash", value: customsResourceManifest.policyHash }
    ]
  }
];

export const customsStages: readonly ZhixuStageDTO[] = [
  {
    stageId: customsStageIds.buyerSelectCustomsExecutor,
    index: 1,
    name: "选择报关履约者",
    evidence: ["履约者元数据指纹"],
    ownerRole: "买家",
    status: "done",
    updatedAt: "2026-05-01T00:05:00.000Z",
    stageKind: "control",
    executorAssignment: "static",
    staticExecutorRoleSlotId: customsRoleSlotIds.buyerSelector,
    selectedStageTargets: [customsStageIds.customsComplete],
    addOnKind: "stage_executor_patch"
  },
  {
    stageId: customsStageIds.buyerPublishCustomsResources,
    index: 2,
    name: "发布报关资源清单",
    evidence: ["资源清单 URI", "资源清单指纹", "访问策略指纹"],
    ownerRole: "买家",
    status: "done",
    updatedAt: "2026-05-01T00:08:00.000Z",
    stageKind: "control",
    executorAssignment: "static",
    staticExecutorRoleSlotId: customsRoleSlotIds.buyerResourceController,
    selectedStageTargets: [customsStageIds.customsComplete],
    addOnKind: "stage_resource_patch",
    resourceRequirements: customsResourceRequirements
  },
  {
    stageId: customsStageIds.customsComplete,
    index: 3,
    name: "报关完成",
    evidence: ["报关完成凭证引用", "报关单 PDF 资源清单"],
    ownerRole: "报关履约者",
    status: "done",
    updatedAt: "2026-05-01T00:20:00.000Z",
    stageKind: "business",
  }
]

export const customsBuyerSelectorManifest: ParticipantAddOnManifestDTO = {
  schemaVersion: "participant-addon-manifest.v1",
  manifestId: "customs:buyer-selector:v1",
  roleSlotId: customsRoleSlotIds.buyerSelector,
  addOnKind: "stage_executor_patch",
  title: "选择报关履约者",
  summary: "为报关完成阶段指定可提交完成信号的钱包。",
  stageBindings: [customsStageIds.customsComplete],
  pages: [
    {
      pageId: "executor-selection",
      title: "履约者选择",
      sections: [
        {
          sectionId: "executor-patch",
          title: "选择设置",
          components: [
            { componentId: "target-stage", componentKind: "stage_select", inputId: "buyerSelector.targetStageId", label: "目标阶段", required: true, defaultValue: customsStageIds.customsComplete },
            { componentId: "mode", componentKind: "select", inputId: "buyerSelector.mode", label: "补丁模式", required: true, defaultValue: "assign", options: [{ value: "assign", label: "指定履约者" }] },
            { componentId: "selector-wallet", componentKind: "wallet", inputId: "buyerSelector.selectorWallet", label: "买家钱包", required: true, defaultValue: customsWallets.buyer },
            { componentId: "executor-wallet", componentKind: "wallet", inputId: "buyerSelector.executorWallet", label: "报关履约者钱包", required: true, defaultValue: customsWallets.customsExecutor },
            { componentId: "executor-metadata-hash", componentKind: "hash", inputId: "buyerSelector.executorMetadataHash", label: "履约者元数据指纹", required: true, defaultValue: "0x7e702e1a2c4cb9b7f56fbac26f9efe34345de47460f2dd05d7462e9117ac5fd2" },
            { componentId: "metadata-uri", componentKind: "uri", inputId: "buyerSelector.metadataURI", label: "履约者元数据 URI", required: true, defaultValue: "uvp-resource://customs/customs-executor-metadata/v1" },
            { componentId: "executor-reference", componentKind: "text", inputId: "buyerSelector.executorReference", label: "履约者参考" },
            { componentId: "proof", componentKind: "proof_rows", label: "证明" }
          ]
        }
      ]
    }
  ],
  actions: [
    {
      actionId: customsActionIds.applyExecutorPatch,
      actionKind: "stage_executor_patch",
      label: "选择报关履约者",
      primary: true,
      inputBindings: {
        selectorWallet: "buyerSelector.selectorWallet",
        targetStageId: "buyerSelector.targetStageId",
        mode: "buyerSelector.mode",
        executorWallet: "buyerSelector.executorWallet",
        executorMetadataHash: "buyerSelector.executorMetadataHash",
        metadataURI: "buyerSelector.metadataURI"
      }
    }
  ]
};

export const customsBuyerResourceControllerManifest: ParticipantAddOnManifestDTO = {
  schemaVersion: "participant-addon-manifest.v1",
  manifestId: "customs:buyer-resource-controller:v1",
  roleSlotId: customsRoleSlotIds.buyerResourceController,
  addOnKind: "stage_resource_patch",
  title: "发布报关资源清单",
  summary: "为报关完成阶段发布内容寻址的资源清单和访问策略指纹。",
  stageBindings: [customsStageIds.customsComplete],
  pages: [
    {
      pageId: "resource-manifest",
      title: "资源清单",
      sections: [
        {
          sectionId: "resource-patch",
          title: "资源补丁",
          components: [
            { componentId: "selector-wallet", componentKind: "wallet", inputId: "buyerResourceController.selectorWallet", label: "买家钱包", required: true, defaultValue: customsWallets.buyer },
            { componentId: "target-stage", componentKind: "stage_select", inputId: "buyerResourceController.targetStageId", label: "目标阶段", required: true, defaultValue: customsStageIds.customsComplete },
            { componentId: "resource-key", componentKind: "text", inputId: "buyerResourceController.resourceKey", label: "资源键", required: true, defaultValue: customsResourceKeys.customsDeclarationPdf },
            { componentId: "manifest-uri", componentKind: "uri", inputId: "buyerResourceController.manifestURI", label: "资源清单 URI", required: true, defaultValue: customsResourceManifest.manifestURI },
            { componentId: "manifest-hash", componentKind: "hash", inputId: "buyerResourceController.manifestHash", label: "资源清单指纹", required: true, defaultValue: customsResourceManifest.manifestHash },
            { componentId: "policy-hash", componentKind: "hash", inputId: "buyerResourceController.policyHash", label: "访问策略指纹", required: true, defaultValue: customsResourceManifest.policyHash },
            { componentId: "requirements", componentKind: "resource_requirements", label: "资源要求" },
            { componentId: "proof", componentKind: "proof_rows", label: "证明" }
          ]
        }
      ]
    }
  ],
  actions: [
    {
      actionId: customsActionIds.applyResourcePatch,
      actionKind: "stage_resource_patch",
      label: "发布资源清单",
      primary: true,
      inputBindings: {
        selectorWallet: "buyerResourceController.selectorWallet",
        targetStageId: "buyerResourceController.targetStageId",
        resourceKey: "buyerResourceController.resourceKey",
        manifestURI: "buyerResourceController.manifestURI",
        manifestHash: "buyerResourceController.manifestHash",
        policyHash: "buyerResourceController.policyHash"
      }
    }
  ]
};

export const customsExecutorManifest: ParticipantAddOnManifestDTO = {
  schemaVersion: "participant-addon-manifest.v1",
  manifestId: "customs:customs-executor:v1",
  roleSlotId: customsRoleSlotIds.customsExecutor,
  addOnKind: "submit_signal",
  title: "提交报关完成",
  summary: "被选中的报关履约者提交报关完成信号和凭证引用。",
  stageBindings: [customsStageIds.customsComplete],
  pages: [
    {
      pageId: "customs-complete",
      title: "报关完成",
      sections: [
        {
          sectionId: "executor-signal",
          title: "完成提交",
          components: [
            { componentId: "wallet", componentKind: "wallet", inputId: "customsExecutor.walletAddress", label: "报关履约者钱包", required: true, defaultValue: customsWallets.customsExecutor },
            { componentId: "requirements", componentKind: "resource_requirements", label: "资源要求" },
            { componentId: "evidence", componentKind: "evidence_refs", inputId: "customsExecutor.evidenceIds", label: "凭证引用", required: true },
            { componentId: "confirmation", componentKind: "confirmation", inputId: "customsExecutor.confirmation", label: "确认报关已完成", required: true },
            { componentId: "proof", componentKind: "proof_rows", label: "证明" }
          ]
        }
      ]
    }
  ],
  actions: [
    {
      actionId: customsActionIds.submitCustomsComplete,
      actionKind: "submit_signal",
      label: "提交报关完成",
      primary: true,
      intent: "confirm_stage",
      inputBindings: {
        walletAddress: "customsExecutor.walletAddress",
        evidenceIds: "customsExecutor.evidenceIds",
        confirmation: "customsExecutor.confirmation"
      }
    }
  ]
};

export const customsRoleSlots: readonly RoleSlotDTO[] = [
  {
    slotId: customsRoleSlotIds.buyerSelector,
    title: "买家选择方",
    label: "买家",
    duty: "选择报关履约者并签名提交执行者补丁。",
    evidence: ["履约者元数据指纹"],
    status: "required",
    tone: "info",
    required: true,
    performanceSlotLabel: "买家选择方",
    businessPersonaLabels: ["买家"],
    addOnManifest: customsBuyerSelectorManifest
  },
  {
    slotId: customsRoleSlotIds.buyerResourceController,
    title: "买家资源请求方",
    label: "买家",
    duty: "发布报关资源清单和访问策略指纹。",
    evidence: ["资源清单指纹", "访问策略指纹"],
    status: "required",
    tone: "info",
    required: true,
    performanceSlotLabel: "买家资源请求方",
    businessPersonaLabels: ["买家"],
    addOnManifest: customsBuyerResourceControllerManifest
  },
  {
    slotId: customsRoleSlotIds.customsExecutor,
    title: "报关履约者",
    label: "报关行",
    duty: "读取授权资源清单并提交报关完成信号。",
    evidence: ["报关完成凭证引用", "报关单 PDF 资源清单"],
    status: "required",
    tone: "warn",
    required: true,
    performanceSlotLabel: "报关履约者",
    businessPersonaLabels: ["报关行", "关务服务商"],
    addOnManifest: customsExecutorManifest
  }
];

export const customsZhixuDetail: ZhixuDetailDTO = {
  zhixuId: CUSTOMS_ZHIXU_ID,
  title: "报关完成秩序",
  subtitle: "买家选择报关履约者、发布资源清单，报关履约者提交链上完成信号。",
  reviewStatus: "approved",
  reviewLabel: "Customs fixture",
  riskLevel: "测试闭环",
  applicableBusiness: ["跨境报关", "出口单证"],
  excludedBusiness: ["文件原文上链", "未授权履约者代签"],
  stageCount: customsStages.length,
  roleSlotCount: customsRoleSlots.length,
  supportedPaymentMethods: ["无资金动作"],
  maintainer: "共同秩序",
  updatedAt: "2026-05-01",
  planPublication: {
    status: "not_found",
    label: "等待 Plan 发布",
    stateMachineLabel: "UVPStateMachine",
    planId: customsPlanIds.planId,
    planHash: customsPlanIds.planHash,
    artifactHash: customsPlanIds.artifactHash
  },
  roleSlots: customsRoleSlots,
  dockableModules: [],
  stages: customsStages,
  proofRows: [
    { label: "Plan ID", value: customsPlanIds.planId },
    { label: "Plan Hash", value: customsPlanIds.planHash },
    { label: "Selector Binding", value: `${customsStageIds.buyerSelectCustomsExecutor}->${customsStageIds.customsComplete}` },
    { label: "Resource Key", value: customsResourceKeys.customsDeclarationPdf }
  ],
  createOrderHint: "创建订单时预授权买家控制动作和已知报关履约者的完成信号。"
};

const customsParticipants: readonly ParticipantDTO[] = [
  {
    participantId: "buyer",
    role: "买家",
    duty: "选择报关履约者并发布资源清单",
    evidence: ["履约者元数据指纹", "资源清单指纹"],
    status: "joined",
    tone: "ok",
    addOnKind: "stage_executor_patch"
  },
  {
    participantId: "customs-executor",
    role: "报关履约者",
    duty: "提交报关完成信号",
    evidence: ["报关完成凭证引用"],
    status: "joined",
    tone: "ok",
    addOnKind: "submit_signal"
  }
];

export const customsOrder: ProductOrderDTO = {
  orderId: CUSTOMS_ORDER_ID,
  zhixuId: CUSTOMS_ZHIXU_ID,
  title: "报关闭环订单",
  status: "registered",
  statusLabel: "报关完成",
  totalAmount: {
    amount: "0",
    currency: "USDC",
    display: "0 USDC"
  },
  fundingStatus: "无资金动作",
  currentStageId: customsStageIds.customsComplete,
  currentStageName: "报关完成",
  currentTaskId: "task-customs-executor",
  currentTaskTitle: "报关完成信号已提交",
  currentTaskSummary: "选择履约者、资源清单发布、报关完成三个动作均已有链上证明。",
  stages: customsStages,
  resourceRequirements: {
    [customsStageIds.customsComplete]: customsResourceRequirements
  },
  participants: customsParticipants,
  recentEvents: [
    { eventId: "evt-customs-executor", text: "StageExecutorActivated customs-complete", time: "2026-05-01T00:05:00.000Z" },
    { eventId: "evt-customs-resource", text: "StageResourcePatchApplied customs_declaration_pdf", time: "2026-05-01T00:08:00.000Z" },
    { eventId: "evt-customs-signal", text: "SignalSubmitted customs-complete.confirm_stage", time: "2026-05-01T00:20:00.000Z" }
  ],
  proofRows: [
    { label: "Executor Event", value: "StageExecutorActivated" },
    { label: "Resource Event", value: "StageResourcePatchApplied" },
    { label: "Signal Event", value: "SignalSubmitted" },
    { label: "Active Executor", value: customsWallets.customsExecutor }
  ]
};

export const customsSelectorTask: ProductTaskDTO = {
  taskId: "task-customs-buyer-selector",
  orderId: CUSTOMS_ORDER_ID,
  orderTitle: customsOrder.title,
  zhixuId: CUSTOMS_ZHIXU_ID,
  title: "选择报关履约者",
  subtitle: "买家签名指定报关完成阶段的履约者钱包。",
  assigneeRole: "买家",
  assigneeWallet: customsWallets.buyer,
  stageId: customsStageIds.buyerSelectCustomsExecutor,
  stageName: "选择报关履约者",
  deadline: "2026-05-01 23:59",
  fundingImpact: "无资金动作",
  // 任务词表没有完成态：工作已提交、等待链上索引按 submitted 如实呈现。
  status: "submitted",
  addOnKind: "stage_executor_patch",
  addOnManifest: customsBuyerSelectorManifest,
  primaryActionLabel: "选择报关履约者",
  participantRoleLabel: "买家",
  participantWallet: customsWallets.buyer,
  canSubmit: false,
  responsibilityStatements: [],
  proofRows: [
    { label: "链上事件", value: "StageExecutorActivated" },
    { label: "Target Stage", value: customsStageIds.customsComplete },
    { label: "Executor", value: customsWallets.customsExecutor }
  ]
};

export const customsResourceControllerTask: ProductTaskDTO = {
  taskId: "task-customs-buyer-resource-controller",
  orderId: CUSTOMS_ORDER_ID,
  orderTitle: customsOrder.title,
  zhixuId: CUSTOMS_ZHIXU_ID,
  title: "发布报关资源清单",
  subtitle: "买家签名发布报关单 PDF 的内容寻址清单和访问策略指纹。",
  assigneeRole: "买家",
  assigneeWallet: customsWallets.buyer,
  stageId: customsStageIds.buyerPublishCustomsResources,
  stageName: "发布报关资源清单",
  deadline: "2026-05-01 23:59",
  fundingImpact: "无资金动作",
  // 任务词表没有完成态：工作已提交、等待链上索引按 submitted 如实呈现。
  status: "submitted",
  addOnKind: "stage_resource_patch",
  addOnManifest: customsBuyerResourceControllerManifest,
  resourceRequirements: customsResourceRequirements,
  primaryActionLabel: "发布资源清单",
  participantRoleLabel: "买家",
  participantWallet: customsWallets.buyer,
  canSubmit: false,
  responsibilityStatements: [],
  proofRows: [
    { label: "链上事件", value: "StageResourcePatchApplied" },
    { label: "Manifest Hash", value: customsResourceManifest.manifestHash },
    { label: "Policy Hash", value: customsResourceManifest.policyHash }
  ]
};

export const customsExecutorTask: ProductTaskDTO = {
  taskId: "task-customs-executor",
  orderId: CUSTOMS_ORDER_ID,
  orderTitle: customsOrder.title,
  zhixuId: CUSTOMS_ZHIXU_ID,
  title: "提交报关完成",
  subtitle: "报关履约者提交完成信号和凭证引用。",
  assigneeRole: "报关履约者",
  assigneeWallet: customsWallets.customsExecutor,
  stageId: customsStageIds.customsComplete,
  stageName: "报关完成",
  deadline: "2026-05-01 23:59",
  fundingImpact: "无资金动作",
  // 任务词表没有完成态：工作已提交、等待链上索引按 submitted 如实呈现。
  status: "submitted",
  addOnKind: "submit_signal",
  addOnManifest: customsExecutorManifest,
  resourceRequirements: customsResourceRequirements,
  performanceSlotId: customsRoleSlotIds.customsExecutor,
  performanceSlotLabel: "报关履约者",
  businessPersonaLabels: ["报关行", "关务服务商"],
  // schema 插件的 requiredEvidence 属于秩序发布面，不随任务 DTO 下发，显式剔除。
  primaryActionLabel: "提交报关完成",
  participantRoleLabel: "报关履约者",
  participantWallet: customsWallets.customsExecutor,
  canSubmit: false,
  responsibilityStatements: [],
  proofRows: [
    { label: "链上事件", value: "SignalSubmitted" },
    { label: "HookReady", value: customsStageIds.customsComplete },
    { label: "Submitter", value: customsWallets.customsExecutor }
  ]
};

export const customsProductCatalog: ProductCatalogDTO = {
  zhixus: [customsZhixuDetail],
  orders: [customsOrder],
  tasks: [customsSelectorTask, customsResourceControllerTask, customsExecutorTask]
};

export const customsOnchainHookPlanArtifact = {
  schemaVersion: "uvp.onchainHookPlan.v3",
  dockInterface: null,
  dockRoutes: [],
  dockRoutesRoot: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  dockInterfaceRoot: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  capabilitiesRoot: "0x2f16cf0c261badeeda287da77effbf45706b26d5f2a0bda19f9285489da9b05e",
  planId: customsPlanIds.planId,
  zhixuId: CUSTOMS_ZHIXU_ID,
  zhixuName: "customs_completion",
  platform: {
    type: "blockchain",
    provider: "eth"
  },
  sourcePlanHash: "0xb53f5c9b4952031d4cfd3117cb453c357ea51edad8920723f64acadc6b26d178",
  compiledHooks: [
    {
      hookId: "0x4625d43b26ce487427096279b6f54b8bf51a479e9ff90e52c0e71bcc0cba42a2",
      stageId: "0xc670b506d61c646291c5d7ad8521d23188993447ada564c84d6be83599107cca",
      stageIdentifier: customsStageIds.buyerPublishCustomsResources,
      hookName: "resource_controller_task_ready",
      kind: "receive",
      orderTriggerKind: "mint",
      emitReady: true,
      instructions: [
        {
          op: "SIGNAL",
          source: "order",
          signalName: "registered",
          sourceId: "0x21c0107378acb490e7190da71596effe409c128f08adcc5467b293f1f3a66431",
          signalId: "0xbe9532cecf48a73f784c5d193f0596e1b631c224802ec00a45840ad110d37000",
          signalKey: "0xae9800a26b8d4a30b264881580350b79eae03733cbcaedc2f84d673af81d83c7"
        }
      ],
      dependencies: [
        {
          kind: "positive",
          source: "order",
          signalName: "registered",
          sourceId: "0x21c0107378acb490e7190da71596effe409c128f08adcc5467b293f1f3a66431",
          signalId: "0xbe9532cecf48a73f784c5d193f0596e1b631c224802ec00a45840ad110d37000",
          signalKey: "0xae9800a26b8d4a30b264881580350b79eae03733cbcaedc2f84d673af81d83c7"
        }
      ],
      routeRef: {
        routeId: "0x9963f771afc5aaa6fabb6af0a7625a6c51011bc02fb39d5d5146ee79440bac3f",
        stageId: "0xc670b506d61c646291c5d7ad8521d23188993447ada564c84d6be83599107cca",
        routeHash: "0x08507123bdafbc8946aba27ab465e524ec48f016fc271024fc305fa133d74324"
      }
    },
    {
      hookId: "0xb433d86c98d77f20be226022a4378e73a8705b394f8e5c434a5f06362f3d2309",
      stageId: "0x301c76d30a738a103f1a948d5edd57e97fa2e17d80ddffff275c32daa56e6047",
      stageIdentifier: customsStageIds.buyerSelectCustomsExecutor,
      hookName: "selector_task_ready",
      kind: "receive",
      orderTriggerKind: "mint",
      emitReady: true,
      instructions: [
        {
          op: "SIGNAL",
          source: "order",
          signalName: "registered",
          sourceId: "0x21c0107378acb490e7190da71596effe409c128f08adcc5467b293f1f3a66431",
          signalId: "0xbe9532cecf48a73f784c5d193f0596e1b631c224802ec00a45840ad110d37000",
          signalKey: "0xae9800a26b8d4a30b264881580350b79eae03733cbcaedc2f84d673af81d83c7"
        }
      ],
      dependencies: [
        {
          kind: "positive",
          source: "order",
          signalName: "registered",
          sourceId: "0x21c0107378acb490e7190da71596effe409c128f08adcc5467b293f1f3a66431",
          signalId: "0xbe9532cecf48a73f784c5d193f0596e1b631c224802ec00a45840ad110d37000",
          signalKey: "0xae9800a26b8d4a30b264881580350b79eae03733cbcaedc2f84d673af81d83c7"
        }
      ],
      routeRef: {
        routeId: "0x169a72a4d6908a7fd8eda5bbabaa54ee05d4de02e40ec40f9cb97f33e60f441a",
        stageId: "0x301c76d30a738a103f1a948d5edd57e97fa2e17d80ddffff275c32daa56e6047",
        routeHash: "0xc07d535cc26a67052cc5f3b89878a45e18816bdc43d3a0d52c7b83bb77a064de"
      }
    },
    {
      hookId: "0xd4132edae6b1386373b5f41f6dbb3f0d4fed0010334fc82af26f8a176584ab8e",
      stageId: "0x447a9daf9645ca8aba6e1de3cb6a4b890bee3339aba2c795a3d25ba43805b70b",
      stageIdentifier: customsStageIds.customsComplete,
      hookName: "customs_ready",
      kind: "receive",
      orderTriggerKind: "mint",
      emitReady: true,
      instructions: [
        {
          op: "SIGNAL",
          source: "buyer",
          signalName: customsSignalIds.executorSelected,
          sourceId: "0x9c1bfc34ea7e295ac684c026c6d4de765734cb6b37fa07330bcfc241743ebbaf",
          signalId: "0xfb0d805fe29ea621f07ef3f01b091cfc965b8e8c0d26adce08a77091c93fbe35",
          signalKey: "0x035281ae069893d2e81fcd219397530de02deff08d6502c4d566e6dd4de7b51f"
        },
        {
          op: "SIGNAL",
          source: "buyer",
          signalName: customsSignalIds.resourcesPublished,
          sourceId: "0x9c1bfc34ea7e295ac684c026c6d4de765734cb6b37fa07330bcfc241743ebbaf",
          signalId: "0x568b5d2b0707e6dfb5616cbaf29ce6fc97b0f720bc5b59a402c4c7dc9ef53465",
          signalKey: "0xfbde4dc6ebe7605fba9485da0533f0fa56527e6134e300d50a86073ec08ca583"
        },
        {
          op: "AND",
          arity: 2
        }
      ],
      dependencies: [
        {
          kind: "positive",
          source: "buyer",
          signalName: customsSignalIds.executorSelected,
          sourceId: "0x9c1bfc34ea7e295ac684c026c6d4de765734cb6b37fa07330bcfc241743ebbaf",
          signalId: "0xfb0d805fe29ea621f07ef3f01b091cfc965b8e8c0d26adce08a77091c93fbe35",
          signalKey: "0x035281ae069893d2e81fcd219397530de02deff08d6502c4d566e6dd4de7b51f"
        },
        {
          kind: "positive",
          source: "buyer",
          signalName: customsSignalIds.resourcesPublished,
          sourceId: "0x9c1bfc34ea7e295ac684c026c6d4de765734cb6b37fa07330bcfc241743ebbaf",
          signalId: "0x568b5d2b0707e6dfb5616cbaf29ce6fc97b0f720bc5b59a402c4c7dc9ef53465",
          signalKey: "0xfbde4dc6ebe7605fba9485da0533f0fa56527e6134e300d50a86073ec08ca583"
        }
      ]
    }
  ],
  dependencyIndex: {
    "0x035281ae069893d2e81fcd219397530de02deff08d6502c4d566e6dd4de7b51f": [
      "0xd4132edae6b1386373b5f41f6dbb3f0d4fed0010334fc82af26f8a176584ab8e"
    ],
    "0xae9800a26b8d4a30b264881580350b79eae03733cbcaedc2f84d673af81d83c7": [
      "0x4625d43b26ce487427096279b6f54b8bf51a479e9ff90e52c0e71bcc0cba42a2",
      "0xb433d86c98d77f20be226022a4378e73a8705b394f8e5c434a5f06362f3d2309"
    ],
    "0xfbde4dc6ebe7605fba9485da0533f0fa56527e6134e300d50a86073ec08ca583": [
      "0xd4132edae6b1386373b5f41f6dbb3f0d4fed0010334fc82af26f8a176584ab8e"
    ]
  },
  executorRoutes: [
    { routeId: "0x9963f771afc5aaa6fabb6af0a7625a6c51011bc02fb39d5d5146ee79440bac3f", stageId: "0xc670b506d61c646291c5d7ad8521d23188993447ada564c84d6be83599107cca", stageIdentifier: customsStageIds.buyerPublishCustomsResources, executorType: "individual", executorId: "buyer", executorHash: "0xceba0f926893649fbdd5053bfd8e95f239a18892e2ee25e3f76562a3413e1e3b", resourcesHash: "0x069184494e0d2f806cee049270bee7ff504cb08daad1a83acc37ea2ca46b930a", routeHash: "0x08507123bdafbc8946aba27ab465e524ec48f016fc271024fc305fa133d74324" },
    { routeId: "0x169a72a4d6908a7fd8eda5bbabaa54ee05d4de02e40ec40f9cb97f33e60f441a", stageId: "0x301c76d30a738a103f1a948d5edd57e97fa2e17d80ddffff275c32daa56e6047", stageIdentifier: customsStageIds.buyerSelectCustomsExecutor, executorType: "individual", executorId: "buyer", executorHash: "0xecab016c59a79e17b59b3ff9a3c5e1caffecbbd4faa7220e245995b712499bbd", resourcesHash: "0x7dbcba468a4a1d997d8401f76d6d5ac8baca6007bffdba640e069955998e94f1", routeHash: "0xc07d535cc26a67052cc5f3b89878a45e18816bdc43d3a0d52c7b83bb77a064de" },
    // customs-complete 是 mint 出生阶段：静态执行者路由是编译接受域的一部分，
    // 买家选择流由 selectorBindings 承载，不豁免出生阶段的静态投递目标。
    { routeId: "0x36f5f268072014b46587ef9953f56de2d7459fa7dba87191d8f860e8565181b9", stageId: "0x447a9daf9645ca8aba6e1de3cb6a4b890bee3339aba2c795a3d25ba43805b70b", stageIdentifier: customsStageIds.customsComplete, executorType: "individual", executorId: "customs", executorHash: "0x515aa3f55b378f1b452f1d57ef224bdd1a2a5a3230475831f33f9cde86433fdc", resourcesHash: "0x0000000000000000000000000000000000000000000000000000000000000000", routeHash: "0xd1b9964460d47933bea2262afbb1ccbf2f206c867790ccd480f0278268ca57a8" }
  ],
  selectorBindings: [
    {
      selectorStageIdentifier: customsStageIds.buyerSelectCustomsExecutor,
      targetStageIdentifier: customsStageIds.customsComplete,
      selectorStageId: "0x301c76d30a738a103f1a948d5edd57e97fa2e17d80ddffff275c32daa56e6047",
      targetStageId: "0x447a9daf9645ca8aba6e1de3cb6a4b890bee3339aba2c795a3d25ba43805b70b",
      bindingHash: "0x8b75cde323adb3d01db51594d16640f1d0610cecd73716fec05d2a05f4d9936f"
    },
    {
      selectorStageIdentifier: customsStageIds.buyerPublishCustomsResources,
      targetStageIdentifier: customsStageIds.customsComplete,
      selectorStageId: "0xc670b506d61c646291c5d7ad8521d23188993447ada564c84d6be83599107cca",
      targetStageId: "0x447a9daf9645ca8aba6e1de3cb6a4b890bee3339aba2c795a3d25ba43805b70b",
      bindingHash: "0x6b6b2c0e1c5c37b978ae6fdbe08ec02aefbb40d213b250cbed9de70f1c4238c8"
    }
  ],
  signalCapabilities: [
    {
      stageIdentifier: customsStageIds.customsComplete,
      stageId: "0x447a9daf9645ca8aba6e1de3cb6a4b890bee3339aba2c795a3d25ba43805b70b",
      source: "customs",
      declaredSignal: "confirm_stage",
      targetSource: "customs",
      targetSourceId: "0xd56a74df2cd5218f4334606e19d522559a6b3fff0a4f100cfed8e95625bcf044",
      targetSignalName: customsSignalIds.customsCompleteConfirmed,
      signalId: "0xeb1df74206213a42503a69c7fb4c25b115de571541bdac6fdf1dc73af51409d0",
      targetOrderRelation: "current",
      capabilityHash: "0x5172f51040252f8548e24e94dbed408e1d458f0552d89e72f6bdd36bdb5d1bc1"
    }
  ],
  admissions: [],
  // 执行者候选集（UB-36②③）：customs 演示域不开逐单换人面——空集 root =
  // EMPTY_MERKLE_ROOT，逐单 executor patch 对本计划恒拒（fail-closed）。
  executorCandidates: [],
  executorCandidatesRoot: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  // 制品自身 planHash 字段是 canonical payload hash——与发布面
  // customsPlanIds.artifactHash 同值（发布面 planHash 是链 runtime hash，
  // 两个字段名的口径差是链 getter 命名权威与发布面命名的有意分工）。
  planHash: customsPlanIds.artifactHash
} as const;

export const customsStoreProductSchema: StoreProductSchemaDTO = {
  schemaVersion: "store-product-schema.v1",
  version: 1,
  zhixuId: CUSTOMS_ZHIXU_ID,
  title: customsZhixuDetail.title,
  maintainer: customsZhixuDetail.maintainer,
  planId: customsPlanIds.planId,
  planHash: customsPlanIds.planHash,
  artifactHash: customsPlanIds.artifactHash,
  onchainHookPlanArtifact: customsOnchainHookPlanArtifact,
  roleSlots: customsRoleSlots,
  businessPersonaLabels: ["买家", "报关行", "关务服务商"],
  stages: customsStages,
  selectorBindings: customsOnchainHookPlanArtifact.selectorBindings,
  schemaHash: "0x5531c267b8dd1cc3c511faf0c8056625f9adfd2beea25d18949e9e5889e1b1be",
  validation: {
    ok: true,
    status: "explicit",
    issues: []
  },
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z"
};
