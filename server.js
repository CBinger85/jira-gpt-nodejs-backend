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
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: String(text ?? "")
          }
        ]
      }
    ]
  };
}

function isValidAdfDocument(value) {
  return (
    value &&
    typeof value === "object" &&
    value.type === "doc" &&
    typeof value.version === "number" &&
    Array.isArray(value.content)
  );
}

function normalizeAdfInput({ plainText, adf }) {
  if (adf !== undefined && adf !== null) {
    if (!isValidAdfDocument(adf)) {
      throw new Error("Ungültiges ADF-Dokument");
    }
    return adf;
  }

  if (plainText !== undefined && plainText !== null) {
    return buildPlainTextAdf(plainText);
  }

  return null;
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
      descriptionAdf,
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

    const normalizedDescription = normalizeAdfInput({
      plainText: description,
      adf: descriptionAdf
    });

    if (!normalizedDescription) {
      return res.status(400).json({
        success: false,
        error: "Pflichtfeld fehlt: description oder descriptionAdf"
      });
    }

    const fields = {
      project: { key: projectKey },
      issuetype: { name: issueType },
      summary,
      description: normalizedDescription
    };

    if (priority) {
      fields.priority = { name: priority };
    }

    if (Array.isArray(labels) && labels.length > 0) {
      fields.labels = labels;
    }

    if (assigneeAccountId) {
      fields.assignee = { accountId: assigneeAccountId };
    }

    const jiraResponse = await jiraClient.post("/issue", { fields });

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
    const jiraData = error.response?.data;
    const jiraStatus = error.response?.status;

    console.error("Jira create issue error:", jiraStatus, jiraData || error.message);

    return res.status(500).json({
      success: false,
      error: "Jira-Ticket konnte nicht erstellt werden",
      jiraStatus,
      jiraDetails: jiraData || error.message
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
    const descriptionText = extractPlainTextFromAdf(issue.fields?.description);

    return res.json({
      success: true,
      issueKey: issue.key,
      issueId: issue.id,
      summary: issue.fields?.summary || null,
      description: descriptionText,
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
    const jiraData = error.response?.data;
    const jiraStatus = error.response?.status;

    console.error("Jira get issue error:", jiraStatus, jiraData || error.message);

    return res.status(500).json({
      success: false,
      error: "Jira-Ticket konnte nicht geladen werden",
      jiraStatus,
      jiraDetails: jiraData || error.message
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
      descriptionAdf,
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

    if (summary) {
      fields.summary = summary;
    }

    if (description !== undefined || descriptionAdf !== undefined) {
      fields.description = normalizeAdfInput({
        plainText: description,
        adf: descriptionAdf
      });
    }

    if (priority) {
      fields.priority = { name: priority };
    }

    if (Array.isArray(labels)) {
      fields.labels = labels;
    }

    if (assigneeAccountId) {
      fields.assignee = { accountId: assigneeAccountId };
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({
        success: false,
        error: "Keine Felder zum Aktualisieren übergeben"
      });
    }

    await jiraClient.put(`/issue/${issueKey}`, { fields });

    return res.json({
      success: true,
      issueKey,
      browseUrl: `${JIRA_BASE_URL}/browse/${issueKey}`
    });
  } catch (error) {
    const jiraData = error.response?.data;
    const jiraStatus = error.response?.status;

    console.error("Jira update issue error:", jiraStatus, jiraData || error.message);

    return res.status(500).json({
      success: false,
      error: "Jira-Ticket konnte nicht aktualisiert werden",
      jiraStatus,
      jiraDetails: jiraData || error.message
    });
  }
});

app.post("/add-jira-comment", async (req, res) => {
  try {
    if (!checkBackendAuth(req, res)) {
      return;
    }

    const { issueKey, comment, commentAdf } = req.body || {};

    if (!issueKey) {
      return res.status(400).json({
        success: false,
        error: "Pflichtfeld fehlt: issueKey"
      });
    }

    const normalizedComment = normalizeAdfInput({
      plainText: comment,
      adf: commentAdf
    });

    if (!normalizedComment) {
      return res.status(400).json({
        success: false,
        error: "Pflichtfeld fehlt: comment oder commentAdf"
      });
    }

    await jiraClient.post(`/issue/${issueKey}/comment`, {
      body: normalizedComment
    });

    return res.json({
      success: true,
      issueKey,
      browseUrl: `${JIRA_BASE_URL}/browse/${issueKey}`
    });
  } catch (error) {
    const jiraData = error.response?.data;
    const jiraStatus = error.response?.status;

    console.error("Jira add comment error:", jiraStatus, jiraData || error.message);

    return res.status(500).json({
      success: false,
      error: "Kommentar konnte nicht hinzugefügt werden",
      jiraStatus,
      jiraDetails: jiraData || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});