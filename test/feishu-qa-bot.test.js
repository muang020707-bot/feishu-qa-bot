"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bot = require("../src/feishu-qa-bot");

let eventCounter = 0;

function event(text, mentions = [], overrides = {}) {
  eventCounter += 1;
  return {
    event: {
      message: {
        message_id: overrides.message_id || `om_test_${eventCounter}`,
        chat_id: overrides.chat_id,
        content: JSON.stringify({ text }),
        mentions
      }
    }
  };
}

test("ignores group messages that do not mention the bot", async () => {
  const result = await bot.handleFeishuEvent(event("公司考勤是怎么样的"), {
    botOpenId: "ou_bot",
    knowledgeSourceUrls: "https://example.feishu.cn/docx/doc123"
  });
  assert.equal(result.ignored, true);
  assert.equal(result.reason, "not_mentioned");
});

test("normalizes question by removing the bot mention", () => {
  const actual = bot.normalizeQuestion(
    event("@_user_1 公司考勤是怎么样的", [
      { key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }
    ]),
    "ou_bot"
  );
  assert.equal(actual, "公司考勤是怎么样的");
});

test("supports multiple bot open ids for mention matching", () => {
  assert.equal(
    bot.shouldReplyToEvent(
      event("@_user_1 公司考勤是怎么样的", [
        { key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_alt_bot" } }
      ]),
      "ou_primary_bot,ou_alt_bot"
    ),
    true
  );
});

test("retrieves relevant chunks from knowledge documents", () => {
  const chunks = bot.retrieveRelevantChunks("公司考勤是怎么样的", [
    {
      title: "员工手册",
      url: "https://example.feishu.cn/docx/abc",
      content: "工作时间为 9:00-18:00。\n考勤需要上下班打卡。\n全勤奖 300 元/月。"
    },
    {
      title: "离职流程",
      url: "https://example.feishu.cn/docx/def",
      content: "离职需要提交申请并完成交接。"
    }
  ]);
  assert.ok(chunks.length > 0);
  assert.match(chunks[0].text, /考勤|工作时间|打卡/);
});

test("retrieves uploaded file candidates by expanded onboarding terms", () => {
  const title = "02-入职管理 - 试岗期-入职须知 - 入职须知明细表.xlsx";
  const chunks = bot.retrieveRelevantChunks("员工入职有什么要注意的", [
    {
      title,
      url: "https://example.feishu.cn/file/onboarding",
      content: title,
      fileToken: "file-onboarding",
      fileExtension: "xlsx",
      canExtractContent: true
    }
  ]);
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0].fileToken, "file-onboarding");
});

test("prefers an exact product document over generic onboarding documents", () => {
  const chunks = bot.retrieveRelevantChunks("小悬灸要注意什么", [
    {
      title: "薪资组成确认单.xlsx",
      url: "https://example.feishu.cn/file/salary",
      content: "签署劳动合同并确认薪资组成。"
    },
    {
      title: "2026牧火主推爆品手卡.pptx",
      url: "https://example.feishu.cn/file/product",
      content: "牧火小悬灸使用时注意控温，向上旋拧盖子调低温度，避免烫伤。"
    }
  ]);
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0].title, "2026牧火主推爆品手卡.pptx");
  assert.match(chunks[0].text, /避免烫伤/);
});

test("hydrates matching uploaded files before answering", async () => {
  const title = "02-入职管理 - 试岗期-入职须知 - 入职须知明细表.xlsx";
  const initialChunks = bot.retrieveRelevantChunks("员工入职有什么要注意的", [
    {
      title,
      url: "https://example.feishu.cn/file/onboarding",
      content: title,
      fileToken: "file-onboarding",
      fileExtension: "xlsx",
      canExtractContent: true
    }
  ]);
  const hydrated = await bot.hydrateRelevantChunks("员工入职有什么要注意的", initialChunks, "tenant-token", {
    downloadDriveFile: async () => Buffer.from("mock xlsx"),
    extractXlsxText: () => "入职注意事项：签署劳动合同、保密协议、入职承诺书，并确认薪资组成。"
  });
  assert.match(hydrated[0].text, /劳动合同/);
  assert.equal(hydrated[0].canExtractContent, false);
});

test("hydrates old doc files with readable text extraction", async () => {
  const title = "01-招聘管理 - 2-DISC性格测评问卷-黑白版(1).doc";
  const initialChunks = bot.retrieveRelevantChunks("DISC测评怎么做", [
    {
      title,
      url: "https://example.feishu.cn/file/disc",
      content: title,
      fileToken: "file-disc",
      fileExtension: "doc",
      canExtractContent: true
    }
  ]);
  const hydrated = await bot.hydrateRelevantChunks("DISC测评怎么做", initialChunks, "tenant-token", {
    downloadDriveFile: async () => Buffer.from("DISC personality test answers should follow the questionnaire", "utf8")
  });
  assert.match(hydrated[0].text, /DISC personality test/);
});

test("recognizes direct material requests", () => {
  assert.equal(bot.isKnowledgeMaterialRequest("给我劳动合同"), true);
  assert.equal(bot.isKnowledgeMaterialRequest("发一下员工手册文档"), true);
  assert.equal(bot.isKnowledgeMaterialRequest("给我性格测试要求"), true);
  assert.equal(bot.isKnowledgeMaterialRequest("花名册发我"), true);
  assert.equal(bot.isKnowledgeMaterialRequest("员工花名册给我"), true);
  assert.equal(bot.isKnowledgeMaterialRequest("公司考勤是怎么样的"), false);
});

test("finds knowledge materials by title and returns links", () => {
  const materials = bot.findKnowledgeMaterials("给我劳动合同", [
    {
      title: "员工手册",
      url: "https://example.feishu.cn/docx/handbook",
      content: "考勤制度"
    },
    {
      title: "劳动合同模板",
      url: "https://example.feishu.cn/docx/contract",
      content: "劳动合同签署说明"
    }
  ]);
  assert.equal(materials.length, 1);
  assert.equal(materials[0].title, "劳动合同模板");
  assert.match(bot.formatKnowledgeMaterialsReply(materials), /https:\/\/example\.feishu\.cn\/docx\/contract/);
});

test("returns only exact compact title matches for specific material requests", () => {
  const materials = bot.findKnowledgeMaterials("每日素材库总统计表发我", [
    {
      title: "每日素材库 总统计表",
      url: "https://example.feishu.cn/sheets/materials",
      content: "工作表：6月素材"
    },
    {
      title: "员工考勤统计表",
      url: "https://example.feishu.cn/sheets/attendance",
      content: "员工考勤统计"
    }
  ]);
  assert.deepEqual(materials.map((item) => item.title), ["每日素材库 总统计表"]);
});

test("finds personality test materials with synonym matching", () => {
  const materials = bot.findKnowledgeMaterials("给我性格测试要求", [
    {
      title: "01-招聘管理 - 2-DISC性格测评问卷-黑白版(1).doc",
      url: "https://example.feishu.cn/file/disc",
      content: "01-招聘管理 - 2-DISC性格测评问卷-黑白版(1).doc",
      fileToken: "file-disc",
      fileExtension: "doc"
    },
    {
      title: "01-招聘管理 - 附件1.面试登记表20201022(1).doc",
      url: "https://example.feishu.cn/file/interview",
      content: "面试登记表"
    }
  ]);
  assert.ok(materials.length > 0);
  assert.equal(materials[0].title, "01-招聘管理 - 2-DISC性格测评问卷-黑白版(1).doc");
});

test("finds roster materials with suffix send wording", () => {
  const materials = bot.findKnowledgeMaterials("员工花名册给我", [
    {
      title: "01-招聘管理 - 人才画像.xls",
      url: "https://example.feishu.cn/file/roster",
      content: "员工花名册 人员名单 人才画像"
    },
    {
      title: "员工手册",
      url: "https://example.feishu.cn/file/handbook",
      content: "考勤制度"
    }
  ]);
  assert.ok(materials.length > 0);
  assert.equal(materials[0].title, "01-招聘管理 - 人才画像.xls");
});

test("includes PPT body text in semantic retrieval hints", async () => {
  let requestBody;
  const hints = await bot.inferKnowledgeHints(
    "这个便携艾灸产品使用时要注意什么",
    [
      {
        title: "2026牧火主推爆品手卡.pptx",
        url: "https://example.feishu.cn/file/products",
        fileExtension: "pptx",
        content: "产品名称牧火小悬灸。向上旋拧盖子调低温度，避免烫伤。"
      }
    ],
    { openaiApiKey: "test", openaiModel: "qwen-plus" },
    {
      jsonRequest: async (_method, _url, options) => {
        requestBody = options.body;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({ keywords: ["牧火小悬灸", "避免烫伤"], titleIndexes: [1] })
              }
            }
          ]
        };
      }
    }
  );
  assert.match(requestBody.messages[1].content, /PPT正文/);
  assert.match(requestBody.messages[1].content, /避免烫伤/);
  assert.deepEqual(hints.titleIndexes, [0]);
});

test("uses inferred title hints when local material matching misses", async () => {
  let replied = "";
  const result = await bot.handleFeishuEvent(
    event("@_user_1 给我九型人格资料", [
      { key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }
    ]),
    {
      botOpenId: "ou_bot",
      knowledgeSourceUrls: "https://example.feishu.cn/drive/folder/root",
      openaiApiKey: "test"
    },
    {
      tenantAccessToken: "tenant-token",
      loadKnowledgeDocuments: async () => [
        {
          title: "01-招聘管理 - PDP行为风格测试和解析.doc",
          url: "https://example.feishu.cn/file/pdp",
          content: "01-招聘管理 - PDP行为风格测试和解析.doc"
        }
      ],
      inferKnowledgeHints: async () => ({ keywords: ["PDP", "行为风格"], titleIndexes: [0] }),
      replyToFeishuMessage: async (_messageId, text) => {
        replied = text;
      }
    }
  );
  assert.equal(result.materialMatches, 1);
  assert.equal(result.hintedTitles, 1);
  assert.match(replied, /PDP行为风格测试/);
});

test("uses inferred title hints when material match is low confidence", async () => {
  let replied = "";
  const result = await bot.handleFeishuEvent(
    event("@_user_1 花名册发我", [
      { key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }
    ]),
    {
      botOpenId: "ou_bot",
      knowledgeSourceUrls: "https://example.feishu.cn/drive/folder/root",
      openaiApiKey: "test"
    },
    {
      tenantAccessToken: "tenant-token",
      loadKnowledgeDocuments: async () => [
        {
          title: "员工调岗通知书",
          url: "https://example.feishu.cn/file/transfer",
          content: "员工调岗通知书"
        },
        {
          title: "01-招聘管理 - 人才画像.xls",
          url: "https://example.feishu.cn/file/roster",
          content: "人员名单 员工花名册 人才画像"
        }
      ],
      inferKnowledgeHints: async () => ({ keywords: ["人才画像", "人员名单"], titleIndexes: [1] }),
      replyToFeishuMessage: async (_messageId, text) => {
        replied = text;
      }
    }
  );
  assert.equal(result.materialMatches, 1);
  assert.ok(result.hintedTitles === 0 || result.hintedTitles === 1);
  assert.match(replied, /人才画像\.xls/);
  assert.match(replied, /https:\/\/example\.feishu\.cn\/file\/roster/);
});

test("recognizes knowledge refresh requests", () => {
  assert.equal(bot.isRefreshKnowledgeRequest("刷新知识库"), true);
  assert.equal(bot.isRefreshKnowledgeRequest("刷新下知识库"), true);
  assert.equal(bot.isRefreshKnowledgeRequest("知识库更新"), true);
  assert.equal(bot.isRefreshKnowledgeRequest("刷新一下知识库"), true);
});

test("appends source documents to supported answers", () => {
  const answer = bot.formatAnswerWithSources("签名时先下载电子营业执照。", [
    {
      title: "电子营业执照进行签名操作指引",
      url: "https://example.feishu.cn/docx/license",
      text: "下载电子营业执照"
    }
  ]);
  assert.match(answer, /依据文档/);
  assert.match(answer, /电子营业执照进行签名操作指引/);
  assert.match(answer, /https:\/\/example\.feishu\.cn\/docx\/license/);
});

test("does not append source documents to unsupported answers", () => {
  const answer = bot.formatAnswerWithSources("知识库暂无明确答案。", [
    {
      title: "员工手册",
      url: "https://example.feishu.cn/docx/handbook",
      text: "考勤"
    }
  ]);
  assert.equal(answer, "知识库暂无明确答案。");
});

test("only cites semantically selected documents when hints are present", () => {
  const answer = bot.formatAnswerWithSources("使用时需要注意控温。", [
    {
      title: "2026牧火主推爆品手卡.pptx",
      url: "https://example.feishu.cn/file/product",
      text: "控温调节",
      score: 1000
    },
    {
      title: "仓库发货流程.docx",
      url: "https://example.feishu.cn/file/warehouse",
      text: "发货流程",
      score: 4
    }
  ]);
  assert.match(answer, /2026牧火主推爆品手卡/);
  assert.doesNotMatch(answer, /仓库发货流程/);
});

test("recognizes wiki knowledge source links", () => {
  const link = bot.extractFeishuLink("https://vcnh0ynuo3yd.feishu.cn/wiki/G5vLwatTWisiuGkrVITcgompnod?fromScene=spaceOverview");
  assert.deepEqual(link, {
    type: "wiki",
    token: "G5vLwatTWisiuGkrVITcgompnod",
    url: "https://vcnh0ynuo3yd.feishu.cn/wiki/G5vLwatTWisiuGkrVITcgompnod?fromScene=spaceOverview"
  });
});

test("loads wiki docx node content", async () => {
  const docs = await bot.loadKnowledgeDocuments(
    {
      knowledgeSourceUrls: "https://vcnh0ynuo3yd.feishu.cn/wiki/G5vLwatTWisiuGkrVITcgompnod?fromScene=spaceOverview"
    },
    {
      tenantAccessToken: "tenant-token",
      getWikiNode: async () => ({
        title: "牧火人事知识库入口",
        obj_type: "docx",
        obj_token: "SE9ZdTMJjo4YuvxCgDbcTaOAnxb",
        has_child: false
      }),
      fetchDocxRawContent: async () => "考勤制度：工作时间为 9:00-18:00。"
    }
  );
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, "牧火人事知识库入口");
  assert.match(docs[0].content, /考勤制度/);
});

test("loads docx shortcuts from drive folders", async () => {
  const docs = await bot.loadKnowledgeDocuments(
    {
      knowledgeSourceUrls: "https://vcnh0ynuo3yd.feishu.cn/drive/folder/Pe45fe0GolwNNKdZ3GlcwKuwnqb"
    },
    {
      tenantAccessToken: "tenant-token",
      listFolderFiles: async () => [
        {
          name: "员工手册",
          type: "shortcut",
          url: "https://vcnh0ynuo3yd.feishu.cn/docx/doc123",
          shortcut_info: { target_type: "docx", target_token: "doc123" }
        }
      ],
      fetchDocxRawContent: async (token) => `来自 ${token} 的考勤制度`
    }
  );
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, "员工手册");
  assert.match(docs[0].content, /考勤制度/);
});

test("loads native Feishu sheets from drive folders", async () => {
  const docs = await bot.loadFolderDocuments(
    "folder-root",
    "tenant-token",
    {
      listFolderFiles: async () => [
        {
          name: "每日素材库 总统计表",
          type: "sheet",
          token: "sheet-token",
          url: "https://example.feishu.cn/sheets/sheet-token"
        }
      ],
      fetchNativeSheetContent: async () => "工作表：总表\n日期\t达人\t素材链接"
    },
    "https://example.feishu.cn/drive/folder/root"
  );
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, "每日素材库 总统计表");
  assert.match(docs[0].content, /素材链接/);
});

test("converts native sheet values into searchable text", () => {
  assert.equal(
    bot.sheetValuesToText([
      ["日期", "达人", "素材"],
      ["2026-06-12", "测试达人", { text: "视频链接" }]
    ]),
    "日期\t达人\t素材\n2026-06-12\t测试达人\t视频链接"
  );
});

test("loads documents from nested drive folders", async () => {
  const docs = await bot.loadKnowledgeDocuments(
    {
      knowledgeSourceUrls: "https://vcnh0ynuo3yd.feishu.cn/drive/folder/rootfolder"
    },
    {
      tenantAccessToken: "tenant-token",
      listFolderFiles: async (folderToken) => {
        if (folderToken === "rootfolder") {
          return [
            {
              name: "04-考勤休假",
              type: "folder",
              token: "attendance-folder",
              url: "https://example.feishu.cn/drive/folder/attendance-folder"
            }
          ];
        }
        return [
          {
            name: "考勤制度",
            type: "docx",
            token: "attendance-doc",
            url: "https://example.feishu.cn/docx/attendance-doc"
          }
        ];
      },
      fetchDocxRawContent: async (token) => `来自 ${token} 的考勤制度`
    }
  );
  assert.equal(docs.length, 1);
  assert.equal(docs[0].title, "04-考勤休假 - 考勤制度");
  assert.equal(docs[0].url, "https://example.feishu.cn/docx/attendance-doc");
  assert.match(docs[0].content, /考勤制度/);
});

test("loads packaged knowledge index before remote sources", async () => {
  const previous = process.env.KNOWLEDGE_INDEX_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-bot-index-"));
  const indexPath = path.join(tempDir, "knowledge-index.json");
  fs.writeFileSync(
    indexPath,
    JSON.stringify({
      knowledgeSourceUrls: "https://example.feishu.cn/drive/folder/root",
      docs: [
        {
          title: "本地索引员工手册",
          url: "https://example.feishu.cn/file/indexed",
          content: "本地索引里的考勤制度"
        }
      ]
    }),
    "utf8"
  );
  process.env.KNOWLEDGE_INDEX_PATH = indexPath;
  try {
    const docs = await bot.loadKnowledgeDocuments(
      { knowledgeSourceUrls: "https://example.feishu.cn/drive/folder/root" },
      {
        disableCache: true,
        listFolderFiles: async () => {
          throw new Error("should not list remote folder");
        }
      }
    );
    assert.equal(docs.length, 1);
    assert.equal(docs[0].title, "本地索引员工手册");
  } finally {
    if (previous === undefined) delete process.env.KNOWLEDGE_INDEX_PATH;
    else process.env.KNOWLEDGE_INDEX_PATH = previous;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("handles mentioned event with mocked dependencies", async () => {
  let replied = "";
  const result = await bot.handleFeishuEvent(
    event("@_user_1 公司考勤是怎么样的", [
      { key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }
    ]),
    {
      botOpenId: "ou_bot",
      knowledgeSourceUrls: "https://example.feishu.cn/docx/doc123",
      openaiApiKey: "test"
    },
    {
      tenantAccessToken: "tenant-token",
      loadKnowledgeDocuments: async () => [
        {
          title: "员工手册",
          url: "https://example.feishu.cn/docx/doc123",
          content: "公司工作时间 9:00-18:00，上下班需要打卡。"
        }
      ],
      inferKnowledgeHints: async () => ({ keywords: [], titleIndexes: [] }),
      askOpenAI: async () => "公司工作时间 9:00-18:00，上下班需要打卡。",
      replyToFeishuMessage: async (_messageId, text) => {
        replied = text;
      }
    }
  );
  assert.equal(result.ignored, false);
  assert.match(replied, /打卡/);
});

test("hydrates uploaded file matches in mentioned events", async () => {
  let modelChunks = [];
  let replied = "";
  const result = await bot.handleFeishuEvent(
    event("@_user_1 员工入职有什么要注意的", [
      { key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }
    ]),
    {
      botOpenId: "ou_bot",
      knowledgeSourceUrls: "https://example.feishu.cn/drive/folder/root",
      openaiApiKey: "test"
    },
    {
      tenantAccessToken: "tenant-token",
      loadKnowledgeDocuments: async () => [
        {
          title: "02-入职管理 - 试岗期-入职须知 - 入职须知明细表.xlsx",
          url: "https://example.feishu.cn/file/onboarding",
          content: "02-入职管理 - 试岗期-入职须知 - 入职须知明细表.xlsx",
          fileToken: "file-onboarding",
          fileExtension: "xlsx",
          canExtractContent: true
        }
      ],
      downloadDriveFile: async () => Buffer.from("mock xlsx"),
      extractXlsxText: () => "入职注意事项：签署劳动合同、保密协议、入职承诺书，并确认薪资组成。",
      askOpenAI: async (_question, chunks) => {
        modelChunks = chunks;
        return "入职时需要签署劳动合同、保密协议、入职承诺书，并确认薪资组成。";
      },
      replyToFeishuMessage: async (_messageId, text) => {
        replied = text;
      }
    }
  );
  assert.equal(result.ignored, false);
  assert.match(modelChunks[0].text, /入职注意事项/);
  assert.match(replied, /依据文档/);
});

test("uses inferred title hints for answer retrieval fallback", async () => {
  let modelChunks = [];
  const result = await bot.handleFeishuEvent(
    event("@_user_1 这个岗位候选人要先做什么评估", [
      { key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }
    ]),
    {
      botOpenId: "ou_bot",
      knowledgeSourceUrls: "https://example.feishu.cn/drive/folder/root",
      openaiApiKey: "test"
    },
    {
      tenantAccessToken: "tenant-token",
      loadKnowledgeDocuments: async () => [
        {
          title: "01-招聘管理 - DISC性格测评问卷.docx",
          url: "https://example.feishu.cn/file/disc",
          content: "候选人需要先完成 DISC 性格测评问卷，再进入复试。"
        }
      ],
      inferKnowledgeHints: async () => ({ keywords: ["DISC", "性格测评"], titleIndexes: [0] }),
      askOpenAI: async (_question, chunks) => {
        modelChunks = chunks;
        return "候选人需要先完成 DISC 性格测评问卷。";
      },
      replyToFeishuMessage: async () => {}
    }
  );
  assert.equal(result.matchedChunks, 1);
  assert.ok(result.hintedTitles === 0 || result.hintedTitles === 1);
  assert.match(modelChunks[0].text, /DISC 性格测评/);
});

test("handles direct material request without calling the model", async () => {
  let replied = "";
  let modelCalled = false;
  const result = await bot.handleFeishuEvent(
    event("@_user_1 给我劳动合同", [
      { key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }
    ]),
    {
      botOpenId: "ou_bot",
      knowledgeSourceUrls: "https://example.feishu.cn/docx/doc123",
      openaiApiKey: "test"
    },
    {
      tenantAccessToken: "tenant-token",
      loadKnowledgeDocuments: async () => [
        {
          title: "劳动合同模板",
          url: "https://example.feishu.cn/docx/contract",
          content: "劳动合同签署说明"
        }
      ],
      askOpenAI: async () => {
        modelCalled = true;
        return "should not be used";
      },
      replyToFeishuMessage: async (_messageId, text) => {
        replied = text;
      }
    }
  );
  assert.equal(result.ignored, false);
  assert.equal(result.materialMatches, 1);
  assert.equal(modelCalled, false);
  assert.match(replied, /劳动合同模板/);
  assert.match(replied, /https:\/\/example\.feishu\.cn\/docx\/contract/);
});

test("handles loose material request without calling the model", async () => {
  let replied = "";
  let modelCalled = false;
  const result = await bot.handleFeishuEvent(
    event("@_user_1 给我性格测试要求", [
      { key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }
    ]),
    {
      botOpenId: "ou_bot",
      knowledgeSourceUrls: "https://example.feishu.cn/drive/folder/root",
      openaiApiKey: "test"
    },
    {
      tenantAccessToken: "tenant-token",
      loadKnowledgeDocuments: async () => [
        {
          title: "01-招聘管理 - 2-DISC性格测评问卷-黑白版(1).doc",
          url: "https://example.feishu.cn/file/disc",
          content: "01-招聘管理 - 2-DISC性格测评问卷-黑白版(1).doc",
          fileToken: "file-disc",
          fileExtension: "doc"
        }
      ],
      askOpenAI: async () => {
        modelCalled = true;
        return "should not be used";
      },
      replyToFeishuMessage: async (_messageId, text) => {
        replied = text;
      }
    }
  );
  assert.equal(result.ignored, false);
  assert.equal(result.materialMatches, 1);
  assert.equal(modelCalled, false);
  assert.match(replied, /DISC性格测评问卷/);
  assert.match(replied, /https:\/\/example\.feishu\.cn\/file\/disc/);
});

test("ignores duplicate message events in memory", async () => {
  let replyCount = 0;
  const duplicateEvent = event(
    "@_user_1 公司考勤是怎么样的",
    [{ key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }],
    { message_id: "om_duplicate", chat_id: "oc_test" }
  );
  const deps = {
    tenantAccessToken: "tenant-token",
    hasExistingBotReply: async () => false,
    loadKnowledgeDocuments: async () => [
      {
        title: "员工手册",
        url: "https://example.feishu.cn/docx/doc123",
        content: "公司工作时间 9:00-18:00，上下班需要打卡。"
      }
    ],
    askOpenAI: async () => "公司工作时间 9:00-18:00，上下班需要打卡。",
    replyToFeishuMessage: async () => {
      replyCount += 1;
    }
  };
  const first = await bot.handleFeishuEvent(duplicateEvent, { botOpenId: "ou_bot", feishuAppId: "cli_bot" }, deps);
  const second = await bot.handleFeishuEvent(duplicateEvent, { botOpenId: "ou_bot", feishuAppId: "cli_bot" }, deps);

  assert.equal(first.ignored, false);
  assert.equal(second.ignored, true);
  assert.equal(second.reason, "duplicate_in_memory");
  assert.equal(replyCount, 1);
});

test("does not reply when a bot reply already exists", async () => {
  let replied = false;
  const result = await bot.handleFeishuEvent(
    event(
      "@_user_1 公司考勤是怎么样的",
      [{ key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }],
      { chat_id: "oc_test" }
    ),
    { botOpenId: "ou_bot", feishuAppId: "cli_bot" },
    {
      tenantAccessToken: "tenant-token",
      hasExistingBotReply: async () => true,
      replyToFeishuMessage: async () => {
        replied = true;
      }
    }
  );
  assert.equal(result.ignored, true);
  assert.equal(result.reason, "already_replied");
  assert.equal(replied, false);
});

test("ignores explicit cancel requests without replying", async () => {
  let replied = false;
  const result = await bot.handleFeishuEvent(
    event("@_user_1 可以不用回答了", [{ key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }]),
    { botOpenId: "ou_bot" },
    {
      replyToFeishuMessage: async () => {
        replied = true;
      }
    }
  );
  assert.equal(result.ignored, true);
  assert.equal(result.reason, "cancel_request");
  assert.equal(replied, false);
});

test("refreshes knowledge cache without loading documents", async () => {
  let replied = "";
  let cleared = false;
  let loaded = false;
  const result = await bot.handleFeishuEvent(
    event("@_user_1 刷新知识库", [{ key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }], { chat_id: "oc_test" }),
    { botOpenId: "ou_bot", feishuAppId: "cli_bot", knowledgeCacheTtlMs: 600000 },
    {
      tenantAccessToken: "tenant-token",
      hasExistingBotReply: async () => false,
      clearKnowledgeCache: () => {
        cleared = true;
      },
      loadKnowledgeDocuments: async () => {
        loaded = true;
        return [];
      },
      replyToFeishuMessage: async (_messageId, text) => {
        replied = text;
      }
    }
  );
  assert.equal(result.refreshed, true);
  assert.equal(cleared, true);
  assert.equal(loaded, false);
  assert.match(replied, /知识库缓存已刷新/);
});

test("empty cache ttl config falls back to default cache window", async () => {
  let replied = "";
  const result = await bot.handleFeishuEvent(
    event("@_user_1 刷新知识库", [{ key: "@_user_1", name: "牧火人事助手", id: { open_id: "ou_bot" } }], { chat_id: "oc_test" }),
    { botOpenId: "ou_bot", feishuAppId: "cli_bot", knowledgeCacheTtlMs: "" },
    {
      tenantAccessToken: "tenant-token",
      hasExistingBotReply: async () => false,
      clearKnowledgeCache: () => {},
      replyToFeishuMessage: async (_messageId, text) => {
        replied = text;
      }
    }
  );
  assert.equal(result.refreshed, true);
  assert.match(replied, /10 分钟/);
});

test("extracts text from OpenAI-compatible chat completions", () => {
  assert.equal(
    bot.extractModelText({ choices: [{ message: { content: "千问回答" } }] }),
    "千问回答"
  );
});

test("prefers DashScope key so runtime does not depend on Codex quota", () => {
  const previousDashscope = process.env.DASHSCOPE_API_KEY;
  const previousOpenai = process.env.OPENAI_API_KEY;
  process.env.DASHSCOPE_API_KEY = "dashscope-test-key";
  process.env.OPENAI_API_KEY = "openai-test-key";
  try {
    assert.equal(bot.getConfig().openaiApiKey, "dashscope-test-key");
  } finally {
    if (previousDashscope === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previousDashscope;
    if (previousOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenai;
  }
});
