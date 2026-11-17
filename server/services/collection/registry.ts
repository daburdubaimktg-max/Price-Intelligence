/**
 * Connector registry: maps every `retailers.collection_method` to the connector that serves it.
 * Supporting a new kind of source means writing one connector module and adding it to CONNECTORS.
 */
import { COLLECTION_METHODS, type CollectionMethod } from '../../../shared/constants.ts';
import type { ConnectorDescription } from '../../../shared/api/collection.ts';
import { simulatedConnector } from './simulated.ts';
import { structuredConnector } from './structured.ts';
import { emptyResult, type ConfigCheck, type Connector } from './types.ts';
import { webConnector } from './web.ts';

/** Manual price entry and CSV / Excel imports: prices arrive through people, not through the scheduler. */
const peopleConnector: Connector = {
  methods: ['manual', 'csv_import'],
  runnable: false,
  dataClass: 'real',

  describe(method: CollectionMethod): ConnectorDescription {
    const manual = method === 'manual';
    return {
      method,
      label: manual ? 'Manual price entry' : 'Manual CSV import',
      summary: manual ? 'Prices are typed in by your team.' : 'Prices are uploaded as CSV or Excel files.',
      description: manual
        ? 'Observations are entered one at a time (optionally with a screenshot or link as evidence) from the Live Price Monitor or the Data Collection Centre. Each entry is stored with the person who entered it and labelled "manual entry".'
        : 'Historical or periodic price files are uploaded, validated row by row and committed to the ledger. Rows keep their original observation dates and are labelled "imported", with the file retained as evidence.',
      runnable: false,
      kind: 'people',
      requirements: manual ? ['Listings for the products you want to track at this retailer'] : ['A CSV or Excel file with at least retailer, product identifier, date and price columns'],
      limitations: ['Not run by the scheduler — there is nothing to collect automatically. Freshness depends on how often your team updates it.'],
      credential: { needed: 'never', label: '', help: '' },
      needs_permission_attestation: false,
      supports_discovery: false,
      config_fields: [],
      examples: [],
    };
  },

  checkConfig(): ConfigCheck {
    return { ok: true, missing: [], warnings: [] };
  },

  canRunWithoutListings(): boolean {
    return false;
  },

  requestsPerListing(): boolean {
    return false;
  },

  async collect() {
    const result = emptyResult();
    result.fatal = { code: 'not_applicable', message: 'This source is updated by people (manual entry or file import); there is nothing to collect automatically.' };
    return result;
  },
};

const CONNECTORS: Connector[] = [structuredConnector, webConnector, simulatedConnector, peopleConnector];

const byMethod = new Map<CollectionMethod, Connector>();
for (const connector of CONNECTORS) {
  for (const method of connector.methods) byMethod.set(method, connector);
}

export function connectorFor(method: CollectionMethod | string): Connector {
  const connector = byMethod.get(method as CollectionMethod);
  if (!connector) throw new Error(`No connector is registered for collection method "${method}"`);
  return connector;
}

export function isRunnableMethod(method: CollectionMethod | string): boolean {
  return byMethod.get(method as CollectionMethod)?.runnable === true;
}

/** Methods the scheduler may run, derived from the registry. */
export function runnableMethods(): CollectionMethod[] {
  return COLLECTION_METHODS.filter((m) => isRunnableMethod(m));
}

/** Catalogue of connector types for the configuration UI. */
export function describeConnectors(): ConnectorDescription[] {
  return COLLECTION_METHODS.filter((m) => byMethod.has(m)).map((m) => byMethod.get(m)!.describe(m));
}
