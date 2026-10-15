# Numbered migrations

The numbering started again at `0001`. Every file here was written after the
collapse described below.

The chain that used to live here ran from `0001` to `0262` and was collapsed
into `db/schema.sql`. No database had ever replayed it end to end: the local and
test databases are built from `schema.sql` in one pass, and staging was rebuilt
from it when the chain was deleted. Carrying 255 files that only one path ever
executed cost a reconciliation migration every time the two paths drifted, and
`0249` was the fifth of those.

Write a new migration with `/new-migration`. `db/schema/*.sql` is still the
authority, `schema.sql` is generated from it, and `npm run db:catalog-parity`
still proves that a database built from `schema.sql` matches one migrated from
the baseline ref.
