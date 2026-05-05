// Compatibility re-export for callers that import submission typed-data helpers
// through chain-services. Internal code should prefer @uvp-eth/protocol-bindings.
export {
  PRODUCT_SUBMIT_DOMAIN_NAME,
  PRODUCT_SUBMIT_DOMAIN_VERSION,
  PRODUCT_SUBMIT_PRIMARY_TYPE,
  PRODUCT_SUBMIT_TYPED_DATA_FIELDS,
  buildProductSubmitTypedData,
  recoverProductSubmitSigner,
  type BuildProductSubmitTypedDataInput,
  type ProductSubmitTypedData,
  type ProductSubmitTypedDataField
} from "@uvp-eth/protocol-bindings";
