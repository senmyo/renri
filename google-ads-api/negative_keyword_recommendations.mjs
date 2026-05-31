import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const auditPath = path.join(root, "output", "search_audit_20260527_054513.json");

const targetCampaigns = [
  "ブランド名",
  "結婚指輪 手作り",
  "結婚指輪 手作り 地域_",
  "結婚指輪 オーダー 地域_",
];

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[　\s]+/g, " ")
    .trim();
}

function yen(micros) {
  return Math.round(Number(micros || 0) / 1_000_000);
}

function conv(value) {
  return Number(value || 0);
}

function addCurrentNegative(map, campaign, text, matchType, level, adGroup = "") {
  if (!targetCampaigns.includes(campaign)) return;
  const key = campaign;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push({
    text: norm(text),
    originalText: text,
    matchType,
    level,
    adGroup,
  });
}

function alreadyCovered(negatives, campaign, candidate, matchType) {
  const text = norm(candidate);
  const campaignNegatives = negatives.get(campaign) || [];
  return campaignNegatives.some((negative) => {
    if (negative.text === text) return true;
    if (negative.matchType === "BROAD") {
      const words = negative.text.split(" ").filter(Boolean);
      return words.length > 0 && words.every((word) => text.includes(word));
    }
    if (negative.matchType === "PHRASE") {
      return text.includes(negative.text);
    }
    if (matchType === "PHRASE" && negative.text && text.includes(negative.text)) return true;
    return false;
  });
}

function candidate(campaign, keyword, matchType, reason, examples) {
  return { campaign, keyword, matchType, reason, examples };
}

function matchSearchTerms(terms, campaign, patterns) {
  return terms
    .filter((row) => row.campaign?.name === campaign)
    .filter((row) => patterns.some((pattern) => norm(row.searchTermView?.searchTerm).includes(norm(pattern))))
    .map((row) => ({
      term: row.searchTermView.searchTerm,
      clicks: Number(row.metrics?.clicks || 0),
      cost: yen(row.metrics?.costMicros),
      conversions: conv(row.metrics?.conversions),
    }))
    .sort((a, b) => b.cost - a.cost);
}

function summarizeExamples(rows) {
  return rows.slice(0, 4).map((row) => `${row.term} (${row.clicks} clicks, ¥${row.cost.toLocaleString("ja-JP")}, CV ${row.conversions})`);
}

function table(headers, rows) {
  const escape = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${headers.map(escape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ].join("\n");
}

const data = JSON.parse(await fs.readFile(auditPath, "utf8"));
const negatives = new Map();

for (const row of data.campaignNegatives?.rows || []) {
  addCurrentNegative(
    negatives,
    row.campaign?.name,
    row.campaignCriterion?.keyword?.text,
    row.campaignCriterion?.keyword?.matchType,
    "Campaign",
  );
}

for (const row of data.adGroupNegatives?.rows || []) {
  addCurrentNegative(
    negatives,
    row.campaign?.name,
    row.adGroupCriterion?.keyword?.text,
    row.adGroupCriterion?.keyword?.matchType,
    "Ad group",
    row.adGroup?.name,
  );
}

const terms = data.searchTerms30?.rows || [];
const recs = [];

const brandInHandmade = matchSearchTerms(terms, "結婚指輪 手作り", ["renri", "レンリ"]);
if (brandInHandmade.length) {
  recs.push(candidate("結婚指輪 手作り", "renri", "PHRASE", "ブランド語句はブランドキャンペーンへ寄せる", summarizeExamples(brandInHandmade)));
  recs.push(candidate("結婚指輪 手作り", "レンリ", "PHRASE", "ブランド語句はブランドキャンペーンへ寄せる", summarizeExamples(brandInHandmade)));
}

const brandInHandmadeGeo = matchSearchTerms(terms, "結婚指輪 手作り 地域_", ["renri", "レンリ"]);
if (brandInHandmadeGeo.length) {
  recs.push(candidate("結婚指輪 手作り 地域_", "renri", "PHRASE", "ブランド語句はブランドキャンペーンへ寄せる", summarizeExamples(brandInHandmadeGeo)));
  recs.push(candidate("結婚指輪 手作り 地域_", "レンリ", "PHRASE", "ブランド語句はブランドキャンペーンへ寄せる", summarizeExamples(brandInHandmadeGeo)));
}

const brandInOrderGeo = matchSearchTerms(terms, "結婚指輪 オーダー 地域_", ["renri", "レンリ"]);
if (brandInOrderGeo.length) {
  recs.push(candidate("結婚指輪 オーダー 地域_", "renri", "PHRASE", "ブランド語句はブランドキャンペーンへ寄せる", summarizeExamples(brandInOrderGeo)));
  recs.push(candidate("結婚指輪 オーダー 地域_", "レンリ", "PHRASE", "ブランド語句はブランドキャンペーンへ寄せる", summarizeExamples(brandInOrderGeo)));
}

const orderHandmadeTerms = matchSearchTerms(terms, "結婚指輪 オーダー 地域_", ["手作り", "作る", "ハンドメイド", "自作"]);
if (orderHandmadeTerms.length) {
  recs.push(candidate("結婚指輪 オーダー 地域_", "手作り", "PHRASE", "オーダー意図から手作り・自作意図を分離", summarizeExamples(orderHandmadeTerms)));
  recs.push(candidate("結婚指輪 オーダー 地域_", "作る", "PHRASE", "オーダー意図から制作体験系を分離", summarizeExamples(orderHandmadeTerms)));
  recs.push(candidate("結婚指輪 オーダー 地域_", "ハンドメイド", "PHRASE", "オーダー意図から手作り意図を分離", summarizeExamples(orderHandmadeTerms)));
  recs.push(candidate("結婚指輪 オーダー 地域_", "自作", "PHRASE", "オーダー意図から自作意図を分離", summarizeExamples(orderHandmadeTerms)));
}

const competitorCandidates = [
  ["結婚指輪 手作り", "リングラム", ["リング ラム", "ringram"]],
  ["結婚指輪 手作り 地域_", "リングラム", ["リング ラム", "ringram"]],
  ["結婚指輪 手作り 地域_", "crafy", ["crafy"]],
  ["結婚指輪 オーダー 地域_", "リングラム", ["リング ラム", "ringram"]],
  ["結婚指輪 オーダー 地域_", "アカネス", ["アカネス"]],
  ["結婚指輪 オーダー 地域_", "somm jewelry", ["somm jewelry"]],
];

for (const [campaign, keyword, patterns] of competitorCandidates) {
  const rows = matchSearchTerms(terms, campaign, patterns);
  if (rows.length) {
    recs.push(candidate(campaign, keyword, "PHRASE", "競合・別ブランド名。比較目的を残す方針でなければ除外", summarizeExamples(rows)));
  }
}

const tokyoRows = matchSearchTerms(terms, "結婚指輪 手作り", ["東京"]);
if (tokyoRows.length) {
  recs.push(candidate("結婚指輪 手作り", "東京", "PHRASE", "神奈川商圏キャンペーンで東京語句がCVなし。東京も商圏なら保留", summarizeExamples(tokyoRows)));
}

const brandLowIntentRows = matchSearchTerms(terms, "ブランド名", ["値段", "婚約"]);
if (brandLowIntentRows.length) {
  recs.push(candidate("ブランド名", "婚約 指輪", "PHRASE", "ブランド防衛対象を結婚指輪/来店予約に寄せるなら婚約指輪意図を分離", summarizeExamples(brandLowIntentRows)));
}

const filtered = recs.filter((rec) => !alreadyCovered(negatives, rec.campaign, rec.keyword, rec.matchType));
const outputDir = path.join(root, "output");
await fs.mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
const mdPath = path.join(outputDir, `negative_keyword_recommendations_${stamp}.md`);
const jsonPath = path.join(outputDir, `negative_keyword_recommendations_${stamp}.json`);

const lines = [];
lines.push("# Negative Keyword Recommendations");
lines.push("");
lines.push(`Generated: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);
lines.push("");
lines.push("## Current Negative Keyword Counts");
lines.push("");
lines.push(table(
  ["Campaign", "Campaign negatives", "Ad group negatives", "Broad", "Phrase", "Exact"],
  targetCampaigns.map((campaign) => {
    const rows = negatives.get(campaign) || [];
    return [
      campaign,
      rows.filter((row) => row.level === "Campaign").length,
      rows.filter((row) => row.level === "Ad group").length,
      rows.filter((row) => row.matchType === "BROAD").length,
      rows.filter((row) => row.matchType === "PHRASE").length,
      rows.filter((row) => row.matchType === "EXACT").length,
    ];
  }),
));
lines.push("");
lines.push("## Recommendations");
lines.push("");
if (filtered.length) {
  lines.push(table(
    ["Campaign", "Negative keyword", "Match type", "Reason", "Examples"],
    filtered.map((rec) => [rec.campaign, rec.keyword, rec.matchType, rec.reason, rec.examples.join("; ")]),
  ));
} else {
  lines.push("No new recommendations after checking existing negatives.");
}
lines.push("");
lines.push("## Already Covered Or Skipped");
lines.push("");
const skipped = recs.filter((rec) => alreadyCovered(negatives, rec.campaign, rec.keyword, rec.matchType));
if (skipped.length) {
  lines.push(table(
    ["Campaign", "Candidate", "Match type", "Reason"],
    skipped.map((rec) => [rec.campaign, rec.keyword, rec.matchType, "Already covered by an existing negative keyword"]),
  ));
} else {
  lines.push("No generated candidates were already covered.");
}
lines.push("");

await fs.writeFile(mdPath, lines.join("\n"), "utf8");
await fs.writeFile(jsonPath, JSON.stringify({ currentNegatives: Object.fromEntries(negatives), recommendations: filtered, skipped }, null, 2), "utf8");
console.log(`Wrote ${mdPath}`);
console.log(`Wrote ${jsonPath}`);
