// Demo data. Every invoice here is a SAMPLE made for this demo.
// "intel" holds hand-written sample values in the shape we'll read from Glasser
// (company_intelligence + web_research). Live mode replaces it with real Glasser calls.

export const VENDORS = {
  gcloud: {
    name: 'Google Cloud',
    domain: 'google.com',
    bankLast4: '9021',
    history: [3120, 3340, 3285, 3410],
    address: '1600 Amphitheatre Pkwy, Mountain View, CA',
    paidInvoices: ['GC-88120', 'GC-88544', 'GC-89013', 'GC-89470'],
  },
  vercel: {
    name: 'Vercel',
    domain: 'vercel.com',
    bankLast4: '4417',
    history: [1180, 1215, 1198, 1240],
    address: '440 N Barranca Ave #4133, Covina, CA',
    paidInvoices: ['VC-2208', 'VC-2291', 'VC-2377', 'VC-2460'],
  },
};

export const INTEL = {
  'g00gle-cloud-billing.co': {
    summary: 'domain registered 9 days ago · no company profile · no measurable traffic',
    domainAgeDays: 9,
    hasProfile: false,
    scamReports: 3,
  },
  'vercel.com': {
    summary: 'Vercel Inc. · founded 2015 · ~700 employees · tens of millions of monthly visits',
    domainAgeDays: 4000,
    hasProfile: true,
    founded: 2015,
    employees: 700,
    scamReports: 0,
  },
  'brightlinesupply.co': {
    summary: 'domain ~14 months old · small company profile · low traffic',
    domainAgeDays: 420,
    hasProfile: true,
    founded: 2025,
    employees: 6,
    scamReports: 0,
  },
};

// Extra fictional vendors used only by the homepage queue animation.
export const EXTRA_VENDORS = {
  northwind: {
    name: 'Northwind Logistics',
    domain: 'northwind-logistics.com',
    bankLast4: '3310',
    history: [5200, 4980, 5410, 5150],
    address: '88 Pier Rd, Oakland, CA',
    paidInvoices: ['NW-1102', 'NW-1131', 'NW-1166', 'NW-1190'],
  },
  papercraft: {
    name: 'Papercraft Office',
    domain: 'papercraftoffice.com',
    bankLast4: '6604',
    history: [640, 710, 585, 690],
    address: '12 Mission St, San Francisco, CA',
    paidInvoices: ['PC-0451', 'PC-0478', 'PC-0502', 'PC-0519'],
  },
};

export const EXTRA_INTEL = {
  'northwind-logistics.com': { summary: 'founded 2011 · ~140 employees', domainAgeDays: 5000, hasProfile: true, founded: 2011, employees: 140, scamReports: 0 },
  'papercraftoffice.com': { summary: 'founded 2016 · ~25 employees', domainAgeDays: 3500, hasProfile: true, founded: 2016, employees: 25, scamReports: 0 },
};

export const EXTRA_INVOICES = [
  {
    id: 'northwind', vendorKey: 'northwind', vendorName: 'Northwind Logistics', tag: 'Monthly bill',
    senderEmail: 'billing@northwind-logistics.com', number: 'NW-1214', issued: 'Oct 2, 2026', due: 'Nov 1, 2026',
    amount: 5320, bankLast4: '3310', address: '88 Pier Rd, Oakland, CA',
    lines: [['Freight · 14 pallets', 4100], ['Warehousing · October', 980], ['Fuel surcharge', 240]],
    body: 'Invoice for October freight and storage. Thank you for your business.',
  },
  {
    id: 'papercraft', vendorKey: 'papercraft', vendorName: 'Papercraft Office', tag: 'Reminder',
    senderEmail: 'accounts@papercraftoffice.com', number: 'PC-0519', issued: 'Oct 14, 2026', due: 'Today',
    amount: 690, bankLast4: '6604', address: '12 Mission St, San Francisco, CA',
    lines: [['Printer paper × 40 reams', 420], ['Toner cartridges × 3', 230], ['Delivery', 40]],
    body: 'Reminder: this invoice is overdue, please pay today.',
  },
];

export const INVOICES = [
  {
    id: 'gcloud',
    vendorKey: 'gcloud',
    vendorName: 'Google Cloud',
    tag: 'Looks routine',
    senderEmail: 'billing@g00gle-cloud-billing.co',
    number: 'GC-90217',
    issued: 'Oct 15, 2026',
    due: 'Today',
    amount: 48250,
    bankLast4: '7730',
    address: '25 Harbor Plaza, Suite 900, Jersey City, NJ',
    lines: [
      ['Compute Engine · committed use', 31400],
      ['Cloud Storage · multi-region', 9850],
      ['Support · premium tier', 7000],
    ],
    body: 'URGENT: Final notice. Your account will be suspended within 24 hours. Note we have updated banking details, please wire today to the new bank account below. Please do not call our office, finance is reachable by email only.',
  },
  {
    id: 'vercel',
    vendorKey: 'vercel',
    vendorName: 'Vercel',
    tag: 'Monthly bill',
    senderEmail: 'invoices@vercel.com',
    number: 'VC-2541',
    issued: 'Oct 1, 2026',
    due: 'Oct 31, 2026',
    amount: 1240,
    bankLast4: '4417',
    address: '440 N Barranca Ave #4133, Covina, CA',
    lines: [
      ['Pro plan · 6 seats', 120],
      ['Bandwidth & functions', 980],
      ['Observability add-on', 140],
    ],
    body: 'Thanks for building with us. Your invoice for October is attached. Payment is due by the end of the month.',
  },
  {
    id: 'brightline',
    vendorKey: 'brightline',
    vendorName: 'Brightline Supply Co.',
    tag: 'New vendor',
    senderEmail: 'ar@brightlinesupply.co',
    number: 'BL-0001',
    issued: 'Oct 16, 2026',
    due: 'Nov 15, 2026',
    amount: 12800,
    bankLast4: '5582',
    address: '2201 Industrial Way, Oakland, CA',
    lines: [
      ['Office chairs × 16', 8960],
      ['Standing desks × 4', 3240],
      ['Delivery & assembly', 600],
    ],
    body: 'Hello, thank you for your first order with Brightline. Please find invoice BL-0001 attached, net 30.',
  },
];
