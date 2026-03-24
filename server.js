import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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
    "Authorization": `Basic ${jiraAuth}`,
    "Accept": "application/json",
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

function buildAdfDescription(text) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: text
          }
        ]
      }
    ]
  };
}

app.get("/health", (_req, res) => {
  res.json({ success: true, status: "ok" });
});

app.post("/create-jira-issue", async (req, res) => {
  try {
    if (BACKEND_API_KEY) {
      const authHeader = req.headers.authorization || "";
      const expected = `Bearer ${BACKEND_API_KEY}`;
      if (authHeader !== expected) {
        return unauthorized(res);
      }
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

    if (!projectKey || !issueType || !summary || !description) {
      return res.status(400).json({
        success: false,
        error: "Pflichtfelder fehlen: projectKey, issueType, summary, description"
      });
    }

    const fields = {
      project: { key: projectKey },
      issuetype: { name: issueType },
      summary,
      description: buildAdfDescription(description)
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

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});