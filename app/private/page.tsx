import PrivateDashboardClient from "./private-dashboard-client";
import startupAssetManifest from "virtual:stable-earn/startup-assets";

// The private route contains no user-specific server data. Serve a static shell
// and let the browser load the authenticated dashboard through its API routes.
export const dynamic = "force-static";

export default function PrivateIndexPage() {
  return <PrivateDashboardClient assetManifest={startupAssetManifest} />;
}
