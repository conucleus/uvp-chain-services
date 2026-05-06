ALTER TABLE store_supplier_audit
  ADD COLUMN before_supported_role_slot_ids_json TEXT;

ALTER TABLE store_supplier_audit
  ADD COLUMN after_supported_role_slot_ids_json TEXT;

ALTER TABLE store_supplier_audit
  ADD COLUMN before_supported_stage_ids_json TEXT;

ALTER TABLE store_supplier_audit
  ADD COLUMN after_supported_stage_ids_json TEXT;
