import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const licenseReportFile = ".vite/third-party-licenses.json";
export const noticesFile = "third-party-notices.txt";

/** @typedef {{name: string, version: string, identifier?: string, text?: string}} LicenseEntry */
/** @typedef {{unpicImg: string, vitePlugin: string, geist: string, vinextThirdParty?: string}} NoticeMaterials */

/** @param {LicenseEntry[]} entries @param {NoticeMaterials} materials */
export function renderThirdPartyNotices(entries, materials) {
  const sections = [
    "Third-party notices",
    "Generated from the packages included in this build. Third-party software and fonts retain their own licenses; the application's PolyForm license does not replace them.",
  ];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = `${entry.name}@${entry.version}`;
    let text = entry.text?.trim();
    let source = "";
    // Supplements are pinned to the verified version AND license identifier.
    // Never silently apply an old copyright statement to an upgraded package.
    if (!text && entry.identifier === "MIT") {
      if (key === "@unpic/core@1.0.3") {
        text = materials.unpicImg;
        source = "https://github.com/ascorbic/unpic-img/blob/%40unpic/core%401.0.3/README.md#license\nhttps://github.com/ascorbic/unpic-img/blob/%40unpic/core%401.0.3/packages/react/LICENSE";
      } else if (key === "@vitejs/plugin-rsc@0.5.38") {
        text = materials.vitePlugin;
        source = "https://github.com/vitejs/vite-plugin-react/blob/2e8512f98a4fc1b302af760c9d41900c2fa66d0a/LICENSE";
      } else if (key === "unpic@4.2.2") {
        // Explicitly retained review exception, not a fabricated copyright notice.
        text = "Package metadata declares MIT. The complete upstream copyright notice remains unconfirmed. See docs/THIRD-PARTY-LICENSES.md in the source repository.\nSource: https://github.com/ascorbic/unpic/tree/eefd6174338cc1377f8f238b84af94f48acd6da4";
      }
    }
    if (!entry.identifier || !text?.trim()) {
      throw new Error(`Missing third-party license material for ${key}; review its upstream license before distributing this build.`);
    }
    sections.push(`${key} (${entry.identifier})\n${source ? `Source: ${source}\n\n` : ""}${text.trim()}`);
  }
  if (entries.some((entry) => entry.name === "vinext")) {
    if (!materials.vinextThirdParty?.trim()) throw new Error("Missing Vinext third-party notices");
    sections.push(`Additional notices supplied with Vinext\n\n${materials.vinextThirdParty.trim()}`);
  }
  if (!materials.geist.trim()) throw new Error("Missing Geist font license");
  sections.push(`Geist and Geist Mono fonts (SIL OFL 1.1)\nSources:\nhttps://github.com/google/fonts/blob/main/ofl/geist/OFL.txt\nhttps://github.com/google/fonts/blob/main/ofl/geistmono/OFL.txt\n\n${materials.geist.trim()}`);
  return `${sections.join("\n\n================================================================\n\n")}\n`;
}

/** @returns {import("vite").Plugin} */
export function thirdPartyNoticesPlugin() {
  /** @type {string} */
  let root;
  return {
    name: "stable-earn:third-party-notices",
    apply: "build",
    configResolved(config) { root = config.root; },
    generateBundle: {
      // Vite first emits its module-based license report in generateBundle.
      order: "post",
      handler(_options, bundle) {
        const report = bundle[licenseReportFile];
        if (!report || report.type !== "asset") throw new Error("Missing Vite third-party license report");
        /** @type {LicenseEntry[]} */
        const entries = JSON.parse(typeof report.source === "string"
          ? report.source : Buffer.from(report.source).toString("utf8"));
        /** @param {string} path */
        const read = (path) => readFileSync(resolve(root, path), "utf8");
        this.emitFile({
          type: "asset",
          fileName: noticesFile,
          source: renderThirdPartyNotices(entries, {
            unpicImg: read("licenses/unpic-img-MIT.txt"),
            vitePlugin: read("licenses/vite-plugin-react-MIT.txt"),
            geist: read("licenses/geist-OFL.txt"),
            vinextThirdParty: entries.some((entry) => entry.name === "vinext")
              ? read("node_modules/vinext/THIRD_PARTY_LICENSES.md") : undefined,
          }),
        });
      },
    },
  };
}
