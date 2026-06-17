import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const bins = Object.values(packageJson.bin ?? {});

for (const bin of bins) {
  await fs.chmod(path.join(root, bin), 0o755);
}
