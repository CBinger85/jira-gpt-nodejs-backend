import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

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
  timeout: 30000,
  validateStatus: () => true
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidAdfDocument(value) {
  return (
    isPlainObject(value) &&
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

    if (node.type === "emoji") {
      if (node.attrs?.text) {
        parts.push(node.attrs.text);
      } else if (node.attrs?.shortName) {
        parts.push(node.attrs.shortName);
      }
    }

    if (node.content) {
      walk(node.content);
    }
  }

  walk(adf);

  return parts.length > 0 ? parts.join(" ") : null;
}

function logPayload(label, payload) {
  try {
    console.log(`${label}:`, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.log(`${label}: [payload konnte nicht serialisiert werden]`, error.message);
  }
}

function handleJiraResponse(res, operationName, jiraResponse, successPayload) {
  if (jiraResponse.status >= 200 && jiraResponse.status < 300) {
    return res.json(successPayload);
  }

  console.error(`${operationName} status:`, jiraResponse.status);
  console.error(
    `${operationName} response:`,
    JSON.stringify(jiraResponse.data, null, 2)
  );

  return res.status(500).json({
    success: false,
    error: `${operationName} fehlgeschlagen`,
    jiraStatus: jiraResponse.status,
    jiraDetails: jiraResponse.data
  });
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
      project: { key: String(projectKey) },
      issuetype: { name: String(issueType) },
      summary: String(summary),
      description: normalizedDescription
    };

    if (priority) {
      fields.priority = { name: String(priority) };
    }

    if (Array.isArray(labels) && labels.length > 0) {
      fields.labels = labels.map(String);
    }

    if (assigneeAccountId) {
      fields.assignee = { accountId: String(assigneeAccountId) };
    }

    const payload = { fields };
    logPayload("create-jira-issue payload", payload);

    const jiraResponse = await jiraClient.post("/issue", payload);

    if (jiraResponse.status >= 200 && jiraResponse.status < 300) {
      const issueId = jiraResponse.data.id;
      const issueKey = jiraResponse.data.key;
      const browseUrl = `${JIRA_BASE_URL}/browse/${issueKey}`;

      return res.json({
        success: true,
        issueId,
        issueKey,
        browseUrl
      });
    }

    console.error("create-jira-issue status:", jiraResponse.status);
    console.error(
      "create-jira-issue response:",
      JSON.stringify(jiraResponse.data, null, 2)
    );

    return res.status(500).json({
      success: false,
      error: "Jira-Ticket konnte nicht erstellt werden",
      jiraStatus: jiraResponse.status,
      jiraDetails: jiraResponse.data
    });
  } catch (error) {
    console.error("create-jira-issue exception:", error.message);

    return res.status(
      error.message?.includes("ADF-Dokument") ? 400 : 500
    ).json({
      success: false,
      error:
        error.message?.includes("ADF-Dokument")
          ? error.message
          : "Jira-Ticket konnte nicht erstellt werden",
      jiraDetails: error.message
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

    const jiraResponse = await jiraClient.get(`/issue/${encodeURIComponent(issueKey)}`);

    if (!(jiraResponse.status >= 200 && jiraResponse.status < 300)) {
      console.error("get-jira-issue status:", jiraResponse.status);
      console.error(
        "get-jira-issue response:",
        JSON.stringify(jiraResponse.data, null, 2)
      );

      return res.status(500).json({
        success: false,
        error: "Jira-Ticket konnte nicht geladen werden",
        jiraStatus: jiraResponse.status,
        jiraDetails: jiraResponse.data
      });
    }

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
    console.error("get-jira-issue exception:", error.message);

    return res.status(500).json({
      success: false,
      error: "Jira-Ticket konnte nicht geladen werden",
      jiraDetails: error.message
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
      fields.priority = { name: String(priority) };
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
    logPayload("update-jira-issue payload", payload);

    const jiraResponse = await jiraClient.put(
      `/issue/${encodeURIComponent(issueKey)}`,
      payload
    );

    if (jiraResponse.status >= 200 && jiraResponse.status < 300) {
      return res.json({
        success: true,
        issueKey,
        browseUrl: `${JIRA_BASE_URL}/browse/${issueKey}`
      });
    }

    console.error("update-jira-issue status:", jiraResponse.status);
    console.error(
      "update-jira-issue response:",
      JSON.stringify(jiraResponse.data, null, 2)
    );

    return res.status(500).json({
      success: false,
      error: "Jira-Ticket konnte nicht aktualisiert werden",
      jiraStatus: jiraResponse.status,
      jiraDetails: jiraResponse.data
    });
  } catch (error) {
    console.error("update-jira-issue exception:", error.message);

    return res.status(
      error.message?.includes("ADF-Dokument") ? 400 : 500
    ).json({
      success: false,
      error:
        error.message?.includes("ADF-Dokument")
          ? error.message
          : "Jira-Ticket konnte nicht aktualisiert werden",
      jiraDetails: error.message
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

    logPayload("add-jira-comment payload", {
      issueKey,
      ...payload
    });

    const jiraResponse = await jiraClient.post(
      `/issue/${encodeURIComponent(issueKey)}/comment`,
      payload
    );

    if (jiraResponse.status >= 200 && jiraResponse.status < 300) {
      return res.json({
        success: true,
        issueKey,
        browseUrl: `${JIRA_BASE_URL}/browse/${issueKey}`
      });
    }

    console.error("add-jira-comment status:", jiraResponse.status);
    console.error(
      "add-jira-comment response:",
      JSON.stringify(jiraResponse.data, null, 2)
    );

    return res.status(500).json({
      success: false,
      error: "Kommentar konnte nicht hinzugefügt werden",
      jiraStatus: jiraResponse.status,
      jiraDetails: jiraResponse.data
    });
  } catch (error) {
    console.error("add-jira-comment exception:", error.message);

    return res.status(
      error.message?.includes("ADF-Dokument") ? 400 : 500
    ).json({
      success: false,
      error:
        error.message?.includes("ADF-Dokument")
          ? error.message
          : "Kommentar konnte nicht hinzugefügt werden",
      jiraDetails: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});