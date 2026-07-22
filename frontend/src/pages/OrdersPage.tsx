import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Customer, Product, Order, OrderStatusHistory } from '../api/types';

interface DraftItem {
    productId: string;
    quantity: string;
}

export function OrdersPage() {
    const [orders, setOrders] = useState<Order[]>([]);
    const [customers, setCustomers] = useState<Customer[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [customerId, setCustomerId] = useState('');
    const [items, setItems] = useState<DraftItem[]>([{ productId: '', quantity: '1' }]);

    const [expandedHistory, setExpandedHistory] = useState<Map<number, OrderStatusHistory[]>>(new Map());
    const [historyLoading, setHistoryLoading] = useState<Set<number>>(new Set());
    const [editingOrderId, setEditingOrderId] = useState<number | null>(null);
    const [editItems, setEditItems] = useState<DraftItem[]>([]);

    async function loadAll() {
        setLoading(true);
        try {
            const [ordersData, customersData, productsData] = await Promise.all([
                api.get<Order[]>('/orders'),
                api.get<Customer[]>('/customers'),
                api.get<Product[]>('/products'),
            ]);
            setOrders(ordersData);
            setCustomers(customersData);
            setProducts(productsData);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load data');
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => { loadAll(); }, []);

    function addItem() {
        setItems([...items, { productId: '', quantity: '1' }]);
    }

    function removeItem(index: number) {
        setItems(items.filter((_, i) => i !== index));
    }

    function updateItem(index: number, field: keyof DraftItem, value: string) {
        setItems(items.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
    }

    async function handleCreate(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        try {
            await api.post<Order>('/orders', {
                customerId: parseInt(customerId),
                items: items.map((i) => ({
                    productId: parseInt(i.productId),
                    quantity: parseInt(i.quantity),
                })),
            });
            setCustomerId('');
            setItems([{ productId: '', quantity: '1' }]);
            await loadAll();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create order');
        }
    }

    async function handleSubmitOrder(id: number) {
        setError(null);
        try {
            await api.patch(`/orders/${id}/status`, { status: 'SUBMITTED' });
            await loadAll();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to submit order');
        }
    }

    async function handleDeleteOrder(id: number) {
        if (!window.confirm('Delete this draft order?')) return;
        setError(null);
        try {
            await api.delete(`/orders/${id}`);
            await loadAll();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete order');
        }
    }

    function startEditOrder(order: Order) {
        setEditingOrderId(order.id);
        setEditItems(order.items.map((i) => ({
            productId: String(i.productId),
            quantity: String(i.quantity),
        })));
    }

    async function handleSaveOrder(id: number) {
        setError(null);
        try {
            await api.patch(`/orders/${id}/items`, {
                customerId: 0,
                items: editItems.map((i) => ({
                    productId: parseInt(i.productId),
                    quantity: parseInt(i.quantity),
                })),
            });
            setEditingOrderId(null);
            await loadAll();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to update order');
        }
    }

    async function toggleHistory(orderId: number) {
        if (expandedHistory.has(orderId)) {
            setExpandedHistory((prev) => {
                const next = new Map(prev);
                next.delete(orderId);
                return next;
            });
            return;
        }
        setHistoryLoading((prev) => new Set(prev).add(orderId));
        try {
            const detail = await api.get<Order>(`/orders/${orderId}`);
            setExpandedHistory((prev) => new Map(prev).set(orderId, detail.history ?? []));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load history');
        } finally {
            setHistoryLoading((prev) => {
                const next = new Set(prev);
                next.delete(orderId);
                return next;
            });
        }
    }

    const productMap = new Map(products.map((p) => [p.id, p]));
    const customerMap = new Map(customers.map((c) => [c.id, c]));

    return (
        <div className="max-w-3xl">
            <h1 className="text-2xl font-bold mb-6">Orders</h1>

            <form
                onSubmit={handleCreate}
                className="bg-slate-800 border border-slate-700 rounded-lg p-4 mb-6 space-y-4"
            >
                <h2 className="font-semibold text-slate-300">New Order</h2>

                <div>
                    <label className="text-sm text-slate-400 block mb-1">Customer</label>
                    <select
                        value={customerId}
                        onChange={(e) => setCustomerId(e.target.value)}
                        required
                        className="bg-slate-700 border border-slate-600 rounded px-3 py-2 w-full"
                    >
                        <option value="">Select a customer…</option>
                        {customers.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name} ({c.email})
                            </option>
                        ))}
                    </select>
                </div>

                <div className="space-y-2">
                    <label className="text-sm text-slate-400 block">Items</label>
                    {items.map((item, i) => (
                        <div key={i} className="flex gap-2">
                            <select
                                value={item.productId}
                                onChange={(e) => updateItem(i, 'productId', e.target.value)}
                                required
                                className="bg-slate-700 border border-slate-600 rounded px-3 py-2 flex-1"
                            >
                                <option value="">Select a product…</option>
                                {products.map((p) => (
                                    <option key={p.id} value={p.id}>
                                        {p.name} (${parseFloat(p.price).toFixed(2)})
                                    </option>
                                ))}
                            </select>
                            <input
                                type="number"
                                min="1"
                                value={item.quantity}
                                onChange={(e) => updateItem(i, 'quantity', e.target.value)}
                                required
                                className="bg-slate-700 border border-slate-600 rounded px-3 py-2 w-20"
                            />
                            {items.length > 1 && (
                                <button
                                    type="button"
                                    onClick={() => removeItem(i)}
                                    className="text-red-400 hover:text-red-300 px-2"
                                >
                                    ✕
                                </button>
                            )}
                        </div>
                    ))}
                    <button
                        type="button"
                        onClick={addItem}
                        className="text-sm text-blue-400 hover:text-blue-300"
                    >
                        + Add item
                    </button>
                </div>

                <button
                    type="submit"
                    className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-medium"
                >
                    Create Order
                </button>
            </form>

            {error && <p className="text-red-400 mb-4">{error}</p>}

            {loading ? (
                <p className="text-slate-400">Loading...</p>
            ) : orders.length === 0 ? (
                <p className="text-slate-400">No orders yet.</p>
            ) : (
                <div className="space-y-3">
                    {orders.map((order) => (
                        <div
                            key={order.id}
                            className="bg-slate-800 border border-slate-700 rounded-lg p-4"
                        >
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-3">
                                    <span className="font-semibold">Order #{order.id}</span>
                                    <span
                                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${order.status === 'SUBMITTED'
                                                ? 'bg-green-900 text-green-300'
                                                : 'bg-yellow-900 text-yellow-300'
                                            }`}
                                    >
                                        {order.status}
                                    </span>
                                </div>
                                <div className="flex items-center gap-3 text-sm text-slate-400">
                                    <span>
                                        {customerMap.get(order.customerId)?.name ?? `Customer #${order.customerId}`}
                                    </span>
                                    {order.status === 'DRAFT' && (
                                        <button
                                            onClick={() => handleSubmitOrder(order.id)}
                                            className="bg-green-700 hover:bg-green-600 text-white text-xs px-3 py-1 rounded"
                                        >
                                            Submit
                                        </button>
                                    )}
                                    {order.status === 'DRAFT' && (
                                        <button
                                            onClick={() => startEditOrder(order)}
                                            className="bg-blue-700 hover:bg-blue-600 text-white text-xs px-3 py-1 rounded"
                                        >
                                            Edit
                                        </button>
                                    )}
                                    {order.status === 'DRAFT' && (
                                        <button
                                            onClick={() => handleDeleteOrder(order.id)}
                                            className="bg-red-700 hover:bg-red-600 text-white text-xs px-3 py-1 rounded"
                                        >
                                            Delete
                                        </button>
                                    )}
                                </div>
                            </div>
                            {editingOrderId === order.id ? (
                                <div className="space-y-2 mt-2">
                                    {editItems.map((item, i) => (
                                        <div key={i} className="flex gap-2">
                                            <select
                                                value={item.productId}
                                                onChange={(e) => setEditItems(editItems.map((ei, idx) =>
                                                    idx === i ? { ...ei, productId: e.target.value } : ei))}
                                                className="bg-slate-700 border border-slate-600 rounded px-2 py-1 flex-1"
                                            >
                                                {products.map((p) => (
                                                    <option key={p.id} value={p.id}>
                                                        {p.name} (${parseFloat(p.price).toFixed(2)})
                                                    </option>
                                                ))}
                                            </select>
                                            <input
                                                type="number"
                                                min="1"
                                                value={item.quantity}
                                                onChange={(e) => setEditItems(editItems.map((ei, idx) =>
                                                    idx === i ? { ...ei, quantity: e.target.value } : ei))}
                                                className="bg-slate-700 border border-slate-600 rounded px-2 py-1 w-20"
                                            />
                                            {editItems.length > 1 && (
                                                <button
                                                    type="button"
                                                    onClick={() => setEditItems(editItems.filter((_, idx) => idx !== i))}
                                                    className="text-red-400 hover:text-red-300 px-2"
                                                >✕</button>
                                            )}
                                        </div>
                                    ))}
                                    <button
                                        type="button"
                                        onClick={() => setEditItems([...editItems, { productId: String(products[0]?.id ?? ''), quantity: '1' }])}
                                        className="text-sm text-blue-400 hover:text-blue-300"
                                    >+ Add item</button>
                                    <div className="flex gap-2 mt-1">
                                        <button
                                            onClick={() => handleSaveOrder(order.id)}
                                            className="bg-green-700 hover:bg-green-600 text-xs px-3 py-1 rounded"
                                        >Save</button>
                                        <button
                                            onClick={() => setEditingOrderId(null)}
                                            className="bg-slate-600 hover:bg-slate-500 text-xs px-3 py-1 rounded"
                                        >Cancel</button>
                                    </div>
                                </div>
                            ) : (
                            <table className="w-full text-sm text-left">
                                <thead>
                                    <tr className="text-slate-500 text-xs">
                                        <th className="py-1">Product</th>
                                        <th className="py-1">Qty</th>
                                        <th className="py-1">Unit Price</th>
                                        <th className="py-1">Subtotal</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {order.items.map((item) => (
                                        <tr key={item.id} className="border-t border-slate-700">
                                            <td className="py-1">
                                                {productMap.get(item.productId)?.name ?? `Product #${item.productId}`}
                                            </td>
                                            <td className="py-1">{item.quantity}</td>
                                            <td className="py-1">${parseFloat(item.unitPrice).toFixed(2)}</td>
                                            <td className="py-1">
                                                ${(item.quantity * parseFloat(item.unitPrice)).toFixed(2)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            )}
                            <div className="mt-3 border-t border-slate-700 pt-2">
                                <button
                                    onClick={() => toggleHistory(order.id)}
                                    className="text-xs text-slate-400 hover:text-slate-200"
                                >
                                    {historyLoading.has(order.id)
                                        ? 'Loading…'
                                        : expandedHistory.has(order.id)
                                        ? 'Hide history ▲'
                                        : 'Show history ▼'}
                                </button>
                                {expandedHistory.has(order.id) && (
                                    <ul className="mt-2 space-y-1">
                                        {expandedHistory.get(order.id)!.length === 0 ? (
                                            <li className="text-xs text-slate-500">No history yet.</li>
                                        ) : (
                                            expandedHistory.get(order.id)!.map((h) => (
                                                <li key={h.id} className="text-xs text-slate-400 flex gap-3">
                                                    <span className="font-medium text-slate-300">{h.status}</span>
                                                    <span>{new Date(h.changedAt).toLocaleString()}</span>
                                                </li>
                                            ))
                                        )}
                                    </ul>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}