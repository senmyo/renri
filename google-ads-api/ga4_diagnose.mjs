import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function loadEnv() {
  const text = await fs.readFile(path.join(root, ".env"), "utf8");
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = value;
  }
  return env;
}

async function getAccessToken(serviceAccountPath) {
  const serviceAccount = JSON.parse(await fs.readFile(serviceAccountPath, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), serviceAccount.private_key);
  const assertion = `${unsigned}.${base64url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`OAuth token request failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()).access_token;
}

function resolveServiceAccountPath(env) {
  const configured = env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON || env.GA4_SERVICE_ACCOUNT_JSON;
  if (!configured) {
    throw new Error("Set GOOGLE_ADS_SERVICE_ACCOUNT_JSON or GA4_SERVICE_ACCOUNT_JSON in .env.");
  }
  return path.isAbsolute(configured) ? configured : path.resolve(root, configured);
}

function normalizePropertyId(value) {
  const cleaned = String(value || "").replace(/\D/g, "");
  if (!cleaned) {
    throw new Error("Set GA4_PROPERTY_ID in .env. Use the numeric GA4 property ID, not the G- measurement ID.");
  }
  return cleaned;
}

async function ga4Fetch({ accessToken, propertyId, endpoint, body }) {
  const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}${endpoint}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, error: text.slice(0, 4000), rows: [] };
  }
  return { ok: true, data: text ? JSON.parse(text) : {} };
}

async function getMetadata(options) {
  const result = await ga4Fetch({ ...options, endpoint: "/metadata" });
  if (!result.ok) return result;
  const metricNames = new Set((result.data.metrics || []).map((metric) => metric.apiName));
  const dimensionNames = new Set((result.data.dimensions || []).map((dimension) => dimension.apiName));
  return { ...result, metricNames, dimensionNames };
}

function pickAvailable(available, candidates, minimum = 1) {
  const picked = candidates.filter((name) => available.has(name));
  if (picked.length < minimum) {
    throw new Error(`Required GA4 fields are unavailable. Tried: ${candidates.join(", ")}`);
  }
  return picked;
}

async function runReport({ accessToken, propertyId, title, dimensions, metrics, dateRanges, limit = 20, orderBys }) {
  const body = {
    dateRanges,
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    limit,
  };
  if (orderBys) body.orderBys = orderBys;

  const result = await ga4Fetch({ accessToken, propertyId, endpoint: ":runReport", body });
  if (!result.ok) return { title, ok: false, status: result.status, error: result.error, rows: [] };

  const rows = (result.data.rows || []).map((row) => ({
    dimensions: Object.fromEntries(dimensions.map((name, index) => [name, row.dimensionValues?.[index]?.value || ""])),
    metrics: Object.fromEntries(metrics.map((name, index) => [name, row.metricValues?.[index]?.value || "0"])),
  }));
  return { title, ok: true, dimensions, metrics, rows, totals: result.data.totals || [] };
}

function table(headers, rows) {
  const escape = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.map(escape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
}

function formatNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString("ja-JP", { maximumFractionDigits: 2 }) : value;
}

function summarize(results, propertyId) {
  const lines = [];
  lines.push("# GA4 Diagnosis");
  lines.push("");
  lines.push(`Generated: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);
  lines.push(`Property ID: ${propertyId}`);
  lines.push("");

  for (const result of Object.values(results)) {
    lines.push(`## ${result.title}`);
    lines.push("");
    if (!result.ok) {
      lines.push(`API error ${result.status}:`);
      lines.push("```");
      lines.push(result.error);
      lines.push("```");
      lines.push("");
      continue;
    }

    if (!result.rows.length) {
      lines.push("No rows returned.");
      lines.push("");
      continue;
    }

    const headers = [...result.dimensions, ...result.metrics];
    const rows = result.rows.map((row) => [
      ...result.dimensions.map((name) => row.dimensions[name]),
      ...result.metrics.map((name) => formatNumber(row.metrics[name])),
    ]);
    lines.push(table(headers, rows));
    lines.push("");
  }

  lines.push("## Initial Reading");
  lines.push("");
  const events = results.events?.rows || [];
  const purchaseEvent = events.find((row) => /purchase|in_app_purchase/i.test(row.dimensions.eventName));
  if (!purchaseEvent) {
    lines.push("- purchase event was not returned in the top events for the last 30 days. Confirm GA4 ecommerce purchase tracking and event naming.");
  }
  const googleCpc = (results.channels?.rows || []).find((row) => /google/i.test(row.dimensions.sessionSourceMedium || "") && /cpc/i.test(row.dimensions.sessionSourceMedium || ""));
  if (!googleCpc) {
    lines.push("- google / cpc did not appear in the top source/medium rows. Confirm Google Ads auto-tagging, GA4-Google Ads link, and campaign traffic volume.");
  }
  if (!events.length) {
    lines.push("- No event rows were returned. Check property ID and GA4 access if this is unexpected.");
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const env = await loadEnv();
  const propertyId = normalizePropertyId(env.GA4_PROPERTY_ID || env.GOOGLE_ANALYTICS_PROPERTY_ID);
  const serviceAccountPath = resolveServiceAccountPath(env);
  const accessToken = await getAccessToken(serviceAccountPath);
  const metadata = await getMetadata({ accessToken, propertyId });

  if (!metadata.ok) {
    throw new Error(`GA4 metadata request failed: ${metadata.status} ${metadata.error}`);
  }

  const metricCandidates = [
    "sessions",
    "totalUsers",
    "activeUsers",
    "newUsers",
    "engagedSessions",
    "eventCount",
    "keyEvents",
    "conversions",
    "ecommercePurchases",
    "purchaseRevenue",
    "totalRevenue",
  ];
  const summaryMetrics = pickAvailable(metadata.metricNames, metricCandidates, 3);
  const revenueMetrics = pickAvailable(metadata.metricNames, ["purchaseRevenue", "totalRevenue", "ecommercePurchases", "keyEvents", "conversions", "eventCount"], 1);
  const eventMetrics = pickAvailable(metadata.metricNames, ["eventCount", "keyEvents", "conversions", "totalUsers"], 1);

  const dateRanges = [{ startDate: "30daysAgo", endDate: "yesterday" }];
  const results = {
    summary: await runReport({
      accessToken,
      propertyId,
      title: "Last 30 Days Summary",
      dimensions: [],
      metrics: summaryMetrics,
      dateRanges,
      limit: 1,
    }),
    channels: await runReport({
      accessToken,
      propertyId,
      title: "Source / Medium",
      dimensions: pickAvailable(metadata.dimensionNames, ["sessionSourceMedium"]),
      metrics: summaryMetrics.slice(0, 6),
      dateRanges,
      limit: 20,
      orderBys: [{ metric: { metricName: summaryMetrics[0] }, desc: true }],
    }),
    landingPages: await runReport({
      accessToken,
      propertyId,
      title: "Landing Pages",
      dimensions: pickAvailable(metadata.dimensionNames, ["landingPagePlusQueryString", "landingPage"], 1).slice(0, 1),
      metrics: [...new Set(["sessions", ...revenueMetrics].filter((name) => metadata.metricNames.has(name)))],
      dateRanges,
      limit: 20,
      orderBys: [{ metric: { metricName: metadata.metricNames.has("sessions") ? "sessions" : revenueMetrics[0] }, desc: true }],
    }),
    events: await runReport({
      accessToken,
      propertyId,
      title: "Events",
      dimensions: pickAvailable(metadata.dimensionNames, ["eventName"]),
      metrics: eventMetrics,
      dateRanges,
      limit: 30,
      orderBys: [{ metric: { metricName: eventMetrics[0] }, desc: true }],
    }),
  };

  const outputDir = path.join(root, "output");
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  const jsonPath = path.join(outputDir, `ga4_diagnosis_${stamp}.json`);
  const mdPath = path.join(outputDir, `ga4_diagnosis_${stamp}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(results, null, 2), "utf8");
  await fs.writeFile(mdPath, summarize(results, propertyId), "utf8");

  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
