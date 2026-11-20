import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

export function getWorkspaceRoots(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [process.cwd()];
  }
  return folders.map((f) => path.resolve(f.uri.fsPath));
}

/**
 * Validates and resolves a file path strictly within the workspace boundaries.
 * Throws PathSecurityError if the path attempts directory traversal outside workspace roots.
 */
export function resolveSafeWorkspacePath(targetPath: string): string {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new PathSecurityError('Invalid file path provided.');
  }

  const roots = getWorkspaceRoots();
  const normalizedInput = path.normalize(targetPath);

  // If path is absolute, check if it starts with any workspace root
  let candidatePath: string | undefined;
  if (path.isAbsolute(normalizedInput)) {
    candidatePath = path.resolve(normalizedInput);
  } else {
    // Resolve relative to first workspace root
    candidatePath = path.resolve(roots[0], normalizedInput);
  }

  // Check if candidatePath is inside at least one workspace root
  const isInside = roots.some((root) => {
    const rel = path.relative(root, candidatePath);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  });

  if (!isInside) {
    throw new PathSecurityError(
      `Access denied: path "${targetPath}" resolves to "${candidatePath}", which is outside the active workspace.`
    );
  }

  // If file exists, check realpath to avoid symlink traversal attacks
  if (fs.existsSync(candidatePath)) {
    try {
      const real = fs.realpathSync(candidatePath);
      const realInside = roots.some((root) => {
        const rootReal = fs.existsSync(root) ? fs.realpathSync(root) : root;
        const rel = path.relative(rootReal, real);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!realInside) {
        throw new PathSecurityError(
          `Access denied: symlink "${targetPath}" resolves outside active workspace.`
        );
      }
    } catch (e) {
      if (e instanceof PathSecurityError) {
        throw e;
      }
      // If realpath fails, keep candidatePath
    }
  }

  return candidatePath;
}

