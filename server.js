import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const {
  PORT = 3000,
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  BACKEND_API_KEY
} = process.env;

if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error("Fehlende Jira-Umgebungsvariablen. Bitte .env prüfen.");
  process.exit(1);
}

const jiraAuth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

const jiraClient = axios.create({
  baseURL: `${JIRA_BASE_URL}/rest/api/3`,
  headers: {
    Authorization: `Basic ${jiraAuth}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  },
  timeout: 30000
});

function unauthorized(res) {
  return res.status(401).json({
    success: false,
    error: "Unauthorized"
  });
}

function checkBackendAuth(req, res) {
  if (!BACKEND_API_KEY) {
    return true;
  }

  const authHeader = req.headers.authorization || "";
  const expected = `Bearer ${BACKEND_API_KEY}`;

  if (authHeader !== expected) {
    unauthorized(res);
    return false;
  }

  return true;
}

function buildPlainTextAdf(text) {
  const safeText = String(text ?? "");

  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: safeText
          ? [
              {
                type: "text",
                text: safeText
              }
            ]
          : []
      }
    ]
  };
}

function isValidAdfDocument(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.type === "doc" &&
    value.version === 1 &&
    Array.isArray(value.content)
  );
}

function normalizeRichTextInput(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    return buildPlainTextAdf(value);
  }

  if (isValidAdfDocument(value)) {
    return value;
  }

  throw new Error(
    `${fieldName} ist weder Plain Text noch ein gültiges ADF-Dokument`
  );
}

function extractPlainTextFromAdf(adf) {
  if (!adf || typeof adf !== "object") {
    return null;
  }

  const parts = [];

  function walk(node) {
    if (!node) {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (node.type === "text" && typeof node.text === "string") {
      parts.push(node.text);
    }

    if (node.type === "emoji" && node.attrs?.text) {
      parts.push(node.attrs.text);
    }

    if (node.content) {
      walk(node.content);
    }
  }

  walk(adf);

  return parts.length > 0 ? parts.join(" ") : null;
}

function logJiraError(context, error) {
  const jiraStatus = error.response?.status;
  const jiraData = error.response?.data;

  console.error(`${context} status:`, jiraStatus || "n/a");
  console.error(
    `${context} details:`,
    JSON.stringify(jiraData || { message: error.message }, null, 2)
  );
}

app.get("/health", (_req, res) => {
  res.json({ success: true, status: "ok" });
});

app.post("/create-jira-issue", async (req, res) => {
  try {
    if (!checkBackendAuth(req, res)) {
      return;
    }

    const {
      projectKey,
      issueType,
      summary,
      description,
      priority,
      labels,
      assigneeAccountId
    } = req.body || {};

    if (!projectKey || !issueType || !summary) {
      return res.status(400).json({
        success: false,
        error: "Pflichtfelder fehlen: projectKey, issueType, summary"
      });
    }

    const normalizedDescription = normalizeRichTextInput(
      description,
      "description"
    );

    if (!normalizedDescription) {
      return res.status(400).json({
        success: false,
        error: "Pflichtfeld fehlt: description"
      });
    }

    const fields = {
      project: { key: projectKey },
      issuetype: { name: issueType },
      summary: String(summary),
      description: normalizedDescription
    };

    if (priority) {
      fields.priority = { name: priority };
    }

    if (Array.isArray(labels) && labels.length > 0) {
      fields.labels = labels.map(String);
    }

    if (assigneeAccountId) {
      fields.assignee = { accountId: String(assigneeAccountId) };
    }

    const payload = { fields };

    console.log(
      "create-jira-issue payload:",
      JSON.stringify(payload, null, 2)
    );

    const jiraResponse = await jiraClient.post("/issue", payload);

    const issueId = jiraResponse.data.id;
    const issueKey = jiraResponse.data.key;
    const browseUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;

    return res.json({
      success: true,
      issueId,
      issueKey,
      browseUrl
    });
  } catch (error) {
    if (error.message?.includes("ADF-Dokument")) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    logJiraError("Jira create issue error", error);

    return res.status(500).json({
      success: false,
      error: "Jira-Ticket konnte nicht erstellt werden",
      jiraStatus: error.response?.status,
      jiraDetails: error.response?.data || error.message
    });
  }
});

app.get("/jira-issue/:issueKey", async (req, res) => {
  try {
    if (!checkBackendAuth(req, res)) {
      return;
    }

    const { issueKey } = req.params;

    if (!issueKey) {
      return res.status(400).json({
        success: false,
        error: "issueKey fehlt"
      });
    }

    const jiraResponse = await jiraClient.get(`/issue/${issueKey}`);
    const issue = jiraResponse.data;

    return res.json({
      success: true,
      issueKey: issue.key,
      issueId: issue.id,
      summary: issue.fields?.summary || null,
      description: extractPlainTextFromAdf(issue.fields?.description),
      descriptionRaw: issue.fields?.description || null,
      status: issue.fields?.status?.name || null,
      issueType: issue.fields?.issuetype?.name || null,
      priority: issue.fields?.priority?.name || null,
      labels: issue.fields?.labels || [],
      assignee: issue.fields?.assignee
        ? {
            accountId: issue.fields.assignee.accountId,
            displayName: issue.fields.assignee.displayName
          }
        : null,
      browseUrl: `${JIRA_BASE_URL}/browse/${issue.key}`
    });
  } catch (error) {
    logJiraError("Jira get issue error", error);

    return res.status(500).json({
      success: false,
      error: "Jira-Ticket konnte nicht geladen werden",
      jiraStatus: error.response?.status,
      jiraDetails: error.response?.data || error.message
    });
  }
});

app.post("/update-jira-issue", async (req, res) => {
  try {
    if (!checkBackendAuth(req, res)) {
      return;
    }

    const {
      issueKey,
      summary,
      description,
      priority,
      labels,
      assigneeAccountId
    } = req.body || {};

    if (!issueKey) {
      return res.status(400).json({
        success: false,
        error: "Pflichtfeld fehlt: issueKey"
      });
    }

    const fields = {};

    if (summary !== undefined && summary !== null && summary !== "") {
      fields.summary = String(summary);
    }

    if (description !== undefined) {
      fields.description = normalizeRichTextInput(description, "description");
    }

    if (priority) {
      fields.priority = { name: priority };
    }

    if (Array.isArray(labels)) {
      fields.labels = labels.map(String);
    }

    if (assigneeAccountId) {
      fields.assignee = { accountId: String(assigneeAccountId) };
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({
        success: false,
        error: "Keine Felder zum Aktualisieren übergeben"
      });
    }

    const payload = { fields };

    console.log(
      "update-jira-issue payload:",
      JSON.stringify(payload, null, 2)
    );

    await jiraClient.put(`/issue/${issueKey}`, payload);

    return res.json({
      success: true,
      issueKey,
      browseUrl: `${JIRA_BASE_URL}/browse/${issueKey}`
    });
  } catch (error) {
    if (error.message?.includes("ADF-Dokument")) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    logJiraError("Jira update issue error", error);

    return res.status(500).json({
      success: false,
      error: "Jira-Ticket konnte nicht aktualisiert werden",
      jiraStatus: error.response?.status,
      jiraDetails: error.response?.data || error.message
    });
  }
});

app.post("/add-jira-comment", async (req, res) => {
  try {
    if (!checkBackendAuth(req, res)) {
      return;
    }

    const { issueKey, comment } = req.body || {};

    if (!issueKey) {
      return res.status(400).json({
        success: false,
        error: "Pflichtfeld fehlt: issueKey"
      });
    }

    const normalizedComment = normalizeRichTextInput(comment, "comment");

    if (!normalizedComment) {
      return res.status(400).json({
        success: false,
        error: "Pflichtfeld fehlt: comment"
      });
    }

    const payload = {
      body: normalizedComment
    };

    console.log(
      "add-jira-comment payload:",
      JSON.stringify(
        {
          issueKey,
          ...payload
        },
        null,
        2
      )
    );

    await jiraClient.post(`/issue/${issueKey}/comment`, payload);

    return res.json({
      success: true,
      issueKey,
      browseUrl: `${JIRA_BASE_URL}/browse/${issueKey}`
    });
  } catch (error) {
    if (error.message?.includes("ADF-Dokument")) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    logJiraError("Jira add comment error", error);

    return res.status(500).json({
      success: false,
      error: "Kommentar konnte nicht hinzugefügt werden",
      jiraStatus: error.response?.status,
      jiraDetails: error.response?.data || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});