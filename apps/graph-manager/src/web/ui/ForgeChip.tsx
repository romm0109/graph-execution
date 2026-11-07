/** A mono caps chip naming the forge: GITHUB or GITLAB. */
export function ForgeChip({ forge }: { forge: "github" | "gitlab" }) {
  return (
    <span className="chip" data-forge={forge}>
      {forge === "github" ? "GITHUB" : "GITLAB"}
    </span>
  );
}
