-- SPDX-License-Identifier: Apache-2.0
-- Every region archives into the installation's one R2 bucket: the Worker's `ARCHIVE` binding, named
-- by the variable `ARCHIVE_BUCKET_NAME` (plan 9.6). A region names no bucket, so the column goes.
-- `backup_endpoint_url` stays: it is the S3 endpoint the nodes' temporary credentials name, the same
-- for every region of the one bucket. The stored archive paths (`s3://<bucket>/<region>/...`) are not
-- touched here: a deployment that moves to another bucket rewrites them in its cutover.
ALTER TABLE regions DROP COLUMN backup_bucket;
