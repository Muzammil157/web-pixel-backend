# Project Changelog — hubspot-new branch

---

## [2026-04-16] Checkout-token bridge + resilient order reconciliation

**Branch:** `hubspot-new`
**File changed:** `index.js` only — 4 targeted changes

### Problem being fixed

Email mismatch between checkout pixel and order webhook caused reconciliation to silently fail — users remained as "Guest" even after placing a real order because:
- `order.email` can differ from the pixel-submitted email (guest changes email at payment step)
- `order.email` can be absent entirely on some guest checkouts
- The old reconciliation only searched by email — if it missed, it created a new duplicate contact

### Changes made

#### 1. `checkoutTokenMap` added alongside `reconciliationMap`

```js
const checkoutTokenMap = new Map(); // checkout_token → email
```

Secondary index that acts as the bridge between the checkout pixel event and the order webhook. Populated when a checkout is received; consumed when an order is reconciled.

#### 2. `/checkout-completed` — store `checkout_token` in both maps

Extracts `checkout.token` (Shopify pixel field) from the payload.

- Added `checkout_token` field to `reconciliationMap` entry
- Stores `checkoutTokenMap.set(token, email)` for order-side lookup

#### 3. `/webhook/orders-create` — widen trigger condition

Was: `if (order.email && HUBSPOT_ACCESS_TOKEN)`
Now: `if (HUBSPOT_ACCESS_TOKEN && (order.email || order.checkout_token))`

Orders with no email but a checkout_token now also go through reconciliation.

#### 4. `reconcileOrderContact` — full 3-step matching + `findHubSpotContactByEmail` helper

**Step A — email match (existing logic, now in a reusable helper)**
Search HubSpot by `order.email`. Helper `findHubSpotContactByEmail` wraps the search call and returns `null` on failure (never throws).

**Step B — checkout_token bridge (new)**
If Step A finds nothing (or email is missing):
- Read `order.checkout_token`
- Look up `checkoutTokenMap` → get the pixel-submitted email
- Search HubSpot by that email instead
- Logs: `[HubSpot] Bridging order X via checkout_token → email@example.com`

**Last resort — create as customer**
If both steps miss: create a new contact using `resolvedEmail || order.billing_address.email`. Logs a warning and skips if no email can be resolved at all.

**Strong merge (updated)**
The PATCH now always sends real name data from the order (not conditional on "Guest"/"Shopify"):
```js
if (firstname) customerProps.firstname = firstname;
if (lastname)  customerProps.lastname  = lastname;
```
Order identity always overwrites whatever was in HubSpot.

### Matching flow after fix

```
Order received (orders/create)
        │
        ├── email present?
        │     YES → Step A: search HubSpot by order.email
        │               │
        │               ├── Contact found → PATCH to CUSTOMER + real names
        │               └── Not found → fall through to Step B
        │
        ├── checkout_token present?
        │     YES → Step B: checkoutTokenMap[token] → pixel email
        │               │
        │               ├── Email found in map → search HubSpot by pixel email
        │               │       ├── Contact found → PATCH to CUSTOMER + real names
        │               │       └── Not found → Last resort
        │               └── Token not in map → Last resort
        │
        └── Last resort
              └── Create new CUSTOMER contact (or skip if no email at all)
```

### What was NOT changed
- `/connect-pixel` — untouched
- B2B PO number logic — untouched
- All commented-out OAuth routes — untouched
- `/checkout-completed` internal HubSpot create/update logic — untouched
- Any other route — untouched

---

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
