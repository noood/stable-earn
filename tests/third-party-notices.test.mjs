import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderThirdPartyNotices } from "../scripts/third-party-notices.mjs";

const materials = {
  unpicImg: readFileSync(new URL("../licenses/unpic-img-MIT.txt", import.meta.url), "utf8"),
  vitePlugin: readFileSync(new URL("../licenses/vite-plugin-react-MIT.txt", import.meta.url), "utf8"),
  geist: readFileSync(new URL("../licenses/geist-OFL.txt", import.meta.url), "utf8"),
  vinextThirdParty: readFileSync(new URL("../node_modules/vinext/THIRD_PARTY_LICENSES.md", import.meta.url), "utf8"),
};

test("notices preserve installed license text and font copyright and full OFL", () => {
  const react = readFileSync(new URL("../node_modules/react/LICENSE", import.meta.url), "utf8").trim();
  const output = renderThirdPartyNotices([{ name: "react", version: "19.3.1", identifier: "MIT", text: react }], materials);
  assert.ok(output.includes(react));
  assert.ok(output.includes(materials.geist.trim()));
  assert.match(output, /Geist and Geist Mono fonts/);
  assert.match(output, /PolyForm license does not replace them/);
});

test("only the verified versions receive their matching upstream supplements", () => {
  const output = renderThirdPartyNotices([
    { name: "@unpic/core", version: "1.0.3", identifier: "MIT" },
    { name: "@vitejs/plugin-rsc", version: "0.5.38", identifier: "MIT" },
  ], materials);
  assert.ok(output.includes(materials.unpicImg.trim()));
  assert.ok(output.includes(materials.vitePlugin.trim()));
  assert.match(output, /2e8512f98a4fc1b302af760c9d41900c2fa66d0a/);
  for (const entry of [
    { name: "@unpic/core", version: "1.0.4", identifier: "MIT" },
    { name: "@vitejs/plugin-rsc", version: "0.5.39", identifier: "MIT" },
    { name: "@unpic/core", version: "1.0.3", identifier: "Apache-2.0" },
  ]) assert.throws(() => renderThirdPartyNotices([entry], materials), /Missing third-party license material/);
});

test("Unpic exception is explicit and never borrows the core package's copyright", () => {
  const output = renderThirdPartyNotices([{ name: "unpic", version: "4.2.2", identifier: "MIT" }], materials);
  assert.match(output, /complete upstream copyright notice remains unconfirmed/);
  assert.doesNotMatch(output, /2023 Matt Kane/);
  assert.throws(() => renderThirdPartyNotices([{ name: "unpic", version: "4.2.3", identifier: "MIT" }], materials), /Missing/);
});

test("unknown or incomplete license material cannot silently disappear", () => {
  for (const entry of [
    { name: "new-package", version: "1", identifier: "MIT" },
    { name: "new-package", version: "1", identifier: "MIT", text: "  " },
    { name: "new-package", version: "1", text: "text" },
  ]) assert.throws(() => renderThirdPartyNotices([entry], materials), /Missing third-party license material/);
});

test("Vinext retains its nested third-party notices, and missing materials fail", () => {
  const entries = [{ name: "vinext", version: "1.2.1", identifier: "MIT", text: "Vinext license" }];
  const output = renderThirdPartyNotices(entries, materials);
  assert.ok(output.includes(materials.vinextThirdParty.trim()));
  assert.match(output, /Faisal Salman/);
  assert.match(output, /Scott Motte/);
  assert.throws(() => renderThirdPartyNotices(entries, { ...materials, vinextThirdParty: undefined }), /Missing Vinext/);
  assert.throws(() => renderThirdPartyNotices([], { ...materials, geist: "" }), /Missing Geist/);
});

test("notice output is stable regardless of input package ordering", () => {
  const entries = [
    { name: "b", version: "1", identifier: "MIT", text: "b license" },
    { name: "a", version: "1", identifier: "MIT", text: "a license" },
  ];
  assert.equal(renderThirdPartyNotices(entries, materials), renderThirdPartyNotices(entries.toReversed(), materials));
});
