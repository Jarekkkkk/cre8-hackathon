import { Link } from "react-router-dom";
import FundBuilder from "../../reference/components/fund-builder";
import { useBodyClass } from "../../lib/use-body-class";
export function DesignFundPage() {
  useBodyClass("create-page", "atp-complete-create");
  return (
    <FundBuilder headingAction={<Link to="/create/activate">Only need target weights? Activate an allocation&nbsp;→</Link>} />
  );
}
