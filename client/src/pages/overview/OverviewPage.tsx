import { Page } from '@/app/AppShell.tsx';
import { EmptyState, PageHeader } from '@/components/ui/primitives.tsx';

export default function Placeholder() {
  return (
    <Page>
      <PageHeader title="Overview" />
      <EmptyState title="This section is being built" />
    </Page>
  );
}
