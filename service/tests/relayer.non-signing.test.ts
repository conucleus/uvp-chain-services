import { describe, expect, it, vi } from "vitest";
import { createRelayerService, MemoryRelayNonceStore, RelayRejection } from "../src/relayer/service.js";
import type {
  BusinessSignatureVerifier,
  RelayRequest,
  RelaySubmissionStore,
  TransactionSubmitter
} from "../src/relayer/types.js";
import type { Address, Hex } from "../src/shared/types.js";

const signer: Address = "0x4444444444444444444444444444444444444444";
const verifyingContract: Address = "0x1111111111111111111111111111111111111111";
const signature: Hex = "0xaaaaaaaa";
const txHash: Hex = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("relayer non-signing boundary", () => {
  it("submits only after a participant business signature verifies", async () => {
    const verifier: BusinessSignatureVerifier = {
      verify: vi.fn(async () => ({ valid: true, signer }))
    };
    const submitter: TransactionSubmitter = {
      submit: vi.fn(async () => ({ txHash }))
    };

    const relayer = createRelayerService({
      verifier,
      submitter,
      nonceStore: new MemoryRelayNonceStore(),
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const submission = await relayer.relay(request("nonce-1"));

    expect(submission.status).toBe("submitted");
    expect(submission.txHash).toBe(txHash);
    expect(verifier.verify).toHaveBeenCalledOnce();
    expect(submitter.submit).toHaveBeenCalledOnce();
    expect("signBusinessPayload" in relayer).toBe(false);
  });

  it("rejects a signature that resolves to a different signer", async () => {
    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({
          valid: true,
          signer: "0x5555555555555555555555555555555555555555"
        })
      },
      submitter: {
        submit: async () => ({ txHash })
      },
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    await expect(relayer.relay(request("nonce-2"))).rejects.toThrow(RelayRejection);
  });

  it("keeps failed submissions observable and retryable", async () => {
    const recorded: unknown[] = [];
    const submissionStore: RelaySubmissionStore = {
      record: async (submission) => {
        recorded.push(submission);
      }
    };

    const relayer = createRelayerService({
      verifier: {
        verify: async () => ({ valid: true, signer })
      },
      submitter: {
        submit: async () => {
          throw new Error("rpc unavailable");
        }
      },
      nonceStore: new MemoryRelayNonceStore(),
      submissionStore,
      now: () => new Date("2026-01-01T00:00:00Z")
    });

    const first = await relayer.relay(request("nonce-3"));
    const second = await relayer.relay(request("nonce-3"));

    expect(first.status).toBe("failed");
    expect(second.status).toBe("failed");
    expect(recorded).toHaveLength(2);
  });
});

function request(nonce: string): RelayRequest {
  return {
    business: {
      action: "approveStage",
      chainId: 31337,
      verifyingContract,
      orderId: "order-1",
      stageId: "stage-1",
      signal: "approve",
      evidenceHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      signer,
      nonce,
      deadline: 2_000_000_000n
    },
    typedData: {
      domain: {
        name: "UVP",
        chainId: 31337,
        verifyingContract
      },
      types: {
        ApproveStage: [
          { name: "orderId", type: "bytes32" },
          { name: "stageId", type: "bytes32" },
          { name: "nonce", type: "uint256" }
        ]
      },
      primaryType: "ApproveStage",
      message: {
        orderId: "order-1",
        stageId: "stage-1",
        nonce
      },
      signature
    }
  };
}
