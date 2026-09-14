import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { UVP_STATE_MACHINE_ARTIFACT_ABI } from '@uvp-eth/protocol-bindings';

import { classifyStateMachineBroadcastError } from '../src/submissions/broadcast-adapter.js';
import {
  classifyStagePatchBroadcastError,
  STAGE_EXECUTOR_PATCH_BROADCAST_LABELS,
  STAGE_RESOURCE_PATCH_BROADCAST_LABELS
} from '../src/stage-patches/broadcast-adapter.js';

/**
 * Conformance suite for the unified UVP error taxonomy
 * (uvp-protocol/protocol/uvp-error-taxonomy.v1.json).
 *
 * chain-services keeps its handwritten classification points (submissions
 * broadcast + safe-broadcast, stage-patches, reconcile, indexer sweep) — the
 * runtime is intentionally not table-driven — but this suite pins the taxonomy
 * version + sha256 and enforces, in both directions:
 *
 *   1. completeness — every errorCode literal emitted by the classification
 *      points (found by scanning the classification sources) is registered in
 *      the taxonomy's chain-services internal_names, and every registered
 *      internal name actually occurs in the sources. A new error code without
 *      a taxonomy entry, or a renamed one, fails here.
 *   2. consistency — the exported classifiers' verdicts (retryable /
 *      deadLetter) match the taxonomy attributes field by field for every
 *      probed condition (base attributes; chain-services has no
 *      producer_overrides except where noted in the table).
 *
 * Any edit to the taxonomy table or to a classification point must update both
 * sides in the same change or these tests fail loudly.
 */

const TAXONOMY_VERSION = 'uvp.error-taxonomy.v1';
const TAXONOMY_SHA256 = 'eb3ceba32669cbdc74b62482e341314f864c49e26bdc570401772457544bd059';

interface TaxonomyErrorEntry {
  readonly code: string;
  readonly producers: readonly string[];
  readonly retryable: boolean;
  readonly dead_letter: boolean;
  readonly benign_scan_outcome: boolean;
  readonly internal_names?: Readonly<Record<string, readonly string[]>>;
  readonly producer_overrides?: Readonly<Record<string, Record<string, unknown>>>;
}

interface TaxonomyFile {
  readonly version: string;
  readonly errors: readonly TaxonomyErrorEntry[];
}

function taxonomyPath(): string {
  const override = process.env.UVP_ERROR_TAXONOMY_JSON;
  if (override) {
    return override;
  }
  // tests/ -> service -> uvp-chain-services -> uvp-eth (workspace root)
  const workspaceRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  return join(workspaceRoot, 'uvp-protocol', 'protocol', 'uvp-error-taxonomy.v1.json');
}

let taxonomy: TaxonomyFile;

beforeAll(() => {
  const path = taxonomyPath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `uvp error taxonomy not readable at ${path} (${(error as Error).message}). `
      + 'The table lives in the uvp-protocol repo under protocol/uvp-error-taxonomy.v1.json; '
      + 'run the test from the pnpm workspace or point UVP_ERROR_TAXONOMY_JSON at the file. '
      + 'Do not skip this suite: it is the chain-services side of the pinned conformance contract.',
    );
  }
  taxonomy = JSON.parse(raw) as TaxonomyFile;
  expect(taxonomy.version).toBe(TAXONOMY_VERSION);
  const digest = createHash('sha256').update(raw).digest('hex');
  expect(digest).toBe(TAXONOMY_SHA256);
});

function entryByCode(code: string): TaxonomyErrorEntry {
  const entry = taxonomy.errors.find((candidate) => candidate.code === code);
  if (!entry) {
    throw new Error(`taxonomy is missing the "${code}" entry`);
  }
  return entry;
}

/** The taxonomy entry whose chain-services internal_names contain the given error code. */
function entryForInternalName(internalName: string): TaxonomyErrorEntry {
  const entry = taxonomy.errors.find((candidate) =>
    candidate.internal_names?.['chain-services']?.includes(internalName));
  if (!entry) {
    throw new Error(`no taxonomy entry registers chain-services internal name "${internalName}"`);
  }
  return entry;
}

describe('uvp error taxonomy pinning (chain-services)', () => {
  it('pins the taxonomy version and sha256', () => {
    expect(taxonomy.version).toBe(TAXONOMY_VERSION);
    const digest = createHash('sha256').update(readFileSync(taxonomyPath(), 'utf8')).digest('hex');
    expect(digest).toBe(TAXONOMY_SHA256);
  });
});

/**
 * Classification-point sources whose emitted error codes the taxonomy must
 * fully register. Scoped to the retry/terminal classification lanes (relayer,
 * submissions/safe-broadcast, stage-patches, reconcile); pure HTTP
 * request-validation codes from the API routes are out of the chain retry
 * taxonomy's scope and live in OUT_OF_TAXONOMY_SCOPE below.
 */
const CLASSIFICATION_SOURCES: readonly string[] = [
  'src/submissions/broadcast-adapter.ts',
  'src/submissions/safe-broadcast-adapter.ts',
  'src/submissions/service.ts',
  'src/stage-patches/broadcast-adapter.ts',
  'src/stage-patches/service.ts',
  'src/reconcile/worker.ts',
];

/** Patterns that surface every emitted errorCode literal in the sources above. */
const CODE_PATTERNS: readonly RegExp[] = [
  /errorCode: "([a-z0-9_]+)"/g,
  /(?:failedBroadcastResult|failedResult|classifiedBroadcastError)\(\s*"([a-z0-9_]+)"/g,
  /(?:invalidSignatureError|staleNonceError|genericFailureError): "([a-z0-9_]+)"/g,
  /(?:ProductSubmissionError|ProductStagePatchError)\(\s*\d+,\s*"([a-z0-9_]+)"/g,
];

/**
 * The `case "…":` pattern is only meaningful in the two broadcast-adapter
 * files, where switches enumerate error codes (labels / dead-letter sets).
 * Elsewhere switches carry statuses and action names.
 */
const CODE_CASE_PATTERN: ReadonlyMap<string, RegExp> = new Map([
  ['src/submissions/broadcast-adapter.ts', /case "([a-z0-9_]+)":/g],
  ['src/stage-patches/broadcast-adapter.ts', /case "([a-z0-9_]+)":/g],
]);

/**
 * Taxonomy 内仍登记、但 chain-services 已刻意不再发射的内部名。
 * - broadcast_retry_blocked: 去重重放改为保留原始错误码（2609100406
 *   X-7 修复——泛化会抹掉 transaction_reverted 等真实错误码），该哨兵
 *   不再有发射点；taxonomy（冻结于 uvp-protocol 仓）的 chain-services
 *   登记项待其仓侧更新。
 * - relayer 框架专属名（2026-09-14 P2-1 裁决删除 src/relayer 死框架，
 *   无生产构造点；duplicate-transaction 车道已下沉两在役 broadcast
 *   adapter，其通用文本分类 executor-kit/protocol 自持）：下列内部名
 *   不再有发射点，taxonomy 登记项待 uvp-protocol 仓侧同步清理。
 */
const INTENTIONALLY_UNEMITTED_NAMES: ReadonlySet<string> = new Set([
  'broadcast_retry_blocked',
  'duplicate_signer_nonce',
  'expired_payload_deadline',
  'invalid_business_signature',
  'malformed_relay_payload',
  'missing_nonce',
  'missing_order_id',
  'missing_verified_signer',
  'order_relay_in_flight',
  'relay_broadcast_failed',
  'rpc_unavailable',
  'verified_signer_mismatch',
]);

/** API request-validation / lifecycle codes outside the retry taxonomy scope. */
const OUT_OF_TAXONOMY_SCOPE: ReadonlySet<string> = new Set([
  'invalid_body',
  'invalid_signature',
  'invalid_chain_identifier',
  'invalid_nonce_factory',
  'evidence_required',
  'evidence_not_found',
  'evidence_not_usable',
  'evidence_order_mismatch',
  'evidence_stage_mismatch',
  'evidence_task_mismatch',
  'prepare_already_used',
  'prepare_not_found',
  'prepare_task_mismatch',
  'product_task_not_found',
  'task_not_submittable',
  'submitter_not_authorized',
  'wallet_mismatch',
  // IDOR 归属校验：广播/重试车道之外的 HTTP 访问控制 4xx（与
  // draft_access_forbidden 同类，后者位于未被扫描的 BFF 服务源）。
  'submission_access_forbidden',
  // Stage-patch / product domain-state request validations (HTTP 4xx before
  // any broadcast attempt): deterministic request defects outside the
  // broadcast retry/dead-letter lanes.
  'ambiguous_order_id',
  'approval_signal_missing',
  'approval_signal_not_allowed',
  'executor_patch_task_not_ready',
  'invalid_executor_patch_mode',
  'invalid_manifest_uri',
  'invalid_previous_executor_signature',
  'invalid_target_stage',
  'module_address_missing',
  'order_signal_authorization_missing',
  'prepared_patch_mismatch',
  'previous_executor_mismatch',
  'previous_executor_not_allowed',
  'previous_executor_required',
  'previous_executor_signature_required',
  'product_order_not_found',
  'selector_wallet_not_authorized',
  'state_machine_address_missing',
  'target_stage_locked',
  'target_stage_not_started',
  'target_stage_started_assign_rejected',
  'typed_data_mismatch',
]);

function serviceRoot(): string {
  // tests/ -> service
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function scannedErrorCodes(): Set<string> {
  const found = new Set<string>();
  for (const relative of CLASSIFICATION_SOURCES) {
    const source = readFileSync(join(serviceRoot(), relative), 'utf8');
    for (const pattern of CODE_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        found.add(match[1] as string);
      }
    }
    const casePattern = CODE_CASE_PATTERN.get(relative);
    if (casePattern) {
      for (const match of source.matchAll(casePattern)) {
        found.add(match[1] as string);
      }
    }
  }
  return found;
}

function taxonomyInternalNames(): Set<string> {
  const names = new Set<string>();
  for (const entry of taxonomy.errors) {
    for (const name of entry.internal_names?.['chain-services'] ?? []) {
      names.add(name);
    }
  }
  return names;
}

describe('chain-services classification completeness against the taxonomy', () => {
  it('registers every errorCode literal emitted by the classification sources', () => {
    const registered = taxonomyInternalNames();
    const unregistered: string[] = [];
    for (const code of scannedErrorCodes()) {
      if (!registered.has(code) && !OUT_OF_TAXONOMY_SCOPE.has(code)) {
        unregistered.push(code);
      }
    }
    expect(unregistered, 'error codes missing a taxonomy entry (add them to uvp-error-taxonomy.v1.json)').toEqual([]);
  });

  it('finds every registered chain-services internal name in the sources (no stale entries)', () => {
    const scanned = scannedErrorCodes();
    const stale: string[] = [];
    for (const name of taxonomyInternalNames()) {
      // Descriptive (non-code) internal names — e.g. the post-commit sweep
      // function identifiers — are pinned by their own source check below.
      if (!/^[a-z0-9_]+$/.test(name)) {
        continue;
      }
      if (INTENTIONALLY_UNEMITTED_NAMES.has(name)) {
        continue;
      }
      if (!scanned.has(name)) {
        stale.push(name);
      }
    }
    expect(stale, 'taxonomy internal names that no longer occur in chain-services sources').toEqual([]);
  });

  it('pins the pending post-commit sweep lane by its source identifiers', () => {
    const entry = entryByCode('post_commit_step_pending');
    expect(entry.retryable).toBe(true);
    expect(entry.dead_letter).toBe(false);
    const indexerSource = readFileSync(join(serviceRoot(), 'src/indexer/service.ts'), 'utf8');
    for (const identifier of ['runPostCommitStepWithBoundedRetry', 'sweepPendingPostCommitSteps', 'savePendingPostCommitStep', 'listPendingPostCommitSteps']) {
      expect(indexerSource.includes(identifier), `indexer sweep identifier "${identifier}" must exist`).toBe(true);
    }
  });

  it('keeps the out-of-scope allowlist honest (no taxonomy entry registers those codes)', () => {
    const registered = taxonomyInternalNames();
    for (const code of OUT_OF_TAXONOMY_SCOPE) {
      expect(registered.has(code), `"${code}" is allowlisted as out of scope but registered in the taxonomy`).toBe(false);
    }
  });
});

interface ClassifierVerdict {
  readonly retryable: boolean;
  readonly deadLetter?: boolean;
}

const SUBMISSION_PROBES: readonly { readonly internalName: string; readonly error: unknown }[] = [
  { internalName: 'unauthorized_signal_submitter', error: new Error('UnauthorizedSignalSubmitter()') },
  { internalName: 'signal_already_exists', error: new Error('SignalAlreadyExists()') },
  { internalName: 'unknown_order', error: new Error('UnknownOrder()') },
  { internalName: 'expired_signal_signature', error: new Error('ExpiredSignalSignature()') },
  { internalName: 'invalid_signal_signature', error: new Error('InvalidSignalSignature()') },
  // duplicate-transaction 三车道（原 relayer 专属，已下沉两在役面）：基础
  // 判定对齐 taxonomy nonce_conflict；broadcast() 捕获口的回执探针改判由
  // broadcast-duplicate-transaction.test.ts 钉。
  { internalName: 'duplicate_transaction', error: new Error('nonce too low') },
  { internalName: 'duplicate_transaction', error: new Error('already known') },
  { internalName: 'duplicate_transaction', error: new Error('replacement transaction underpriced') },
  // 未登记 revert 走泛规则（对齐 relayer 兜底）：永久失败，不得无限重放烧 gas。
  { internalName: 'transaction_reverted', error: new Error('execution reverted: SomeUnregisteredError()') },
  { internalName: 'relayer_insufficient_funds', error: new Error('insufficient funds') },
  { internalName: 'rpc_timeout', error: new Error('The request timed out') },
  { internalName: 'state_machine_broadcast_failed', error: new Error('broadcaster caught fire inexplicably') },
];

describe('chain-services classification consistency against the taxonomy', () => {
  it('submissions broadcast classifier verdicts match the taxonomy attributes field by field', () => {
    for (const probe of SUBMISSION_PROBES) {
      const entry = entryForInternalName(probe.internalName);
      const verdict = classifyStateMachineBroadcastError(probe.error) as ClassifierVerdict & { errorCode: string };
      const branch = entryForInternalName(verdict.errorCode);
      expect(branch.code, `probe error for "${probe.internalName}" landed on "${verdict.errorCode}"`).toBe(entry.code);
      expect(verdict.retryable, `${entry.code}: retryable`).toBe(entry.retryable);
      const deadLetter = verdict.deadLetter ?? branchDeadLetterFallback(verdict.errorCode, verdict.retryable);
      expect(deadLetter, `${entry.code}: dead_letter`).toBe(entry.dead_letter);
    }
  });

  it('keeps the route-4 unification pinned: insufficient_funds is retryable in the broadcast lane', () => {
    const submissionVerdict = classifyStateMachineBroadcastError(new Error('insufficient funds'));
    expect(submissionVerdict.retryable).toBe(true);
    const entry = entryByCode('insufficient_funds');
    expect(entry.retryable).toBe(true);
    expect(entry.dead_letter).toBe(false);
    expect(entry.producers).toContain('chain-services');
    expect(entry.producers).toContain('executor-kit');
  });

  it('keeps duplicate_signal terminal in chain-services (the executor-kit benign override is producer-scoped)', () => {
    const entry = entryByCode('duplicate_signal');
    expect(entry.retryable).toBe(false);
    expect(entry.dead_letter).toBe(true);
    const override = entry.producer_overrides?.['executor-kit'];
    expect(override).toBeDefined();
    expect(entry.producer_overrides?.['executor-kit']?.['dead_letter']).toBe(false);
  });

  it('keeps the nonce_conflict divergence recorded (needs-ruling): submissions non-retryable base, table base matches', () => {
    const entry = entryByCode('nonce_conflict');
    const verdict = classifyStateMachineBroadcastError(new Error('replacement transaction underpriced')) as ClassifierVerdict & { errorCode: string };
    expect(verdict.errorCode).toBe('duplicate_transaction');
    expect(verdict.retryable).toBe(entry.retryable);
    expect(verdict.retryable).toBe(false);
    // executor-kit override records the diverging retryable=true disposition.
    expect(entry.producer_overrides?.['executor-kit']?.['retryable']).toBe(true);
  });
});

/**
 * 第三腿：stage-patch 广播分类器的"合约 revert 名→检测模式"conformance。
 * 前两腿（内部名登记完备性/双向、分类器判定与词表属性一致）不覆盖这
 * 一点——历史上分类器检查的自造近似名（StaleStagePatchNonce /
 * UnauthorizedStageSelector 等）与真实合约错误名互不为子串，全部失配，
 * 一切持久性 revert 落进泛 retryable 分支（同一 prepare 无限重试链上必
 * 拒的变更）。本腿把每个受检错误名钉在权威 ABI 上：
 * - UVPStateMachine 的错误名直接取自 @uvp-eth/protocol-bindings 的
 *   UVP_STATE_MACHINE_ARTIFACT_ABI（forge artifacts 生成，上游重命名
 *   即红）；
 * - UVPStagePatchModule 自身的错误名暂以合约源镜像清单锁定（bindings
 *   尚未导出模块 artifact ABI），与 state machine 重名的条目由 artifact
 *   ABI 交叉验证防拼写漂移。
 */
describe('stage-patch contract revert names against the authoritative ABI (third leg)', () => {
  /** UVPStagePatchModule.sol 声明的全部 custom error（合约源镜像，勿凭记忆改写）。 */
  const STAGE_PATCH_MODULE_ERROR_NAMES: readonly string[] = [
    'ExpiredStageExecutorPatchSignature',
    'ExpiredStageResourcePatchSignature',
    'InvalidStageExecutorPatchMode',
    'InvalidStageExecutorPatchSignature',
    'InvalidStageExecutorPatchSignatureLength',
    'InvalidStageResourcePatchSignature',
    'InvalidStageResourcePatchSignatureLength',
    'StageAlreadyHasSignal',
    'StageExecutorPatchApprovalSignalMissing',
    'StageExecutorPatchNonceNotIncreasing',
    'StageExecutorPatchPreviousExecutorMismatch',
    'StageHasNoSignal',
    'StageExecutorPatchForbiddenOnBirthStage',
    'StagePreviousExecutorAmbiguous',
    'StageResourcePatchNonceNotIncreasing',
    'StageSelectorBindingNotFound',
    'UnauthorizedStageExecutorPatchSelector',
    'UnauthorizedStageResourcePatchSelector',
    'UnknownOrder',
    'ZeroManifestHash',
    'ZeroPatchHash',
    'ZeroPolicyHash',
    'ZeroResourceKey',
    'ZeroSelector',
    'ZeroSelectorStageId',
    'ZeroStageExecutor',
    'ZeroTargetStageId'
  ];

  /** 与 UVPStateMachine（artifact ABI）重名的条目——可程序化交叉验证。 */
  const ARTIFACT_CROSS_CHECK_NAMES: readonly string[] = [
    'StageExecutorPatchNonceNotIncreasing',
    'UnknownOrder',
    'ZeroPatchHash',
    'ZeroStageExecutor',
    'ZeroTargetStageId'
  ];

  /** 曾经失配的自造近似名——任何一侧出现即红（防回归）。 */
  const RETIRED_MISSPELLED_NAMES: readonly string[] = [
    'StaleStagePatchNonce',
    'StaleStageExecutorPatchNonce',
    'StaleStageResourcePatchNonce',
    'UnauthorizedStageSelector',
    'UnauthorizedStageResourceSelector',
    'InvalidStagePatchSignature'
  ];

  function stateMachineArtifactErrorNames(): Set<string> {
    const entries = UVP_STATE_MACHINE_ARTIFACT_ABI as readonly { readonly type: string; readonly name?: string }[];
    return new Set(
      entries
        .filter((entry) => entry.type === 'error' && typeof entry.name === 'string')
        .map((entry) => entry.name as string)
    );
  }

  it('cross-checks the mirrored module names against the state-machine artifact ABI', () => {
    const artifactNames = stateMachineArtifactErrorNames();
    for (const name of ARTIFACT_CROSS_CHECK_NAMES) {
      expect(artifactNames, `"${name}" must exist in UVP_STATE_MACHINE_ARTIFACT_ABI (contract renamed?)`).toContain(name);
      expect(STAGE_PATCH_MODULE_ERROR_NAMES).toContain(name);
    }
    for (const retired of RETIRED_MISSPELLED_NAMES) {
      expect(artifactNames, `retired misspelled name "${retired}" must not reappear as a real contract error`).not.toContain(retired);
      expect(STAGE_PATCH_MODULE_ERROR_NAMES).not.toContain(retired);
    }
  });

  interface RevertNameExpectation {
    readonly internalName: string;
    readonly retryable: boolean;
    readonly labels?: 'resource';
  }

  /** 各权威 revert 名的期望分类（内部名均已在 taxonomy 登记）。 */
  const REVERT_NAME_EXPECTATIONS: readonly (RevertNameExpectation & { readonly name: string })[] = [
    { name: 'ExpiredStageExecutorPatchSignature', internalName: 'expired_stage_executor_patch_signature', retryable: false },
    { name: 'ExpiredStageResourcePatchSignature', internalName: 'expired_stage_resource_patch_signature', retryable: false, labels: 'resource' },
    { name: 'InvalidStageExecutorPatchSignature', internalName: 'invalid_stage_executor_patch_signature', retryable: false },
    { name: 'InvalidStageExecutorPatchSignatureLength', internalName: 'invalid_stage_executor_patch_signature', retryable: false },
    { name: 'InvalidStageResourcePatchSignature', internalName: 'invalid_stage_resource_patch_signature', retryable: false, labels: 'resource' },
    { name: 'InvalidStageResourcePatchSignatureLength', internalName: 'invalid_stage_resource_patch_signature', retryable: false, labels: 'resource' },
    { name: 'StageExecutorPatchNonceNotIncreasing', internalName: 'stale_stage_executor_patch_nonce', retryable: false },
    { name: 'StageResourcePatchNonceNotIncreasing', internalName: 'stale_stage_resource_patch_nonce', retryable: false, labels: 'resource' },
    { name: 'UnauthorizedStageExecutorPatchSelector', internalName: 'selector_not_authorized', retryable: false },
    { name: 'UnauthorizedStageResourcePatchSelector', internalName: 'selector_not_authorized', retryable: false, labels: 'resource' },
    // 瞬态优先于泛 revert：viem 复合文本同时含 "reverted." 与错误名。
    { name: 'UnknownOrder', internalName: 'unknown_order', retryable: true },
    // 其余持久 revert 走泛规则（estimateGas 阶段的未登记 revert）——永久。
    { name: 'InvalidStageExecutorPatchMode', internalName: 'transaction_reverted', retryable: false },
    { name: 'StageSelectorBindingNotFound', internalName: 'transaction_reverted', retryable: false },
    { name: 'StageExecutorPatchApprovalSignalMissing', internalName: 'transaction_reverted', retryable: false },
    { name: 'StageExecutorPatchPreviousExecutorMismatch', internalName: 'transaction_reverted', retryable: false },
    { name: 'ZeroPatchHash', internalName: 'transaction_reverted', retryable: false },
    { name: 'ZeroStageExecutor', internalName: 'transaction_reverted', retryable: false }
  ];

  it('detects every authoritative revert name through both errorName and revert text, with taxonomy-consistent verdicts', () => {
    for (const expectation of REVERT_NAME_EXPECTATIONS) {
      // 分类器对 labels 的泛型只约束 buildCall 的入参类型（分类路径不触
      // 碰 buildCall），资源档标签按执行档标签类型传入即可统一断言。
      const labels = (expectation.labels === 'resource'
        ? STAGE_RESOURCE_PATCH_BROADCAST_LABELS
        : STAGE_EXECUTOR_PATCH_BROADCAST_LABELS) as typeof STAGE_EXECUTOR_PATCH_BROADCAST_LABELS;
      const viaErrorName = classifyStagePatchBroadcastError(
        Object.assign(new Error('The contract function reverted with the following reason: execution reverted'), {
          errorName: expectation.name
        }),
        labels
      ) as ClassifierVerdict & { errorCode: string };
      expect(
        viaErrorName.errorCode,
        `errorName "${expectation.name}" must classify as ${expectation.internalName}`
      ).toBe(expectation.internalName);
      expect(viaErrorName.retryable, `${expectation.name}: retryable`).toBe(expectation.retryable);

      const viaRevertText = classifyStagePatchBroadcastError(
        new Error(`execution reverted: Error: ${expectation.name}()`),
        labels
      ) as ClassifierVerdict & { errorCode: string };
      expect(
        viaRevertText.errorCode,
        `revert text containing "${expectation.name}" must classify as ${expectation.internalName}`
      ).toBe(expectation.internalName);
      expect(viaRevertText.retryable).toBe(expectation.retryable);

      // 判定与 taxonomy 属性字段一致。例外：expired_stage_* 由模板拼接
      //（沿用广播前 deadline 预检的既有内部名约定），不在冻结词表的
      // chain-services internal_names 登记内——词表仓（uvp-protocol）补
      // 登记前跳过查表，仅锁定 retryable=false 的判定。
      if (expectation.internalName.startsWith('expired_stage_')) {
        continue;
      }
      const entry = entryForInternalName(expectation.internalName);
      expect(expectation.retryable, `${entry.code} via ${expectation.name}`).toBe(entry.retryable);
    }
  });

  it('keeps resource-patch names on the resource label set', () => {
    const verdict = classifyStagePatchBroadcastError(
      new Error('execution reverted: Error: StageResourcePatchNonceNotIncreasing()'),
      STAGE_RESOURCE_PATCH_BROADCAST_LABELS
    ) as ClassifierVerdict & { errorCode: string };
    expect(verdict.errorCode).toBe('stale_stage_resource_patch_nonce');
    expect(verdict.retryable).toBe(false);
  });

  it('keeps the shared duplicate-transaction lanes terminal-by-default on both patch label sets', () => {
    // 基础判定对齐 taxonomy nonce_conflict（retryable=false/dead_letter=true）；
    // broadcast() 捕获口的回执探针改判（receipt_unknown 可重试等）由
    // broadcast-duplicate-transaction.test.ts 单独钉。
    for (const labels of [STAGE_EXECUTOR_PATCH_BROADCAST_LABELS, STAGE_RESOURCE_PATCH_BROADCAST_LABELS] as const) {
      for (const text of ['nonce too low', 'already known', 'replacement transaction underpriced']) {
        const verdict = classifyStagePatchBroadcastError(
          new Error(text),
          // 分类器对 labels 的泛型只约束 buildCall 的入参类型（分类路径不
          // 触碰 buildCall），资源档标签按执行档标签类型传入即可统一断言。
          labels as typeof STAGE_EXECUTOR_PATCH_BROADCAST_LABELS
        ) as ClassifierVerdict & { errorCode: string };
        expect(verdict.errorCode, `${text} on ${labels.label}`).toBe('duplicate_transaction');
        const entry = entryForInternalName('duplicate_transaction');
        expect(verdict.retryable).toBe(entry.retryable);
        expect(entry.dead_letter).toBe(true);
      }
    }
  });

  it('keeps transport errors retryable and ahead of the generic revert rule', () => {
    const verdict = classifyStagePatchBroadcastError(
      Object.assign(new Error('The request timed out'), { name: 'TimeoutError' }),
      STAGE_EXECUTOR_PATCH_BROADCAST_LABELS
    ) as ClassifierVerdict & { errorCode: string };
    expect(verdict.errorCode).toBe('rpc_timeout');
    expect(verdict.retryable).toBe(true);
  });
});

/** deadLetterForBroadcastError default: non-retryable codes in the DL switch are dead letters. */
function branchDeadLetterFallback(errorCode: string, retryable: boolean): boolean {
  if (retryable) {
    return false;
  }
  const deadLetterCodes = new Set([
    'chain_id_mismatch',
    'duplicate_transaction',
    'expired_signal_signature',
    'invalid_signal_signature',
    'order_plan_unresolved',
    'relayer_business_signer_reuse',
    'signal_already_exists',
    'transaction_reverted',
    'unauthorized_signal_submitter',
  ]);
  return deadLetterCodes.has(errorCode);
}
