/**
 * Shared observation widgets (used by the monitor, catalogue, history and collection screens):
 *   ListingDrawer            latest price, history chart and recent observations of one retailer listing
 *   ObservationDrawer        full provenance of one observation (source, evidence, confidence, void / restore)
 *   ManualObservationDialog  manual price entry with optional supporting evidence
 */
import { Dialog, Drawer } from '@/components/ui/overlays.tsx';
import { LoadingBlock } from '@/components/ui/primitives.tsx';

export interface ListingDrawerProps {
  listingId: number | null;
  onClose: () => void;
}
export function ListingDrawer({ listingId, onClose }: ListingDrawerProps) {
  return (
    <Drawer open={listingId !== null} onClose={onClose} title="Listing" width="lg">
      <LoadingBlock />
    </Drawer>
  );
}

export interface ObservationDrawerProps {
  observationId: number | null;
  onClose: () => void;
  /** Called after the observation was voided or restored. */
  onChanged?: () => void;
}
export function ObservationDrawer({ observationId, onClose }: ObservationDrawerProps) {
  return (
    <Drawer open={observationId !== null} onClose={onClose} title="Observation" width="md">
      <LoadingBlock />
    </Drawer>
  );
}

export interface ManualObservationDialogProps {
  open: boolean;
  onClose: () => void;
  /** Pre-select a listing… */
  listingId?: number | null;
  /** …or limit the listing choice to one product. */
  productId?: number | null;
  onSaved?: () => void;
}
export function ManualObservationDialog({ open, onClose }: ManualObservationDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title="Add price observation">
      <LoadingBlock />
    </Dialog>
  );
}
