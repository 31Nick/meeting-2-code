import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { CopilotClient } from "@github/copilot-sdk";
import type { MCPLocalServerConfig, MCPRemoteServerConfig } from "@github/copilot-sdk";
import { extractMeetingRequirements, analyzeSelectedGaps } from "./agents/gap-analyzer.js";
import type { GapItem, MeetingInfo } from "./agents/gap-analyzer.js";
import { analyzeInfrastructureGaps } from "./agents/infra-analyzer.js";
import { createEpicIssue, linkSubIssuesToEpic } from "./agents/epic-issue.js";
import { createGithubIssues } from "./agents/github-issues.js";
import { assignCodingAgent } from "./agents/coding-agent.js";
import { deployToAzure, resetM2CWorkloadRepo } from "./agents/azure-deployer.js";
import { validateDeployment } from "./agents/playwright-validator.js";
import { executeLocalAgent } from "./agents/local-agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// ─── Copilot SDK Client (singleton) ───────────────────────────────────────────
const client = new CopilotClient({ logLevel: "debug" });

// ─── State ────────────────────────────────────────────────────────────────────
let lastRequirements: string[] = [];
let lastMeetingInfo: MeetingInfo | null = null;
let lastAnalysis: GapItem[] = [];
let epicIssueNumber = 0;
let epicIssueUrl = "";
let createdIssues: Array<{ id: number; title: string; number: number; url: string }> = [];

// ─── MCP Server configs ──────────────────────────────────────────────────────
function getWorkIQMcpConfig(): Record<string, MCPLocalServerConfig | MCPRemoteServerConfig> {
    return {
        workiq: {
            type: "local",
            command: "npx",
            args: ["-y", "@microsoft/workiq", "mcp"],
            tools: ["*"],
            timeout: 180000,
        } as MCPLocalServerConfig,
    };
}

function getGitHubMcpConfig(): Record<string, MCPLocalServerConfig | MCPRemoteServerConfig> {
    return {
        github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            tools: ["*"],
        } as MCPRemoteServerConfig,
    };
}

function getAzureMcpConfig(): Record<string, MCPLocalServerConfig | MCPRemoteServerConfig> {
    return {
        azure: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            tools: ["*"],
        } as MCPRemoteServerConfig,
    };
}

type RequirementDomain = "application" | "infrastructure" | "hybrid";

function classifyRequirementDomain(requirement: string): RequirementDomain {
    const text = requirement.toLowerCase();

    const infrastructureHints = [
        "azure", "bicep", "terraform", "resource group", "subscription", "tenant", "vnet", "subnet",
        "private endpoint", "private link", "dns", "firewall", "rbac", "managed identity", "entra",
        "key vault", "app service plan", "container app", "container registry", "aks", "vm", "front door",
        "application gateway", "api management", "storage account", "cosmos", "service bus", "event hub",
        "log analytics", "monitor", "diagnostic", "policy", "landing zone", "infrastructure", "iac",
        "network", "deploy pipeline", "environment", "quota", "sku",
    ];

    const applicationHints = [
        "ui", "ux", "page", "screen", "component", "frontend", "backend", "api endpoint", "controller",
        "function", "business logic", "validation", "workflow", "button", "form", "table", "card",
        "copy", "layout", "theme", "style", "typescript", "javascript", "node", "react", "test",
    ];

    const hasInfra = infrastructureHints.some((keyword) => text.includes(keyword));
    const hasApp = applicationHints.some((keyword) => text.includes(keyword));

    if (hasInfra && hasApp) return "hybrid";
    if (hasInfra) return "infrastructure";
    return "application";
}

const complexityRank: Record<"Low" | "Medium" | "High" | "Critical", number> = {
    Low: 1,
    Medium: 2,
    High: 3,
    Critical: 4,
};

function pickHigherComplexity(
    first: "Low" | "Medium" | "High" | "Critical",
    second: "Low" | "Medium" | "High" | "Critical",
): "Low" | "Medium" | "High" | "Critical" {
    return complexityRank[first] >= complexityRank[second] ? first : second;
}

function mergeHybridGap(appGap: GapItem, infraGap: GapItem): GapItem {
    return {
        ...appGap,
        domain: "hybrid",
        complexity: pickHigherComplexity(appGap.complexity, infraGap.complexity),
        estimatedEffort: `${appGap.estimatedEffort} + ${infraGap.estimatedEffort}`,
        currentState: `${appGap.currentState}\n\nInfrastructure context:\n${infraGap.currentState}`,
        gap: `${appGap.gap}\n\nInfrastructure gap:\n${infraGap.gap}`,
        details: `Application workstream:\n${appGap.details}\n\nInfrastructure workstream:\n${infraGap.details}`,
    };
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function sseHeaders(res: express.Response) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    return (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Step 1: Extract meeting requirements + create epic (SSE)
app.get("/api/analyze", async (req, res) => {
    const sendEvent = sseHeaders(res);
    const meetingName = (req.query.meeting as string) || "Meeting 2 Code demo";

    try {
        const result = await extractMeetingRequirements(client, {
            meetingName,
            workiqMcp: getWorkIQMcpConfig(),
            onProgress: (step, message) => sendEvent("progress", { step, message }),
            onMeetingInfo: (info) => sendEvent("meeting-info", info),
            onLog: (message) => sendEvent("log", { message }),
        });

        lastRequirements = result.requirements;
        lastMeetingInfo = result.info;
        lastAnalysis = [];

        // Send requirements to frontend
        sendEvent("requirements", { requirements: result.requirements });

        // Create epic issue on GitHub
        sendEvent("progress", { step: 3, message: "Creating epic issue on GitHub..." });
        sendEvent("log", { message: "Creating epic issue with meeting summary..." });

        const epic = await createEpicIssue(
            result.info,
            result.requirements,
            (msg) => sendEvent("log", { message: msg }),
        );
        epicIssueNumber = epic.number;
        epicIssueUrl = epic.url;

        sendEvent("epic-created", { number: epic.number, url: epic.url });
        sendEvent("complete", { success: true });
    } catch (error) {
        console.error("Analysis error:", error);
        sendEvent("error", {
            success: false,
            error: error instanceof Error ? error.message : "Analysis failed",
        });
    } finally {
        res.end();
    }
});

// Step 1b: Analyze gaps for selected requirements (SSE via POST)
app.post("/api/analyze-gaps", async (req, res) => {
    const { selectedIndices } = req.body as { selectedIndices: number[] };

    const selectedReqs = (selectedIndices || [])
        .filter((i: number) => i >= 0 && i < lastRequirements.length)
        .map((i: number) => ({ index: i, text: lastRequirements[i]! }));

    if (selectedReqs.length === 0) {
        return res.status(400).json({ success: false, error: "No requirements selected" });
    }

    const sendEvent = sseHeaders(res);

    try {
        const appReqs = selectedReqs.filter((req) => {
            const domain = classifyRequirementDomain(req.text);
            return domain === "application" || domain === "hybrid";
        });
        const infraReqs = selectedReqs.filter((req) => {
            const domain = classifyRequirementDomain(req.text);
            return domain === "infrastructure" || domain === "hybrid";
        });

        for (const req of selectedReqs) {
            sendEvent("gap-started", { id: req.index + 1 });
        }

        sendEvent("log", {
            message: `Routing ${selectedReqs.length} requirement(s): ${appReqs.length} app/hybrid, ${infraReqs.length} infra/hybrid`,
        });

        const [appAnalysis, infraAnalysis] = await Promise.all([
            appReqs.length > 0
                ? analyzeSelectedGaps(client, {
                    requirements: appReqs,
                    githubMcp: getGitHubMcpConfig(),
                    onProgress: (step, message) => sendEvent("progress", { step, message }),
                    onLog: (message) => sendEvent("log", { message }),
                })
                : Promise.resolve([]),
            infraReqs.length > 0
                ? analyzeInfrastructureGaps(client, {
                    requirements: infraReqs,
                    azureMcp: getAzureMcpConfig(),
                    onProgress: (step, message) => sendEvent("progress", { step, message }),
                    onLog: (message) => sendEvent("log", { message }),
                })
                : Promise.resolve([]),
        ]);

        const appById = new Map<number, GapItem>(appAnalysis.map((gap) => [gap.id, { ...gap, domain: gap.domain || "application" }]));
        const infraById = new Map<number, GapItem>(infraAnalysis.map((gap) => [gap.id, { ...gap, domain: "infrastructure" }]));

        const mergedById = new Map<number, GapItem>();
        for (const req of selectedReqs) {
            const id = req.index + 1;
            const appGap = appById.get(id);
            const infraGap = infraById.get(id);

            if (appGap && infraGap) {
                mergedById.set(id, mergeHybridGap(appGap, infraGap));
            } else if (appGap) {
                mergedById.set(id, { ...appGap, domain: appGap.domain || "application" });
            } else if (infraGap) {
                mergedById.set(id, { ...infraGap, domain: "infrastructure" });
            }
        }

        const analysis = Array.from(mergedById.values()).sort((a, b) => a.id - b.id);

        for (const gap of analysis) {
            sendEvent("gap", { gap });
        }

        // Merge into lastAnalysis (keep previous results, add/replace new)
        for (const gap of analysis) {
            const existing = lastAnalysis.findIndex(g => g.id === gap.id);
            if (existing >= 0) lastAnalysis[existing] = gap;
            else lastAnalysis.push(gap);
        }

        sendEvent("complete", { success: true, totalGaps: analysis.length });
    } catch (error) {
        console.error("Gap analysis error:", error);
        sendEvent("error", {
            success: false,
            error: error instanceof Error ? error.message : "Gap analysis failed",
        });
    } finally {
        res.end();
    }
});

// Step 2: Create GitHub issues for selected gaps (SSE streaming)
app.post("/api/create-issues", async (req, res) => {
    const { selectedIds } = req.body as { selectedIds: number[] };
    const selectedGaps = lastAnalysis.filter((g) => selectedIds.includes(g.id));

    if (selectedGaps.length === 0) {
        return res.status(400).json({ success: false, error: "No items selected" });
    }

    const sendEvent = sseHeaders(res);

    try {
        const issues = await createGithubIssues({
            gaps: selectedGaps,
            epicIssueNumber: epicIssueNumber > 0 ? epicIssueNumber : undefined,
            onProgress: (current, total, message) => sendEvent("progress", { current, total, message }),
            onIssueCreated: (issue) => sendEvent("issue", { issue }),
            onLog: (message) => sendEvent("log", { message }),
        });

        createdIssues = issues;

        // Link sub-issues to epic
        if (epicIssueNumber > 0) {
            const subNums = issues.filter(i => i.number > 0).map(i => i.number);
            await linkSubIssuesToEpic(epicIssueNumber, subNums, (msg) => sendEvent("log", { message: msg }));
        }

        sendEvent("complete", { success: true, total: issues.length });
    } catch (error) {
        console.error("Issue creation error:", error);
        sendEvent("error", {
            success: false,
            error: error instanceof Error ? error.message : "Issue creation failed",
        });
    } finally {
        res.end();
    }
});

// Step 3: Assign coding agent to issues (SSE streaming)
app.post("/api/assign-coding-agent", async (req, res) => {
    const { issueNumbers } = req.body as { issueNumbers: number[] };

    if (!issueNumbers?.length) {
        return res.status(400).json({ success: false, error: "No issues provided" });
    }

    const sendEvent = sseHeaders(res);

    try {
        const results = await assignCodingAgent({
            issueNumbers,
            onProgress: (current, total, message) => sendEvent("progress", { current, total, message }),
            onResult: (result) => sendEvent("result", { result }),
            onLog: (message) => sendEvent("log", { message }),
        });

        sendEvent("complete", { success: true, results });
    } catch (error) {
        console.error("Assign agent error:", error);
        sendEvent("error", {
            success: false,
            error: error instanceof Error ? error.message : "Agent assignment failed",
        });
    } finally {
        res.end();
    }
});

// Health check
app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", state: client.getState() });
});

// Step 4a: Deploy to Azure (SSE streaming)
app.post("/api/deploy", async (_req, res) => {
    const sendEvent = sseHeaders(res);

    try {
        const result = await deployToAzure({
            onProgress: (step, message) => sendEvent("progress", { step, message }),
            onLog: (message) => sendEvent("log", { message }),
        });

        if (result.success) {
            if (result.url) {
                sendEvent("deploy-url", { url: result.url });
            }
            sendEvent("complete", { success: true, url: result.url, message: result.message });
        } else {
            sendEvent("error", {
                success: false,
                error: result.message,
                errorType: result.errorType,
            });
        }
    } catch (error) {
        console.error("Deploy error:", error);
        sendEvent("error", {
            success: false,
            error: error instanceof Error ? error.message : "Deployment failed",
        });
    } finally {
        res.end();
    }
});

// Step 4b: Validate deployment against requirements (SSE streaming)
app.post("/api/validate", async (req, res) => {
    const { url, requirements: clientRequirements } = req.body as { url: string; requirements?: string[] };

    if (!url) {
        return res.status(400).json({ success: false, error: "No URL provided" });
    }

    // Accept requirements from the client (survives server restarts)
    if (clientRequirements?.length) {
        lastRequirements = clientRequirements;
    }

    if (lastRequirements.length === 0) {
        return res.status(400).json({ success: false, error: "No requirements extracted yet" });
    }

    const sendEvent = sseHeaders(res);

    try {
        const results = await validateDeployment({
            url,
            requirements: lastRequirements,
            client,
            onProgress: (current, total, message) => sendEvent("progress", { current, total, message }),
            onResult: (result) => sendEvent("result", { result }),
            onStart: (requirementIndex, requirement) => sendEvent("validation-start", { requirementIndex, requirement }),
            onLog: (message) => sendEvent("log", { message }),
        });

        const passed = results.filter((r) => r.passed).length;
        const failed = results.length - passed;
        sendEvent("complete", { success: true, total: results.length, passed, failed });
    } catch (error) {
        console.error("Validate error:", error);
        sendEvent("error", {
            success: false,
            error: error instanceof Error ? error.message : "Validation failed",
        });
    } finally {
        res.end();
    }
});

// Step 3b: Execute local Copilot agent for selected gaps (SSE streaming)
app.post("/api/execute-local-agent", async (req, res) => {
    const { gapIds } = req.body as { gapIds: number[] };

    console.log("[execute-local-agent] Received gapIds:", JSON.stringify(gapIds));

    if (!gapIds?.length) {
        console.error("[execute-local-agent] Empty gapIds. req.body:", JSON.stringify(req.body));
        return res.status(400).json({ success: false, error: "No gaps provided" });
    }

    const selectedGaps = lastAnalysis
        .filter((g) => gapIds.includes(g.id))
        .map((g) => ({
            id: g.id,
            requirement: g.requirement,
            gap: g.gap,
            details: g.details,
            complexity: g.complexity,
        }));

    if (selectedGaps.length === 0) {
        return res.status(400).json({ success: false, error: "No matching gaps found" });
    }

    const sendEvent = sseHeaders(res);

    try {
        const results = await executeLocalAgent(client, {
            gaps: selectedGaps,
            githubMcp: getGitHubMcpConfig(),
            onItemStart: (id, requirement) => sendEvent("item-start", { id, requirement }),
            onItemProgress: (id, message) => sendEvent("item-progress", { id, message }),
            onItemComplete: (id, success, summary) => sendEvent("item-complete", { id, success, summary }),
            onLog: (message) => sendEvent("log", { message }),
        });

        const successCount = results.filter((r) => r.success).length;
        sendEvent("complete", { success: true, total: results.length, succeeded: successCount, results });
    } catch (error) {
        console.error("Local agent error:", error);
        sendEvent("error", {
            success: false,
            error: error instanceof Error ? error.message : "Local agent execution failed",
        });
    } finally {
        res.end();
    }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Reset m2c-workload repo to clean state on startup (demo reset)
resetM2CWorkloadRepo().then(() => {
    app.listen(PORT, () => {
        console.log(`\n🚀 Meeting-2-Ship running at http://localhost:${PORT}\n`);
    });
}).catch((err) => {
    console.warn("[startup] Repo reset warning:", err instanceof Error ? err.message : String(err));
    app.listen(PORT, () => {
        console.log(`\n🚀 Meeting-2-Ship running at http://localhost:${PORT}\n`);
    });
});
