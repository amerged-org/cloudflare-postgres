-- pgcf-schema-revision: 1
-- The platform schema of a tenant database (plan database-events-and-schedules, 4.5). The agent
-- runs this file as the cluster's superuser between BEGIN and COMMIT, with search_path set to
-- pg_catalog, so every name is qualified.
--
-- Who owns what decides who can attach code to the outbox. The schema and its two tables belong
-- to the superuser that runs this file, never to a role the tenant's code can run as: the two
-- SECURITY DEFINER functions belong to the role "pgcf-events", which owns nothing else and holds
-- only INSERT and SELECT on the outbox and SELECT on the settings. Code that runs as "pgcf-events"
-- (a cast on a captured column, which pgcf.capture calls through to_jsonb, is enough) can read the
-- outbox, add rows and alter the two functions, but it cannot create a trigger, a rule or a function
-- in the schema nor change a table. The CHECKs on pgcf.outbox bound every row it can add: the seq
-- and epoch ranges, the payload size and its depth. The drain runs as the superuser and reads every
-- row as hostile input, and nothing in the schema reaches outside the database: the platform role
-- logs in to nothing and holds no grant beyond the schema's two tables and functions.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = 'pgcf' AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid = n.nspowner AND r.rolsuper)) THEN
    RAISE EXCEPTION 'schema pgcf belongs to another owner' USING ERRCODE = '42P06';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pgcf-events') THEN
    CREATE ROLE "pgcf-events" NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'pgcf') THEN
    CREATE SCHEMA pgcf;
  END IF;
END $$;
ALTER ROLE "pgcf-events" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD NULL;
CREATE TABLE IF NOT EXISTS pgcf.settings (
  singleton pg_catalog.bool PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch pg_catalog.int8 NOT NULL CHECK (epoch > 0),
  max_payload_bytes pg_catalog.int8 NOT NULL CHECK (max_payload_bytes > 0),
  max_outbox_rows pg_catalog.int8 NOT NULL CHECK (max_outbox_rows > 0)
);
CREATE TABLE IF NOT EXISTS pgcf.outbox (
  seq pg_catalog.int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  epoch pg_catalog.int8 NOT NULL,
  emitted_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  topic pg_catalog.text NOT NULL CHECK (topic OPERATOR(pg_catalog.~) '^[a-z][a-z0-9_]{0,47}$'),
  payload pg_catalog.jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(payload) = 'object'),
  CHECK (seq BETWEEN 1 AND 9007199254740991),
  CHECK (epoch BETWEEN 1 AND 9007199254740991),
  CHECK (pg_catalog.octet_length(payload::pg_catalog.text) <= 262144),
  CHECK (NOT pg_catalog.jsonb_path_exists(payload, '$.**{33 to last}'))
);
REVOKE ALL ON TABLE pgcf.settings, pgcf.outbox FROM PUBLIC;
REVOKE ALL ON SCHEMA pgcf FROM PUBLIC;
GRANT USAGE ON SCHEMA pgcf TO PUBLIC;
GRANT SELECT ON TABLE pgcf.settings TO "pgcf-events";
GRANT SELECT, INSERT ON TABLE pgcf.outbox TO "pgcf-events";

CREATE OR REPLACE FUNCTION pgcf.emit(topic pg_catalog.text, payload pg_catalog.jsonb)
RETURNS pg_catalog.int8
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_variable
DECLARE
  limits pgcf.settings%ROWTYPE;
  used pg_catalog.int8;
  new_seq pg_catalog.int8;
BEGIN
  SELECT * INTO limits FROM pgcf.settings;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pgcf is not configured' USING ERRCODE = '55000';
  END IF;
  IF topic IS NULL OR topic OPERATOR(pg_catalog.!~) '^[a-z][a-z0-9_]{0,47}$' THEN
    RAISE EXCEPTION 'topic is not a data event topic' USING ERRCODE = '22023';
  END IF;
  IF payload IS NULL OR pg_catalog.jsonb_typeof(payload) <> 'object' THEN
    RAISE EXCEPTION 'payload is not a JSON object' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.octet_length(payload::pg_catalog.text) > limits.max_payload_bytes THEN
    RAISE EXCEPTION 'payload is too large' USING ERRCODE = '54000';
  END IF;
  IF pg_catalog.jsonb_path_exists(payload, '$.**{33 to last}') THEN
    RAISE EXCEPTION 'payload is nested too deeply' USING ERRCODE = '54000';
  END IF;
  SELECT count(*) INTO used FROM (SELECT 1 FROM ONLY pgcf.outbox LIMIT limits.max_outbox_rows) q;
  IF used >= limits.max_outbox_rows THEN
    RAISE EXCEPTION 'pgcf outbox is full' USING ERRCODE = '53400';
  END IF;
  INSERT INTO pgcf.outbox (epoch, topic, payload) VALUES (limits.epoch, topic, payload)
    RETURNING seq INTO new_seq;
  PERFORM pg_catalog.pg_notify('pgcf_outbox', '');
  RETURN new_seq;
END;
$$;

CREATE OR REPLACE FUNCTION pgcf.capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  fresh pg_catalog.jsonb;
  stale pg_catalog.jsonb;
  new_record pg_catalog.jsonb := '{}';
  old_record pg_catalog.jsonb := '{}';
  wanted pg_catalog.text;
  event_topic pg_catalog.text;
  value pg_catalog.jsonb;
  digits pg_catalog.numeric;
BEGIN
  IF (SELECT c.relpersistence FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID) = 't' THEN
    RAISE EXCEPTION 'pgcf.capture does not watch temporary tables' USING ERRCODE = '42501';
  END IF;
  IF TG_WHEN <> 'AFTER' OR TG_LEVEL <> 'ROW' THEN
    RAISE EXCEPTION 'pgcf.capture runs AFTER ... FOR EACH ROW only' USING ERRCODE = '39P01';
  END IF;
  IF TG_NARGS = 0 THEN
    RAISE EXCEPTION 'pgcf.capture needs the columns to publish' USING ERRCODE = '22023';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    stale := pg_catalog.to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    fresh := pg_catalog.to_jsonb(NEW);
  END IF;
  IF TG_OP = 'INSERT' THEN
    old_record := NULL;
  ELSIF TG_OP = 'DELETE' THEN
    new_record := NULL;
  END IF;
  FOREACH wanted IN ARRAY TG_ARGV LOOP
    IF (TG_OP <> 'INSERT' AND NOT (stale ? wanted))
       OR (TG_OP <> 'DELETE' AND NOT (fresh ? wanted)) THEN
      RAISE EXCEPTION 'pgcf.capture column % does not exist', wanted USING ERRCODE = '42703';
    END IF;
    IF TG_OP <> 'DELETE' THEN
      value := fresh -> wanted;
      IF pg_catalog.jsonb_typeof(value) = 'number' THEN
        digits := (value #>> '{}')::pg_catalog.numeric;
        IF pg_catalog.abs(digits) >= 1e300 OR (digits <> 0 AND pg_catalog.abs(digits) < 1e-300) THEN
          value := pg_catalog.to_jsonb(value #>> '{}');
        ELSIF digits <> ((digits::pg_catalog.float8)::pg_catalog.text)::pg_catalog.numeric THEN
          value := pg_catalog.to_jsonb(value #>> '{}');
        END IF;
      END IF;
      new_record := new_record || pg_catalog.jsonb_build_object(wanted, value);
    END IF;
    IF TG_OP <> 'INSERT' THEN
      value := stale -> wanted;
      IF pg_catalog.jsonb_typeof(value) = 'number' THEN
        digits := (value #>> '{}')::pg_catalog.numeric;
        IF pg_catalog.abs(digits) >= 1e300 OR (digits <> 0 AND pg_catalog.abs(digits) < 1e-300) THEN
          value := pg_catalog.to_jsonb(value #>> '{}');
        ELSIF digits <> ((digits::pg_catalog.float8)::pg_catalog.text)::pg_catalog.numeric THEN
          value := pg_catalog.to_jsonb(value #>> '{}');
        END IF;
      END IF;
      old_record := old_record || pg_catalog.jsonb_build_object(wanted, value);
    END IF;
  END LOOP;
  IF TG_OP = 'UPDATE' AND new_record = old_record THEN
    RETURN NULL;
  END IF;
  -- The topic is the table name in lower case, with every other character outside [a-z0-9_] replaced
  -- by '_', a 't_' prefix when it does not start with a letter, and at most 48 characters.
  event_topic := pg_catalog.regexp_replace(pg_catalog.lower(TG_TABLE_NAME::pg_catalog.text), '[^a-z0-9_]', '_', 'g');
  IF event_topic OPERATOR(pg_catalog.!~) '^[a-z]' THEN
    event_topic := 't_' || event_topic;
  END IF;
  event_topic := pg_catalog.left(event_topic, 48);
  PERFORM pgcf.emit(
    event_topic,
    pg_catalog.jsonb_build_object(
      'schema', TG_TABLE_SCHEMA,
      'table', TG_TABLE_NAME,
      'op', pg_catalog.lower(TG_OP),
      'record', new_record,
      'old_record', old_record));
  RETURN NULL;
END;
$$;

ALTER FUNCTION pgcf.emit(pg_catalog.text, pg_catalog.jsonb) OWNER TO "pgcf-events";
ALTER FUNCTION pgcf.capture() OWNER TO "pgcf-events";
REVOKE ALL ON FUNCTION pgcf.emit(pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pgcf.capture() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgcf.capture() TO PUBLIC;
GRANT EXECUTE ON FUNCTION pgcf.emit(pg_catalog.text, pg_catalog.jsonb) TO "app" WITH GRANT OPTION;
