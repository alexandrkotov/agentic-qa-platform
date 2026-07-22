import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Customer } from '../api/types';

export function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadCustomers() {
    setLoading(true);
    try {
      const data = await api.get<Customer[]>('/customers');
      setCustomers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCustomers();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.post<Customer>('/customers', { email, name });
      setEmail('');
      setName('');
      await loadCustomers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create customer');
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Customers</h1>

      <form onSubmit={handleSubmit} className="flex gap-2 mb-6">
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="bg-slate-800 border border-slate-600 rounded px-3 py-2 flex-1"
        />
        <input
          type="text"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="bg-slate-800 border border-slate-600 rounded px-3 py-2 flex-1"
        />
        <button
          type="submit"
          className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-medium"
        >
          Add Customer
        </button>
      </form>

      {error && <p className="text-red-400 mb-4">{error}</p>}

      {loading ? (
        <p className="text-slate-400">Loading...</p>
      ) : (
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-700 text-slate-400 text-sm">
              <th className="py-2">ID</th>
              <th className="py-2">Email</th>
              <th className="py-2">Name</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id} className="border-b border-slate-800">
                <td className="py-2">{c.id}</td>
                <td className="py-2">{c.email}</td>
                <td className="py-2">{c.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}