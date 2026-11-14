// A UI plugin as GM_UI_PLUGINS loads it: React comes from graph-manager through `api`.
export default function hello(api) {
  const h = api.React.createElement;
  function Billing() {
    const [n, setN] = api.React.useState(0); // hooks work: one React
    return h("section", { "data-testid": "page-billing" }, h("h1", null, "Billing"), h("button", { type: "button", onClick: () => setN(n + 1) }, `Clicked ${n}`));
  }
  api.registerNav({ label: "Billing", path: "/billing" });
  api.registerRoute({ path: "/billing", element: h(Billing) });
  api.registerTopbar(h("span", { "data-testid": "plan-badge" }, "Pro plan"));
  api.registerSettingsSection({ title: "Plan", element: h("p", null, "You are on the Pro plan.") });
}
