/** Product Catalogue: products, listing matching, competitor mappings, and brands & categories. */
import { useSearchParams } from 'react-router';
import { Page } from '@/app/AppShell.tsx';
import { useApiQuery } from '@/lib/hooks.ts';
import { PageHeader, TabPanel, Tabs } from '@/components/ui/primitives.tsx';
import type { MatchingListResponse, MappingRow } from '@shared/api/catalogue.ts';
import type { Paged } from '@/lib/api.ts';
import { MappingsTab } from './MappingsTab.tsx';
import { MatchingTab } from './MatchingTab.tsx';
import { ProductsTab } from './ProductsTab.tsx';
import { CATALOGUE } from './shared.tsx';
import { TaxonomyTab } from './TaxonomyTab.tsx';

type TabKey = 'products' | 'matching' | 'mappings' | 'taxonomy';
const TABS: TabKey[] = ['products', 'matching', 'mappings', 'taxonomy'];

export default function CataloguePage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: TabKey = TABS.includes(raw as TabKey) ? (raw as TabKey) : 'products';

  // Work waiting in the two review queues, shown on the tabs.
  const matching = useApiQuery<MatchingListResponse>([CATALOGUE, 'matching', 'counts'], '/matching/listings', { status: 'unmatched', page_size: 1 });
  const mappings = useApiQuery<Paged<MappingRow> & { counts: { suggested: number; approved: number; rejected: number } }>([CATALOGUE, 'mappings', 'counts'], '/mappings', { page_size: 1 });

  return (
    <Page>
      <PageHeader
        title="Product Catalogue"
        description="The master list of your own and competitor products. Retailer listings are matched to these products, and competitor products are mapped to the own products they are compared with."
      />
      <Tabs<TabKey>
        value={tab}
        // each tab keeps its own filters in the URL; switching tabs starts from a clean address
        onChange={(next) => setParams(next === 'products' ? {} : { tab: next })}
        tabs={[
          { value: 'products', label: 'Products' },
          { value: 'matching', label: 'Listing matching', count: matching.data?.counts.unmatched || null },
          { value: 'mappings', label: 'Competitor mappings', count: mappings.data?.counts.suggested || null },
          { value: 'taxonomy', label: 'Brands & categories' },
        ]}
      >
        <TabPanel value="products">
          <ProductsTab />
        </TabPanel>
        <TabPanel value="matching">
          <MatchingTab />
        </TabPanel>
        <TabPanel value="mappings">
          <MappingsTab />
        </TabPanel>
        <TabPanel value="taxonomy">
          <TaxonomyTab />
        </TabPanel>
      </Tabs>
    </Page>
  );
}
