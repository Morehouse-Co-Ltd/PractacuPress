-- Single item read counter (FSD A-16 / B-20, plan P0-06).
--
-- See the sqlite change set for the rationale. view_count is the de-duplicated
-- number of reads the server served for a published item; it is a counter column so
-- the listing and the detail response read it for free, and the index serves the
-- "popular" leaderboard ordering.

ALTER TABLE content_items ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX contentitem_site_id_status_view_count
    ON content_items (site_id, status, view_count);
