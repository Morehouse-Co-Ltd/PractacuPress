DROP INDEX contentitem_site_id_status_view_count ON content_items;
ALTER TABLE content_items DROP COLUMN view_count;
