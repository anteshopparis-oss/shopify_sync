const axios = require("axios");

// ===============================
// 🔄 PRODUCT SYNC (Baakman catalogue → Shopify product status)
// ===============================
// Any Shopify product whose SKUs are all missing from the Baakman catalogue,
// or out of stock there, is set to DRAFT (hidden from the store) and tagged.
// When the SKU is available again, products carrying that tag are set to
// ACTIVE again.
// Products drafted by hand (no tag) are never reactivated.

const SYNC_TAG = "baakman-unavailable";
const SHOPIFY_STORE = process.env.SHOPIFY_STORE; // e.g. my-shop.myshopify.com
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";

// ---------- Shopify auth ----------
// Either a fixed Admin API token (SHOPIFY_ACCESS_TOKEN), or the app's
// client ID + secret, exchanged for a token (valid ~24h) when needed.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getShopifyToken() {
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;

  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  const response = await axios.post(
    `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET
    })
  );

  cachedToken = response.data.access_token;
  // refresh 5 minutes before it expires
  cachedTokenExpiresAt = Date.now() + ((response.data.expires_in || 86400) - 300) * 1000;
  return cachedToken;
}

function isShopifyConfigured() {
  return Boolean(
    SHOPIFY_STORE &&
    (process.env.SHOPIFY_ACCESS_TOKEN ||
      (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET))
  );
}

async function shopifyGraphql(query, variables = {}, attempt = 1) {
  const token = await getShopifyToken();

  const response = await axios.post(
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    { query, variables },
    { headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" } }
  );

  const errors = response.data.errors;
  if (errors) {
    const throttled = errors.some(e => e.extensions?.code === "THROTTLED");
    if (throttled && attempt <= 5) {
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      return shopifyGraphql(query, variables, attempt + 1);
    }
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(errors)}`);
  }

  return response.data.data;
}

// ---------- Shopify queries ----------
const PRODUCTS_QUERY = `
  query Products($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        status
        tags
        variants(first: 10) { nodes { sku } }
      }
    }
  }
`;

const SET_STATUS_MUTATION = `
  mutation SetStatus($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      userErrors { field message }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }
`;

const TAGS_REMOVE_MUTATION = `
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }
`;

async function getAllShopifyProducts() {
  const products = [];
  let cursor = null;

  do {
    const data = await shopifyGraphql(PRODUCTS_QUERY, { cursor });
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  return products;
}

async function runMutation(mutation, variables, key) {
  const data = await shopifyGraphql(mutation, variables);
  const userErrors = data[key]?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(`${key} failed: ${JSON.stringify(userErrors)}`);
  }
}

async function setProductStatus(product, status) {
  await runMutation(SET_STATUS_MUTATION, { product: { id: product.id, status } }, "productUpdate");

  if (status === "DRAFT") {
    await runMutation(TAGS_ADD_MUTATION, { id: product.id, tags: [SYNC_TAG] }, "tagsAdd");
  } else {
    await runMutation(TAGS_REMOVE_MUTATION, { id: product.id, tags: [SYNC_TAG] }, "tagsRemove");
  }
}

// ---------- sync ----------
// Shopify SKUs sometimes carry a "DS" prefix that Baakman codes don't have
// (Shopify "DSXT-126" = Baakman "XT-126"). Baakman has no codes starting with DS.
function toBaakmanCode(sku) {
  return String(sku || "").trim().toUpperCase().replace(/^DS(?=[A-Z]+-)/, "");
}

// Baakman stock indicators (API in Dutch, CSV export in English):
//   Ruime voorraad / Large stock, Beperkte voorraad / Limited stock,
//   Wordt verwacht / To be expected, OUT OF STOCK / NO STOCK
const OUT_OF_STOCK = ["OUT OF STOCK", "NO STOCK"];
const EXPECTED = ["WORDT VERWACHT", "TO BE EXPECTED"];

// PRODUCT_SYNC_HIDE_EXPECTED=on also hides "expected" (not in stock yet) products
function unavailableReason(stockIndicator) {
  const stock = String(stockIndicator || "").trim().toUpperCase();
  if (OUT_OF_STOCK.includes(stock)) return "out of stock at Baakman";
  if (EXPECTED.includes(stock) && process.env.PRODUCT_SYNC_HIDE_EXPECTED === "on") {
    return "not in stock yet at Baakman (expected)";
  }
  return null;
}

/**
 * @param {() => Promise<Array>} fetchBaakmanCatalogue - must throw on failure
 * @param {{ dryRun: boolean }} options
 */
async function syncProducts(fetchBaakmanCatalogue, { dryRun }) {
  const catalogue = await fetchBaakmanCatalogue();

  // never act on an empty catalogue — it would hide the whole store
  if (!Array.isArray(catalogue) || catalogue.length === 0) {
    throw new Error("Baakman catalogue is empty — sync aborted, nothing changed");
  }

  const stockByCode = new Map(
    catalogue.map(p => [String(p.code || "").trim().toUpperCase(), p.stockIndicator])
  );
  const shopifyProducts = await getAllShopifyProducts();

  const toDisable = [];
  const toEnable = [];

  for (const product of shopifyProducts) {
    const skus = product.variants.nodes.map(v => String(v.sku || "").trim()).filter(Boolean);
    if (skus.length === 0) continue; // no SKU → not a Baakman product, leave it alone

    // available if at least one variant is in the catalogue and in stock
    const reasons = skus.map(sku => {
      const code = toBaakmanCode(sku);
      if (!stockByCode.has(code)) return "not in Baakman catalogue";
      return unavailableReason(stockByCode.get(code));
    });
    const available = reasons.some(reason => reason === null);
    const disabledBySync = product.tags.includes(SYNC_TAG);

    if (!available && product.status === "ACTIVE") {
      toDisable.push({ product, skus, reason: [...new Set(reasons)].join(", ") });
    } else if (available && disabledBySync && product.status === "DRAFT") {
      toEnable.push({ product, skus });
    }
  }

  const label = dryRun ? "[PREVIEW] would " : "";
  const failures = [];

  for (const { product, skus, reason } of toDisable) {
    console.log(`🚫 ${label}disable "${product.title}" (${skus.join(", ")}) — ${reason}`);
    if (!dryRun) {
      try {
        await setProductStatus(product, "DRAFT");
      } catch (err) {
        failures.push(`${product.title}: ${err.message}`);
      }
    }
  }

  for (const { product, skus } of toEnable) {
    console.log(`✅ ${label}re-enable "${product.title}" (${skus.join(", ")}) — available again at Baakman`);
    if (!dryRun) {
      try {
        await setProductStatus(product, "ACTIVE");
      } catch (err) {
        failures.push(`${product.title}: ${err.message}`);
      }
    }
  }

  const summary = {
    dryRun,
    shopifyProducts: shopifyProducts.length,
    baakmanProducts: catalogue.length,
    disabled: toDisable.map(({ product, skus, reason }) => ({ title: product.title, skus, reason })),
    reEnabled: toEnable.map(({ product, skus }) => ({ title: product.title, skus })),
    failures
  };

  console.log(
    `🔄 Product sync ${dryRun ? "preview" : "done"}: ` +
    `${toDisable.length} to disable, ${toEnable.length} to re-enable, ${failures.length} failures ` +
    `(${shopifyProducts.length} Shopify products checked against ${catalogue.length} Baakman products)`
  );

  return summary;
}

module.exports = { syncProducts, isShopifyConfigured, toBaakmanCode };
