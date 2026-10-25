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

const TAXONOMY_VERSION = 'uvp.error-taxonomy.v1';
const TAXONOMY_SHA256 = 'edd7a1ee1e1a1e6899c008f00aeb57da0918cb98bd8982d7469c855610e7ae84';

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
  const workspaceRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  return join(workspaceRoot, 'uvp-core', 'protocol', 'uvp-error-taxonomy.v1.json');
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
      + 'The table is self-hosted in the uvp-core repo under protocol/uvp-error-taxonomy.v1.json; '
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

const CLASSIFICATION_SOURCES: readonly string[] = [
  'src/submissions/broadcast-adapter.ts',
  'src/submissions/safe-broadcast-adapter.ts',
  'src/submissions/service.ts',
  'src/stage-patches/broadcast-adapter.ts',
  'src/stage-patches/service.ts',
  'src/reconcile/worker.ts',
  'src/governance/adapter.ts',
  'src/governance/service.ts',
  'src/product/query/bff/trigger.ts',
];

const CODE_PATTERNS: readonly RegExp[] = [
  /errorCode: "([a-z0-9_]+)"/g,
  /(?:failedBroadcastResult|failedResult|classifiedBroadcastError)\(\s*"([a-z0-9_]+)"/g,
  /(?:invalidSignatureError|staleNonceError|genericFailureError): "([a-z0-9_]+)"/g,
  /(?:ProductSubmissionError|ProductStagePatchError)\(\s*\d+,\s*"([a-z0-9_]+)"/g,
];

const CODE_CASE_PATTERN: ReadonlyMap<string, RegExp> = new Map([
  ['src/submissions/broadcast-adapter.ts', /case "([a-z0-9_]+)":/g],
  ['src/stage-patches/broadcast-adapter.ts', /case "([a-z0-9_]+)":/g],
]);

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

const OUT_OF_TAXONOMY_SCOPE: ReadonlySet<string> = new Set([
  'invalid_body',
  'invalid_signature',
  'invalid_chain_identifier',
  'invalid_nonce_factory',
  'evidence_required',
  'evidence_not_found',
  'evidence_not_usable',
  'evidence_order_mismatch',
  'evidence_slot_required',
  'evidence_stage_mismatch',
  'evidence_task_mismatch',
  'prepare_already_used',
  'prepare_not_found',
  'prepare_task_mismatch',
  'product_task_not_found',
  'task_not_submittable',
  'submitter_not_authorized',
  'wallet_mismatch',
  'submission_access_forbidden',
  'ambiguous_order_id',
  'executor_candidate_set_unavailable',
  'executor_patch_task_not_ready',
  'invalid_executor_patch_mode',
  'invalid_manifest_uri',
  'invalid_previous_executor_signature',
  'invalid_target_stage',
  'chain_id_missing',
  'module_address_missing',
  'order_signal_authorization_missing',
  'prepared_patch_mismatch',
  'previous_executor_mismatch',
  'previous_executor_ambiguous',
  'previous_executor_not_allowed',
  'previous_executor_required',
  'previous_executor_signature_not_allowed',
  'previous_executor_signature_required',
  'executor_patch_forbidden_on_birth_stage',
  'executor_not_in_candidate_set',
  'stage_patch_capability_tables_unavailable',
  'capability_tables_unavailable',
  'product_order_not_found',
  'selector_wallet_not_authorized',
  'state_machine_address_missing',
  'target_stage_locked',
  'target_stage_not_started',
  'target_stage_started_assign_rejected',
  'typed_data_mismatch',
  'broadcast_failed',
  'governance_adapter_failed',
  'governance_broadcast_disabled',
  'governance_chain_id_mismatch',
  'governance_chain_id_unavailable',
  'governance_registry_owner_unavailable',
  'governance_signer_not_authorized',
  'trigger_order_broadcast_failed',
  'trigger_order_reverted',
  'signal_selection_required',
  'signal_not_available',
]);

function serviceRoot(): string {
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
  { internalName: 'duplicate_transaction', error: new Error('nonce too low') },
  { internalName: 'duplicate_transaction', error: new Error('already known') },
  { internalName: 'duplicate_transaction', error: new Error('replacement transaction underpriced') },
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

  it('keeps nonce_conflict ruled single-value across producers (A-30): retryable, never dead-lettered', () => {
    const entry = entryByCode('nonce_conflict');
    const verdict = classifyStateMachineBroadcastError(new Error('replacement transaction underpriced')) as ClassifierVerdict & { errorCode: string };
    expect(verdict.errorCode).toBe('duplicate_transaction');
    expect(verdict.retryable).toBe(entry.retryable);
    expect(verdict.retryable).toBe(true);
    expect(verdict.deadLetter).toBe(entry.dead_letter);
    expect(entry.dead_letter).toBe(false);
    expect(entry.producer_overrides).toBeUndefined();
  });
});

describe('stage-patch contract revert names against the authoritative ABI (third leg)', () => {
  const STAGE_PATCH_MODULE_ERROR_NAMES: readonly string[] = [
    'ExpiredStageExecutorPatchSignature',
    'ExpiredStageResourcePatchSignature',
    'InvalidStageExecutorPatchMode',
    'InvalidStageExecutorPatchSignature',
    'InvalidStageExecutorPatchSignatureLength',
    'InvalidStageResourcePatchSignature',
    'InvalidStageResourcePatchSignatureLength',
    'StageAlreadyHasSignal',
    'StageExecutorNotCandidate',
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

  const ARTIFACT_CROSS_CHECK_NAMES: readonly string[] = [
    'StageExecutorPatchNonceNotIncreasing',
    'UnknownOrder',
    'ZeroPatchHash',
    'ZeroStageExecutor',
    'ZeroTargetStageId'
  ];

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
    { name: 'UnknownOrder', internalName: 'unknown_order', retryable: true },
    { name: 'StageExecutorNotCandidate', internalName: 'executor_not_in_candidate_set', retryable: false },
    { name: 'InvalidStageExecutorPatchMode', internalName: 'transaction_reverted', retryable: false },
    { name: 'StageSelectorBindingNotFound', internalName: 'transaction_reverted', retryable: false },
    { name: 'StageExecutorPatchPreviousExecutorMismatch', internalName: 'transaction_reverted', retryable: false },
    { name: 'ZeroPatchHash', internalName: 'transaction_reverted', retryable: false },
    { name: 'ZeroStageExecutor', internalName: 'transaction_reverted', retryable: false }
  ];

  it('detects every authoritative revert name through both errorName and revert text, with taxonomy-consistent verdicts', () => {
    for (const expectation of REVERT_NAME_EXPECTATIONS) {
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

      if (
        expectation.internalName.startsWith('expired_stage_') ||
        expectation.internalName === 'executor_not_in_candidate_set'
      ) {
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

  it('keeps the shared duplicate-transaction lanes retryable on both patch label sets (nonce_conflict single value)', () => {
    for (const labels of [STAGE_EXECUTOR_PATCH_BROADCAST_LABELS, STAGE_RESOURCE_PATCH_BROADCAST_LABELS] as const) {
      for (const text of ['nonce too low', 'already known', 'replacement transaction underpriced']) {
        const verdict = classifyStagePatchBroadcastError(
          new Error(text),
          labels as typeof STAGE_EXECUTOR_PATCH_BROADCAST_LABELS
        ) as ClassifierVerdict & { errorCode: string };
        expect(verdict.errorCode, `${text} on ${labels.label}`).toBe('duplicate_transaction');
        const entry = entryForInternalName('duplicate_transaction');
        expect(verdict.retryable).toBe(entry.retryable);
        expect(entry.retryable).toBe(true);
        expect(entry.dead_letter).toBe(false);
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

function branchDeadLetterFallback(errorCode: string, retryable: boolean): boolean {
  if (retryable) {
    return false;
  }
  const deadLetterCodes = new Set([
    'chain_id_mismatch',
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
