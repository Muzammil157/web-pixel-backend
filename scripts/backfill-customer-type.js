// One-time backfill (2026-11-17): set Shopify Guest / Customer on existing
// HubSpot contacts, so the abandoned-cart emails can tell them apart.
//
//   Customer = the email has a Shopify store account (state ENABLED)
//              OR is subscribed to email marketing in Shopify
//   Guest    = neither (including emails Shopify has never seen)
//
// Writes shopify_customer_type, shopify_has_account, shopify_email_marketing
// (the backend creates these properties on startup — deploy it first).
//
// Which contacts: those WITHOUT shopify_customer_type that were either
//   • created in the last N days (default 90), or
//   • currently flagged shopify_is_abandoned = true.
// From then on the backend keeps new contacts up to date by itself.
//
// Usage (from the backend folder, with the same .env as the server):
//   node scripts/backfill-customer-type.js               ← dry run, CSV report only
//   node scripts/backfill-customer-type.js --apply       ← also updates HubSpot
//   node scripts/backfill-customer-type.js --days 180    ← look further back

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const APPLY   = process.argv.includes("--apply");
const daysArg = process.argv.indexOf("--days");
const DAYS    = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 90 : 90;
const HS      = process.env.HUBSPOT_ACCESS_TOKEN;
const SHOPIFY = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOP    = process.env.SHOPIFY_SHOP_DOMAIN || "medical-and-lab-supplies.myshopify.com";
const DAY_MS  = 24 * 60 * 60 * 1000;

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

// HubSpot search returns at most 10,000 results per query, so contacts are
// fetched in 7-day windows.
async function searchAll(filters) {
  const results = [];
  let after;
  do {
    const res = await withRetry(() => axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        filterGroups: [{ filters }],
        properties: ["email", "firstname", "lastname", "createdate"],
        sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
        limit: 200,
        ...(after ? { after } : {}),
      },
      { headers: hsHeaders }
    ), "HubSpot search");
    results.push(...res.data.results);
    after = res.data.paging?.next?.after;
    await sleep(300); // HubSpot search is limited to ~4 requests/second
  } while (after);
  return results;
}

async function fetchContacts() {
  const byId = new Map();
  const missing = { propertyName: "shopify_customer_type", operator: "NOT_HAS_PROPERTY" };
  const hasEmail = { propertyName: "email", operator: "HAS_PROPERTY" };

  const end = Date.now();
  for (let from = end - DAYS * DAY_MS; from < end; from += 7 * DAY_MS) {
    const to = Math.min(from + 7 * DAY_MS, end);
    const batch = await searchAll([
      missing, hasEmail,
      { propertyName: "createdate", operator: "BETWEEN", value: String(from), highValue: String(to) },
    ]);
    batch.forEach(c => byId.set(c.id, c));
  }

  const flagged = await searchAll([
    missing, hasEmail,
    { propertyName: "shopify_is_abandoned", operator: "EQ", value: "true" },
  ]);
  flagged.forEach(c => byId.set(c.id, c));
  return [...byId.values()];
}

async function classify(email) {
  const res = await withRetry(() => axios.post(
    `https://${SHOP}/admin/api/2026-01/graphql.json`,
    {
      query: `
        query CustomerType($q: String!) {
          customers(first: 1, query: $q) {
            nodes { state defaultEmailAddress { marketingState } }
          }
        }
      `,
      variables: { q: `email:"${email.replace(/"/g, "")}"` },
    },
    { headers: { "X-Shopify-Access-Token": SHOPIFY, "Content-Type": "application/json" } }
  ), `Shopify customer ${email}`);
  if (res.data.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(res.data.errors)}`);
  const customer = res.data.data?.customers?.nodes?.[0];
  const hasAccount     = customer?.state === "ENABLED";
  const marketingState = customer?.defaultEmailAddress?.marketingState || "NOT_SUBSCRIBED";
  return {
    type: hasAccount || marketingState === "SUBSCRIBED" ? "customer" : "guest",
    hasAccount,
    marketingState,
    inShopify: Boolean(customer),
  };
}

function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

(async () => {
  console.log(`Mode: ${APPLY ? "APPLY (HubSpot will be updated)" : "DRY RUN (no changes)"} | last ${DAYS} days + all flagged abandoners`);
  const contacts = await fetchContacts();
  console.log(`Contacts without a customer type: ${contacts.length}`);

  const rows = [];
  const updates = [];
  for (const [i, c] of contacts.entries()) {
    const p = c.properties || {};
    const email = (p.email || "").trim().toLowerCase();
    const base = { id: c.id, email, name: `${p.firstname || ""} ${p.lastname || ""}`.trim(), created: p.createdate };
    try {
      const r = await classify(email);
      rows.push({ ...base, ...r });
      updates.push({ id: c.id, properties: {
        shopify_customer_type:   r.type,
        shopify_has_account:     r.hasAccount ? "true" : "false",
        shopify_email_marketing: r.marketingState,
      } });
    } catch (err) {
      rows.push({ ...base, type: `error: ${err.message}` });
    }
    if ((i + 1) % 100 === 0) console.log(`  checked ${i + 1}/${contacts.length}`);
    await sleep(250);
  }

  if (APPLY) {
    for (let i = 0; i < updates.length; i += 100) {
      await withRetry(() => axios.post(
        "https://api.hubapi.com/crm/v3/objects/contacts/batch/update",
        { inputs: updates.slice(i, i + 100) },
        { headers: hsHeaders }
      ), "HubSpot batch update");
      await sleep(300);
    }
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = path.join(process.cwd(), `customer-type-${APPLY ? "applied" : "dry-run"}-${stamp}.csv`);
  const header = ["contact_id", "email", "name", "created", "customer_type", "has_account", "email_marketing", "in_shopify"];
  const lines = [header.join(",")].concat(rows.map(r =>
    [r.id, r.email, r.name, r.created, r.type, r.hasAccount, r.marketingState, r.inShopify].map(csvCell).join(",")));
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const count = t => rows.filter(r => r.type === t).length;
  console.log(`\n${APPLY ? "Updated" : "Would update"}: ${updates.length} | customer: ${count("customer")} | guest: ${count("guest")} | errors: ${rows.length - updates.length}`);
  console.log(`Report: ${file}`);
})().catch(err => {
  console.error("Backfill failed:", err.message);
  process.exit(1);
});
