"use strict";

const fs = require("fs");
const path = require("path");
const bot = require("../src/feishu-qa-bot");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const [name, ...rest] = line.split("=");
    const key = name.trim();
    if (!process.env[key]) process.env[key] = rest.join("=").trim();
  }
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += limit) {
    const batch = items.slice(index, index + limit);
    results.push(...(await Promise.all(batch.map(mapper))));
  }
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  loadEnvFile(path.join(process.cwd(), ".env.local"));
  const config = bot.getConfig();
  const outputPath = process.argv[2] || path.join(process.cwd(), "knowledge-index.json");
  const tenantAccessToken = await bot.getTenantAccessToken(config);
  const docs = await bot.loadKnowledgeDocuments(config, {
    disableCache: true,
    disablePackagedIndex: true,
    tenantAccessToken
  });

  let hydrated = 0;
  const indexedDocs = await mapLimit(docs, 1, async (doc) => {
    if (!doc.canExtractContent || !doc.fileToken) return doc;
    try {
      const content = await bot.loadDriveFileContent(doc, tenantAccessToken);
      await sleep(800);
      if (content && content.trim()) {
        hydrated += 1;
        return { ...doc, content, canExtractContent: false };
      }
    } catch (_) {
      return doc;
    }
    return doc;
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    knowledgeSourceUrls: config.knowledgeSourceUrls,
    docs: indexedDocs.filter((doc) => doc.content && doc.content.trim())
  };
  fs.writeFileSync(outputPath, JSON.stringify(payload), "utf8");
  console.log(JSON.stringify({ outputPath, docs: payload.docs.length, hydrated }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
