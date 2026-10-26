// One-time cleanup (2026-10-26): clear shopify_is_abandoned on contacts who
// placed a Shopify order AFTER their abandoned checkout, but whose flag was
// never cleared (e.g. the order wasn't matched to the contact — Evie Park,
// abandoned 2026-09-03, ordered #396142 on 2026-09-12, still flagged).
//
// It does NOT expire old abandoned checkouts — that window is waiting on a
// decision from Bill/Courtney.
//
// Usage (from the backend folder, with the same .env as the server):
//   node scripts/clear-abandoned-buyers.js            ← dry run, writes a CSV report only
//   node scripts/clear-abandoned-buyers.js --apply    ← also updates HubSpot
//
// For each contact with shopify_is_abandoned = true:
//   abandon date = shopify_abandoned_date, else recent_conversion_date (the
//                  backend's checkout form submission), else skipped
//   if Shopify has an order for the contact's email placed on/after the
//   abandon date (minus 10 minutes of tolerance), the contact is cleared:
//   shopify_is_abandoned = false, shopify_has_order = true.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const APPLY   = process.argv.includes("--apply");
const HS      = process.env.HUBSPOT_ACCESS_TOKEN;
const SHOPIFY = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOP    = process.env.SHOPIFY_SHOP_DOMAIN || "medical-and-lab-supplies.myshopify.com";
const TOLERANCE_MS = 10 * 60 * 1000;

if (!HS || !SHOPIFY) {
  console.error("HUBSPOT_ACCESS_TOKEN and SHOPIFY_ACCESS_TOKEN must be set (.env)");
  process.exit(1);
}

const hsHeaders = { Authorization: `Bearer ${HS}`, "Content-Type": "application/json" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry(fn, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      if (attempt < 4 && (!status || status === 401 || status === 429 || status >= 500)) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new Error(`${label}: ${err.response?.data?.message || err.message}`);
    }
  }
}

async function fetchFlaggedContacts() {
  const contacts = [];
  let after;
  do {
    const res = await withRetry(() => axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        filterGroups: [{ filters: [{ propertyName: "shopify_is_abandoned", operator: "EQ", value: "true" }] }],
        properties: ["email", "firstname", "lastname", "shopify_abandoned_date", "recent_conversion_date"],
        sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
        limit: 200,
        ...(after ? { after } : {}),
      },
      { headers: hsHeaders }
    ), "HubSpot search");
    contacts.push(...res.data.results);
    after = res.data.paging?.next?.after;
    await sleep(300); // HubSpot search is limited to ~4 requests/second
  } while (after);
  return contacts;
}

async function findOrderSince(email, sinceMs) {
  const since = new Date(sinceMs - TOLERANCE_MS).toISOString();
  const res = await withRetry(() => axios.post(
    `https://${SHOP}/admin/api/2026-01/graphql.json`,
    {
      query: `
        query OrdersSince($q: String!) {
          orders(first: 1, sortKey: CREATED_AT, query: $q) {
            nodes { name createdAt }
          }
        }
      `,
      variables: { q: `email:"${email}" created_at:>='${since}'` },
    },
    { headers: { "X-Shopify-Access-Token": SHOPIFY, "Content-Type": "application/json" } }
  ), `Shopify orders for ${email}`);
  if (res.data.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(res.data.errors)}`);
  return res.data.data?.orders?.nodes?.[0] || null;
}

function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

(async () => {
  console.log(`Mode: ${APPLY ? "APPLY (HubSpot will be updated)" : "DRY RUN (no changes)"}`);
  const contacts = await fetchFlaggedContacts();
  console.log(`Contacts with shopify_is_abandoned = true: ${contacts.length}`);

  const rows = [];
  const toClear = [];
  for (const [i, c] of contacts.entries()) {
    const p = c.properties || {};
    const email = (p.email || "").trim().toLowerCase();
    const abandonedAt = Date.parse(p.shopify_abandoned_date || p.recent_conversion_date || "");
    const base = { id: c.id, email, name: `${p.firstname || ""} ${p.lastname || ""}`.trim(),
                   abandoned: Number.isFinite(abandonedAt) ? new Date(abandonedAt).toISOString() : "" };

    if (!email) { rows.push({ ...base, action: "skipped: no email" }); continue; }
    if (!Number.isFinite(abandonedAt)) { rows.push({ ...base, action: "skipped: no abandon date" }); continue; }

    try {
      const order = await findOrderSince(email, abandonedAt);
      if (order) {
        rows.push({ ...base, order: order.name, orderDate: order.createdAt, action: APPLY ? "cleared" : "would clear" });
        toClear.push(c.id);
      } else {
        rows.push({ ...base, action: "kept: no order since abandoning" });
      }
    } catch (err) {
      rows.push({ ...base, action: `error: ${err.message}` });
    }
    if ((i + 1) % 50 === 0) console.log(`  checked ${i + 1}/${contacts.length}`);
    await sleep(250);
  }

  if (APPLY && toClear.length) {
    for (let i = 0; i < toClear.length; i += 100) {
      const inputs = toClear.slice(i, i + 100).map(id => ({
        id,
        properties: { shopify_is_abandoned: "false", shopify_has_order: "true" },
      }));
      await withRetry(() => axios.post(
        "https://api.hubapi.com/crm/v3/objects/contacts/batch/update",
        { inputs },
        { headers: hsHeaders }
      ), "HubSpot batch update");
      await sleep(300);
    }
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = path.join(process.cwd(), `abandoned-cleanup-${APPLY ? "applied" : "dry-run"}-${stamp}.csv`);
  const header = ["contact_id", "email", "name", "abandoned_at", "order", "order_date", "action"];
  const lines = [header.join(",")].concat(rows.map(r =>
    [r.id, r.email, r.name, r.abandoned, r.order, r.orderDate, r.action].map(csvCell).join(",")));
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const count = prefix => rows.filter(r => r.action.startsWith(prefix)).length;
  console.log(`\n${APPLY ? "Cleared" : "Would clear"}: ${toClear.length}`);
  console.log(`Kept (no order since abandoning): ${count("kept")}`);
  console.log(`Skipped: ${count("skipped")} | Errors: ${count("error")}`);
  console.log(`Report: ${file}`);
})().catch(err => {
  console.error("Cleanup failed:", err.message);
  process.exit(1);
});
