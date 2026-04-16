# Project Changelog — hubspot-new branch

All changes documented in reverse chronological order.
This file is updated after every code change.

---

## [2026-04-16] HubSpot Lifecycle Reconciliation

**Branch:** `hubspot-new`
**File changed:** `index.js` only — 4 surgical additions, nothing else touched

---

### Problem being fixed

| Symptom | Root cause |
|---|---|
| Customers appear as "Guest" in HubSpot after placing orders | `/checkout-completed` used `"Guest"` / `"Shopify"` as name fallbacks |
| Completed customers still show as leads or unknown | No `lifecyclestage` was ever set on contact creation |
| Abandoned checkouts indistinguishable from real customers | Pixel event treated the same as a completed purchase |
| Duplicate contacts for the same person | No update path — "Contact already exists. Doing nothing." |
| No linkage between checkout pixel and order event | No reconciliation layer existed |

---

### Changes made (index.js)

#### 1. Reconciliation Map (added after existing `const` declarations)

```js
const reconciliationMap = new Map();
// Key: email
// Value: { status: 'LEAD'|'CUSTOMER', firstname, lastname, timestamp }
```

In-memory store that tracks each email's current lifecycle state.
Resets on server restart — HubSpot is the persistent source of truth.

---

#### 2. `/checkout-completed` — pixel event = LEAD only

**Search query updated** to fetch `firstname`, `lastname`, `lifecyclestage` (was only fetching `email`).

**If contact does not exist:**
- Was: `firstname: "Guest"`, `lastname: "Shopify"`, no `lifecyclestage`
- Now: real name from checkout payload (or empty string), `lifecyclestage: "lead"`

**If contact already exists:**
- Was: `"Contact already exists. Doing nothing."` — no update at all
- Now:
  - If `lifecyclestage` is not already `"customer"` → PATCH to `"lead"` (HubSpot lifecycle can only move forward, never backward, so customer is never downgraded)
  - Fixes placeholder names: if `firstname === "Guest"` or `lastname === "Shopify"`, overwrites with real data from checkout payload

**Reconciliation map updated** to `LEAD` after both paths.

---

#### 3. `/webhook/orders-create` — order event = CUSTOMER conversion

After the existing B2B PO number try/catch block (completely isolated — cannot affect existing Shopify logic):

```js
if (order.email && HUBSPOT_ACCESS_TOKEN) {
  reconcileOrderContact(order).catch(err =>
    console.error('[HubSpot] reconcileOrderContact error:', err.message)
  );
}
```

Fire-and-forget. Any HubSpot failure is logged and swallowed — the Shopify webhook response is always `200` and the B2B logic above is never affected.

---

#### 4. `reconcileOrderContact(order)` helper function (added before `app.listen`)

Called every time an order is created. Contains all the HubSpot promotion logic.

**Flow:**
```
Order received
      │
      ▼
Search HubSpot by email
      │
      ├── Contact found
      │     ├── PATCH lifecyclestage → "customer"
      │     ├── Fix firstname if "Guest" or empty → real name from order
      │     └── Fix lastname if "Shopify" or empty → real name from order
      │
      └── Contact NOT found
            └── POST new contact: email + real name + lifecyclestage: "customer"
      │
      ▼
Update reconciliationMap → { status: "CUSTOMER", ... }
```

Name resolution priority: `order.customer.first_name` → `order.billing_address.first_name` → `""`

---

### What was NOT changed

- `/connect-pixel` — untouched
- B2B PO number logic inside `/webhook/orders-create` — untouched
- All commented-out OAuth routes — untouched
- `app.use(cors(...))` and middleware — untouched
- Any other route or configuration — untouched

---

### Lifecycle model after fix

| Event | Source | HubSpot result |
|---|---|---|
| Customer submits checkout info (pixel) | `/checkout-completed` | Contact created/updated as **LEAD** |
| Customer abandons — no order follows | (no further event) | Stays as **LEAD** |
| Customer completes order | `/webhook/orders-create` | Contact promoted to **CUSTOMER**, placeholder names fixed |
| Order arrives with no prior checkout event | `/webhook/orders-create` | Contact created directly as **CUSTOMER** |
| Duplicate webhook for same order | `/webhook/orders-create` | PATCH is idempotent — no duplicate contacts |
