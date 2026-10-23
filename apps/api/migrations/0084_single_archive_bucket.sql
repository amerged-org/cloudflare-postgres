-- SPDX-License-Identifier: Apache-2.0
-- Every region archives into the installation's one R2 bucket: the Worker's `ARCHIVE` binding, named
-- by the variable `ARCHIVE_BUCKET_NAME`, and reached at the one S3 endpoint of the variable
-- `ARCHIVE_ENDPOINT_URL` (plan 9.6; the owner's decision of 2026-10-19 in 11.3). A region names
-- neither, so both columns go. No API changed `backup_endpoint_url` after the region was made, and a
-- region that was made with the account's general endpoint for a bucket of the EU jurisdiction (the
-- live us-dev) could never be corrected; the Worker takes the endpoint from its variable, so that
-- nodes of every region get credentials for the host that holds the bucket.
-- The stored archive paths (`s3://<bucket>/<region>/...`) are not touched here: a deployment that
-- moves to another bucket rewrites them in its cutover. The Worker with `ARCHIVE_ENDPOINT_URL` is
-- deployed before this file runs: the Worker that reads the columns cannot run without them.
ALTER TABLE regions DROP COLUMN backup_bucket;
ALTER TABLE regions DROP COLUMN backup_endpoint_url;
