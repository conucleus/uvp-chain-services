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
export const STAGE_ZHIXU_ID = "zx-dbfac16c36b253ae56bc322280a3a66d";
export const EXAMPLE_ORDER_ID = "order-example-001";

export const exampleStageIds = {
  buyerSelectExampleExecutor: "buyer.select-example-executor",
  buyerPublishExampleResources: "buyer.publish-example-resources",
  exampleComplete: "example-complete"
} as const;

export const exampleRoleSlotIds = {
  buyerSelector: "buyer-selector",
  buyerResourceController: "buyer-resource-controller",
  exampleExecutor: "example-executor"
} as const;

export const exampleActionIds = {
  applyExecutorPatch: "buyer-selector.apply-executor-patch",
  applyResourcePatch: "buyer-resource-controller.apply-resource-patch",
  submitExampleComplete: "example-executor.submit-example-complete"
} as const;

export const exampleResourceKeys = {
  exampleDeclarationPdf: "example_declaration_pdf"
} as const;

export const exampleSignalIds = {
  orderRegistered: "registered",
  executorSelected: "buyer.select-example-executor.executor_selected",
  resourcesPublished: "buyer.publish-example-resources.resources_published",
  exampleCompleteConfirmed: "example-complete.confirm_stage"
} as const;

export const exampleInitialTriggerSource = "order";

export const exampleWallets = {
  buyer: "0x1111111111111111111111111111111111111111",
  exampleExecutor: "0x2222222222222222222222222222222222222222"
} as const;

export const stagePlanIds = {
  // 三值按公式同批复算钉住（planId 变更会改写 canonical payload 哈希）：
  // planId = planIdOf(zhixuId, zhixuName, platform)；planHash = 链 runtime
  // hash（PlanCommit 注册哈希，与链上 planHash(planId) getter 同名同值）；
  // artifactHash = 制品 canonical payload hash（hashOnchainPlanPayload）。
  planId: "0xc17ec525b4686fa302e21811ed15c1f7888d9ee1313665393defc396b7702519",
  planHash: "0xa990f484cc8b97561f6dd6adddd978a09976b24100b439e6debba3c18615935a",
  artifactHash: "0xd0c73aff30c51014acdc04f1fc89458884aa5ae0d8e3766a9cc181cf5393765a"
} as const;

export const exampleResourceManifest: ProductResourceManifestDTO = {
  schemaVersion: "uvp-resource-manifest-v1",
  orderId: EXAMPLE_ORDER_ID,
  targetStageId: exampleStageIds.exampleComplete,
  resourceKey: exampleResourceKeys.exampleDeclarationPdf,
  visibility: "protected",
  manifestURI: "uvp-resource://example/example-declaration-pdf/v1",
  manifestHash: "0xdac56fa990b9253da7a5773a657adbe3d170f1b428169858b3f2545b2d562405",
  policyHash: "0xc7ff3c7a9a1d12181aba887281be556416beedb1e600e132e57e1cfddf78e490",
  ciphertextHash: "0x3cf67bf9b98b52d4ba6c00f6d26f0541098fca706ff68707a7c59c7284dd64b5",
  storageCID: "bafyuvpexampledeclarationpdfciphertext",
  recipientEnvelopeRoot: "0xf4d441f65f7ef2b91f664d4bd0c14c980f35e5f0e5f481f678d5f7e59a43d071",
  createdBy: exampleWallets.buyer,
  createdAt: "2026-05-01T00:00:00.000Z"
};

const exampleResourcePolicy: ProductResourceAccessPolicyDTO = {
  visibility: "protected",
  readers: [
    { kind: "role", label: "买家", value: exampleRoleSlotIds.buyerResourceController },
    { kind: "role", label: "示例单据履约者", value: exampleRoleSlotIds.exampleExecutor }
  ],
  writers: [
    { kind: "role", label: "买家资源请求方", value: exampleRoleSlotIds.buyerResourceController }
  ],
  controllers: [
    { kind: "wallet", label: "买家钱包", value: exampleWallets.buyer }
  ],
  policyHash: exampleResourceManifest.policyHash
};

export const exampleResourceRequirements: readonly ProductResourceRequirementDTO[] = [
  {
    resourceId: "example-declaration-pdf",
    resourceKey: exampleResourceKeys.exampleDeclarationPdf,
    label: "示例单据单 PDF",
    required: true,
    source: "resource_patch",
    resourceType: "document",
    visibility: "protected",
    sourceStageId: exampleStageIds.exampleComplete,
    description: "示例单据单以加密内容寻址清单和指纹形式提供，文件原文不写入链上。",
    manifestURI: exampleResourceManifest.manifestURI,
    manifestHash: exampleResourceManifest.manifestHash,
    manifest: exampleResourceManifest,
    accessPolicy: exampleResourcePolicy,
    accessStatus: {
      state: "available",
      label: "授权参与方可核对资源清单",
      canRead: true,
      canWrite: true,
      canControl: true
    },
    proofRows: [
      { label: "链上事件", value: "StageResourcePatchApplied" },
      { label: "Resource Key", value: exampleResourceKeys.exampleDeclarationPdf },
      { label: "Manifest Hash", value: exampleResourceManifest.manifestHash },
      { label: "Policy Hash", value: exampleResourceManifest.policyHash }
    ]
  }
];

export const exampleStages: readonly ZhixuStageDTO[] = [
  {
    stageId: exampleStageIds.buyerSelectExampleExecutor,
    index: 1,
    name: "选择示例单据履约者",
    evidence: ["履约者元数据指纹"],
    ownerRole: "买家",
    status: "done",
    updatedAt: "2026-05-01T00:05:00.000Z",
    stageKind: "control",
    executorAssignment: "static",
    staticExecutorRoleSlotId: exampleRoleSlotIds.buyerSelector,
    selectedStageTargets: [exampleStageIds.exampleComplete],
    addOnKind: "stage_executor_patch"
  },
  {
    stageId: exampleStageIds.buyerPublishExampleResources,
    index: 2,
    name: "发布示例单据资源清单",
    evidence: ["资源清单 URI", "资源清单指纹", "访问策略指纹"],
    ownerRole: "买家",
    status: "done",
    updatedAt: "2026-05-01T00:08:00.000Z",
    stageKind: "control",
    executorAssignment: "static",
    staticExecutorRoleSlotId: exampleRoleSlotIds.buyerResourceController,
    selectedStageTargets: [exampleStageIds.exampleComplete],
    addOnKind: "stage_resource_patch",
    resourceRequirements: exampleResourceRequirements
  },
  {
    stageId: exampleStageIds.exampleComplete,
    index: 3,
    name: "示例单据完成",
    evidence: ["示例单据完成凭证引用", "示例单据单 PDF 资源清单"],
    ownerRole: "示例单据履约者",
    status: "done",
    updatedAt: "2026-05-01T00:20:00.000Z",
    stageKind: "business",
  }
]

export const exampleBuyerSelectorManifest: ParticipantAddOnManifestDTO = {
  schemaVersion: "participant-addon-manifest.v1",
  manifestId: "example:buyer-selector:v1",
  roleSlotId: exampleRoleSlotIds.buyerSelector,
  addOnKind: "stage_executor_patch",
  title: "选择示例单据履约者",
  summary: "为示例单据完成阶段指定可提交完成信号的钱包。",
  stageBindings: [exampleStageIds.exampleComplete],
  pages: [
    {
      pageId: "executor-selection",
      title: "履约者选择",
      sections: [
        {
          sectionId: "executor-patch",
          title: "选择设置",
          components: [
            { componentId: "target-stage", componentKind: "stage_select", inputId: "buyerSelector.targetStageId", label: "目标阶段", required: true, defaultValue: exampleStageIds.exampleComplete },
            { componentId: "mode", componentKind: "select", inputId: "buyerSelector.mode", label: "补丁模式", required: true, defaultValue: "assign", options: [{ value: "assign", label: "指定履约者" }] },
            { componentId: "selector-wallet", componentKind: "wallet", inputId: "buyerSelector.selectorWallet", label: "买家钱包", required: true, defaultValue: exampleWallets.buyer },
            { componentId: "executor-wallet", componentKind: "wallet", inputId: "buyerSelector.executorWallet", label: "示例单据履约者钱包", required: true, defaultValue: exampleWallets.exampleExecutor },
            { componentId: "executor-metadata-hash", componentKind: "hash", inputId: "buyerSelector.executorMetadataHash", label: "履约者元数据指纹", required: true, defaultValue: "0x7e702e1a2c4cb9b7f56fbac26f9efe34345de47460f2dd05d7462e9117ac5fd2" },
            { componentId: "metadata-uri", componentKind: "uri", inputId: "buyerSelector.metadataURI", label: "履约者元数据 URI", required: true, defaultValue: "uvp-resource://example/example-executor-metadata/v1" },
            { componentId: "executor-reference", componentKind: "text", inputId: "buyerSelector.executorReference", label: "履约者参考" },
            { componentId: "proof", componentKind: "proof_rows", label: "证明" }
          ]
        }
      ]
    }
  ],
  actions: [
    {
      actionId: exampleActionIds.applyExecutorPatch,
      actionKind: "stage_executor_patch",
      label: "选择示例单据履约者",
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

export const exampleBuyerResourceControllerManifest: ParticipantAddOnManifestDTO = {
  schemaVersion: "participant-addon-manifest.v1",
  manifestId: "example:buyer-resource-controller:v1",
  roleSlotId: exampleRoleSlotIds.buyerResourceController,
  addOnKind: "stage_resource_patch",
  title: "发布示例单据资源清单",
  summary: "为示例单据完成阶段发布内容寻址的资源清单和访问策略指纹。",
  stageBindings: [exampleStageIds.exampleComplete],
  pages: [
    {
      pageId: "resource-manifest",
      title: "资源清单",
      sections: [
        {
          sectionId: "resource-patch",
          title: "资源补丁",
          components: [
            { componentId: "selector-wallet", componentKind: "wallet", inputId: "buyerResourceController.selectorWallet", label: "买家钱包", required: true, defaultValue: exampleWallets.buyer },
            { componentId: "target-stage", componentKind: "stage_select", inputId: "buyerResourceController.targetStageId", label: "目标阶段", required: true, defaultValue: exampleStageIds.exampleComplete },
            { componentId: "resource-key", componentKind: "text", inputId: "buyerResourceController.resourceKey", label: "资源键", required: true, defaultValue: exampleResourceKeys.exampleDeclarationPdf },
            { componentId: "manifest-uri", componentKind: "uri", inputId: "buyerResourceController.manifestURI", label: "资源清单 URI", required: true, defaultValue: exampleResourceManifest.manifestURI },
            { componentId: "manifest-hash", componentKind: "hash", inputId: "buyerResourceController.manifestHash", label: "资源清单指纹", required: true, defaultValue: exampleResourceManifest.manifestHash },
            { componentId: "policy-hash", componentKind: "hash", inputId: "buyerResourceController.policyHash", label: "访问策略指纹", required: true, defaultValue: exampleResourceManifest.policyHash },
            { componentId: "requirements", componentKind: "resource_requirements", label: "资源要求" },
            { componentId: "proof", componentKind: "proof_rows", label: "证明" }
          ]
        }
      ]
    }
  ],
  actions: [
    {
      actionId: exampleActionIds.applyResourcePatch,
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

export const exampleExecutorManifest: ParticipantAddOnManifestDTO = {
  schemaVersion: "participant-addon-manifest.v1",
  manifestId: "example:example-executor:v1",
  roleSlotId: exampleRoleSlotIds.exampleExecutor,
  addOnKind: "submit_signal",
  title: "提交示例单据完成",
  summary: "被选中的示例单据履约者提交示例单据完成信号和凭证引用。",
  stageBindings: [exampleStageIds.exampleComplete],
  pages: [
    {
      pageId: "example-complete",
      title: "示例单据完成",
      sections: [
        {
          sectionId: "executor-signal",
          title: "完成提交",
          components: [
            { componentId: "wallet", componentKind: "wallet", inputId: "exampleExecutor.walletAddress", label: "示例单据履约者钱包", required: true, defaultValue: exampleWallets.exampleExecutor },
            { componentId: "requirements", componentKind: "resource_requirements", label: "资源要求" },
            { componentId: "evidence", componentKind: "evidence_refs", inputId: "exampleExecutor.evidenceIds", label: "凭证引用", required: true },
            { componentId: "confirmation", componentKind: "confirmation", inputId: "exampleExecutor.confirmation", label: "确认示例单据已完成", required: true },
            { componentId: "proof", componentKind: "proof_rows", label: "证明" }
          ]
        }
      ]
    }
  ],
  actions: [
    {
      actionId: exampleActionIds.submitExampleComplete,
      actionKind: "submit_signal",
      label: "提交示例单据完成",
      primary: true,
      intent: "confirm_stage",
      inputBindings: {
        walletAddress: "exampleExecutor.walletAddress",
        evidenceIds: "exampleExecutor.evidenceIds",
        confirmation: "exampleExecutor.confirmation"
      }
    }
  ]
};

export const exampleRoleSlots: readonly RoleSlotDTO[] = [
  {
    slotId: exampleRoleSlotIds.buyerSelector,
    title: "买家选择方",
    label: "买家",
    duty: "选择示例单据履约者并签名提交执行者补丁。",
    evidence: ["履约者元数据指纹"],
    status: "required",
    tone: "info",
    required: true,
    performanceSlotLabel: "买家选择方",
    businessPersonaLabels: ["买家"],
    addOnManifest: exampleBuyerSelectorManifest
  },
  {
    slotId: exampleRoleSlotIds.buyerResourceController,
    title: "买家资源请求方",
    label: "买家",
    duty: "发布示例单据资源清单和访问策略指纹。",
    evidence: ["资源清单指纹", "访问策略指纹"],
    status: "required",
    tone: "info",
    required: true,
    performanceSlotLabel: "买家资源请求方",
    businessPersonaLabels: ["买家"],
    addOnManifest: exampleBuyerResourceControllerManifest
  },
  {
    slotId: exampleRoleSlotIds.exampleExecutor,
    title: "示例单据履约者",
    label: "示例单据行",
    duty: "读取授权资源清单并提交示例单据完成信号。",
    evidence: ["示例单据完成凭证引用", "示例单据单 PDF 资源清单"],
    status: "required",
    tone: "warn",
    required: true,
    performanceSlotLabel: "示例单据履约者",
    businessPersonaLabels: ["示例单据行", "关务服务商"],
    addOnManifest: exampleExecutorManifest
  }
];

export const exampleZhixuDetail: ZhixuDetailDTO = {
  zhixuId: STAGE_ZHIXU_ID,
  title: "示例单据完成秩序",
  subtitle: "买家选择示例单据履约者、发布资源清单，示例单据履约者提交链上完成信号。",
  reviewStatus: "approved",
  reviewLabel: "Example fixture",
  riskLevel: "测试闭环",
  applicableBusiness: ["跨境示例单据", "示例流程单证"],
  excludedBusiness: ["文件原文上链", "未授权履约者代签"],
  stageCount: exampleStages.length,
  roleSlotCount: exampleRoleSlots.length,
  supportedPaymentMethods: ["无资金动作"],
  maintainer: "共同秩序",
  updatedAt: "2026-05-01",
  planPublication: {
    status: "not_found",
    label: "等待 Plan 发布",
    stateMachineLabel: "UVPStateMachine",
    planId: stagePlanIds.planId,
    planHash: stagePlanIds.planHash,
    artifactHash: stagePlanIds.artifactHash
  },
  roleSlots: exampleRoleSlots,
  dockableModules: [],
  stages: exampleStages,
  proofRows: [
    { label: "Plan ID", value: stagePlanIds.planId },
    { label: "Plan Hash", value: stagePlanIds.planHash },
    { label: "Selector Binding", value: `${exampleStageIds.buyerSelectExampleExecutor}->${exampleStageIds.exampleComplete}` },
    { label: "Resource Key", value: exampleResourceKeys.exampleDeclarationPdf }
  ],
  createOrderHint: "创建订单时预授权买家控制动作和已知示例单据履约者的完成信号。"
};

const exampleParticipants: readonly ParticipantDTO[] = [
  {
    participantId: "buyer",
    role: "买家",
    duty: "选择示例单据履约者并发布资源清单",
    evidence: ["履约者元数据指纹", "资源清单指纹"],
    status: "joined",
    tone: "ok",
    addOnKind: "stage_executor_patch"
  },
  {
    participantId: "example-executor",
    role: "示例单据履约者",
    duty: "提交示例单据完成信号",
    evidence: ["示例单据完成凭证引用"],
    status: "joined",
    tone: "ok",
    addOnKind: "submit_signal"
  }
];

export const exampleOrder: ProductOrderDTO = {
  orderId: EXAMPLE_ORDER_ID,
  zhixuId: STAGE_ZHIXU_ID,
  title: "示例单据闭环订单",
  status: "registered",
  statusLabel: "示例单据完成",
  totalAmount: {
    amount: "0",
    currency: "USDC",
    display: "0 USDC"
  },
  fundingStatus: "无资金动作",
  currentStageId: exampleStageIds.exampleComplete,
  currentStageName: "示例单据完成",
  currentTaskId: "task-example-executor",
  currentTaskTitle: "示例单据完成信号已提交",
  currentTaskSummary: "选择履约者、资源清单发布、示例单据完成三个动作均已有链上证明。",
  stages: exampleStages,
  resourceRequirements: {
    [exampleStageIds.exampleComplete]: exampleResourceRequirements
  },
  participants: exampleParticipants,
  recentEvents: [
    { eventId: "evt-example-executor", text: "StageExecutorActivated example-complete", time: "2026-05-01T00:05:00.000Z" },
    { eventId: "evt-example-resource", text: "StageResourcePatchApplied example_declaration_pdf", time: "2026-05-01T00:08:00.000Z" },
    { eventId: "evt-example-signal", text: "SignalSubmitted example-complete.confirm_stage", time: "2026-05-01T00:20:00.000Z" }
  ],
  proofRows: [
    { label: "Executor Event", value: "StageExecutorActivated" },
    { label: "Resource Event", value: "StageResourcePatchApplied" },
    { label: "Signal Event", value: "SignalSubmitted" },
    { label: "Active Executor", value: exampleWallets.exampleExecutor }
  ]
};

export const exampleSelectorTask: ProductTaskDTO = {
  taskId: "task-example-buyer-selector",
  orderId: EXAMPLE_ORDER_ID,
  orderTitle: exampleOrder.title,
  zhixuId: STAGE_ZHIXU_ID,
  title: "选择示例单据履约者",
  subtitle: "买家签名指定示例单据完成阶段的履约者钱包。",
  assigneeRole: "买家",
  assigneeWallet: exampleWallets.buyer,
  stageId: exampleStageIds.buyerSelectExampleExecutor,
  stageName: "选择示例单据履约者",
  deadline: "2026-05-01 23:59",
  fundingImpact: "无资金动作",
  // 任务词表没有完成态：工作已提交、等待链上索引按 submitted 如实呈现。
  status: "submitted",
  addOnKind: "stage_executor_patch",
  addOnManifest: exampleBuyerSelectorManifest,
  primaryActionLabel: "选择示例单据履约者",
  participantRoleLabel: "买家",
  participantWallet: exampleWallets.buyer,
  canSubmit: false,
  responsibilityStatements: [],
  proofRows: [
    { label: "链上事件", value: "StageExecutorActivated" },
    { label: "Target Stage", value: exampleStageIds.exampleComplete },
    { label: "Executor", value: exampleWallets.exampleExecutor }
  ]
};

export const exampleResourceControllerTask: ProductTaskDTO = {
  taskId: "task-example-buyer-resource-controller",
  orderId: EXAMPLE_ORDER_ID,
  orderTitle: exampleOrder.title,
  zhixuId: STAGE_ZHIXU_ID,
  title: "发布示例单据资源清单",
  subtitle: "买家签名发布示例单据单 PDF 的内容寻址清单和访问策略指纹。",
  assigneeRole: "买家",
  assigneeWallet: exampleWallets.buyer,
  stageId: exampleStageIds.buyerPublishExampleResources,
  stageName: "发布示例单据资源清单",
  deadline: "2026-05-01 23:59",
  fundingImpact: "无资金动作",
  // 任务词表没有完成态：工作已提交、等待链上索引按 submitted 如实呈现。
  status: "submitted",
  addOnKind: "stage_resource_patch",
  addOnManifest: exampleBuyerResourceControllerManifest,
  resourceRequirements: exampleResourceRequirements,
  primaryActionLabel: "发布资源清单",
  participantRoleLabel: "买家",
  participantWallet: exampleWallets.buyer,
  canSubmit: false,
  responsibilityStatements: [],
  proofRows: [
    { label: "链上事件", value: "StageResourcePatchApplied" },
    { label: "Manifest Hash", value: exampleResourceManifest.manifestHash },
    { label: "Policy Hash", value: exampleResourceManifest.policyHash }
  ]
};

export const exampleExecutorTask: ProductTaskDTO = {
  taskId: "task-example-executor",
  orderId: EXAMPLE_ORDER_ID,
  orderTitle: exampleOrder.title,
  zhixuId: STAGE_ZHIXU_ID,
  title: "提交示例单据完成",
  subtitle: "示例单据履约者提交完成信号和凭证引用。",
  assigneeRole: "示例单据履约者",
  assigneeWallet: exampleWallets.exampleExecutor,
  stageId: exampleStageIds.exampleComplete,
  stageName: "示例单据完成",
  deadline: "2026-05-01 23:59",
  fundingImpact: "无资金动作",
  // 任务词表没有完成态：工作已提交、等待链上索引按 submitted 如实呈现。
  status: "submitted",
  addOnKind: "submit_signal",
  addOnManifest: exampleExecutorManifest,
  resourceRequirements: exampleResourceRequirements,
  performanceSlotId: exampleRoleSlotIds.exampleExecutor,
  performanceSlotLabel: "示例单据履约者",
  businessPersonaLabels: ["示例单据行", "关务服务商"],
  // schema 插件的 requiredEvidence 属于秩序发布面，不随任务 DTO 下发，显式剔除。
  primaryActionLabel: "提交示例单据完成",
  participantRoleLabel: "示例单据履约者",
  participantWallet: exampleWallets.exampleExecutor,
  canSubmit: false,
  responsibilityStatements: [],
  proofRows: [
    { label: "链上事件", value: "SignalSubmitted" },
    { label: "HookReady", value: exampleStageIds.exampleComplete },
    { label: "Submitter", value: exampleWallets.exampleExecutor }
  ]
};

export const exampleProductCatalog: ProductCatalogDTO = {
  zhixus: [exampleZhixuDetail],
  orders: [exampleOrder],
  tasks: [exampleSelectorTask, exampleResourceControllerTask, exampleExecutorTask]
};

export const exampleOnchainHookPlanArtifact = {
  schemaVersion: "uvp.onchainHookPlan.v3",
  dockInterface: null,
  dockRoutes: [],
  dockRoutesRoot: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  dockInterfaceRoot: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  capabilitiesRoot: "0x2f16cf0c261badeeda287da77effbf45706b26d5f2a0bda19f9285489da9b05e",
  planId: stagePlanIds.planId,
  zhixuId: STAGE_ZHIXU_ID,
  zhixuName: "example_completion",
  platform: {
    type: "blockchain",
    provider: "eth"
  },
  sourcePlanHash: "0xb53f5c9b4952031d4cfd3117cb453c357ea51edad8920723f64acadc6b26d178",
  compiledHooks: [
    {
      hookId: "0x4625d43b26ce487427096279b6f54b8bf51a479e9ff90e52c0e71bcc0cba42a2",
      stageId: "0xc670b506d61c646291c5d7ad8521d23188993447ada564c84d6be83599107cca",
      stageIdentifier: exampleStageIds.buyerPublishExampleResources,
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
      stageIdentifier: exampleStageIds.buyerSelectExampleExecutor,
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
      stageIdentifier: exampleStageIds.exampleComplete,
      hookName: "example_ready",
      kind: "receive",
      orderTriggerKind: "mint",
      emitReady: true,
      instructions: [
        {
          op: "SIGNAL",
          source: "buyer",
          signalName: exampleSignalIds.executorSelected,
          sourceId: "0x9c1bfc34ea7e295ac684c026c6d4de765734cb6b37fa07330bcfc241743ebbaf",
          signalId: "0xfb0d805fe29ea621f07ef3f01b091cfc965b8e8c0d26adce08a77091c93fbe35",
          signalKey: "0x035281ae069893d2e81fcd219397530de02deff08d6502c4d566e6dd4de7b51f"
        },
        {
          op: "SIGNAL",
          source: "buyer",
          signalName: exampleSignalIds.resourcesPublished,
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
          signalName: exampleSignalIds.executorSelected,
          sourceId: "0x9c1bfc34ea7e295ac684c026c6d4de765734cb6b37fa07330bcfc241743ebbaf",
          signalId: "0xfb0d805fe29ea621f07ef3f01b091cfc965b8e8c0d26adce08a77091c93fbe35",
          signalKey: "0x035281ae069893d2e81fcd219397530de02deff08d6502c4d566e6dd4de7b51f"
        },
        {
          kind: "positive",
          source: "buyer",
          signalName: exampleSignalIds.resourcesPublished,
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
    { routeId: "0x9963f771afc5aaa6fabb6af0a7625a6c51011bc02fb39d5d5146ee79440bac3f", stageId: "0xc670b506d61c646291c5d7ad8521d23188993447ada564c84d6be83599107cca", stageIdentifier: exampleStageIds.buyerPublishExampleResources, executorType: "individual", executorId: "buyer", executorHash: "0xceba0f926893649fbdd5053bfd8e95f239a18892e2ee25e3f76562a3413e1e3b", resourcesHash: "0x069184494e0d2f806cee049270bee7ff504cb08daad1a83acc37ea2ca46b930a", routeHash: "0x08507123bdafbc8946aba27ab465e524ec48f016fc271024fc305fa133d74324" },
    { routeId: "0x169a72a4d6908a7fd8eda5bbabaa54ee05d4de02e40ec40f9cb97f33e60f441a", stageId: "0x301c76d30a738a103f1a948d5edd57e97fa2e17d80ddffff275c32daa56e6047", stageIdentifier: exampleStageIds.buyerSelectExampleExecutor, executorType: "individual", executorId: "buyer", executorHash: "0xecab016c59a79e17b59b3ff9a3c5e1caffecbbd4faa7220e245995b712499bbd", resourcesHash: "0x7dbcba468a4a1d997d8401f76d6d5ac8baca6007bffdba640e069955998e94f1", routeHash: "0xc07d535cc26a67052cc5f3b89878a45e18816bdc43d3a0d52c7b83bb77a064de" },
    // example-complete 是 mint 出生阶段：静态执行者路由是编译接受域的一部分，
    // 买家选择流由 selectorBindings 承载，不豁免出生阶段的静态投递目标。
    { routeId: "0x36f5f268072014b46587ef9953f56de2d7459fa7dba87191d8f860e8565181b9", stageId: "0x447a9daf9645ca8aba6e1de3cb6a4b890bee3339aba2c795a3d25ba43805b70b", stageIdentifier: exampleStageIds.exampleComplete, executorType: "individual", executorId: "example", executorHash: "0x515aa3f55b378f1b452f1d57ef224bdd1a2a5a3230475831f33f9cde86433fdc", resourcesHash: "0x0000000000000000000000000000000000000000000000000000000000000000", routeHash: "0xd1b9964460d47933bea2262afbb1ccbf2f206c867790ccd480f0278268ca57a8" }
  ],
  selectorBindings: [
    {
      selectorStageIdentifier: exampleStageIds.buyerSelectExampleExecutor,
      targetStageIdentifier: exampleStageIds.exampleComplete,
      selectorStageId: "0x301c76d30a738a103f1a948d5edd57e97fa2e17d80ddffff275c32daa56e6047",
      targetStageId: "0x447a9daf9645ca8aba6e1de3cb6a4b890bee3339aba2c795a3d25ba43805b70b",
      bindingHash: "0x8b75cde323adb3d01db51594d16640f1d0610cecd73716fec05d2a05f4d9936f"
    },
    {
      selectorStageIdentifier: exampleStageIds.buyerPublishExampleResources,
      targetStageIdentifier: exampleStageIds.exampleComplete,
      selectorStageId: "0xc670b506d61c646291c5d7ad8521d23188993447ada564c84d6be83599107cca",
      targetStageId: "0x447a9daf9645ca8aba6e1de3cb6a4b890bee3339aba2c795a3d25ba43805b70b",
      bindingHash: "0x6b6b2c0e1c5c37b978ae6fdbe08ec02aefbb40d213b250cbed9de70f1c4238c8"
    }
  ],
  signalCapabilities: [
    {
      stageIdentifier: exampleStageIds.exampleComplete,
      stageId: "0x447a9daf9645ca8aba6e1de3cb6a4b890bee3339aba2c795a3d25ba43805b70b",
      source: "example",
      declaredSignal: "confirm_stage",
      targetSource: "example",
      targetSourceId: "0xd56a74df2cd5218f4334606e19d522559a6b3fff0a4f100cfed8e95625bcf044",
      targetSignalName: exampleSignalIds.exampleCompleteConfirmed,
      signalId: "0xeb1df74206213a42503a69c7fb4c25b115de571541bdac6fdf1dc73af51409d0",
      targetOrderRelation: "current",
      capabilityHash: "0x5172f51040252f8548e24e94dbed408e1d458f0552d89e72f6bdd36bdb5d1bc1"
    }
  ],
  admissions: [],
  // 执行者候选集（UB-36②③）：example 演示域不开逐单换人面——空集 root =
  // EMPTY_MERKLE_ROOT，逐单 executor patch 对本计划恒拒（fail-closed）。
  executorCandidates: [],
  executorCandidatesRoot: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  // 制品自身 planHash 字段是 canonical payload hash——与发布面
  // stagePlanIds.artifactHash 同值（发布面 planHash 是链 runtime hash，
  // 两个字段名的口径差是链 getter 命名权威与发布面命名的有意分工）。
  planHash: stagePlanIds.artifactHash
} as const;

export const exampleStoreProductSchema: StoreProductSchemaDTO = {
  schemaVersion: "store-product-schema.v1",
  version: 1,
  zhixuId: STAGE_ZHIXU_ID,
  title: exampleZhixuDetail.title,
  maintainer: exampleZhixuDetail.maintainer,
  planId: stagePlanIds.planId,
  planHash: stagePlanIds.planHash,
  artifactHash: stagePlanIds.artifactHash,
  onchainHookPlanArtifact: exampleOnchainHookPlanArtifact,
  roleSlots: exampleRoleSlots,
  businessPersonaLabels: ["买家", "示例单据行", "关务服务商"],
  stages: exampleStages,
  selectorBindings: exampleOnchainHookPlanArtifact.selectorBindings,
  schemaHash: "0x5531c267b8dd1cc3c511faf0c8056625f9adfd2beea25d18949e9e5889e1b1be",
  validation: {
    ok: true,
    status: "explicit",
    issues: []
  },
  createdAt: "2026-05-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z"
};
