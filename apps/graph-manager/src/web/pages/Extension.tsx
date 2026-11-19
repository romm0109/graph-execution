import { Navigate, useParams } from "react-router-dom";
import "./Extension.css";

/** `/x/<name>`: an extension's UI, a full-height iframe of graph-manager's proxy `/ext/<name>/`. */
export default function Extension({ extensions }: { extensions: string[] | undefined }) {
  const { name = "" } = useParams();
  if (extensions === undefined)
    return (
      <div className="gate" role="status" aria-label="Loading">
        <span className="gate-spinner" aria-hidden="true" />
      </div>
    );
  if (!extensions.includes(name)) return <Navigate to="/runs" replace />;
  return (
    <div className="page ext-page" data-testid="page-extension">
      <iframe className="ext-frame" src={`/ext/${encodeURIComponent(name)}/`} title={name} data-testid="extension-frame" />
    </div>
  );
}
