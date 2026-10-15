# Query result contracts during Drizzle adoption

These are compatibility requirements, not preferences. They were verified against the local
Postgres clone through both the existing `pg` pool and `drizzle-orm@0.45.2` before query migration
started.

| Database value | Raw `pg` | Drizzle schema | Application/API contract |
|---|---|---|---|
| `date` | `YYYY-MM-DD` string | `YYYY-MM-DD` string | Preserve exactly; never construct a `Date` |
| `timestamptz` | `Date` | `Date` | Repository/output shaping returns the same ISO string as today |
| `bigint` cents | string | number (`mode: 'number'`) | Preserve each existing repository's number/string boundary; never perform floating-point money arithmetic |
| `jsonb` | object/array | object/array | Preserve structure; do not stringify on reads |
| generated stored column | database-computed | marked generated in Drizzle | Never include in insert/update values |
| selected Drizzle column | snake_case database name | TypeScript schema key | Map deliberate entity aliases such as `sort_order` → `order`; do not assume `sortOrder` is the public field |
| whole-query `sql` result | snake_case keys | snake_case keys | Alias fields explicitly or run the established mapper before returning |
| partial select | caller-chosen keys | caller-chosen keys | Preserve the old response keys and omitted large/internal columns |

Representative local checks confirmed:

- `activities.activity_date` is a string through Drizzle;
- `activities.created_at` is a `Date` through Drizzle;
- a `*_cents` bigint is a number through the normalized Drizzle schema;
- `law_firms.plan` is a parsed object;
- selecting `billing_codes.sort_order` produces the Drizzle key `sortOrder`, which is **not** the
  existing entity alias `order`;
- `db.execute(sql\`...\`)` returns database column names such as `created_at` and `law_firm_id`.

For every migrated repository, compare the final service/route result rather than only the raw
Drizzle row. A query can be database-equivalent and still break the API by changing a runtime type
or key.
