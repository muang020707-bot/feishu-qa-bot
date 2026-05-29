"use strict";

const https = require("https");
const zlib = require("zlib");

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";
const DEFAULT_LLM_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-plus";
const NO_ANSWER = "知识库里暂时没有找到这个问题的明确答案。建议联系对应负责人确认，或把正确文档链接补充到知识库后再问我。";
const NO_MATERIAL = "我在知识库里暂时没找到对应资料链接。你可以换个资料名称再问我，或把资料补充到知识库里。";
const DEFAULT_KNOWLEDGE_CACHE_TTL_MS = 10 * 60 * 1000;
const MESSAGE_DEDUPE_TTL_MS = 60 * 60 * 1000;
let knowledgeCache = null;
const messageDedupeCache = new Map();

function getEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getKnowledgeCacheTtlMs(config = {}) {
  const rawValue = config.knowledgeCacheTtlMs !== undefined && config.knowledgeCacheTtlMs !== null && config.knowledgeCacheTtlMs !== ""
    ? config.knowledgeCacheTtlMs
    : getEnv("KNOWLEDGE_CACHE_TTL_MS");
  if (rawValue === undefined || rawValue === null || rawValue === "") return DEFAULT_KNOWLEDGE_CACHE_TTL_MS;
  const raw = Number(rawValue);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_KNOWLEDGE_CACHE_TTL_MS;
}

function clearKnowledgeCache() {
  knowledgeCache = null;
}

function jsonRequest(method, url, { headers = {}, body, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      {
        method,
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = text;
          try {
            data = text ? JSON.parse(text) : {};
          } catch (_) {
            data = { raw: text };
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode} ${url}: ${text.slice(0, 300)}`));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`Request timed out: ${url}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function binaryRequest(method, url, { headers = {}, body, timeoutMs = 30000, redirectCount = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      {
        method,
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          Accept: "*/*",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers
        },
        timeout: timeoutMs
      },
      (res) => {
        const location = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && location && redirectCount < 3) {
          res.resume();
          const nextUrl = new URL(location, url).toString();
          binaryRequest(method, nextUrl, { headers, body, timeoutMs, redirectCount: redirectCount + 1 }).then(resolve, reject);
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode} ${url}: ${buffer.toString("utf8", 0, Math.min(buffer.length, 300))}`));
            return;
          }
          resolve({ buffer, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`Request timed out: ${url}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function extractFeishuLink(url) {
  const text = String(url || "").trim();
  const folder = text.match(/\/drive\/folder\/([A-Za-z0-9]+)/);
  if (folder) return { type: "folder", token: folder[1], url: text };
  const wiki = text.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wiki) return { type: "wiki", token: wiki[1], url: text };
  const docx = text.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docx) return { type: "docx", token: docx[1], url: text };
  const doc = text.match(/\/docs\/([A-Za-z0-9]+)/);
  if (doc) return { type: "doc", token: doc[1], url: text };
  return { type: "unknown", token: text, url: text };
}

function parseTextMessageContent(content) {
  if (!content) return "";
  if (typeof content === "object") {
    return content.text || "";
  }
  try {
    const parsed = JSON.parse(content);
    return parsed.text || content;
  } catch (_) {
    return String(content);
  }
}

function eventMessage(event) {
  const root = event && (event.event || event);
  return root && root.message ? root.message : {};
}

function shouldReplyToEvent(event, botOpenId) {
  const message = eventMessage(event);
  const mentions = message.mentions || [];
  if (!botOpenId) return mentions.length > 0;
  const botIds = splitCsv(botOpenId);
  return mentions.some((mention) => botIds.includes(mention.id) || (mention.id && botIds.includes(mention.id.open_id)));
}

function normalizeQuestion(event, botOpenId) {
  const message = eventMessage(event);
  let text = parseTextMessageContent(message.content);
  const botIds = splitCsv(botOpenId);
  for (const mention of message.mentions || []) {
    if (!botOpenId || botIds.includes(mention.id) || (mention.id && botIds.includes(mention.id.open_id))) {
      if (mention.key) text = text.replaceAll(mention.key, "");
      if (mention.name) text = text.replace(new RegExp(`@?${escapeRegExp(mention.name)}`, "g"), "");
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanupMessageDedupeCache(now = Date.now()) {
  for (const [messageId, timestamp] of messageDedupeCache.entries()) {
    if (now - timestamp > MESSAGE_DEDUPE_TTL_MS) messageDedupeCache.delete(messageId);
  }
}

function claimMessageForProcessing(messageId, now = Date.now()) {
  cleanupMessageDedupeCache(now);
  if (messageDedupeCache.has(messageId)) return false;
  messageDedupeCache.set(messageId, now);
  return true;
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += limit) {
    const batch = items.slice(index, index + limit);
    results.push(...(await Promise.all(batch.map(mapper))));
  }
  return results;
}

async function getTenantAccessToken(config) {
  const data = await jsonRequest("POST", `${FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal`, {
    body: {
      app_id: config.feishuAppId,
      app_secret: config.feishuAppSecret
    }
  });
  if (data.code !== 0) throw new Error(`Feishu token error: ${data.msg || data.code}`);
  return data.tenant_access_token;
}

async function listFolderFiles(folderToken, tenantAccessToken) {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      folder_token: folderToken,
      page_size: "100"
    });
    if (pageToken) params.set("page_token", pageToken);
    const data = await jsonRequest("GET", `${FEISHU_BASE_URL}/drive/v1/files?${params}`, {
      headers: { Authorization: `Bearer ${tenantAccessToken}` }
    });
    if (data.code !== 0) throw new Error(`Feishu folder list error: ${data.msg || data.code}`);
    files.push(...((data.data && data.data.files) || []));
    pageToken = data.data && data.data.has_more ? data.data.page_token || "" : "";
  } while (pageToken);
  return files;
}

async function fetchDocxRawContent(documentId, tenantAccessToken) {
  const data = await jsonRequest("GET", `${FEISHU_BASE_URL}/docx/v1/documents/${documentId}/raw_content`, {
    headers: { Authorization: `Bearer ${tenantAccessToken}` }
  });
  if (data.code !== 0) throw new Error(`Feishu docx raw_content error: ${data.msg || data.code}`);
  return (data.data && (data.data.content || data.data.raw_content)) || "";
}

async function fetchLegacyDocRawContent(docToken, tenantAccessToken) {
  const data = await jsonRequest("GET", `${FEISHU_BASE_URL}/doc/v2/${docToken}/raw_content`, {
    headers: { Authorization: `Bearer ${tenantAccessToken}` }
  });
  if (data.code !== 0) throw new Error(`Feishu doc raw_content error: ${data.msg || data.code}`);
  return (data.data && data.data.content) || "";
}

async function downloadDriveFile(fileToken, tenantAccessToken) {
  const data = await binaryRequest("GET", `${FEISHU_BASE_URL}/drive/v1/files/${fileToken}/download`, {
    headers: { Authorization: `Bearer ${tenantAccessToken}` },
    timeoutMs: 45000
  });
  const contentType = String(data.headers["content-type"] || "");
  if (contentType.includes("application/json")) {
    const payload = JSON.parse(data.buffer.toString("utf8") || "{}");
    if (payload.code && payload.code !== 0) throw new Error(`Feishu file download error: ${payload.msg || payload.code}`);
  }
  return data.buffer;
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function xmlToText(xml) {
  return decodeXmlEntities(
    String(xml || "")
      .replace(/<w:tab\s*\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findZipEntry(buffer, entryName) {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 66000); offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return null;

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(centralOffset + 42);
    const fileName = buffer.toString("utf8", centralOffset + 46, centralOffset + 46 + fileNameLength);

    if (fileName === entryName) {
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
      if (method === 0) return compressed;
      if (method === 8) return zlib.inflateRawSync(compressed);
      return null;
    }

    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }
  return null;
}

function listZipEntries(buffer) {
  const entries = [];
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 66000); offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return entries;

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) return entries;
    const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    entries.push(buffer.toString("utf8", centralOffset + 46, centralOffset + 46 + fileNameLength));
    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function extractDocxText(buffer) {
  const entries = ["word/document.xml", ...listZipEntries(buffer).filter((name) => /^word\/(header|footer)\d+\.xml$/.test(name))];
  return entries
    .map((entry) => {
      const xml = findZipEntry(buffer, entry);
      return xml ? xmlToText(xml.toString("utf8")) : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function extractTextNodes(xml) {
  return [...String(xml || "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXmlEntities(match[1])).join("");
}

function extractXlsxText(buffer) {
  const sharedXml = findZipEntry(buffer, "xl/sharedStrings.xml");
  const sharedStrings = sharedXml
    ? [...sharedXml.toString("utf8").matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((match) => extractTextNodes(match[1]))
    : [];
  const sheetNames = listZipEntries(buffer).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  const rows = [];

  for (const sheetName of sheetNames) {
    const sheet = findZipEntry(buffer, sheetName);
    if (!sheet) continue;
    const sheetXml = sheet.toString("utf8");
    for (const rowMatch of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellMatch[1];
        const cellXml = cellMatch[2];
        const value = (cellXml.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (attrs.includes('t="s"') && value !== undefined) {
          cells.push(sharedStrings[Number(value)] || "");
        } else if (attrs.includes('t="inlineStr"')) {
          cells.push(extractTextNodes(cellXml));
        } else if (value !== undefined) {
          cells.push(decodeXmlEntities(value));
        }
      }
      const row = cells.map((cell) => String(cell || "").trim()).filter(Boolean).join("\t");
      if (row) rows.push(row);
    }
  }

  return rows.join("\n").trim();
}

function getFileExtension(name) {
  const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

function canExtractDriveFile(fileExtension) {
  return fileExtension === "docx" || fileExtension === "xlsx";
}

async function loadDriveFileContent(file, tenantAccessToken, deps = {}) {
  if (!file || !canExtractDriveFile(file.fileExtension)) return "";
  const buffer = await (deps.downloadDriveFile || downloadDriveFile)(file.fileToken, tenantAccessToken);
  if (file.fileExtension === "docx") return (deps.extractDocxText || extractDocxText)(buffer);
  if (file.fileExtension === "xlsx") return (deps.extractXlsxText || extractXlsxText)(buffer);
  return "";
}

async function getWikiNode(wikiToken, tenantAccessToken) {
  const params = new URLSearchParams({ token: wikiToken, obj_type: "wiki" });
  const data = await jsonRequest("GET", `${FEISHU_BASE_URL}/wiki/v2/spaces/get_node?${params}`, {
    headers: { Authorization: `Bearer ${tenantAccessToken}` }
  });
  if (data.code !== 0) throw new Error(`Feishu wiki get_node error: ${data.msg || data.code}`);
  return data.data && data.data.node;
}

async function listWikiChildNodes(spaceId, parentNodeToken, tenantAccessToken) {
  const params = new URLSearchParams({
    space_id: spaceId,
    parent_node_token: parentNodeToken || "",
    page_size: "50"
  });
  const data = await jsonRequest("GET", `${FEISHU_BASE_URL}/wiki/v2/spaces/${spaceId}/nodes?${params}`, {
    headers: { Authorization: `Bearer ${tenantAccessToken}` }
  });
  if (data.code !== 0) throw new Error(`Feishu wiki nodes list error: ${data.msg || data.code}`);
  return (data.data && data.data.items) || [];
}

async function loadWikiNodeDocuments(node, tenantAccessToken, deps, sourceUrl, depth = 0) {
  if (!node || depth > 4) return [];
  const docs = [];

  if (node.obj_type === "docx" && node.obj_token) {
    const content = await (deps.fetchDocxRawContent || fetchDocxRawContent)(node.obj_token, tenantAccessToken);
    docs.push({ title: node.title || node.obj_token, url: sourceUrl, content });
  } else if (node.obj_type === "doc" && node.obj_token) {
    const content = await (deps.fetchLegacyDocRawContent || fetchLegacyDocRawContent)(node.obj_token, tenantAccessToken);
    docs.push({ title: node.title || node.obj_token, url: sourceUrl, content });
  }

  if (node.has_child && node.space_id && node.node_token) {
    const children = await (deps.listWikiChildNodes || listWikiChildNodes)(node.space_id, node.node_token, tenantAccessToken);
    for (const child of children) {
      docs.push(...(await loadWikiNodeDocuments(child, tenantAccessToken, deps, sourceUrl, depth + 1)));
    }
  }

  return docs;
}

async function loadFolderDocuments(folderToken, tenantAccessToken, deps, sourceUrl, parentTitle = "", depth = 0) {
  if (!folderToken || depth > 6) return [];
  const files = await (deps.listFolderFiles || listFolderFiles)(folderToken, tenantAccessToken);
  const docs = [];
  const documentFiles = [];

  for (const file of files) {
    const targetType = file.type === "shortcut" && file.shortcut_info ? file.shortcut_info.target_type : file.type;
    const targetToken = file.type === "shortcut" && file.shortcut_info ? file.shortcut_info.target_token : file.token;
    const title = [parentTitle, file.name || targetToken].filter(Boolean).join(" - ");

    if (targetType === "folder") {
      docs.push(...(await loadFolderDocuments(targetToken, tenantAccessToken, deps, file.url || sourceUrl, title, depth + 1)));
    } else if (targetType === "docx" || targetType === "doc") {
      documentFiles.push({ targetType, targetToken, title, url: file.url || sourceUrl });
    } else if (targetType === "file") {
      const fileExtension = getFileExtension(file.name || title);
      docs.push({
        title,
        url: file.url || sourceUrl,
        content: title,
        fileToken: targetToken,
        fileExtension,
        canExtractContent: canExtractDriveFile(fileExtension)
      });
    }
  }

  const loadedDocuments = await mapLimit(documentFiles, 3, async (file) => {
    if (file.targetType === "docx") {
      const content = await (deps.fetchDocxRawContent || fetchDocxRawContent)(file.targetToken, tenantAccessToken);
      return { title: file.title, url: file.url, content };
    }
    const content = await (deps.fetchLegacyDocRawContent || fetchLegacyDocRawContent)(file.targetToken, tenantAccessToken);
    return { title: file.title, url: file.url, content };
  });
  docs.push(...loadedDocuments);

  return docs;
}

async function loadKnowledgeDocuments(config, deps = {}) {
  const cacheKey = config.knowledgeSourceUrls || "";
  const cacheTtlMs = getKnowledgeCacheTtlMs(config);
  if (!deps.disableCache && cacheTtlMs > 0 && knowledgeCache && knowledgeCache.key === cacheKey && Date.now() - knowledgeCache.loadedAt < cacheTtlMs) {
    return knowledgeCache.docs;
  }

  const tenantAccessToken = deps.tenantAccessToken || (await getTenantAccessToken(config));
  const sourceLinks = splitCsv(config.knowledgeSourceUrls).map(extractFeishuLink);
  const docs = [];

  for (const source of sourceLinks) {
    if (source.type === "folder") {
      docs.push(...(await loadFolderDocuments(source.token, tenantAccessToken, deps, source.url)));
    } else if (source.type === "docx") {
      const content = await (deps.fetchDocxRawContent || fetchDocxRawContent)(source.token, tenantAccessToken);
      docs.push({ title: source.token, url: source.url, content });
    } else if (source.type === "doc") {
      const content = await (deps.fetchLegacyDocRawContent || fetchLegacyDocRawContent)(source.token, tenantAccessToken);
      docs.push({ title: source.token, url: source.url, content });
    } else if (source.type === "wiki") {
      const node = await (deps.getWikiNode || getWikiNode)(source.token, tenantAccessToken);
      docs.push(...(await loadWikiNodeDocuments(node, tenantAccessToken, deps, source.url)));
    }
  }

  const filteredDocs = docs.filter((doc) => doc.content && doc.content.trim());
  if (!deps.disableCache) {
    knowledgeCache = { key: cacheKey, loadedAt: Date.now(), docs: filteredDocs };
  }
  return filteredDocs;
}

const STOP_TOKENS = new Set([
  "什么",
  "怎么",
  "怎样",
  "如何",
  "有没有",
  "是否",
  "需要",
  "可以",
  "员工",
  "公司",
  "一下",
  "这个",
  "那个",
  "有什",
  "么要",
  "的是"
]);

const QUERY_EXPANSIONS = [
  {
    pattern: /入职|新人|新员工|录用|报到|试岗|试用/,
    terms: ["入职", "新员工", "新人", "录用", "报到", "试岗", "试用", "入职管理", "入职手续", "入职须知", "录取通知", "合同签署"]
  },
  {
    pattern: /注意|事项|准备|材料|要注意|须知|流程|手续/,
    terms: ["注意", "事项", "准备", "材料", "须知", "明细", "流程", "手续", "确认", "签署", "承诺书", "保密协议", "劳动合同", "薪资组成"]
  },
  {
    pattern: /考勤|打卡|上班|下班|迟到|早退|休假|请假|加班/,
    terms: ["考勤", "打卡", "上班", "下班", "迟到", "早退", "休假", "请假", "加班", "排班", "月度汇总"]
  },
  {
    pattern: /转正|调岗|调薪|涨薪|试用期/,
    terms: ["转正", "调岗", "调薪", "涨薪", "试用期", "审批单", "通知书"]
  },
  {
    pattern: /离职|辞职|解除|交接/,
    terms: ["离职", "辞职", "解除", "交接", "离职证明", "离职协议"]
  }
];

function tokenize(text) {
  const lower = String(text || "").toLowerCase();
  const words = lower.match(/[a-z0-9]+|[\u4e00-\u9fa5]{1,4}/g) || [];
  return words.filter((word) => word.trim().length > 0 && !STOP_TOKENS.has(word));
}

function expandQueryTokens(question) {
  const text = String(question || "");
  const tokens = new Set(tokenize(text));
  for (const expansion of QUERY_EXPANSIONS) {
    if (expansion.pattern.test(text)) {
      for (const term of expansion.terms) tokens.add(term.toLowerCase());
    }
  }
  return [...tokens].filter(Boolean);
}

function chunkDocument(doc, maxChars = 900) {
  const paragraphs = String(doc.content || "")
    .split(/\n{2,}|\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if ((current + "\n" + paragraph).length > maxChars && current) {
      chunks.push({ ...doc, text: current });
      current = paragraph;
    } else {
      current = current ? `${current}\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push({ ...doc, text: current });
  return chunks;
}

function retrieveRelevantChunks(question, docs, limit = 6) {
  const qTokens = expandQueryTokens(question);
  if (!qTokens.length) return [];
  const questionLower = String(question || "").toLowerCase().replace(/\s+/g, "");
  const chunks = docs.flatMap((doc) => chunkDocument(doc));
  return chunks
    .map((chunk) => {
      const title = String(chunk.title || "").toLowerCase();
      const text = String(chunk.text || "").toLowerCase();
      const haystack = `${title}\n${text}`;
      let score = title.replace(/\s+/g, "").includes(questionLower) ? 30 : 0;
      if (/入职/.test(question) && /注意|事项|须知|要注意/.test(question) && /入职须知/.test(chunk.title || "")) score += 25;
      if (/入职/.test(question) && /注意|事项|须知|要注意/.test(question) && /入职须知明细表/.test(chunk.title || "")) score += 15;
      for (const token of qTokens) {
        if (title.includes(token)) score += token.length >= 3 ? 8 : 5;
        if (text.includes(token)) score += token.length >= 3 ? 3 : 1;
      }
      if (chunk.canExtractContent && score > 0) score += 5;
      score -= Math.max(0, String(chunk.title || "").split(" - ").length - 4) * 3;
      return { ...chunk, score };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length)
    .slice(0, limit);
}

async function hydrateRelevantChunks(question, chunks, tenantAccessToken, deps = {}, limit = 4) {
  const files = [];
  const seen = new Set();
  for (const chunk of chunks) {
    if (!chunk.canExtractContent || !chunk.fileToken || seen.has(chunk.fileToken)) continue;
    seen.add(chunk.fileToken);
    files.push(chunk);
    if (files.length >= limit) break;
  }
  if (!files.length) return chunks;

  const hydratedDocs = [];
  for (const file of files) {
    try {
      const content = await loadDriveFileContent(file, tenantAccessToken, deps);
      if (content && content.trim()) {
        hydratedDocs.push({ ...file, content, canExtractContent: false });
      }
    } catch (_) {
      // Keep the title-only match if a single file cannot be downloaded or parsed.
    }
  }

  const hydratedChunks = retrieveRelevantChunks(question, hydratedDocs, chunks.length || 6);
  if (!hydratedChunks.length) return chunks;
  const hydratedTokens = new Set(hydratedDocs.map((doc) => doc.fileToken));
  return [...hydratedChunks, ...chunks.filter((chunk) => !hydratedTokens.has(chunk.fileToken))].slice(0, chunks.length || 6);
}

function isKnowledgeMaterialRequest(question) {
  const text = String(question || "").replace(/\s+/g, "");
  if (!text) return false;
  if (/(资料|文档|文件|附件|链接|下载|原文|模板)/.test(text)) return true;
  return /(给我|发我|发一下|发下|我要|我想要|找一下|找下|调取|发送|查看|打开).{0,12}(合同|手册|制度|表格|表单|流程|规定|清单)/.test(text);
}

function isRefreshKnowledgeRequest(question) {
  const text = String(question || "").replace(/\s+/g, "");
  return /^(刷新|更新|重载|重新加载|清空缓存)(知识库|资料|文档库)?$/.test(text) || /^(知识库|资料|文档库)(刷新|更新|重载|重新加载)$/.test(text);
}

function normalizeMaterialQuery(question) {
  return String(question || "")
    .replace(/(麻烦|请|帮我|帮忙|给我|发我|发一下|发下|我要|我想要|找一下|找下|调取|发送|查看|打开|下载|一下|看看|看下|相关|对应|这个|那个|的)/g, " ")
    .replace(/(资料|文档|文件|附件|链接|原文|模板)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findKnowledgeMaterials(question, docs, limit = 5) {
  const query = normalizeMaterialQuery(question) || String(question || "").trim();
  const qTokens = expandQueryTokens(query);
  const candidates = docs.filter((doc) => doc && doc.url && doc.title);

  if (!qTokens.length) return candidates.slice(0, limit);

  return candidates
    .map((doc) => {
      const title = String(doc.title || "").toLowerCase();
      const content = String(doc.content || "").toLowerCase();
      const queryLower = query.toLowerCase();
      let score = title.includes(queryLower) ? 12 : 0;
      for (const token of qTokens) {
        if (title.includes(token)) score += 5;
        if (content.includes(token)) score += 1;
      }
      return { title: doc.title, url: doc.url, score };
    })
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-Hans-CN"))
    .slice(0, limit);
}

function formatKnowledgeMaterialsReply(materials) {
  if (!materials.length) return NO_MATERIAL;
  const lines = ["找到这些资料，可以直接打开："];
  materials.forEach((material, index) => {
    lines.push(`${index + 1}. ${material.title}`);
    lines.push(material.url);
  });
  return lines.join("\n");
}

function answerLooksUnsupported(answer) {
  return /知识库(里)?暂无|没有找到|没有明确/.test(String(answer || ""));
}

function formatAnswerWithSources(answer, chunks, limit = 3) {
  if (!chunks.length || answerLooksUnsupported(answer)) return answer;

  const sources = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const key = `${chunk.title}\n${chunk.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ title: chunk.title, url: chunk.url });
    if (sources.length >= limit) break;
  }
  if (!sources.length) return answer;

  const lines = ["", "依据文档："];
  sources.forEach((source, index) => {
    lines.push(`${index + 1}. ${source.title}`);
    lines.push(source.url);
  });
  return `${answer.trim()}\n${lines.join("\n")}`;
}

async function askOpenAI(question, chunks, config) {
  if (!chunks.length) return NO_ANSWER;
  const context = chunks
    .map((chunk, index) => `资料${index + 1}：${chunk.title}\n${chunk.text}`)
    .join("\n\n---\n\n");
  const data = await jsonRequest("POST", `${config.openaiBaseUrl || DEFAULT_LLM_BASE_URL}/chat/completions`, {
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: {
      model: config.openaiModel || DEFAULT_MODEL,
      messages: [
        {
          role: "system",
          content: "你是公司内部飞书问答机器人。必须只基于提供的资料回答。资料没有明确依据时，只回复知识库暂无明确答案，不要编造制度、薪资、合同、审批结论。回答要简洁、中文。"
        },
        {
          role: "user",
          content: `问题：${question}\n\n可用资料：\n${context}`
        }
      ]
    }
  });
  const text = extractModelText(data).trim();
  return text || NO_ANSWER;
}

function extractModelText(data) {
  if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
    return data.choices[0].message.content;
  }
  if (typeof data.output_text === "string") return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n");
}

async function replyToFeishuMessage(messageId, text, tenantAccessToken) {
  const content = JSON.stringify({ text: text.slice(0, 5000) });
  const data = await jsonRequest("POST", `${FEISHU_BASE_URL}/im/v1/messages/${messageId}/reply`, {
    headers: { Authorization: `Bearer ${tenantAccessToken}` },
    body: { msg_type: "text", content, uuid: `reply-${messageId}` }
  });
  if (data.code !== 0) throw new Error(`Feishu reply error: ${data.msg || data.code}`);
  return data;
}

async function listRecentChatMessages(chatId, tenantAccessToken, limit = 50) {
  const params = new URLSearchParams({
    container_id: chatId,
    container_id_type: "chat",
    page_size: String(limit),
    sort_type: "ByCreateTimeDesc"
  });
  const data = await jsonRequest("GET", `${FEISHU_BASE_URL}/im/v1/messages?${params}`, {
    headers: { Authorization: `Bearer ${tenantAccessToken}` }
  });
  if (data.code !== 0) throw new Error(`Feishu messages list error: ${data.msg || data.code}`);
  return (data.data && data.data.items) || [];
}

async function hasExistingBotReply(message, config, tenantAccessToken, deps = {}) {
  if (!message.chat_id || !message.message_id || !config.feishuAppId) return false;
  const messages = await (deps.listRecentChatMessages || listRecentChatMessages)(message.chat_id, tenantAccessToken);
  return messages.some((item) => {
    const sender = item.sender || {};
    return (
      !item.deleted &&
      (item.parent_id === message.message_id || item.root_id === message.message_id) &&
      sender.sender_type === "app" &&
      sender.id === config.feishuAppId
    );
  });
}

function getConfig() {
  return {
    openaiApiKey: getEnv("DASHSCOPE_API_KEY") || getEnv("OPENAI_API_KEY"),
    openaiBaseUrl: getEnv("OPENAI_BASE_URL", DEFAULT_LLM_BASE_URL),
    feishuAppId: getEnv("FEISHU_APP_ID"),
    feishuAppSecret: getEnv("FEISHU_APP_SECRET"),
    botOpenId: getEnv("BOT_OPEN_ID"),
    knowledgeSourceUrls: getEnv("KNOWLEDGE_SOURCE_URLS"),
    openaiModel: getEnv("OPENAI_MODEL", DEFAULT_MODEL),
    knowledgeCacheTtlMs: getEnv("KNOWLEDGE_CACHE_TTL_MS")
  };
}

async function handleFeishuEvent(event, config = getConfig(), deps = {}) {
  const message = eventMessage(event);
  if (!message.message_id) return { ignored: true, reason: "missing_message_id" };
  if (!shouldReplyToEvent(event, config.botOpenId)) return { ignored: true, reason: "not_mentioned" };

  const question = normalizeQuestion(event, config.botOpenId);
  if (!question) return { ignored: true, reason: "empty_question" };
  if (/不用回答|不要回答|别回答|停止回答|取消回答/.test(question)) {
    return { ignored: true, reason: "cancel_request", question };
  }
  if (!deps.disableMessageDedupe && !(deps.claimMessageForProcessing || claimMessageForProcessing)(message.message_id)) {
    return { ignored: true, reason: "duplicate_in_memory", question };
  }

  try {
    const tenantAccessToken = deps.tenantAccessToken || (await (deps.getTenantAccessToken || getTenantAccessToken)(config));
    if (await (deps.hasExistingBotReply || hasExistingBotReply)(message, config, tenantAccessToken, deps)) {
      return { ignored: true, reason: "already_replied", question };
    }

    if (isRefreshKnowledgeRequest(question)) {
      (deps.clearKnowledgeCache || clearKnowledgeCache)();
      const minutes = Math.round(getKnowledgeCacheTtlMs(config) / 60000);
      const refreshText = minutes > 0
        ? `知识库缓存已刷新。下一条问题会重新读取飞书云盘资料；平时资料更新后最多约 ${minutes} 分钟自动生效。`
        : "知识库缓存已刷新。当前配置为不缓存，每次都会重新读取飞书云盘资料。";
      await (deps.replyToFeishuMessage || replyToFeishuMessage)(message.message_id, refreshText, tenantAccessToken);
      return { ignored: false, question, refreshed: true };
    }

    const docs = await (deps.loadKnowledgeDocuments || loadKnowledgeDocuments)(config, { ...deps, tenantAccessToken });

    if (isKnowledgeMaterialRequest(question)) {
      const materials = findKnowledgeMaterials(question, docs);
      const reply = formatKnowledgeMaterialsReply(materials);
      await (deps.replyToFeishuMessage || replyToFeishuMessage)(message.message_id, reply, tenantAccessToken);
      return { ignored: false, question, materialMatches: materials.length };
    }

    const chunks = await (deps.hydrateRelevantChunks || hydrateRelevantChunks)(
      question,
      retrieveRelevantChunks(question, docs),
      tenantAccessToken,
      deps
    );
    const answer = await (deps.askOpenAI || askOpenAI)(question, chunks, config);
    await (deps.replyToFeishuMessage || replyToFeishuMessage)(message.message_id, formatAnswerWithSources(answer, chunks), tenantAccessToken);
    return { ignored: false, question, matchedChunks: chunks.length };
  } catch (error) {
    if (!deps.disableMessageDedupe) messageDedupeCache.delete(message.message_id);
    throw error;
  }
}

async function cloudFunction(params, context, logger) {
  try {
    const result = await handleFeishuEvent(params);
    logger && logger.info && logger.info(JSON.stringify(result));
    return result;
  } catch (error) {
    logger && logger.error && logger.error(error.stack || error.message);
    throw error;
  }
}

module.exports = cloudFunction;
module.exports.handleFeishuEvent = handleFeishuEvent;
module.exports.shouldReplyToEvent = shouldReplyToEvent;
module.exports.normalizeQuestion = normalizeQuestion;
module.exports.extractFeishuLink = extractFeishuLink;
module.exports.retrieveRelevantChunks = retrieveRelevantChunks;
module.exports.hydrateRelevantChunks = hydrateRelevantChunks;
module.exports.isKnowledgeMaterialRequest = isKnowledgeMaterialRequest;
module.exports.findKnowledgeMaterials = findKnowledgeMaterials;
module.exports.formatKnowledgeMaterialsReply = formatKnowledgeMaterialsReply;
module.exports.isRefreshKnowledgeRequest = isRefreshKnowledgeRequest;
module.exports.formatAnswerWithSources = formatAnswerWithSources;
module.exports.loadFolderDocuments = loadFolderDocuments;
module.exports.loadKnowledgeDocuments = loadKnowledgeDocuments;
module.exports.getWikiNode = getWikiNode;
module.exports.claimMessageForProcessing = claimMessageForProcessing;
module.exports.hasExistingBotReply = hasExistingBotReply;
module.exports.clearKnowledgeCache = clearKnowledgeCache;
module.exports.getConfig = getConfig;
module.exports.extractDocxText = extractDocxText;
module.exports.extractXlsxText = extractXlsxText;
module.exports.extractModelText = extractModelText;
module.exports.NO_ANSWER = NO_ANSWER;
module.exports.NO_MATERIAL = NO_MATERIAL;
