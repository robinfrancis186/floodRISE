\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgrouting;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

COMMENT ON EXTENSION postgis IS 'Spatial storage and analysis for floodRISE';
COMMENT ON EXTENSION pgrouting IS 'Versioned lower-risk routing for floodRISE';
