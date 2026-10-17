// Turns live data into the INTEL record the engine reads:
//   { summary, domainAgeDays, hasProfile, founded, employees, scamReports, place }
// Sources: Glasser → Hunter (company profile by domain), Glasser → Serper (Google search),
// public RDAP (domain registration date). Provider output is provider-native, so each
// adapter pulls only the fields it needs and treats anything missing as unknown.

import { glasserRun } from './glasser.mjs';
import { domainAge } from './rdap.mjs';

const COMPLAINT_HOSTS = [
  'reddit.com', 'trustpilot.com', 'bbb.org', 'scamadviser.com', 'scam-detector.com', 'ripoffreport.com',
  'sitejabber.com', 'complaintsboard.com', 'scamwatcher.com', 'x.com', 'twitter.com', 'facebook.com',
];
const SCAM_WORDS = /\b(scam|scammer|fraud|fraudulent|phishing|fake invoice|impersonat\w*)\b/i;

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const onHost = (host, list) => list.some((h) => host === h || host.endsWith('.' + h));

function adaptHunter(run) {
  const d = run?.ok ? run.output?.data : null;
  if (!d || !d.name) return { hasProfile: false };
  const employees = d.metrics?.employeesCount ?? null;
  return {
    hasProfile: true,
    name: d.name,
    founded: d.foundedYear ?? null,
    employees,
    employeesBand: d.metrics?.employees ?? null,
    location: d.location ?? null,
    phone: d.phone ?? d.site?.phoneNumbers?.[0] ?? null,
  };
}

// A result counts as a report only if it's on a complaint/forum site, names this exact
// domain, and uses scam language. Pages on the domain itself never count.
function adaptSerper(run, domain) {
  const organic = run?.ok ? run.output?.organic ?? [] : null;
  if (organic === null) return { reports: null, hits: [] };
  const needle = domain.toLowerCase();
  const hits = organic.filter((r) => {
    const host = hostOf(r.link);
    if (!host || host === needle || host.endsWith('.' + needle)) return false;
    const text = `${r.title ?? ''} ${r.snippet ?? ''}`.toLowerCase();
    return onHost(host, COMPLAINT_HOSTS) && text.includes(needle) && SCAM_WORDS.test(text);
  }).map((r) => ({ title: r.title, link: r.link }));
  return { reports: hits.length, hits };
}

const fmt = (n) => n.toLocaleString('en-US');

export async function buildIntel(domain, { fresh = false } = {}) {
  domain = domain.toLowerCase().trim();
  const [hunterRun, serperRun, age] = await Promise.all([
    glasserRun('hunter', '/v2/companies/find', { domain }, { fresh }).catch((e) => ({ ok: false, error: e.message })),
    glasserRun('serper', '/search', { q: `"${domain}" scam OR fraud OR phishing`, num: 10 }, { fresh }).catch((e) => ({ ok: false, error: e.message })),
    domainAge(domain),
  ]);

  const company = adaptHunter(hunterRun);
  const search = adaptSerper(serperRun, domain);

  const thisYear = new Date().getFullYear();
  const established = company.hasProfile && (company.employees ?? 0) >= 200 && company.founded && thisYear - company.founded >= 5;
  // Big, old companies show up in scam searches because criminals impersonate them.
  // Those are brand-abuse mentions, not reports against the sender.
  const scamReports = search.reports === null ? null : established ? 0 : search.reports;

  let domainAgeDays = null;
  if (age.status === 'registered' && age.ageDays != null) domainAgeDays = age.ageDays;
  if (age.status === 'not_registered') domainAgeDays = 0;

  const parts = [];
  if (company.hasProfile) {
    parts.push(company.name);
    if (company.founded) parts.push(`founded ${company.founded}`);
    if (company.employees) parts.push(`~${fmt(company.employees)} employees`);
  } else parts.push('no company profile');
  if (age.status === 'registered' && age.registeredAt) parts.push(`domain registered ${age.registeredAt}`);
  if (age.status === 'not_registered') parts.push('the domain registry has no record of this domain');

  const nothingWorked = !hunterRun?.ok && search.reports === null && age.status === 'unknown';
  const intel = nothingWorked ? null : {
    summary: parts.join(' · '),
    domainAgeDays,
    hasProfile: company.hasProfile,
    founded: company.founded ?? null,
    employees: company.employees ?? null,
    scamReports: scamReports ?? 0,
    notRegistered: age.status === 'not_registered',
    phone: company.phone ?? null,
  };

  const sources = [
    { source: 'Glasser · Hunter company profile', ok: !!hunterRun?.ok, value: company.hasProfile ? `${company.name}${company.founded ? `, founded ${company.founded}` : ''}${company.employees ? `, ~${fmt(company.employees)} employees` : ''}` : (hunterRun?.error ?? 'no record for this domain'), runUrl: hunterRun?.runUrl ?? null, charge: hunterRun?.charge ?? 0, cached: !!hunterRun?.cached },
    { source: 'Glasser · Serper Google search', ok: !!serperRun?.ok, value: search.reports === null ? (serperRun?.error ?? 'search failed') : established && search.reports ? `${search.reports} scam mentions, all about criminals impersonating this brand` : `${search.reports} scam report${search.reports === 1 ? '' : 's'} naming ${domain}`, runUrl: serperRun?.runUrl ?? null, charge: serperRun?.charge ?? 0, cached: !!serperRun?.cached, hits: search.hits },
    { source: 'RDAP domain registry (free)', ok: age.status !== 'unknown', value: age.status === 'registered' ? `registered ${age.registeredAt ?? '(date hidden)'}` : age.status === 'not_registered' ? 'not registered' : 'no answer', runUrl: `https://rdap.org/domain/${domain}`, charge: 0, cached: false },
  ];
  const cost = +sources.reduce((a, s) => a + s.charge, 0).toFixed(4);
  return { domain, intel, sources, cost };
}
