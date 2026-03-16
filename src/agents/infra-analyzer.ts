import type { CopilotClient, MCPLocalServerConfig, MCPRemoteServerConfig } from "@github/copilot-sdk";
import type { GapItem } from "./gap-analyzer.js";
import { createAgentSession } from "./session-helpers.js";

const REPO_PATH = `/Users/${process.env.USER || "31Nick"}/Repos/m2c-workload`;

interface AnalyzeInfrastructureOptions {
    requirements: Array<{ index: number; text: string }>;
    azureMcp: Record<string, MCPLocalServerConfig | MCPRemoteServerConfig>;
    onProgress?: (step: number, message: string) => void;
    onGapStarted?: (id: number) => void;
    onGap?: (gap: GapItem) => void;
    onLog?: (message: string) => void;
}

const MAX_CONCURRENT = 3;

export async function analyzeInfrastructureGaps(
    client: CopilotClient,
    options: AnalyzeInfrastructureOptions,
): Promise<GapItem[]> {
    const { requirements } = options;
    const progress = options.onProgress ?? (() => {});
    const onGapStarted = options.onGapStarted ?? (() => {});
    const onGap = options.onGap ?? (() => {});
    const log = options.onLog ?? (() => {});

    if (requirements.length === 0) return [];

    const concurrent = Math.min(MAX_CONCURRENT, requirements.length);
    progress(4, "Analyzing Azure infrastructure requirements...");
    log(`Starting Azure MCP infrastructure analysis (${concurrent} concurrent sessions)...`);

    const gapItems: GapItem[] = [];
    let completedCount = 0;

    async function analyzeOne(req: { index: number; text: string }): Promise<void> {
        const id = req.index + 1;
        const label = req.text.length > 60 ? req.text.substring(0, 60) + "..." : req.text;

        onGapStarted(id);
        log(`☁️ [${completedCount + 1}/${requirements.length}] Infra analysis: ${label}`);

        try {
            const session = await createAgentSession(client, {
                model: "gpt-5.2-codex",
                mcpServers: options.azureMcp,
                workingDirectory: REPO_PATH,
                systemMessage: {
                    content: `You are an Azure infrastructure architect.

You MUST use Azure MCP tools to assess the requirement and propose Azure infrastructure implementation work.

Constraints:
1) Prefer Azure-native services and secure defaults.
2) Prefer Bicep/Terraform infrastructure-as-code changes instead of manual portal steps.
3) Include governance basics (RBAC/identity, diagnostics, monitoring, tags, policy implications) when relevant.
4) Return ONLY valid JSON.

Output JSON schema:
{
  "requirement": "string",
  "currentState": "what likely exists today or what is unknown",
  "gap": "what Azure infrastructure capability is missing",
  "complexity": "Low|Medium|High|Critical",
  "estimatedEffort": "time estimate",
  "details": "specific infrastructure tasks and suggested IaC files/resources",
  "services": ["Azure service names used in solution"],
  "iac": "Bicep|Terraform|Mixed"
}`,
                },
                label: `infra-gap-${id}`,
            });

            const result = await session.sendAndWait({
                prompt: `Analyze this ONE infrastructure requirement and produce implementation tasks:

"${req.text}"

Use Azure MCP tools to ground recommendations in Azure capabilities and best practices.
Return ONLY a valid JSON object.`,
            }, 120_000);

            const content = result?.data?.content || "{}";
            await session.destroy();

            const jsonMatch = content.match(/\{[\s\S]*\}/);
            const parsed = JSON.parse(jsonMatch?.[0] || "{}");

            const gap: GapItem = {
                id,
                requirement: parsed.requirement || req.text,
                currentState: parsed.currentState || "Infrastructure baseline not yet assessed",
                gap: parsed.gap || "Infrastructure gap needs implementation",
                complexity: parsed.complexity || "Medium",
                estimatedEffort: parsed.estimatedEffort || "TBD",
                details: parsed.details || "Define IaC resources, identity, network, and monitoring baselines",
                domain: "infrastructure",
            };

            gapItems.push(gap);
            onGap(gap);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const fallback: GapItem = {
                id,
                requirement: req.text,
                currentState: "Azure MCP analysis unavailable",
                gap: "Infrastructure requirement needs explicit Azure implementation planning",
                complexity: "Medium",
                estimatedEffort: "TBD",
                details:
                    `Unable to complete Azure MCP analysis: ${message.substring(0, 180)}. ` +
                    "Create infrastructure backlog tasks for IaC, identity/RBAC, diagnostics, and deployment pipeline updates.",
                domain: "infrastructure",
            };
            gapItems.push(fallback);
            onGap(fallback);
            log(`⚠️ Infra analysis fallback for req #${id}: ${message.substring(0, 120)}`);
        }

        completedCount++;
        log(`✔ [${completedCount}/${requirements.length}] Infra analyzed: ${label}`);
    }

    const queue = [...requirements];
    const workers = Array.from({ length: concurrent }, async () => {
        while (queue.length > 0) {
            const req = queue.shift();
            if (!req) break;
            await analyzeOne(req);
        }
    });

    await Promise.all(workers);
    log(`✔ Infrastructure analysis complete: ${gapItems.length} requirement(s)`);
    return gapItems;
}
