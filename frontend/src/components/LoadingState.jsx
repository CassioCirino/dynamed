export function LoadingState({ label = "Carregando..." }) {
  return (
    <div className="loading-state">
      <div className="pulse" />
      <span>{label}</span>
    </div>
  );
}
