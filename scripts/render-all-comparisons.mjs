import { spawnSync } from "node:child_process";
import { comparisons } from "./comparisons.mjs";

for (const [fixture, outDir] of comparisons) {
  run("node", ["scripts/render-prince-reference.mjs", fixture, outDir]);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}
