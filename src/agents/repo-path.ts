import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

const DEFAULT_SEARCH_ROOT = join(homedir(), "VSCode Repo");
const LEGACY_FALLBACK_ROOT = join(homedir(), "Repos");
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

    const roots = [
        process.env.M2C_REPO_SEARCH_ROOT,
        DEFAULT_SEARCH_ROOT,
        LEGACY_FALLBACK_ROOT,
    ].filter((p): p is string => !!p && existsSync(p));

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
