"use strict";

const https = require("https");

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";
const DEFAULT_LLM_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-plus";
const NO_ANSWER = "知识库里暂时没有找到这个问题的明确答案。建议联系对应负责人确认，或把正确文档链接补充到知识库后再问我。";
const NO_MATERIAL = "我在知识库里暂时没找到对应资料链接。你可以换个资料名称再问我，或把资料补充到知识库里。";
const KNOWLEDGE_CACHE_TTL_MS = 10 * 60 * 1000;
let knowledgeCache = null;

function getEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
  if (!deps.disableCache && knowledgeCache && knowledgeCache.key === cacheKey && Date.now() - knowledgeCache.loadedAt < KNOWLEDGE_CACHE_TTL_MS) {
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

function tokenize(text) {
  const lower = String(text || "").toLowerCase();
  const words = lower.match(/[a-z0-9]+|[\u4e00-\u9fa5]{1,2}/g) || [];
  return words.filter((word) => word.trim().length > 0);
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
      chunks.push({ title: doc.title, url: doc.url, text: current });
      current = paragraph;
    } else {
      current = current ? `${current}\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push({ title: doc.title, url: doc.url, text: current });
  return chunks;
}

function retrieveRelevantChunks(question, docs, limit = 6) {
  const qTokens = tokenize(question);
  if (!qTokens.length) return [];
  const chunks = docs.flatMap((doc) => chunkDocument(doc));
  return chunks
    .map((chunk) => {
      const haystack = `${chunk.title}\n${chunk.text}`.toLowerCase();
      const score = qTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      return { ...chunk, score };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length)
    .slice(0, limit);
}

function isKnowledgeMaterialRequest(question) {
  const text = String(question || "").replace(/\s+/g, "");
  if (!text) return false;
  if (/(资料|文档|文件|附件|链接|下载|原文|模板)/.test(text)) return true;
  return /(给我|发我|发一下|发下|我要|我想要|找一下|找下|调取|发送|查看|打开).{0,12}(合同|手册|制度|表格|表单|流程|规定|清单)/.test(text);
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
  const qTokens = tokenize(query);
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
          content: "你是公司内部飞书问答机器人。只基于提供的资料回答。资料没有明确依据时，回复知识库暂无明确答案，不要编造制度、薪资、合同、审批结论。回答要简洁、中文。"
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

function getConfig() {
  return {
    openaiApiKey: getEnv("DASHSCOPE_API_KEY") || getEnv("OPENAI_API_KEY"),
    openaiBaseUrl: getEnv("OPENAI_BASE_URL", DEFAULT_LLM_BASE_URL),
    feishuAppId: getEnv("FEISHU_APP_ID"),
    feishuAppSecret: getEnv("FEISHU_APP_SECRET"),
    botOpenId: getEnv("BOT_OPEN_ID"),
    knowledgeSourceUrls: getEnv("KNOWLEDGE_SOURCE_URLS"),
    openaiModel: getEnv("OPENAI_MODEL", DEFAULT_MODEL)
  };
}

async function handleFeishuEvent(event, config = getConfig(), deps = {}) {
  const message = eventMessage(event);
  if (!message.message_id) return { ignored: true, reason: "missing_message_id" };
  if (!shouldReplyToEvent(event, config.botOpenId)) return { ignored: true, reason: "not_mentioned" };

  const question = normalizeQuestion(event, config.botOpenId);
  if (!question) return { ignored: true, reason: "empty_question" };

  const tenantAccessToken = deps.tenantAccessToken || (await (deps.getTenantAccessToken || getTenantAccessToken)(config));
  const docs = await (deps.loadKnowledgeDocuments || loadKnowledgeDocuments)(config, { ...deps, tenantAccessToken });

  if (isKnowledgeMaterialRequest(question)) {
    const materials = findKnowledgeMaterials(question, docs);
    const reply = formatKnowledgeMaterialsReply(materials);
    await (deps.replyToFeishuMessage || replyToFeishuMessage)(message.message_id, reply, tenantAccessToken);
    return { ignored: false, question, materialMatches: materials.length };
  }

  const chunks = retrieveRelevantChunks(question, docs);
  const answer = await (deps.askOpenAI || askOpenAI)(question, chunks, config);
  await (deps.replyToFeishuMessage || replyToFeishuMessage)(message.message_id, answer, tenantAccessToken);
  return { ignored: false, question, matchedChunks: chunks.length };
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
module.exports.isKnowledgeMaterialRequest = isKnowledgeMaterialRequest;
module.exports.findKnowledgeMaterials = findKnowledgeMaterials;
module.exports.formatKnowledgeMaterialsReply = formatKnowledgeMaterialsReply;
module.exports.loadFolderDocuments = loadFolderDocuments;
module.exports.loadKnowledgeDocuments = loadKnowledgeDocuments;
module.exports.getWikiNode = getWikiNode;
module.exports.extractModelText = extractModelText;
module.exports.NO_ANSWER = NO_ANSWER;
module.exports.NO_MATERIAL = NO_MATERIAL;
