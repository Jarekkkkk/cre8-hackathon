import { useParams, Link } from "react-router-dom";
import fullAssets from "../../reference/data/assets.json";
import type { UnderlyingAsset } from "../../reference/lib/underlying-assets";
const REFERENCE_ASSETS = fullAssets as UnderlyingAsset[];
import { useBodyClass } from "../../lib/use-body-class";
import { AssetDetail } from "./AssetDetail";
export function AssetPage() {
  useBodyClass("atp-asset-page");
  const { slug } = useParams();
  const asset = REFERENCE_ASSETS.find((a) => a.slug === slug);
  return asset ? (
    <AssetDetail key={asset.slug} asset={asset} />
  ) : (
    <main className="page">
      <h1>Asset not found</h1>
      <Link to="/vaults">All funds</Link>
    </main>
  );
}
