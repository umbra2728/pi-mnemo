import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function projectFor(cwd: string | undefined | null): string | null {
  if (!cwd) return null;
  const home = os.homedir();
  let dir = path.resolve(cwd);
  if (dir === home || dir === "/") return null;
  while (dir.startsWith(home) && dir !== home) {
    if (fs.existsSync(path.join(dir, ".git"))) return path.basename(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.basename(path.resolve(cwd));
}
