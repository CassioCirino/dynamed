import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { roleLabel } from "../lib/format";

function getMenuByRole(role) {
  const base = [
    { to: "/", label: "Painel" },
    { to: "/journeys", label: "Jornadas" },
    { to: "/appointments", label: "Atendimentos" },
    { to: "/exams", label: "Exames" },
  ];

  if (role !== "patient") {
    base.push({ to: "/patients", label: "Pacientes" });
  }

  if (["admin", "receptionist", "doctor"].includes(role)) {
    base.push({ to: "/operations", label: "Operacoes" });
  }

  return base;
}

export function AppLayout() {
  const { user, logout } = useAuth();
  const menu = getMenuByRole(user.role);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <p className="brand-kicker">HOSPITAL</p>
          <h1>PulseCare Sim</h1>
          <p className="brand-subtitle">Ambiente de observabilidade</p>
        </div>

        <nav className="menu">
          {menu.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} className="menu-link">
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <p className="user-role">{roleLabel(user.role)}</p>
          <p className="user-name">{user.full_name || user.fullName || user.name}</p>
          <button className="ghost-button" type="button" onClick={logout}>
            Sair
          </button>
        </div>
      </aside>

      <main className="content-area">
        <Outlet />
      </main>
    </div>
  );
}
