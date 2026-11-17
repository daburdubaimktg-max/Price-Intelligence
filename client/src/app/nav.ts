import {
  Activity, BadgePercent, Bell, DatabaseZap, FileChartColumn, Globe, History, LayoutDashboard, Package, Scale, Settings, type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Matches the index route exactly. */
  end?: boolean;
}

/** The eleven sections of the product, in the order specified. */
export const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/monitor', label: 'Live Price Monitor', icon: Activity },
  { to: '/catalogue', label: 'Product Catalogue', icon: Package },
  { to: '/competitors', label: 'Competitor Intelligence', icon: Scale },
  { to: '/history', label: 'Historical Price Explorer', icon: History },
  { to: '/promotions', label: 'Promotion Intelligence', icon: BadgePercent },
  { to: '/markets', label: 'Market Intelligence', icon: Globe },
  { to: '/alerts', label: 'Alerts Centre', icon: Bell },
  { to: '/collection', label: 'Data Collection Centre', icon: DatabaseZap },
  { to: '/reports', label: 'Reports', icon: FileChartColumn },
  { to: '/admin', label: 'Administration', icon: Settings },
];
