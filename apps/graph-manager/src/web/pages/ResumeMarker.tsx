// KAN-97: after a resume, whether a task or a review report kept its earlier result or ran again.

export function ResumeMarker({ value }: { value?: "reused" | "reran" }) {
  if (!value) return null;
  return (
    <span className={`resume-marker resume-${value}`} data-testid="resume-marker" title={value === "reused" ? "kept from before the resume" : "ran again after the resume"}>
      {value === "reused" ? "reused" : "ran again"}
    </span>
  );
}
