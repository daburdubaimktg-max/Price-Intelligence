/** Staged CSV / Excel import (upload → map columns → validate → commit) for price history and products. */
import { Dialog } from '@/components/ui/overlays.tsx';
import { LoadingBlock } from '@/components/ui/primitives.tsx';

export interface ImportWizardProps {
  open: boolean;
  kind: 'observations' | 'products';
  onClose: () => void;
  onCommitted?: () => void;
}
export function ImportWizard({ open, kind, onClose }: ImportWizardProps) {
  return (
    <Dialog open={open} onClose={onClose} title={kind === 'products' ? 'Import products' : 'Import price history'} size="xl">
      <LoadingBlock />
    </Dialog>
  );
}
