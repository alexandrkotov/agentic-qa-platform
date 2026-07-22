import { NavLink, Outlet } from 'react-router-dom';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-2 rounded-md text-sm font-medium ${
    isActive ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
  }`;

export function Layout() {
  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <nav className="border-b border-slate-700 px-6 py-4 flex items-center gap-2">
        <span className="text-lg font-bold mr-6">Agentic QA Platform</span>
        <NavLink to="/customers" className={navLinkClass}>Customers</NavLink>
        <NavLink to="/products" className={navLinkClass}>Products</NavLink>
        <NavLink to="/orders" className={navLinkClass}>Orders</NavLink>
      </nav>
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}