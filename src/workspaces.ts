import fs from "node:fs";
import path from "node:path";

export interface WorkspaceRegistry {
  roots: Map<string, string>;
  defaultAlias: string;
  warnings: string[];
}

const ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;

function canonicalDirectory(input: string): string {
  const resolved = fs.realpathSync(path.resolve(input));
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`不是目录: ${input}`);
  }
  return resolved;
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Resolve configured workspace aliases to canonical directories.
 * Invalid entries are rejected individually. The daemon cwd is always present
 * as either its configured alias or the reserved `default` fallback.
 */
export function resolveWorkspaceRegistry(
  configured: Record<string, string> | undefined,
  daemonCwd: string,
): WorkspaceRegistry {
  const fallbackRoot = canonicalDirectory(daemonCwd);
  const roots = new Map<string, string>();
  const warnings: string[] = [];

  for (const [rawAlias, rawRoot] of Object.entries(configured ?? {})) {
    const alias = rawAlias.trim().toLowerCase();
    if (!ALIAS_PATTERN.test(alias)) {
      warnings.push(`忽略无效工作区别名 "${rawAlias}"（仅允许字母、数字、点、下划线和连字符，最长 32）`);
      continue;
    }
    if (typeof rawRoot !== "string" || !rawRoot.trim()) {
      warnings.push(`忽略工作区 "${alias}"：路径为空`);
      continue;
    }
    try {
      roots.set(alias, canonicalDirectory(rawRoot.trim()));
    } catch (err) {
      warnings.push(`忽略工作区 "${alias}"：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let defaultAlias = [...roots.entries()].find(([, root]) => root === fallbackRoot)?.[0];
  if (!defaultAlias) {
    defaultAlias = "default";
    if (roots.has(defaultAlias) && roots.get(defaultAlias) !== fallbackRoot) {
      let suffix = 2;
      while (roots.has(`default-${suffix}`)) suffix++;
      defaultAlias = `default-${suffix}`;
    }
    roots.set(defaultAlias, fallbackRoot);
  }

  return { roots, defaultAlias, warnings };
}

/** Find the most specific configured root containing a path. */
export function findWorkspaceAlias(registry: WorkspaceRegistry, candidatePath: string): string | null {
  let candidate: string;
  try {
    candidate = canonicalDirectory(candidatePath);
  } catch {
    return null;
  }

  let match: { alias: string; length: number } | null = null;
  for (const [alias, root] of registry.roots) {
    if (!isPathInside(root, candidate)) continue;
    if (!match || root.length > match.length) match = { alias, length: root.length };
  }
  return match?.alias ?? null;
}

export function workspaceSessionKey(sessionKey: string, alias: string): string {
  return `${sessionKey}\u001fworkspace:${alias}`;
}
