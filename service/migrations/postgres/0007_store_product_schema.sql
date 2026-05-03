ALTER TABLE store_zhixu_draft
  ADD COLUMN product_schema_json JSONB;

CREATE INDEX IF NOT EXISTS store_zhixu_draft_product_schema_idx
  ON store_zhixu_draft (updated_at, draft_id)
  WHERE product_schema_json IS NOT NULL;
