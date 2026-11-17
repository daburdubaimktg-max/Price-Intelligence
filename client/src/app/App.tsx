import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { useAuth } from '@/lib/auth.tsx';
import { LoadingBlock } from '@/components/ui/primitives.tsx';
import { AppShell } from './AppShell.tsx';
import { ForcedPasswordChange } from './ChangePassword.tsx';
import { Login } from './Login.tsx';

const Overview = lazy(() => import('@/pages/overview/OverviewPage.tsx'));
const Monitor = lazy(() => import('@/pages/monitor/MonitorPage.tsx'));
const Catalogue = lazy(() => import('@/pages/catalogue/CataloguePage.tsx'));
const ProductDetail = lazy(() => import('@/pages/catalogue/ProductDetailPage.tsx'));
const Competitors = lazy(() => import('@/pages/competitors/CompetitorsPage.tsx'));
const HistoryExplorer = lazy(() => import('@/pages/history/HistoryPage.tsx'));
const Promotions = lazy(() => import('@/pages/promotions/PromotionsPage.tsx'));
const Deals = lazy(() => import('@/pages/deals/DealsPage.tsx'));
const Brands = lazy(() => import('@/pages/brands/BrandsPage.tsx'));
const BrandDetail = lazy(() => import('@/pages/brands/BrandDetailPage.tsx'));
const Markets = lazy(() => import('@/pages/markets/MarketsPage.tsx'));
const Alerts = lazy(() => import('@/pages/alerts/AlertsPage.tsx'));
const Collection = lazy(() => import('@/pages/collection/CollectionPage.tsx'));
const Reports = lazy(() => import('@/pages/reports/ReportsPage.tsx'));
const Admin = lazy(() => import('@/pages/admin/AdminPage.tsx'));

export function App() {
  const { status, user } = useAuth();
  if (status === 'loading') return <LoadingBlock className="min-h-dvh" label="Loading Price Intelligence OS…" />;
  if (status === 'signed-out') return <Login />;
  if (user?.must_change_password) return <ForcedPasswordChange />;
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Overview />} />
        <Route path="monitor" element={<Monitor />} />
        <Route path="catalogue" element={<Catalogue />} />
        <Route path="catalogue/products/:id" element={<ProductDetail />} />
        <Route path="competitors" element={<Competitors />} />
        <Route path="history" element={<HistoryExplorer />} />
        <Route path="promotions" element={<Promotions />} />
        <Route path="deals" element={<Deals />} />
        <Route path="brands" element={<Brands />} />
        <Route path="brands/:id" element={<BrandDetail />} />
        <Route path="markets" element={<Markets />} />
        <Route path="alerts" element={<Alerts />} />
        <Route path="collection" element={<Collection />} />
        <Route path="reports" element={<Reports />} />
        <Route path="admin" element={<Admin />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
