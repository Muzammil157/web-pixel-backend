# Shopify × HubSpot Integration — Setup Guide

---

## Table of Contents
1. [What Needs to Be Done for Every New Client](#what-needs-to-be-done-for-every-new-client)
2. [Step-by-Step Setup](#step-by-step-setup)
3. [Environment Variables Reference](#environment-variables-reference)
4. [What Is Currently Hardcoded (Must Be Changed Per Client)](#what-is-currently-hardcoded)
5. [Improvement Suggestions](#improvement-suggestions)

---

## What Needs to Be Done for Every New Client

### Shopify (5 tasks)
- [ ] Create a custom app in Shopify Admin and generate an access token with the right scopes
- [ ] Register two webhooks pointing at the backend
- [ ] Install the Web Pixel extension with the correct backend URL
- [ ] Add the `hubspotutk` snippet to `theme.liquid`
- [ ] Set shop domain as an environment variable

### HubSpot (4 tasks)
- [ ] Create a Private App and get the access token
- [ ] Create 5 custom contact properties
- [ ] Create a HubSpot Form (for visitor stitching) and note the Form ID
- [ ] Note the Portal ID from account settings

### Backend / Render (3 tasks)
- [ ] Deploy the backend (or create a new Render service per client)
- [ ] Set all environment variables in Render
- [ ] Update hardcoded values in the code (Portal ID, Form ID, shop domain)

---

## Step-by-Step Setup

### PART 1 — Shopify

#### 1.1 Create a Custom App

1. Go to **Shopify Admin → Settings → Apps and sales channels → Develop apps**
2. Click **Create an app**
3. Name it (e.g. "HubSpot Integration")
4. Click **Configure Admin API scopes** and enable:
   - `read_customers`
   - `read_orders`
   - `write_orders`
   - `read_checkouts` *(required for checkout data)*
5. Click **Save** → go to **API credentials** → click **Install app**
6. Copy the **Admin API access token** — this is `SHOPIFY_ACCESS_TOKEN`
7. Copy the **API key** → `SHOPIFY_CLIENT_ID`
8. Copy the **API secret key** → `SHOPIFY_CLIENT_SECRET`

#### 1.2 Register Webhooks

Go to **Shopify Admin → Settings → Notifications → Webhooks → Create webhook**

| Event | URL | Format |
|---|---|---|
| Checkout creation | `https://{your-backend}.onrender.com/webhook/checkout-create` | JSON |
| Order creation | `https://{your-backend}.onrender.com/webhook/orders-create` | JSON |

#### 1.3 Install the Web Pixel Extension

In your Shopify Partner app, deploy the pixel extension with this code (update the backend URL):

```js
register(({ analytics }) => {
  analytics.subscribe("checkout_contact_info_submitted", (event) => {
    const checkout = event.data.checkout;
    fetch("https://{your-backend}.onrender.com/checkout-completed", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "checkout_contact_info_submitted",
        token: checkout.token,
        order_id: checkout.order?.id,
        email: checkout.email,
        first_name: checkout.billingAddress?.firstName,
        last_name: checkout.billingAddress?.lastName,
        total: checkout.totalPrice?.amount,
        line_items: checkout.lineItems.map((item) => ({
          title: item.title,
          quantity: item.quantity,
          price: item.finalLinePrice?.amount,
          sku: item.variant?.sku,
          image_url: item.variant?.image?.url || "",
          url: item.variant?.product?.url || "",
        })),
        timestamp: event.timestamp,
      }),
    }).catch(() => {});
  });
});
```

#### 1.4 Add hubspotutk Snippet to theme.liquid

Add this just before `</body>`, **after** the HubSpot tracking snippet:

```html
<script>
  function getHubspotCookie() {
    const cookies = document.cookie.split(';');
    for (let cookie of cookies) {
      const [key, value] = cookie.trim().split('=');
      if (key === 'hubspotutk') return value;
    }
    return null;
  }

  const hutk = getHubspotCookie();

  if (hutk) {
    fetch('/cart/update.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributes: { hubspotutk: hutk } })
    }).catch(err => console.error('Failed to save hubspotutk:', err));
  }
</script>
```

---

### PART 2 — HubSpot

#### 2.1 Create a Private App

1. Go to **HubSpot → Settings → Integrations → Private Apps**
2. Click **Create a private app**
3. Name it (e.g. "Shopify Integration")
4. Under **Scopes**, enable:
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
5. Click **Create app** → copy the **access token** → `HUBSPOT_ACCESS_TOKEN`

#### 2.2 Create Custom Contact Properties

Go to **HubSpot → Settings → Properties → Contact properties → Create property**

Create all five:

| Property Name (internal) | Label | Field Type | Purpose |
|---|---|---|---|
| `shopify_has_order` | Shopify Has Order | Single checkbox | True only when a real order is placed |
| `shopify_is_abandoned` | Shopify Is Abandoned | Single checkbox | True on checkout start, false on order |
| `contact_attempted` | Contact Attempted | Single checkbox | Managed by marketing flows |
| `shopify_checkout_url` | Shopify Checkout URL | Single-line text | Abandoned cart recovery link |
| `shopify_abandoned_cart_html` | Abandoned Cart HTML | Multi-line text | Email-ready cart snapshot |

> **Important:** The internal name must match exactly as shown above — the code references these by name.

#### 2.3 Create a HubSpot Form

1. Go to **HubSpot → Marketing → Forms → Create form**
2. Choose **Embedded form** → blank template
3. Add the **Email** field (required)
4. Name it (e.g. "Shopify Abandoned Checkout")
5. Click **Publish**
6. Copy the **Form ID** from the URL or share settings → `HUBSPOT_FORM_ID`

#### 2.4 Get the Portal ID

Go to **HubSpot → Settings → Account Management → Account Details**
Copy the **Hub ID** (e.g. `5031174`) → `HUBSPOT_PORTAL_ID`

---

### PART 3 — Backend

#### 3.1 Update Hardcoded Values in index.js

Before deploying for a new client, update these in the code:

```js
// In submitHubSpotForm():
const PORTAL_ID = "YOUR_PORTAL_ID";
const FORM_ID   = "YOUR_FORM_ID";

// In /connect-pixel route:
const shop = "YOUR_SHOP.myshopify.com";

// In /webhook/orders-create route:
`https://YOUR_SHOP.myshopify.com/admin/api/2026-01/customers/...`
`https://YOUR_SHOP.myshopify.com/admin/api/2026-01/orders/...`

// In /checkout-completed route:
const shop = process.env.SHOPIFY_SHOP_DOMAIN || "YOUR_SHOP.myshopify.com";
```

#### 3.2 Set Environment Variables on Render

Go to your Render service → **Environment** → add all variables:

| Variable | Where to get it |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | HubSpot Private App |
| `SHOPIFY_ACCESS_TOKEN` | Shopify Custom App → API credentials |
| `SHOPIFY_CLIENT_ID` | Shopify Custom App → API key |
| `SHOPIFY_CLIENT_SECRET` | Shopify Custom App → API secret |
| `SHOPIFY_SHOP_DOMAIN` | e.g. `store-name.myshopify.com` |
| `HUBSPOT_PORTAL_ID` | HubSpot account Hub ID |
| `HUBSPOT_FORM_ID` | HubSpot form ID |
| `PORT` | `3000` |

#### 3.3 Deploy and Verify

1. Push code → Render auto-deploys (or click **Manual Deploy**)
2. Wait for status to show **Live**
3. Test with:

```bash
curl -X POST https://{your-backend}.onrender.com/webhook/checkout-create \
  -H "Content-Type: application/json" \
  -d '{
    "token": "test-123",
    "email": "test@example.com",
    "abandoned_checkout_url": "https://example.com/recover",
    "note_attributes": [{ "name": "hubspotutk", "value": "test-hutk" }]
  }'
```

Check Render logs for:
```
[Shopify] checkout/create received | token: test-123 | email: test@example.com
[HubSpot Form] Submission SUCCESS
```

---

## Environment Variables Reference

```env
HUBSPOT_ACCESS_TOKEN=your_hubspot_private_app_token
SHOPIFY_ACCESS_TOKEN=your_shopify_admin_api_token
SHOPIFY_CLIENT_ID=your_shopify_api_key
SHOPIFY_CLIENT_SECRET=your_shopify_api_secret
SHOPIFY_SHOP_DOMAIN=store-name.myshopify.com
HUBSPOT_PORTAL_ID=your_hubspot_hub_id
HUBSPOT_FORM_ID=your_hubspot_form_id
PORT=3000
```

---

## What Is Currently Hardcoded

These values are embedded directly in `index.js` and **must be manually updated** for each new client. This is the biggest source of errors in the current setup.

| Location in code | Hardcoded value | Should become |
|---|---|---|
| `submitHubSpotForm()` | Portal ID `5031174` | `process.env.HUBSPOT_PORTAL_ID` |
| `submitHubSpotForm()` | Form ID `e25d767c-...` | `process.env.HUBSPOT_FORM_ID` |
| `/connect-pixel` | `medical-and-lab-supplies.myshopify.com` | `process.env.SHOPIFY_SHOP_DOMAIN` |
| `/webhook/orders-create` | `medical-and-lab-supplies.myshopify.com` | `process.env.SHOPIFY_SHOP_DOMAIN` |
| `submitHubSpotForm()` | `pageUri` (med lab supply URL) | `process.env.SHOPIFY_STORE_URL` |

---

## Improvement Suggestions

### Priority 1 — Quick wins (low effort, high impact)

#### Move all hardcoded values to environment variables
Every client-specific value in the code should come from `process.env`. No code changes should be needed when onboarding a new client — only env var changes on Render.

```js
// Instead of:
const PORTAL_ID = "5031174";

// Use:
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID;
```

This alone eliminates the biggest source of per-client errors.

---

#### Add a `/health` endpoint
A simple endpoint that confirms every credential is present and all connections work:

```
GET /health

Response:
{
  "shopify": "connected",
  "hubspot": "connected",
  "shop": "medical-and-lab-supplies.myshopify.com",
  "portalId": "5031174"
}
```

Run this after every new client deployment to confirm the setup is working before going live.

---

### Priority 2 — Automate Shopify setup

#### Auto-register webhooks via API
Instead of manually clicking through Shopify Admin, add a `/setup/webhooks` endpoint that registers both webhooks programmatically:

```
POST /setup/webhooks
→ Registers checkouts/create and orders/create automatically
→ Logs confirmation with webhook IDs
```

This replaces 4 manual clicks per webhook with a single API call.

---

#### Auto-create HubSpot contact properties
Add a `/setup/hubspot-properties` endpoint that creates all 5 custom properties via the HubSpot Properties API. First call on a new account — never click through HubSpot Settings again.

---

### Priority 3 — Structural improvements

#### One Render service per client vs. shared service
**Current:** Single codebase deployed once, code is edited per client.
**Better:** Same codebase, one Render service per client, all config via env vars.

This means:
- No code changes between clients — only env vars differ
- Each client is fully isolated
- Rolling back one client doesn't affect others
- Render's free tier supports multiple services

---

#### Client config validation on startup
On server start, check that all required env vars are present and log a clear error if any are missing:

```
[Startup] ✓ HUBSPOT_ACCESS_TOKEN present
[Startup] ✓ SHOPIFY_ACCESS_TOKEN present
[Startup] ✗ HUBSPOT_FORM_ID missing — HubSpot form submissions will fail
```

Catches misconfiguration immediately instead of discovering it when a real checkout fires.

---

#### A single setup checklist endpoint
A `GET /setup/status` endpoint that returns the full checklist state — which properties exist in HubSpot, which webhooks are registered in Shopify, which env vars are set — so you can verify a new client setup in one request instead of checking three different admin panels.

---

## Onboarding Time Estimate

| Current (manual) | After improvements |
|---|---|
| ~3–4 hours per client | ~45 minutes per client |
| High risk of typos / missed steps | Automated and validated |
| Requires code edits | Config only — no code changes |
