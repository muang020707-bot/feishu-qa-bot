"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const bot = require("../src/feishu-qa-bot");

function event(text, mentions = []) {
  return {
    event: {
      message: {
        message_id: "om_test",
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
      askOpenAI: async () => "公司工作时间 9:00-18:00，上下班需要打卡。",
      replyToFeishuMessage: async (_messageId, text) => {
        replied = text;
      }
    }
  );
  assert.equal(result.ignored, false);
  assert.match(replied, /打卡/);
});
