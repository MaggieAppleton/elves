# Card Page Index Cache Lifetime Design

## Goal

Keep card-number selectors reusable across page switches without retaining selectors or full card records after their store records are deleted.

## Design

Use `Store.createCache` for per-card page-info selectors. The store record atom is the weak cache key: a card on an inactive page keeps the same selector while its record remains in the store, and deleting the record makes the cache entry collectible. Retyping a shape reuses the one selector attached to that record rather than creating another entry.

Do not cache expanded fan results per representative. While a representative is expanded, read its semantic member-id selector, the shared lazy page-layout signal, and current member records directly. Once collapsed, React tracking detaches those reads and no long-lived computed value retains the full member records.

## Verification

- Instrument 100 consumers and assert one shared number-map build, one constant-time lookup per selector, and no linear number searches.
- Exercise create, delete, retype, and page-switch churn; selector cache entries must remain tied to live records and inactive-page selectors must be reused.
- Expand and collapse a fan, delete a former member, and prove no cached fan result retains the old record.
- Preserve the existing lazy fan-layout, merge behavior, accessibility numbering, and relevant end-to-end behavior.
