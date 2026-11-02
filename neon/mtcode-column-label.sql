-- Rename Projects column header BIOS ID → MTCODE (stable id d2; Neon field stays bios_id).
-- Meta stores __kssw_column_defs as a JSON *string* inside jsonb (same as app cloudApi).
-- App also rewrites via seedStandardProjectColumns / normalizeManagedColumns on next load.

UPDATE public.projects
SET custom = jsonb_set(
  custom,
  '{__kssw_column_defs}',
  to_jsonb((
    SELECT coalesce(jsonb_agg(
      CASE
        WHEN elem->>'id' = '00000000-0000-4000-8000-0000000000d2'
          OR upper(trim(elem->>'label')) IN ('BIOS ID', 'BIOSID', 'BIOS_ID')
        THEN elem || jsonb_build_object('label', 'MTCODE')
        ELSE elem
      END
      ORDER BY coalesce((elem->>'sort_order')::int, 0)
    ), '[]'::jsonb)::text
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(custom->'__kssw_column_defs') = 'array' THEN custom->'__kssw_column_defs'
        WHEN jsonb_typeof(custom->'__kssw_column_defs') = 'string'
          THEN (custom->>'__kssw_column_defs')::jsonb
        ELSE '[]'::jsonb
      END
    ) AS elem
  ))
)
WHERE name = '__kssw_meta__'
  AND custom ? '__kssw_column_defs';

UPDATE public.project_columns
SET label = 'MTCODE'
WHERE id = '00000000-0000-4000-8000-0000000000d2'
   OR upper(trim(label)) IN ('BIOS ID', 'BIOSID', 'BIOS_ID');
