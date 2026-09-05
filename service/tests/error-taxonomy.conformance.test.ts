import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { classifyRelaySubmitterError } from '../src/relayer/service.js';
import { classifyStateMachineBroadcastError } from '../src/submissions/broadcast-adapter.js';

/**
 * Conformance suite for the unified UVP error taxonomy
 * (uvp-protocol/protocol/uvp-error-taxonomy.v1.json).
 *
 * chain-services keeps its handwritten classification points (relayer,
 * submissions/safe-broadcast, stage-patches, reconcile, indexer sweep) — the
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
const TAXONOMY_SHA256 = 'b742667c145f4e14db428405af64b004a6379f46cc440f9fafe2114fc19d30fc';

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
  'src/relayer/service.ts',
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
  'submitter_wallet_not_active_executor',
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

/** Drives the relayer classifier into each branch and maps to the taxonomy code. */
const RELAYER_PROBES: readonly { readonly internalName: string; readonly error: unknown }[] = [
  { internalName: 'unauthorized_signal_submitter', error: new Error('Contract function reverted: UnauthorizedSignalSubmitter()') },
  { internalName: 'invalid_business_signature', error: new Error('InvalidSignalSignature: signature does not match') },
  { internalName: 'expired_payload_deadline', error: new Error('ExpiredSignalSignature: deadline has expired') },
  { internalName: 'signal_already_exists', error: new Error('SignalAlreadyExists()') },
  { internalName: 'duplicate_transaction', error: new Error('nonce too low') },
  { internalName: 'duplicate_transaction', error: new Error('already known') },
  { internalName: 'relayer_insufficient_funds', error: new Error('insufficient funds for gas * price + value') },
  { internalName: 'chain_id_mismatch', error: new Error('chain id mismatch: 1 != 31337') },
  { internalName: 'unknown_order', error: new Error('execution reverted: Error: UnknownOrder()') },
  { internalName: 'transaction_reverted', error: new Error('execution reverted') },
  { internalName: 'rpc_unavailable', error: new Error('request timed out: ETIMEDOUT') },
  { internalName: 'relay_broadcast_failed', error: new Error('something unprecedented happened') },
];

const SUBMISSION_PROBES: readonly { readonly internalName: string; readonly error: unknown }[] = [
  { internalName: 'unauthorized_signal_submitter', error: new Error('UnauthorizedSignalSubmitter()') },
  { internalName: 'signal_already_exists', error: new Error('SignalAlreadyExists()') },
  { internalName: 'unknown_order', error: new Error('UnknownOrder()') },
  { internalName: 'expired_signal_signature', error: new Error('ExpiredSignalSignature()') },
  { internalName: 'invalid_signal_signature', error: new Error('InvalidSignalSignature()') },
  { internalName: 'relayer_insufficient_funds', error: new Error('insufficient funds') },
  { internalName: 'rpc_timeout', error: new Error('The request timed out') },
  { internalName: 'state_machine_broadcast_failed', error: new Error('broadcaster caught fire inexplicably') },
];

describe('chain-services classification consistency against the taxonomy', () => {
  it('relayer classifier verdicts match the taxonomy attributes field by field', () => {
    expect(RELAYER_PROBES.length).toBeGreaterThanOrEqual(12);
    for (const probe of RELAYER_PROBES) {
      const entry = entryForInternalName(probe.internalName);
      const verdict = classifyRelaySubmitterError(probe.error) as ClassifierVerdict & { errorCode: string };
      const actual = verdict.errorCode;
      // The probe must land on the branch it claims to cover.
      const branch = entryForInternalName(actual);
      expect(branch.code, `probe error for "${probe.internalName}" landed on "${actual}"`).toBe(entry.code);
      expect(verdict.retryable, `${entry.code}: retryable`).toBe(entry.retryable);
      expect(verdict.deadLetter ?? !verdict.retryable, `${entry.code}: dead_letter`).toBe(entry.dead_letter);
    }
  });

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

  it('keeps the route-4 unification pinned: insufficient_funds is retryable in both lanes', () => {
    const relayerVerdict = classifyRelaySubmitterError(new Error('insufficient funds'));
    const submissionVerdict = classifyStateMachineBroadcastError(new Error('insufficient funds'));
    expect(relayerVerdict.retryable).toBe(true);
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

  it('keeps the nonce_conflict divergence recorded (needs-ruling): relayer non-retryable, table base matches relayer', () => {
    const entry = entryByCode('nonce_conflict');
    const verdict = classifyRelaySubmitterError(new Error('replacement transaction underpriced')) as ClassifierVerdict & { errorCode: string };
    expect(verdict.errorCode).toBe('duplicate_transaction');
    expect(verdict.retryable).toBe(entry.retryable);
    expect(verdict.retryable).toBe(false);
    // executor-kit override records the diverging retryable=true disposition.
    expect(entry.producer_overrides?.['executor-kit']?.['retryable']).toBe(true);
  });
});

/** deadLetterForBroadcastError default: non-retryable codes in the DL switch are dead letters. */
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
