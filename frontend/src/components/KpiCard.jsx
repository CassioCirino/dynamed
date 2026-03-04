export function KpiCard({ title, value, hint, tone = "default" }) {
  return (
    <article className={`kpi-card kpi-${tone}`}>
      <p className="kpi-title">{title}</p>
      <p className="kpi-value">{value}</p>
      {hint ? <p className="kpi-hint">{hint}</p> : null}
    </article>
  );
}
