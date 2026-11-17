import { Drawer } from '@/components/ui/overlays.tsx';
import { EmptyState } from '@/components/ui/primitives.tsx';

export default function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Drawer open={open} onClose={onClose} title="Intelligence assistant">
      <EmptyState title="The assistant is being built" />
    </Drawer>
  );
}
