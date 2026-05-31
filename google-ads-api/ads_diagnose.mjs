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
  const envPath = path.join(root, ".env");
  const examplePath = path.join(root, ".env.example");
  let text = "";
  try {
    text = await fs.readFile(envPath, "utf8");
  } catch {
    await fs.copyFile(examplePath, envPath);
    throw new Error(`Created ${envPath}. Fill GOOGLE_ADS_DEVELOPER_TOKEN, then run this script again.`);
  }

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

async function findServiceAccountJson(env) {
  if (env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON) {
    return path.resolve(root, env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON);
  }
  const files = await fs.readdir(root);
  const jsonFiles = files.filter((file) => file.endsWith(".json"));
  if (jsonFiles.length !== 1) {
    throw new Error("Set GOOGLE_ADS_SERVICE_ACCOUNT_JSON in .env.");
  }
  return path.join(root, jsonFiles[0]);
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

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`OAuth token request failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.access_token;
}

function normalizeCustomerId(value, label) {
  const cleaned = String(value || "").replace(/\D/g, "");
  if (!/^\d{10}$/.test(cleaned)) {
    throw new Error(`${label} must be a 10 digit Google Ads customer ID.`);
  }
  return cleaned;
}

async function search({ env, accessToken, customerId, query, title, loginCustomerId }) {
  const version = env.GOOGLE_ADS_API_VERSION || "v22";
  const url = `https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:searchStream`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) {
    return {
      title,
      ok: false,
      status: response.status,
      error: text.slice(0, 4000),
      rows: [],
    };
  }

  const chunks = text ? JSON.parse(text) : [];
  const rows = chunks.flatMap((chunk) => chunk.results || []);
  return { title, ok: true, rows };
}

function isPermissionDenied(result) {
  return !result.ok && /USER_PERMISSION_DENIED|PERMISSION_DENIED/i.test(result.error || "");
}

function microsToCurrency(micros) {
  const value = Number(micros || 0) / 1_000_000;
  return Math.round(value).toLocaleString("ja-JP");
}

function compactReasons(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return "";
  return reasons.join(", ");
}

function table(headers, rows) {
  const escape = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.map(escape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
}

function summarize(results) {
  const lines = [];
  lines.push("# Google Ads Display Remarketing Diagnosis");
  lines.push("");
  lines.push(`Generated: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);
  lines.push("");

  const account = results.account?.rows?.[0]?.customer;
  if (account) {
    lines.push(`Account: ${account.descriptiveName || ""} (${account.id || ""})`);
    lines.push("");
  }

  for (const result of Object.values(results)) {
    if (!result || result.ok) continue;
    lines.push(`## ${result.title}`);
    lines.push("");
    lines.push(`API error ${result.status}:`);
    lines.push("```");
    lines.push(result.error);
    lines.push("```");
    lines.push("");
  }

  const campaignRows = results.campaigns?.rows || [];
  lines.push("## Display Campaigns");
  lines.push("");
  if (campaignRows.length) {
    lines.push(table(
      ["Campaign", "Status", "Primary status", "Reasons", "Impr", "Clicks", "Cost"],
      campaignRows.map((row) => [
        row.campaign?.name,
        row.campaign?.status,
        row.campaign?.primaryStatus,
        compactReasons(row.campaign?.primaryStatusReasons),
        row.metrics?.impressions || 0,
        row.metrics?.clicks || 0,
        `¥${microsToCurrency(row.metrics?.costMicros)}`,
      ]),
    ));
  } else {
    lines.push("No Display campaigns returned for the last 30 days.");
  }
  lines.push("");

  const adGroupRows = results.adGroups?.rows || [];
  lines.push("## Display Ad Groups");
  lines.push("");
  if (adGroupRows.length) {
    lines.push(table(
      ["Campaign", "Ad group", "Status", "Primary status", "Reasons", "Impr", "Clicks"],
      adGroupRows.map((row) => [
        row.campaign?.name,
        row.adGroup?.name,
        row.adGroup?.status,
        row.adGroup?.primaryStatus,
        compactReasons(row.adGroup?.primaryStatusReasons),
        row.metrics?.impressions || 0,
        row.metrics?.clicks || 0,
      ]),
    ));
  } else {
    lines.push("No Display ad groups returned for the last 30 days.");
  }
  lines.push("");

  const adRows = results.ads?.rows || [];
  lines.push("## Ads");
  lines.push("");
  if (adRows.length) {
    lines.push(table(
      ["Campaign", "Ad group", "Ad ID", "Status", "Approval", "Review", "Primary status", "Reasons", "Impr"],
      adRows.map((row) => [
        row.campaign?.name,
        row.adGroup?.name,
        row.adGroupAd?.ad?.id,
        row.adGroupAd?.status,
        row.adGroupAd?.policySummary?.approvalStatus,
        row.adGroupAd?.policySummary?.reviewStatus,
        row.adGroupAd?.primaryStatus,
        compactReasons(row.adGroupAd?.primaryStatusReasons),
        row.metrics?.impressions || 0,
      ]),
    ));
  } else {
    lines.push("No Display ads returned for the last 30 days.");
  }
  lines.push("");

  const userListRows = results.userLists?.rows || [];
  lines.push("## User Lists");
  lines.push("");
  if (userListRows.length) {
    lines.push(table(
      ["List", "Status", "Type", "Display size", "Search size", "Eligible display", "Eligible search"],
      userListRows.map((row) => [
        row.userList?.name,
        row.userList?.membershipStatus,
        row.userList?.type,
        row.userList?.sizeForDisplay ?? "",
        row.userList?.sizeForSearch ?? "",
        row.userList?.eligibleForDisplay ?? "",
        row.userList?.eligibleForSearch ?? "",
      ]),
    ));
  } else {
    lines.push("No user lists returned.");
  }
  lines.push("");

  const criteriaRows = results.userListCriteria?.rows || [];
  lines.push("## Audience Criteria");
  lines.push("");
  if (criteriaRows.length) {
    lines.push(table(
      ["Campaign", "Ad group", "Criterion", "Status", "Type", "User list"],
      criteriaRows.map((row) => [
        row.campaign?.name,
        row.adGroup?.name,
        `${row.adGroupCriterion?.negative ? "EXCLUDE: " : ""}${row.adGroupCriterion?.displayName || row.adGroupCriterion?.criterionId}`,
        row.adGroupCriterion?.status,
        row.adGroupCriterion?.type,
        row.adGroupCriterion?.userList?.userList || "",
      ]),
    ));
  } else {
    lines.push("No user-list audience criteria returned.");
  }
  lines.push("");

  const allImpressions = [
    ...campaignRows.map((row) => Number(row.metrics?.impressions || 0)),
    ...adGroupRows.map((row) => Number(row.metrics?.impressions || 0)),
    ...adRows.map((row) => Number(row.metrics?.impressions || 0)),
  ];
  const hasZeroImpressions = allImpressions.length && allImpressions.every((value) => value === 0);
  const smallLists = userListRows
    .map((row) => row.userList)
    .filter((list) => list && Number(list.sizeForDisplay || 0) > 0 && Number(list.sizeForDisplay || 0) < 100);
  const emptyOrUnknownLists = userListRows
    .map((row) => row.userList)
    .filter((list) => list && Number(list.sizeForDisplay || 0) === 0);

  lines.push("## Initial Reading");
  lines.push("");
  if (hasZeroImpressions && smallLists.length) {
    lines.push("- All checked Display entities have 0 impressions, and at least one selected user list appears below the common Display serving threshold of 100 active users.");
  }
  if (hasZeroImpressions && emptyOrUnknownLists.length) {
    lines.push("- All checked Display entities have 0 impressions, and some user lists have display size 0 or unavailable. Audience size/eligibility is the first suspect.");
  }
  if (!criteriaRows.length) {
    lines.push("- No user-list criteria were returned. Check whether the remarketing lists are attached at ad-group level, campaign level, or through a different targeting setting.");
  }
  if (!campaignRows.length || !adGroupRows.length || !adRows.length) {
    lines.push("- Some Display entities were not returned. This can happen if the campaign is outside the last 30-day metrics window, not a Display campaign, or the query fields need adjustment.");
  }
  if (!hasZeroImpressions && allImpressions.length) {
    lines.push("- At least one checked entity has impressions, so the issue may be date range, UI filtering, or a specific ad group/ad rather than account-wide non-serving.");
  }
  lines.push("");

  lines.push("Recommended next checks:");
  lines.push("- If selected lists are under 100 display users, add a broader list such as product viewers 30 days or all visitors 30 days, or temporarily enable optimized targeting for a test.");
  lines.push("- If campaign/ad/ad-group primary status is not eligible, address the listed status reason first.");
  lines.push("- If ads are approved and lists are eligible but impressions remain 0, review budget, bid strategy, exclusions, dynamic feed/product approval, and schedule settings.");
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const env = await loadEnv();
  if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    throw new Error("Set GOOGLE_ADS_DEVELOPER_TOKEN in google-ads-api/.env.");
  }
  const customerId = normalizeCustomerId(env.GOOGLE_ADS_CUSTOMER_ID, "GOOGLE_ADS_CUSTOMER_ID");
  const loginCustomerId = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
    ? normalizeCustomerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID, "GOOGLE_ADS_LOGIN_CUSTOMER_ID")
    : "";
  const serviceAccountPath = await findServiceAccountJson(env);
  const accessToken = await getAccessToken(serviceAccountPath);

  const queryOptions = { env, accessToken, customerId, loginCustomerId };
  const queries = {
    account: {
      title: "Account",
      query: `
        SELECT
          customer.id,
          customer.descriptive_name,
          customer.manager,
          customer.test_account
        FROM customer
        LIMIT 1
      `,
    },
    campaigns: {
      title: "Display campaigns",
      query: `
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.primary_status,
          campaign.primary_status_reasons,
          campaign.advertising_channel_type,
          campaign.serving_status,
          campaign.start_date,
          campaign.end_date,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions
        FROM campaign
        WHERE campaign.advertising_channel_type = DISPLAY
          AND segments.date DURING LAST_30_DAYS
        ORDER BY campaign.id
      `,
    },
    adGroups: {
      title: "Display ad groups",
      query: `
        SELECT
          campaign.name,
          ad_group.id,
          ad_group.name,
          ad_group.status,
          ad_group.primary_status,
          ad_group.primary_status_reasons,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros
        FROM ad_group
        WHERE campaign.advertising_channel_type = DISPLAY
          AND segments.date DURING LAST_30_DAYS
        ORDER BY campaign.name, ad_group.name
      `,
    },
    ads: {
      title: "Display ads",
      query: `
        SELECT
          campaign.name,
          ad_group.name,
          ad_group_ad.ad.id,
          ad_group_ad.status,
          ad_group_ad.policy_summary.approval_status,
          ad_group_ad.policy_summary.review_status,
          ad_group_ad.primary_status,
          ad_group_ad.primary_status_reasons,
          metrics.impressions,
          metrics.clicks
        FROM ad_group_ad
        WHERE campaign.advertising_channel_type = DISPLAY
          AND segments.date DURING LAST_30_DAYS
        ORDER BY campaign.name, ad_group.name
      `,
    },
    userLists: {
      title: "User lists",
      query: `
        SELECT
          user_list.id,
          user_list.name,
          user_list.membership_status,
          user_list.type,
          user_list.size_for_display,
          user_list.size_for_search,
          user_list.eligible_for_display,
          user_list.eligible_for_search
        FROM user_list
        ORDER BY user_list.name
      `,
    },
    userListCriteria: {
      title: "Audience criteria",
      query: `
        SELECT
          campaign.name,
          ad_group.name,
          ad_group_criterion.criterion_id,
          ad_group_criterion.display_name,
          ad_group_criterion.status,
          ad_group_criterion.negative,
          ad_group_criterion.type,
          ad_group_criterion.user_list.user_list
        FROM ad_group_criterion
        WHERE campaign.advertising_channel_type = DISPLAY
          AND ad_group_criterion.type = USER_LIST
        ORDER BY campaign.name, ad_group.name
      `,
    },
  };

  const results = {};
  for (const [key, item] of Object.entries(queries)) {
    let result = await search({ ...queryOptions, title: item.title, query: item.query });
    if (loginCustomerId && isPermissionDenied(result)) {
      const directResult = await search({
        ...queryOptions,
        loginCustomerId: "",
        title: `${item.title} (direct access retry)`,
        query: item.query,
      });
      result = directResult.ok ? directResult : result;
    }
    results[key] = result;
  }

  const outputDir = path.join(root, "output");
  await fs.mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  const jsonPath = path.join(outputDir, `diagnosis_${stamp}.json`);
  const mdPath = path.join(outputDir, `diagnosis_${stamp}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(results, null, 2), "utf8");
  await fs.writeFile(mdPath, summarize(results), "utf8");

  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
