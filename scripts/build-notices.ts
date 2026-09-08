import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// The public package ships JS modules and a browser bundle, not a native Bun executable.
// Dependencies installed separately by npm/Bun retain their own distribution notices.
const root = resolve(import.meta.dirname, "..");
const project = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const sections: string[] = [
  "# Third-party notices",
  "The Maquila observer browser bundle includes the packages below. These license texts are copied from the exact installed versions pinned by Maquila. Other runtime dependencies are installed separately and retain their own licenses. The public npm artifact does not include the optional standalone Bun executable.",
];
for (const name of ["preact", "dayjs"]) {
  const directory = resolve(root, "node_modules", name);
  const metadata = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
  if (
    metadata.name !== name ||
    metadata.version !== project.dependencies[name] ||
    metadata.license !== "MIT"
  )
    throw new Error(`review required for bundled dependency ${name}`);
  const license = readFileSync(resolve(directory, "LICENSE"), "utf8").trim();
  if (!license.includes("Permission is hereby granted"))
    throw new Error(`license text missing for ${name}`);
  sections.push(`## ${name} ${metadata.version}\n\nLicense: MIT\n\n\`\`\`text\n${license}\n\`\`\``);
}
writeFileSync(resolve(root, "THIRD_PARTY_NOTICES.md"), `${sections.join("\n\n")}\n`);
console.log("Wrote browser-bundle notices for Preact and Day.js");
