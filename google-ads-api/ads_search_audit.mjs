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
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

async function getAccessToken(serviceAccountPath) {
  const serviceAccount = JSON.parse(await fs.readFile(serviceAccountPath, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/adwords",
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

function normalizeCustomerId(value, label) {
  const cleaned = String(value || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(cleaned)) {
    throw new Error(`${label} must be a 10 digit Google Ads customer ID.`);
  }
  return cleaned;
}

function resolveServiceAccountPath(env) {
  const configured = env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON;
  if (!configured) throw new Error("Set GOOGLE_ADS_SERVICE_ACCOUNT_JSON in .env.");
  return path.isAbsolute(configured) ? configured : path.resolve(root, configured);
}

async function search({ env, accessToken, customerId, loginCustomerId, title, query }) {
  const version = env.GOOGLE_ADS_API_VERSION || "v22";
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  const response = await fetch(`https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) {
    return { title, ok: false, status: response.status, error: text.slice(0, 4000), rows: [] };
  }
  const chunks = text ? JSON.parse(text) : [];
  return { title, ok: true, rows: chunks.flatMap((chunk) => chunk.results || []) };
}

function microsToYen(micros) {
  return Number(micros || 0) / 1_000_000;
}

function pct(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "";
  return `${(number * 100).toFixed(1)}%`;
}

function yen(value) {
  const number = Number(value || 0);
  return `¥${Math.round(number).toLocaleString("ja-JP")}`;
}

function compactReasons(reasons) {
  return Array.isArray(reasons) ? reasons.join(", ") : "";
}

function table(headers, rows) {
  const escape = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.map(escape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
}

function campaignIntent(name) {
  const text = String(name || "").toLowerCase();
  if (/renri|レンリ|ﾚﾝﾘ|brand|ブランド/.test(text)) return "Brand protection";
  if (/手作り/.test(text) && /地域|横浜|神奈川|東京/.test(text)) return "Handmade rings with geo terms";
  if (/手作り/.test(text)) return "Handmade rings local market";
  if (/オーダ|order/.test(text)) return "Order-made rings";
  return "Other";
}

function metricRow(row) {
  const metrics = row.metrics || {};
  const cost = microsToYen(metrics.costMicros);
  const conv = Number(metrics.conversions || 0);
  return {
    impressions: Number(metrics.impressions || 0),
    clicks: Number(metrics.clicks || 0),
    cost,
    conversions: conv,
    conversionValue: Number(metrics.conversionsValue || 0),
    ctr: Number(metrics.ctr || 0),
    averageCpc: microsToYen(metrics.averageCpc),
    costPerConversion: conv > 0 ? cost / conv : null,
  };
}

function getKeywordText(row) {
  return row.adGroupCriterion?.keyword?.text || "";
}

function getSearchTerm(row) {
  return row.searchTermView?.searchTerm || "";
}

function isLikelyWeakTerm(term) {
  return /無料|中古|求人|採用|作り方|材料|キット|自作|amazon|楽天|メルカリ|ティファニー|カルティエ|4℃|画像|写真|とは|意味|値段だけ|相場だけ/i.test(term);
}

function summarize(results, customerId) {
  const lines = [];
  const account = results.account?.rows?.[0]?.customer;
  lines.push("# Google Ads Search Audit");
  lines.push("");
  lines.push(`Generated: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);
  lines.push(`Customer: ${account?.descriptiveName || ""} (${customerId})`);
  lines.push("");

  for (const result of Object.values(results)) {
    if (!result || result.ok) continue;
    lines.push(`## API Error: ${result.title}`);
    lines.push("");
    lines.push(`Status ${result.status}`);
    lines.push("```");
    lines.push(result.error);
    lines.push("```");
    lines.push("");
  }

  const campaignRows = results.campaign30?.rows || [];
  lines.push("## Campaigns Last 30 Days");
  lines.push("");
  if (campaignRows.length) {
    lines.push(table(
      ["Intent", "Campaign", "Status", "Primary", "Bid", "Budget", "Impr", "Clicks", "CTR", "Cost", "Conv", "CPA", "Search IS", "Lost IS Budget", "Lost IS Rank"],
      campaignRows.map((row) => {
        const c = row.campaign || {};
        const m = metricRow(row);
        return [
          campaignIntent(c.name),
          c.name,
          c.status,
          c.primaryStatus,
          c.biddingStrategyType,
          yen(microsToYen(row.campaignBudget?.amountMicros)),
          m.impressions,
          m.clicks,
          pct(m.ctr),
          yen(m.cost),
          m.conversions.toFixed(2),
          m.costPerConversion === null ? "" : yen(m.costPerConversion),
          pct(row.metrics?.searchImpressionShare),
          pct(row.metrics?.searchBudgetLostImpressionShare),
          pct(row.metrics?.searchRankLostImpressionShare),
        ];
      }),
    ));
  } else {
    lines.push("No active Search campaign metrics were returned for the last 30 days.");
  }
  lines.push("");

  const geoRows = results.geoSettings?.rows || [];
  lines.push("## Location Setting");
  lines.push("");
  if (geoRows.length) {
    lines.push(table(
      ["Campaign", "Positive location option", "Negative location option"],
      geoRows.map((row) => [
        row.campaign?.name,
        row.campaign?.geoTargetTypeSetting?.positiveGeoTargetType,
        row.campaign?.geoTargetTypeSetting?.negativeGeoTargetType,
      ]),
    ));
  } else {
    lines.push("No location setting rows returned.");
  }
  lines.push("");

  const keywordRows = results.keywords30?.rows || [];
  lines.push("## Costly Keywords Last 30 Days");
  lines.push("");
  if (keywordRows.length) {
    lines.push(table(
      ["Campaign", "Ad group", "Keyword", "Match", "Status", "QS", "Impr", "Clicks", "Cost", "Conv", "CPA"],
      keywordRows.slice(0, 30).map((row) => {
        const m = metricRow(row);
        return [
          row.campaign?.name,
          row.adGroup?.name,
          getKeywordText(row),
          row.adGroupCriterion?.keyword?.matchType,
          row.adGroupCriterion?.status,
          row.adGroupCriterion?.qualityInfo?.qualityScore ?? "",
          m.impressions,
          m.clicks,
          yen(m.cost),
          m.conversions.toFixed(2),
          m.costPerConversion === null ? "" : yen(m.costPerConversion),
        ];
      }),
    ));
  } else {
    lines.push("No keyword metrics returned.");
  }
  lines.push("");

  const searchTermRows = results.searchTerms30?.rows || [];
  lines.push("## Search Terms Last 30 Days");
  lines.push("");
  if (searchTermRows.length) {
    lines.push(table(
      ["Campaign", "Ad group", "Search term", "Match", "Impr", "Clicks", "Cost", "Conv", "Flag"],
      searchTermRows.slice(0, 50).map((row) => {
        const m = metricRow(row);
        const term = getSearchTerm(row);
        return [
          row.campaign?.name,
          row.adGroup?.name,
          term,
          row.segments?.searchTermMatchType || "",
          m.impressions,
          m.clicks,
          yen(m.cost),
          m.conversions.toFixed(2),
          isLikelyWeakTerm(term) ? "negative candidate" : "",
        ];
      }),
    ));
  } else {
    lines.push("No search term rows returned.");
  }
  lines.push("");

  const negativeRows = [...(results.campaignNegatives?.rows || []), ...(results.adGroupNegatives?.rows || [])];
  lines.push("## Negative Keywords");
  lines.push("");
  if (negativeRows.length) {
    lines.push(table(
      ["Level", "Campaign", "Ad group", "Keyword", "Match", "Status"],
      negativeRows.slice(0, 120).map((row) => [
        row.adGroup ? "Ad group" : "Campaign",
        row.campaign?.name,
        row.adGroup?.name || "",
        row.adGroupCriterion?.keyword?.text || row.campaignCriterion?.keyword?.text,
        row.adGroupCriterion?.keyword?.matchType || row.campaignCriterion?.keyword?.matchType,
        row.adGroupCriterion?.status || row.campaignCriterion?.status,
      ]),
    ));
  } else {
    lines.push("No negative keywords returned.");
  }
  lines.push("");

  const conversionRows = results.conversionActions?.rows || [];
  lines.push("## Conversion Actions");
  lines.push("");
  if (conversionRows.length) {
    lines.push(table(
      ["Name", "Status", "Category", "Type", "Primary", "Included"],
      conversionRows.map((row) => [
        row.conversionAction?.name,
        row.conversionAction?.status,
        row.conversionAction?.category,
        row.conversionAction?.type,
        row.conversionAction?.primaryForGoal,
        row.conversionAction?.includeInConversionsMetric,
      ]),
    ));
  } else {
    lines.push("No conversion actions returned.");
  }
  lines.push("");

  lines.push("## Initial Findings");
  lines.push("");
  const activeCampaignRows = campaignRows.filter((row) => row.campaign?.status === "ENABLED");
  const presenceInterestRows = geoRows.filter((row) => row.campaign?.geoTargetTypeSetting?.positiveGeoTargetType === "PRESENCE_OR_INTEREST");
  if (presenceInterestRows.length) {
    lines.push(`- ${presenceInterestRows.length} Search campaigns use PRESENCE_OR_INTEREST. For local bridal searches, consider switching location option to PRESENCE unless the campaign is intentionally keyword-geo based.`);
  }
  const noConvCostlyKeywords = keywordRows
    .filter((row) => metricRow(row).cost >= 1000 && metricRow(row).conversions === 0)
    .slice(0, 10);
  if (noConvCostlyKeywords.length) {
    lines.push(`- ${noConvCostlyKeywords.length} high-cost keywords have no conversions in the last 30 days. Review match type, ad group intent, and landing page fit.`);
  }
  const weakTerms = searchTermRows.filter((row) => isLikelyWeakTerm(getSearchTerm(row))).slice(0, 10);
  if (weakTerms.length) {
    lines.push(`- ${weakTerms.length} search terms look like negative keyword candidates. Add exact/phrase negatives after checking intent.`);
  }
  const limitedAds = (results.ads30?.rows || []).filter((row) => /LIMITED|NOT_ELIGIBLE/i.test(`${row.adGroupAd?.policySummary?.approvalStatus || ""} ${row.adGroupAd?.primaryStatus || ""}`));
  if (limitedAds.length) {
    lines.push(`- ${limitedAds.length} ads are limited or not eligible. Check policy labels and primary status reasons.`);
  }
  const brandRows = activeCampaignRows.filter((row) => campaignIntent(row.campaign?.name) === "Brand protection");
  for (const row of brandRows) {
    const is = Number(row.metrics?.searchImpressionShare || 0);
    if (is && is < 0.9) lines.push(`- Brand campaign "${row.campaign?.name}" has Search IS ${pct(is)}. Brand protection should usually target near-full impression share.`);
  }
  if (!conversionRows.some((row) => row.conversionAction?.primaryForGoal && row.conversionAction?.includeInConversionsMetric)) {
    lines.push("- No primary included conversion action was obvious from the returned conversion actions. Confirm the account optimizes toward the intended purchase/inquiry action.");
  }
  if (!activeCampaignRows.length) {
    lines.push("- No enabled Search campaign metrics were returned for the last 30 days. Confirm campaign status/date range if this is unexpected.");
  }
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const env = await loadEnv();
  const customerId = normalizeCustomerId(env.GOOGLE_ADS_CUSTOMER_ID, "GOOGLE_ADS_CUSTOMER_ID");
  const loginCustomerId = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
    ? normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID, "GOOGLE_ADS_LOGIN_CUSTOMER_ID")
    : "";
  if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) throw new Error("Set GOOGLE_ADS_DEVELOPER_TOKEN in .env.");
  const accessToken = await getAccessToken(resolveServiceAccountPath(env));
  const options = { env, accessToken, customerId, loginCustomerId };

  const queries = {
    account: {
      title: "Account",
      query: `
        SELECT customer.id, customer.descriptive_name, customer.manager, customer.test_account
        FROM customer
        LIMIT 1
      `,
    },
    campaign30: {
      title: "Search campaigns last 30 days",
      query: `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.primary_status,
          campaign.primary_status_reasons,
          campaign.advertising_channel_type,
          campaign.bidding_strategy_type,
          campaign_budget.amount_micros,
          campaign_budget.status,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value,
          metrics.search_impression_share,
          metrics.search_top_impression_share,
          metrics.search_absolute_top_impression_share,
          metrics.search_budget_lost_impression_share,
          metrics.search_rank_lost_impression_share
        FROM campaign
        WHERE campaign.status != REMOVED
          AND campaign.advertising_channel_type = SEARCH
          AND segments.date DURING LAST_30_DAYS
        ORDER BY metrics.cost_micros DESC
      `,
    },
    geoSettings: {
      title: "Search campaign geo settings",
      query: `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.geo_target_type_setting.positive_geo_target_type,
          campaign.geo_target_type_setting.negative_geo_target_type
        FROM campaign
        WHERE campaign.status != REMOVED
          AND campaign.advertising_channel_type = SEARCH
        ORDER BY campaign.name
      `,
    },
    locations: {
      title: "Campaign location targets",
      query: `
        SELECT
          campaign.name,
          campaign_criterion.criterion_id,
          campaign_criterion.negative,
          campaign_criterion.status,
          campaign_criterion.location.geo_target_constant
        FROM campaign_criterion
        WHERE campaign_criterion.type = LOCATION
          AND campaign.status != REMOVED
        ORDER BY campaign.name
      `,
    },
    keywords30: {
      title: "Keywords last 30 days",
      query: `
        SELECT
          campaign.name,
          ad_group.name,
          ad_group_criterion.criterion_id,
          ad_group_criterion.status,
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type,
          ad_group_criterion.quality_info.quality_score,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value
        FROM keyword_view
        WHERE campaign.status != REMOVED
          AND campaign.advertising_channel_type = SEARCH
          AND ad_group_criterion.negative = FALSE
          AND segments.date DURING LAST_30_DAYS
        ORDER BY metrics.cost_micros DESC
        LIMIT 200
      `,
    },
    searchTerms30: {
      title: "Search terms last 30 days",
      query: `
        SELECT
          campaign.name,
          ad_group.name,
          search_term_view.search_term,
          search_term_view.status,
          segments.search_term_match_type,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.average_cpc,
          metrics.cost_micros,
          metrics.conversions,
          metrics.conversions_value
        FROM search_term_view
        WHERE campaign.status != REMOVED
          AND campaign.advertising_channel_type = SEARCH
          AND segments.date DURING LAST_30_DAYS
        ORDER BY metrics.cost_micros DESC
        LIMIT 200
      `,
    },
    ads30: {
      title: "Search ads last 30 days",
      query: `
        SELECT
          campaign.name,
          ad_group.name,
          ad_group_ad.status,
          ad_group_ad.primary_status,
          ad_group_ad.primary_status_reasons,
          ad_group_ad.policy_summary.approval_status,
          ad_group_ad.policy_summary.review_status,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions
        FROM ad_group_ad
        WHERE campaign.status != REMOVED
          AND campaign.advertising_channel_type = SEARCH
          AND segments.date DURING LAST_30_DAYS
        ORDER BY metrics.cost_micros DESC
        LIMIT 200
      `,
    },
    campaignNegatives: {
      title: "Campaign negative keywords",
      query: `
        SELECT
          campaign.name,
          campaign_criterion.status,
          campaign_criterion.keyword.text,
          campaign_criterion.keyword.match_type
        FROM campaign_criterion
        WHERE campaign_criterion.type = KEYWORD
          AND campaign_criterion.negative = TRUE
          AND campaign.status != REMOVED
        ORDER BY campaign.name
      `,
    },
    adGroupNegatives: {
      title: "Ad group negative keywords",
      query: `
        SELECT
          campaign.name,
          ad_group.name,
          ad_group_criterion.status,
          ad_group_criterion.keyword.text,
          ad_group_criterion.keyword.match_type
        FROM ad_group_criterion
        WHERE ad_group_criterion.type = KEYWORD
          AND ad_group_criterion.negative = TRUE
          AND campaign.status != REMOVED
        ORDER BY campaign.name, ad_group.name
      `,
    },
    conversionActions: {
      title: "Conversion actions",
      query: `
        SELECT
          conversion_action.name,
          conversion_action.status,
          conversion_action.type,
          conversion_action.category,
          conversion_action.primary_for_goal,
          conversion_action.include_in_conversions_metric
        FROM conversion_action
        WHERE conversion_action.status != REMOVED
        ORDER BY conversion_action.name
      `,
    },
  };

  const results = {};
  for (const [key, item] of Object.entries(queries)) {
    results[key] = await search({ ...options, title: item.title, query: item.query });
  }

  const outputDir = path.join(root, "output");
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  const jsonPath = path.join(outputDir, `search_audit_${stamp}.json`);
  const mdPath = path.join(outputDir, `search_audit_${stamp}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(results, null, 2), "utf8");
  await fs.writeFile(mdPath, summarize(results, customerId), "utf8");
  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
