import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, parse } from "path";

const DEFAULT_SEARCH_ROOT = join(homedir(), "VSCode Repo");
const LEGACY_FALLBACK_ROOT = join(homedir(), "Repos");
const WINDOWS_DRIVE_VSCODE_REPO = join(parse(process.cwd()).root, "VSCode Repo");
const MAX_SEARCH_DEPTH = 5;

const IGNORED_DIRS = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".azure",
    ".vscode",
    ".next",
    "out",
    "coverage",
]);

const pathCache = new Map<string, string>();

function collectCwdAncestors(): string[] {
    const ancestors: string[] = [];
    let current = process.cwd();

    while (true) {
        ancestors.push(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }

    return ancestors;
}

function buildSearchRoots(): string[] {
    const explicit = [process.env.M2C_REPO_SEARCH_ROOT].filter((p): p is string => !!p);
    const cwdAncestors = collectCwdAncestors();
    const vscodeRepoAncestor = cwdAncestors.find((p) => basename(p).toLowerCase() === "vscode repo");

    const candidates = [
        ...explicit,
        process.cwd(),
        ...(vscodeRepoAncestor ? [vscodeRepoAncestor] : []),
        WINDOWS_DRIVE_VSCODE_REPO,
        DEFAULT_SEARCH_ROOT,
        LEGACY_FALLBACK_ROOT,
    ];

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        if (existsSync(candidate)) unique.push(candidate);
    }

    return unique;
}

function searchRepoPath(rootDir: string, repoName: string, depth: number): string | null {
    if (!existsSync(rootDir) || depth < 0) return null;

    let entries: string[] = [];
    try {
        entries = readdirSync(rootDir);
    } catch {
        return null;
    }

    for (const entry of entries) {
        if (IGNORED_DIRS.has(entry)) continue;

        const fullPath = join(rootDir, entry);
        let stats;
        try {
            stats = statSync(fullPath);
        } catch {
            continue;
        }
        if (!stats.isDirectory()) continue;

        if (entry === repoName) {
            return fullPath;
        }

        const nested = searchRepoPath(fullPath, repoName, depth - 1);
        if (nested) return nested;
    }

    return null;
}

export function resolveRepoPath(repoName: string): string {
    const envPath = process.env.M2C_REPO_PATH;
    if (envPath && basename(envPath) === repoName) {
        return envPath;
    }

    const cached = pathCache.get(repoName);
    if (cached) return cached;

    const roots = buildSearchRoots();

    for (const root of roots) {
        const found = searchRepoPath(root, repoName, MAX_SEARCH_DEPTH);
        if (found) {
            pathCache.set(repoName, found);
            return found;
        }
    }

    const fallback = join(DEFAULT_SEARCH_ROOT, repoName);
    pathCache.set(repoName, fallback);
    return fallback;
}
