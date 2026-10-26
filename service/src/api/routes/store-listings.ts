import { redactErrorMessage } from "../../security/redaction.js";
import type { StoreListingService } from "../../store/listings/index.js";
import { StoreListingServiceError, type StoreListingStatus, type StoreListingRecord } from "../../store/listings/index.js";
import {
  authorizeStoreWrite,
  isAnchoredStoreAuthorizationResult,
  isStoreAuthorizationResult,
  recordStoreAccessFailure,
  recordStoreAccessSuccess,
  requireAnchoredStoreAddress
} from "../store-authz.js";
import { cleanQuery, decodePathParameter, InvalidPathParameterError, invalidPathParameterResponse, type ApiRequest, type ApiResponse } from "../route-context.js";
import type { RouteModule } from "../route-module.js";

export function createStoreListingsRouteModule(options: {
  readonly listingService: StoreListingService;
}): RouteModule {
  return {
    async handle(request, context) {
      if (!request.pathname.startsWith("/store/listings")) {
        return undefined;
      }
      try {
        if (request.method === "POST" && request.pathname === "/store/listings/import") {
          const auditAction = "store.listing.manage";
          const authorization = await authorizeStoreWrite(context, request, auditAction, { type: "store_listing" });
          if (isStoreAuthorizationResult(authorization)) {
            const anchored = await requireAnchoredStoreAddress(context, request, { type: "store_listing" });
            if (!isAnchoredStoreAuthorizationResult(anchored)) {
              return anchored;
            }
            try {
              const body = await options.listingService.importListing(request.body, listingActor(anchored.access));
              await recordStoreAccessSuccess(context, request, authorization.access, auditAction, {
                type: "store_listing",
                id: body.listing.listingId
              });
              return { status: 201, body };
            } catch (error) {
              await recordStoreAccessFailure(context, request, authorization.access, auditAction, { type: "store_listing" }, error);
              throw error;
            }
          }
          const anchored = await requireAnchoredStoreAddress(context, request, { type: "store_listing" });
          if (!isAnchoredStoreAuthorizationResult(anchored)) {
            return anchored;
          }
          return {
            status: 201,
            body: await options.listingService.importListing(request.body, listingActor(anchored.access))
          };
        }

        if (request.method === "GET" && request.pathname === "/store/listings") {
          const access = await context.storeIdentityProvider.resolve(request.headers);
          const isOperator = access.level === "store_operator" || access.level === "store_admin";
          const status = parseListingStatus(request.query?.status);
          const listings = await options.listingService.listListings(status);
          const visible = isOperator
            ? listings
            : listings.filter((listing) => listing.status === "public");
          return {
            status: 200,
            body: {
              listings: visible.map((listing) => isOperator ? listing : publicListingFields(listing))
            }
          };
        }

        const listingMatch = /^\/store\/listings\/([^/]+)(?:\/(anchor-verification|review|delist|relist))?$/.exec(request.pathname);
        if (!listingMatch) {
          return { status: 404, body: { error: "not_found" } };
        }
        const listingId = decodePathParameter(listingMatch[1] ?? "");
        const action = listingMatch[2];

        if (request.method === "GET" && !action) {
          const detail = await options.listingService.getListing(listingId);
          const access = await context.storeIdentityProvider.resolve(request.headers);
          const isOperator = access.level === "store_operator" || access.level === "store_admin";
          if (!isOperator && detail.listing.status !== "public") {
            return { status: 404, body: { error: "listing_not_found" } };
          }
          return {
            status: 200,
            body: isOperator ? detail : { listing: publicListingFields(detail.listing), anchorVerification: detail.anchorVerification }
          };
        }

        if (request.method === "GET" && action === "anchor-verification") {
          const detail = await options.listingService.getListing(listingId);
          const access = await context.storeIdentityProvider.resolve(request.headers);
          const isOperator = access.level === "store_operator" || access.level === "store_admin";
          if (!isOperator && detail.listing.status !== "public") {
            return { status: 404, body: { error: "listing_not_found" } };
          }
          return {
            status: 200,
            body: { anchorVerification: detail.anchorVerification }
          };
        }

        if (request.method === "POST" && action) {
          const auditAction = "store.listing.manage";
          const resource = { type: "store_listing", id: listingId };
          const authorization = await authorizeStoreWrite(context, request, auditAction, resource);
          if (!isStoreAuthorizationResult(authorization)) {
            return authorization;
          }
          const anchored = await requireAnchoredStoreAddress(context, request, resource);
          if (!isAnchoredStoreAuthorizationResult(anchored)) {
            return anchored;
          }
          try {
            let body: Awaited<ReturnType<StoreListingService["getListing"]>>;
            switch (action) {
              case "review":
                body = await options.listingService.reviewListing(listingId, request.body, listingActor(anchored.access));
                break;
              case "delist":
                body = await options.listingService.delistListing(listingId, request.body, listingActor(anchored.access));
                break;
              case "relist":
                body = await options.listingService.relistListing(listingId, listingActor(anchored.access));
                break;
              default:
                return { status: 404, body: { error: "not_found" } };
            }
            await recordStoreAccessSuccess(context, request, authorization.access, auditAction, resource);
            return { status: 200, body };
          } catch (error) {
            await recordStoreAccessFailure(context, request, authorization.access, auditAction, resource, error);
            throw error;
          }
        }
      } catch (error) {
        if (error instanceof InvalidPathParameterError) {
          return invalidPathParameterResponse();
        }
        if (error instanceof StoreListingServiceError) {
          return {
            status: error.status,
            body: {
              error: error.code,
              message: redactErrorMessage(error),
              ...(error.details !== undefined ? { details: error.details } : {})
            }
          };
        }
        return {
          status: 503,
          body: { error: "store_listing_unavailable", message: redactErrorMessage(error) }
        };
      }
      void cleanQuery;
      return { status: 404, body: { error: "not_found" } };
    }
  };
}

function listingActor(access: {
  readonly level: string;
  readonly anchoredAddress?: import("../../shared/types.js").Address;
  readonly walletAccountId?: string;
  readonly principalId?: string;
}): {
  readonly accessLevel: string;
  readonly anchoredAddress?: import("../../shared/types.js").Address;
  readonly accountId?: string;
  readonly principalId?: string;
} {
  return {
    accessLevel: access.level,
    ...(access.anchoredAddress ? { anchoredAddress: access.anchoredAddress } : {}),
    ...(access.walletAccountId ? { accountId: access.walletAccountId } : {}),
    ...(access.principalId ? { principalId: access.principalId } : {})
  };
}

function publicListingFields(listing: StoreListingRecord): { readonly listingId: string; readonly planId: string; readonly planHashClaimed?: string; readonly status: "public"; readonly importedAt: string } {
  return {
    listingId: listing.listingId,
    planId: listing.planId,
    ...(listing.planHashClaimed ? { planHashClaimed: listing.planHashClaimed } : {}),
    status: "public",
    importedAt: listing.importedAt
  };
}

function parseListingStatus(value: string | undefined): StoreListingStatus | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "imported" || value === "public" || value === "rejected" || value === "delisted") {
    return value;
  }
  return undefined;
}
