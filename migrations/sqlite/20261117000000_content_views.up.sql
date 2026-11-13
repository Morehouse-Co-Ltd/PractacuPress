-- Single item read counter (FSD A-16 / B-20, plan P0-06).
--
-- view_count is the de-duplicated number of times the server served this published
-- item to a reader. It is a counter on the row rather than an aggregate over the
-- page_view ledger: every listing and the detail response already load the row, so a
-- column makes the number free to read, while counting page views per item would put
-- a group by on the list path and could never de-duplicate by reader.
--
-- Existing rows start at 0, which is the honest answer for content published before
-- the counter existed: no read was ever attributed to them.
--
-- The index serves the "popular" leaderboard, which orders one site's published rows
-- by this counter inside a publication window.

ALTER TABLE content_items ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX contentitem_site_id_status_view_count
    ON content_items (site_id, status, view_count);
