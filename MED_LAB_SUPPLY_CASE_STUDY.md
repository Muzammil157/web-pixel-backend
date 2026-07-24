# Med Lab Supply — Proprietary Shopify × HubSpot Integration

**A custom CRM bridge that turns storefront behavior into intelligent, actionable contact data**

---

## The Problem

Med Lab Supply runs its storefront on Shopify and its customer relationships on HubSpot. Out of the box, these two platforms don't talk to each other in any meaningful way. The standard integrations available on the market are surface-level — they sync basic order data after the fact, but they don't capture the full customer journey.

Specifically, the business had three unresolved problems:

1. **Abandoned carts were invisible to HubSpot.** When a customer started checkout but didn't complete their purchase, HubSpot had no record of it — no contact, no context, no URL to follow up with.

2. **Completed customers appeared as "Guest" in HubSpot.** The checkout flow created contacts with placeholder names and no lifecycle stage. After a customer placed a real order, HubSpot still showed them as an unknown lead.

3. **There was no reliable way to distinguish abandoned leads from real customers.** Both looked the same in HubSpot, making accurate marketing segmentation impossible.

---

## The Solution

Med Lab Supply now has a proprietary backend integration — a real-time bridge between Shopify and HubSpot that captures the full customer journey from first checkout interaction all the way through to completed order.

This is not a plugin or a third-party connector. It is custom infrastructure with logic designed specifically around how Med Lab Supply's customers shop.

---

## How It Works

### 1. Real-Time Checkout Tracking via Shopify Web Pixel

When a customer reaches the checkout page and submits their contact information, a **Shopify Web Pixel** — JavaScript running natively inside the Shopify storefront — fires a real-time event. That event is sent directly to the integration backend with:

- Customer email, first name, last name
- Checkout token (a unique identifier for this checkout session)
- Every item in the cart — title, quantity, price, product image, and product link

The backend immediately creates or updates a **HubSpot contact** with lifecycle stage set to `lead`. This happens within seconds of the customer entering their email.

### 2. The Abandoned Checkout URL — Where Most Integrations Fall Short

One of the most critical pieces of data for abandoned cart recovery is the **abandoned checkout URL** — a unique Shopify-generated recovery link that takes the customer back to their exact checkout session with one click.

Standard integrations either don't capture this at all, or rely on a field that is frequently empty.

This integration solves it with a two-signal bridge:

- **Shopify's `checkout/create` webhook** fires the moment a checkout session opens. This webhook contains the real, fully-formed recovery URL including the session key.
- The backend stores this URL indexed by the checkout token.
- When the pixel event fires moments later (with the customer's email), the backend matches the stored URL by token and writes it directly to a custom HubSpot contact property: `shopify_checkout_url`.

The result: every abandoned cart contact in HubSpot has a working, one-click recovery link — ready to drop into any email sequence.

### 3. Abandoned Cart HTML — Ready for Email

Beyond the URL, the integration generates a **full HTML snapshot of the customer's cart** — formatted specifically for email clients including Gmail, Outlook, and Apple Mail.

For each item in the cart, the HTML block includes:
- Product image
- Product title
- Price and quantity
- Direct "View Product" link

This HTML is stored on the HubSpot contact as a custom property (`shopify_abandoned_cart_html`). HubSpot email templates pull it in as a personalization token — meaning every abandoned cart email automatically shows the customer exactly what they left behind, with zero manual work.

### 4. Contact Lifecycle Reconciliation — Lead to Customer

When a customer completes an order, Shopify fires an `orders/create` webhook. The backend receives this and promotes the HubSpot contact from `lead` to `customer`, updating their name with the real order data.

This step includes a resilience layer for a common real-world edge case: **the email on the completed order sometimes differs from the email entered during checkout** (for example, a guest who changes their email at the payment step).

The integration handles this with a three-step matching strategy:

1. **Match by order email** — search HubSpot for the order's email address.
2. **Bridge via checkout token** — if that fails, look up the checkout token, find the email stored when the pixel originally fired, and search HubSpot by that instead.
3. **Create as customer** — if both miss, create a new customer contact using whatever email is available.

No completed order goes unrecorded in HubSpot.

### 5. Segmentation Flags — Precise Audience Building

The integration writes three custom boolean properties to every HubSpot contact:

| Property | What it means |
|---|---|
| `shopify_has_order` | `true` only after a real order is placed — never overwritten by checkout events |
| `shopify_is_abandoned` | `true` when a checkout starts; flipped to `false` when an order is completed |
| `contact_attempted` | Managed by marketing flows — tracks whether a follow-up has been sent |

These flags make it possible to build HubSpot lists with precision:

- **Abandoned, never contacted** → `shopify_is_abandoned = true`, `contact_attempted = false`
- **Abandoned, follow-up sent** → `shopify_is_abandoned = true`, `contact_attempted = true`
- **Converted customers** → `shopify_has_order = true`
- **Customers who were previously in abandoned cart flows** → `shopify_has_order = true`, `contact_attempted = true`

---

## What Sets This Apart

Most Shopify–HubSpot connectors on the market do one thing: sync completed orders. They don't:

- Capture checkout intent in real time, before a purchase is made
- Bridge the email mismatch between checkout and order events
- Store pre-formatted abandoned cart HTML for use in email templates
- Retrieve the real Shopify recovery URL and attach it to the contact
- Write purchase-aware segmentation flags that marketing flows can act on immediately

---

## Technical Overview

| Layer | Technology |
|---|---|
| Backend | Node.js / Express |
| Hosting | Render (cloud, always-on) |
| Shopify | Web Pixel (storefront) + Admin Webhooks |
| HubSpot | CRM API v3 — contacts, properties, lifecycle stages |
| Session bridging | Token-indexed in-memory maps (checkout → email, checkout → recovery URL) |
| Data persistence | HubSpot CRM (source of truth; survives server restarts) |

---

## Outcome

Med Lab Supply's HubSpot CRM now reflects exactly where every customer is in their journey — in real time, automatically, without manual data entry.

Abandoned cart recovery campaigns have everything they need: the contact record, the one-click recovery link, the cart contents formatted for email, and the segmentation flags to know precisely who to target and when.

When a customer completes an order, they are promoted to customer status automatically — real name, correct lifecycle stage, no duplicates, no placeholders.
