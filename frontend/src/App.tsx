import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/customers" replace />} />
        <Route path="/customers" element={<div>Customers page coming soon</div>} />
        <Route path="/products" element={<div>Products page coming soon</div>} />
        <Route path="/orders" element={<div>Orders page coming soon</div>} />
      </Route>
    </Routes>
  );
}

export default App;
